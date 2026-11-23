// Bitget, classic account, USDT-M futures (api.bitget.com). Docs: https://www.bitget.com/docs/classic/rest-api
// (ACCESS-KEY, ACCESS-SIGN = base64 HMAC SHA256 of timestamp + METHOD + requestPath + "?" + queryString + body,
// ACCESS-TIMESTAMP in milliseconds, ACCESS-PASSPHRASE), https://www.bitget.com/api-doc/contract/trade/Place-Order
// (POST /api/v2/mix/order/place-order; force ioc; tradeSide is ignored in one-way mode and opens in hedge mode),
// https://www.bitget.com/docs/classic/websocket/intro (private wss://ws.bitget.com/v2/ws/private, login op with
// sign = base64 HMAC SHA256 of timestamp + "GET" + "/user/verify") and
// https://www.bitget.com/docs/classic/websocket/contract/private/Order-Channel (channel "orders", instType
// USDT-FUTURES, status canceled / filled). The REST reply only acknowledges the order and is kept as `ack`.
// This uses the classic account API; a unified trading account (UTA) has its own endpoints.
import { now, Sock } from './util.js';
import { MARKETS as STOCKS, MAX_NOTIONAL_USD } from './markets.js';
import { hmacB64, toStep, probePrice, clientId, pick, timedGet, getJson, cached, warm, unlistedStub } from './cex.js';

const HOST = 'https://api.bitget.com', WS = 'wss://ws.bitget.com/v2/ws/private', PT = 'USDT-FUTURES';
const FINAL = new Set(['canceled', 'filled']);

export function bitgetCred(env) {
  const key = String(env.BITGET_API_KEY || '').trim(), secret = String(env.BITGET_API_SECRET || '').trim(), pass = String(env.BITGET_PASSPHRASE || '');
  if (!key && !secret && !pass) return { cred: null, credError: null };
  if (!key || !secret || !pass) return { cred: null, credError: 'BITGET_API_KEY, BITGET_API_SECRET and BITGET_PASSPHRASE are all required' };
  return { cred: { key, secret, pass }, credError: null };
}
export const bitgetSign = (secret, ts, method, path, query = '', body = '') => hmacB64(secret, ts + method + path + (query ? '?' + query : '') + body);
// The docs give the login timestamp in milliseconds in the text and in seconds in one example: try ms first.
export const bitgetLogin = (cred, ts) => ({ op: 'login', args: [{ apiKey: cred.key, passphrase: cred.pass, timestamp: ts, sign: bitgetSign(cred.secret, ts, 'GET', '/user/verify') }] });
async function call(cred, method, path, { query = '', body = null } = {}) {
  const ts = String(Date.now()), b = body ? JSON.stringify(body) : '';
  const headers = { 'ACCESS-KEY': cred.key, 'ACCESS-SIGN': bitgetSign(cred.secret, ts, method, path, query, b), 'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': cred.pass, locale: 'en-US' };
  if (b) headers['Content-Type'] = 'application/json';
  const r = await fetch(HOST + path + (query ? '?' + query : ''), { method, headers, body: b || undefined });
  const t = now(), j = await r.json().catch(() => ({ code: String(r.status), msg: 'non-JSON reply' }));
  return { t, j, http: r.status };
}
// A signed read (never an order): the USDT-M futures account.
export async function bitgetCheck(env) {
  const { cred, credError } = bitgetCred(env); if (!cred) return { ok: false, error: credError || 'no key' };
  try {
    const { j, http } = await call(cred, 'GET', '/api/v2/mix/account/accounts', { query: 'productType=' + PT });
    if (j.code !== '00000') return { ok: false, http, code: j.code, message: j.msg };
    return { ok: true, accounts: (j.data || []).map(a => ({ marginCoin: a.marginCoin, available: a.available, accountEquity: a.accountEquity, posMode: a.posMode })) };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function openPrivate(cred) {
  for (const ts of [String(Date.now()), String(Math.floor(Date.now() / 1000))]) {
    const ws = new Sock(WS); await ws.open();
    const l = ws.waitFor(m => m.event === 'login' || m.event === 'error', 6000, 'bitget login'); ws.send(bitgetLogin(cred, ts));
    const { msg } = await l.catch(e => ({ msg: { event: 'error', msg: e.message } }));
    if (msg.event === 'login' && String(msg.code) === '0') return ws;
    ws.close(); if (ts.length < 13) throw new Error('bitget login refused: ' + (msg.code || '') + ' ' + (msg.msg || ''));
  }
}

export function create(env, stock, side = 'short') {
  const buy = side === 'long', symbol = STOCKS[stock].bitget, { cred, credError } = bitgetCred(env);
  if (!symbol) return unlistedStub('bitget', 'Bitget', stock);
  let ws = null, baseline = null, ct = null, mark = null;
  const ping = () => timedGet(HOST + '/api/v2/public/time');
  return {
    id: 'bitget', real: false,
    async connect() {
      await ping();
      if (!cred) return;
      ws = await openPrivate(cred);
      const s = ws.waitFor(m => (m.event === 'subscribe' && m.arg && m.arg.channel === 'orders') || m.event === 'error', 6000, 'bitget subscribe');
      ws.send({ op: 'subscribe', args: [{ instType: PT, channel: 'orders', instId: 'default' }] });
      const r = await s; if (r.msg.event === 'error') throw new Error('bitget subscribe refused: ' + r.msg.code + ' ' + (r.msg.msg || ''));
    },
    async prepare() {
      baseline = await warm(ping);
      if (!cred) return;
      const [cs, sp] = await Promise.all([
        cached('bitget:contracts', 600000, () => getJson(`${HOST}/api/v2/mix/market/contracts?productType=${PT}`)),
        getJson(`${HOST}/api/v2/mix/market/symbol-price?productType=${PT}&symbol=${symbol}`)]);
      ct = (cs.data || []).find(x => x.symbol === symbol); if (!ct || ct.symbolStatus !== 'normal') throw new Error(symbol + ' not trading');
      mark = +((sp.data || [])[0] || {}).markPrice; if (!(mark > 0)) throw new Error('mark price unavailable');
      this.real = true;
    },
    ping,
    async fire(t0) {
      const out = { basis: 'none' }; if (credError) out.keyError = credError;
      let finP = null, ackP = null, cl = null;
      if (this.real) {
        const tick = (Number(ct.priceEndStep) * 10 ** -Number(ct.pricePlace)).toFixed(Number(ct.pricePlace)), step = ct.sizeMultiplier;
        const band = Math.min(+ct.buyLimitPriceRatio || 0.05, +ct.sellLimitPriceRatio || 0.05);
        const px = probePrice(mark, buy, Math.min(0.02, band * 0.66), tick), size = toStep(Math.max(+ct.minTradeNum, (+(ct.minTradeUSDT || 5) * 1.05) / +px), step, 'up');
        if (+size * +px > MAX_NOTIONAL_USD) throw new Error('order size check failed: ' + size + ' ' + symbol);
        out.kind = 'IOC order'; cl = clientId('pr');
        finP = ws.waitFor(m => m.arg && m.arg.channel === 'orders' && Array.isArray(m.data) && m.data.some(o => o.clientOid === cl && FINAL.has(o.status)), 10000, 'bitget final state');
        finP.catch(() => {});
        ackP = call(cred, 'POST', '/api/v2/mix/order/place-order', { body: { symbol, productType: PT, marginMode: 'crossed', marginCoin: 'USDT', size, price: px, side: buy ? 'buy' : 'sell', tradeSide: 'open', orderType: 'limit', force: 'ioc', clientOid: cl } });
        ackP.catch(() => {});
      }
      const netP = ping(), tn = now(); out.network = (await netP) + (tn - t0);
      if (finP) {
        try {
          const rej = ackP.then(a => a.j.code !== '00000' ? a : new Promise(() => {}));
          const first = await Promise.race([finP.then(f => ({ f })), rej.then(a => ({ a }))]);
          if (first.a) out.error = 'order rejected: ' + first.a.j.code + ' ' + (first.a.j.msg || '');
          else {
            const { msg, t } = first.f, o = msg.data.find(d => d.clientOid === cl);
            out.confirmed = t - t0; out.basis = 'real'; out.status = o.status + (o.cancelReason ? ' (' + o.cancelReason + ')' : '');
            out.proof = { kind: 'order', id: String(o.orderId), where: 'Bitget order id. There is no public record of a single order' };
            out.reply = pick(o, ['orderId', 'clientOid', 'instId', 'side', 'tradeSide', 'posMode', 'orderType', 'force', 'status', 'cancelReason', 'price', 'size', 'accBaseVolume', 'cTime', 'uTime']);
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
