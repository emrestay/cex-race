// OKX V5, USDT-margined perpetual swaps (www.okx.com). Docs: https://www.okx.com/docs-v5/en/
// REST auth ("REST Authentication"): OK-ACCESS-KEY, OK-ACCESS-SIGN = base64 HMAC SHA256 of
// timestamp + METHOD + requestPath + body, OK-ACCESS-TIMESTAMP (ISO 8601 with milliseconds), OK-ACCESS-PASSPHRASE.
// Order: POST /api/v5/trade/order ("Place order"; ordType ioc, tdMode cross, sz in contracts of ctVal).
// Final state: private WebSocket wss://ws.okx.com/ws/v5/private, login op (timestamp in seconds, sign =
// base64 HMAC SHA256 of timestamp + "GET" + "/users/self/verify"), channel "orders" ("WS / Order channel"),
// state canceled / filled / mmp_canceled. The REST reply only acknowledges the order and is kept as `ack`.
import { now, Sock } from './util.js';
import { MARKETS as STOCKS, MAX_NOTIONAL_USD } from './markets.js';
import { hmacB64, toStep, probePrice, clientId, pick, timedGet, getJson, cached, warm, unlistedStub } from './cex.js';

const HOST = 'https://www.okx.com', WS = 'wss://ws.okx.com/ws/v5/private';
const FINAL = new Set(['canceled', 'filled', 'mmp_canceled']);

export function okxCred(env) {
  const key = String(env.OKX_API_KEY || '').trim(), secret = String(env.OKX_API_SECRET || '').trim(), pass = String(env.OKX_PASSPHRASE || '');
  if (!key && !secret && !pass) return { cred: null, credError: null };
  if (!key || !secret || !pass) return { cred: null, credError: 'OKX_API_KEY, OKX_API_SECRET and OKX_PASSPHRASE are all required' };
  return { cred: { key, secret, pass }, credError: null };
}
export const okxSign = (secret, ts, method, path, body = '') => hmacB64(secret, ts + method + path + body);
export const okxLogin = (cred, ts = String(Math.floor(Date.now() / 1000))) => ({ op: 'login', args: [{ apiKey: cred.key, passphrase: cred.pass, timestamp: ts, sign: okxSign(cred.secret, ts, 'GET', '/users/self/verify') }] });
async function call(cred, method, path, body) {
  const ts = new Date().toISOString(), b = body ? JSON.stringify(body) : '';
  const headers = { 'OK-ACCESS-KEY': cred.key, 'OK-ACCESS-SIGN': okxSign(cred.secret, ts, method, path, b), 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': cred.pass };
  if (b) headers['Content-Type'] = 'application/json';
  const r = await fetch(HOST + path, { method, headers, body: b || undefined });
  const t = now(), j = await r.json().catch(() => ({ code: String(r.status), msg: 'non-JSON reply' }));
  return { t, j, http: r.status };
}
// A signed read (never an order): account configuration and the USDT balance.
export async function okxCheck(env) {
  const { cred, credError } = okxCred(env); if (!cred) return { ok: false, error: credError || 'no key' };
  try {
    const [c, b] = await Promise.all([call(cred, 'GET', '/api/v5/account/config'), call(cred, 'GET', '/api/v5/account/balance')]);
    if (c.j.code !== '0') return { ok: false, http: c.http, code: c.j.code, message: c.j.msg };
    const cf = (c.j.data || [])[0] || {}, d = ((b.j.data || [])[0] || {}).details || [];
    return { ok: true, acctLv: cf.acctLv, posMode: cf.posMode, subAccount: !!(cf.mainUid && cf.uid && cf.mainUid !== cf.uid), balances: d.filter(x => +x.eq > 0.001).map(x => ({ ccy: x.ccy, eq: x.eq, availBal: x.availBal })) };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function create(env, stock, side = 'short') {
  const buy = side === 'long', instId = STOCKS[stock].okx, { cred, credError } = okxCred(env);
  if (!instId) return unlistedStub('okx', 'OKX', stock);
  let ws = null, baseline = null, inst = null, mark = null, lim = null, longShort = false;
  const ping = () => timedGet(HOST + '/api/v5/public/time');
  return {
    id: 'okx', real: false,
    async connect() {
      await ping();
      if (!cred) return;
      ws = new Sock(WS); await ws.open();
      const l = ws.waitFor(m => m.event === 'login' || m.event === 'error', 6000, 'okx login'); ws.send(okxLogin(cred));
      const { msg } = await l; if (msg.event !== 'login' || msg.code !== '0') throw new Error('okx login refused: ' + (msg.code || '') + ' ' + (msg.msg || ''));
      const s = ws.waitFor(m => (m.event === 'subscribe' && m.arg && m.arg.channel === 'orders') || m.event === 'error', 6000, 'okx subscribe');
      ws.send({ op: 'subscribe', args: [{ channel: 'orders', instType: 'SWAP', instId }] });
      const r = await s; if (r.msg.event === 'error') throw new Error('okx subscribe refused: ' + r.msg.code + ' ' + (r.msg.msg || ''));
    },
    async prepare() {
      baseline = await warm(ping);
      if (!cred) return;
      const [ii, mp, pl, cf] = await Promise.all([
        cached('okx:inst:' + instId, 600000, () => getJson(`${HOST}/api/v5/public/instruments?instType=SWAP&instId=${instId}`)),
        getJson(`${HOST}/api/v5/public/mark-price?instType=SWAP&instId=${instId}`),
        getJson(`${HOST}/api/v5/public/price-limit?instId=${instId}`),
        cached('okx:config', 600000, async () => { const { j } = await call(cred, 'GET', '/api/v5/account/config'); if (j.code !== '0') throw new Error('account check failed: ' + j.code + ' ' + (j.msg || '')); return j; })]);
      inst = (ii.data || [])[0]; if (!inst || inst.state !== 'live') throw new Error(instId + ' not live');
      mark = +((mp.data || [])[0] || {}).markPx; if (!(mark > 0)) throw new Error('mark price unavailable');
      lim = (pl.data || [])[0] || null;
      longShort = ((cf.data || [])[0] || {}).posMode === 'long_short_mode';
      this.real = true;
    },
    ping,
    async fire(t0) {
      const out = { basis: 'none' }; if (credError) out.keyError = credError;
      let finP = null, ackP = null, cl = null;
      if (this.real) {
        let px = probePrice(mark, buy, 0.02, inst.tickSz);
        // Stay inside the published price limits: buys at or below buyLmt, sells at or above sellLmt.
        if (lim && lim.enabled !== false) { if (buy && +px > +lim.buyLmt) px = toStep(+lim.buyLmt, inst.tickSz, 'down'); if (!buy && +px < +lim.sellLmt) px = toStep(+lim.sellLmt, inst.tickSz, 'up'); }
        const sz = toStep(+inst.minSz, inst.lotSz, 'up'); // the minimum size, in contracts
        if (+sz * +inst.ctVal * +px > MAX_NOTIONAL_USD) throw new Error('order size check failed: ' + sz + ' contracts ' + instId);
        out.kind = 'IOC order'; cl = clientId('pr');
        finP = ws.waitFor(m => m.arg && m.arg.channel === 'orders' && Array.isArray(m.data) && m.data.some(o => o.clOrdId === cl && FINAL.has(o.state)), 10000, 'okx final state');
        finP.catch(() => {});
        const body = { instId, tdMode: 'cross', side: buy ? 'buy' : 'sell', ordType: 'ioc', px, sz, clOrdId: cl };
        if (longShort) body.posSide = buy ? 'long' : 'short';
        ackP = call(cred, 'POST', '/api/v5/trade/order', body);
        ackP.catch(() => {});
      }
      const netP = ping(), tn = now(); out.network = (await netP) + (tn - t0);
      if (finP) {
        try {
          const failed = a => a.j.code !== '0' || ((a.j.data || [])[0] || {}).sCode !== '0';
          const rej = ackP.then(a => failed(a) ? a : new Promise(() => {}));
          const first = await Promise.race([finP.then(f => ({ f })), rej.then(a => ({ a }))]);
          if (first.a) { const d = (first.a.j.data || [])[0] || {}; out.error = 'order rejected: ' + (d.sCode || first.a.j.code) + ' ' + (d.sMsg || first.a.j.msg || ''); }
          else {
            const { msg, t } = first.f, o = msg.data.find(d => d.clOrdId === cl);
            out.confirmed = t - t0; out.basis = 'real'; out.status = o.state + (o.cancelSource ? ' (source ' + o.cancelSource + ')' : '');
            out.proof = { kind: 'order', id: String(o.ordId), where: 'OKX order id. There is no public record of a single order' };
            out.reply = pick(o, ['ordId', 'clOrdId', 'instId', 'side', 'posSide', 'ordType', 'state', 'cancelSource', 'px', 'sz', 'accFillSz', 'cTime', 'uTime', 'code', 'msg']);
            const a = await Promise.race([ackP, new Promise(r => setTimeout(() => r(null), 3000))]); if (a) out.ack = a.t - t0;
          }
          if (out.confirmed != null && out.network >= out.confirmed && baseline != null) { out.network = baseline; out.networkFrom = 'warm-up'; }
        } catch (e) { out.error = e.message; }
      }
      return out;
    },
    close() { ws && ws.close(); },
  };
}
