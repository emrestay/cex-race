// Bybit V5, linear perpetuals (api.bybit.com). Docs: https://bybit-exchange.github.io/docs/v5/guide
// (REST auth: X-BAPI-API-KEY, X-BAPI-TIMESTAMP, X-BAPI-RECV-WINDOW, X-BAPI-SIGN = lowercase hex HMAC SHA256 of
// timestamp + api key + recv window + JSON body, or + query string for GET),
// https://bybit-exchange.github.io/docs/v5/order/create-order (POST /v5/order/create; the reply is only an
// acknowledgement: "please use the websocket to confirm the order status"),
// https://bybit-exchange.github.io/docs/v5/ws/connect (private stream wss://stream.bybit.com/v5/private,
// auth op with HMAC hex of "GET/realtime" + expires) and https://bybit-exchange.github.io/docs/v5/websocket/private/order
// (order topic; final orderStatus values from https://bybit-exchange.github.io/docs/v5/enum).
// With a key the probe is a real Limit IOC order that cannot fill; the clock stops at the order update that
// reports it closed (Cancelled for an unfilled IOC). The REST acknowledgement is recorded as `ack`.
import { now, Sock } from './util.js';
import { MARKETS as STOCKS, MAX_NOTIONAL_USD } from './markets.js';
import { hmacHex, toStep, probePrice, clientId, pick, timedGet, getJson, cached, warm, unlistedStub } from './cex.js';

const HOST = 'https://api.bybit.com', WS = 'wss://stream.bybit.com/v5/private', RECV = '5000';
const FINAL = new Set(['Filled', 'Cancelled', 'Rejected', 'PartiallyFilledCanceled', 'Deactivated']);

export function bybitCred(env) {
  const key = String(env.BYBIT_API_KEY || '').trim(), secret = String(env.BYBIT_API_SECRET || '').trim();
  if (!key && !secret) return { cred: null, credError: null };
  if (!key || !secret) return { cred: null, credError: 'BYBIT_API_KEY and BYBIT_API_SECRET are both required' };
  return { cred: { key, secret }, credError: null };
}
export const bybitSign = (secret, ts, key, recv, payload) => hmacHex(secret, ts + key + recv + payload);
export const bybitWsAuth = (cred, expires) => ({ op: 'auth', args: [cred.key, expires, hmacHex(cred.secret, 'GET/realtime' + expires)] });
async function call(cred, method, path, params) {
  const ts = String(Date.now()), isGet = method === 'GET';
  const payload = isGet ? new URLSearchParams(params).toString() : JSON.stringify(params);
  const headers = { 'X-BAPI-API-KEY': cred.key, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': RECV, 'X-BAPI-SIGN': bybitSign(cred.secret, ts, cred.key, RECV, payload) };
  if (!isGet) headers['Content-Type'] = 'application/json';
  const r = await fetch(HOST + path + (isGet && payload ? '?' + payload : ''), { method, headers, body: isGet ? undefined : payload });
  const t = now(), j = await r.json().catch(() => ({ retCode: r.status, retMsg: 'non-JSON reply' }));
  return { t, j, http: r.status };
}
// A signed read (never an order): the unified account wallet.
export async function bybitCheck(env) {
  const { cred, credError } = bybitCred(env); if (!cred) return { ok: false, error: credError || 'no key' };
  try {
    const { j, http } = await call(cred, 'GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    if (j.retCode !== 0) return { ok: false, http, code: j.retCode, message: j.retMsg };
    const a = (j.result && j.result.list || [])[0] || {};
    return { ok: true, accountType: a.accountType, totalEquity: a.totalEquity, availableBalance: a.totalAvailableBalance, coins: (a.coin || []).filter(c => +c.walletBalance !== 0).map(c => ({ coin: c.coin, walletBalance: c.walletBalance })) };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function create(env, stock, side = 'short') {
  const buy = side === 'long', symbol = STOCKS[stock].bybit, { cred, credError } = bybitCred(env);
  if (!symbol) return unlistedStub('bybit', 'Bybit', stock);
  let ws = null, baseline = null, inst = null, mark = null, idx = 0;
  const ping = () => timedGet(HOST + '/v5/market/time');
  return {
    id: 'bybit', real: false,
    async connect() {
      await ping();
      if (!cred) return;
      ws = new Sock(WS); await ws.open();
      const a = ws.waitFor(m => m.op === 'auth', 6000, 'bybit auth'); ws.send(bybitWsAuth(cred, Date.now() + 10000));
      const { msg } = await a; if (!msg.success) throw new Error('bybit auth refused: ' + (msg.ret_msg || 'unknown'));
      const s = ws.waitFor(m => m.op === 'subscribe', 6000, 'bybit subscribe'); ws.send({ op: 'subscribe', args: ['order.linear'] });
      const r = await s; if (!r.msg.success) throw new Error('bybit subscribe refused: ' + (r.msg.ret_msg || 'unknown'));
    },
    async prepare() {
      baseline = await warm(ping);
      if (!cred) return;
      const [ii, tk, pos] = await Promise.all([
        cached('bybit:inst:' + symbol, 600000, () => getJson(`${HOST}/v5/market/instruments-info?category=linear&symbol=${symbol}`)),
        getJson(`${HOST}/v5/market/tickers?category=linear&symbol=${symbol}`),
        cached('bybit:pos:' + symbol, 600000, async () => { const { j } = await call(cred, 'GET', '/v5/position/list', { category: 'linear', symbol }); if (j.retCode !== 0) throw new Error('account check failed: ' + j.retCode + ' ' + (j.retMsg || '')); return j; })]);
      inst = ii.result && ii.result.list && ii.result.list[0]; if (!inst || inst.status !== 'Trading') throw new Error(symbol + ' not trading');
      mark = +(tk.result && tk.result.list && tk.result.list[0] && tk.result.list[0].markPrice); if (!(mark > 0)) throw new Error('mark price unavailable');
      // One-way mode uses positionIdx 0; hedge mode lists positions 1 (long) and 2 (short).
      idx = (pos.result.list || []).some(p => p.positionIdx === 1 || p.positionIdx === 2) ? (buy ? 1 : 2) : 0;
      this.real = true;
    },
    ping,
    async fire(t0) {
      const out = { basis: 'none' }; if (credError) out.keyError = credError;
      let finP = null, ackP = null, link = null;
      if (this.real) {
        const lf = inst.lotSizeFilter, tick = inst.priceFilter.tickSize, x = +(inst.riskParameters && inst.riskParameters.priceLimitRatioX) || 0.05;
        const px = probePrice(mark, buy, Math.min(0.02, x * 0.8), tick), qty = toStep(Math.max(+lf.minOrderQty, (+(lf.minNotionalValue || 5) * 1.05) / +px), lf.qtyStep, 'up');
        if (+qty * +px > MAX_NOTIONAL_USD) throw new Error('order size check failed: ' + qty + ' ' + symbol);
        out.kind = 'IOC order'; link = clientId('pr');
        finP = ws.waitFor(m => m.topic && m.topic.startsWith('order') && Array.isArray(m.data) && m.data.some(o => o.orderLinkId === link && FINAL.has(o.orderStatus)), 10000, 'bybit final state');
        finP.catch(() => {});
        ackP = call(cred, 'POST', '/v5/order/create', { category: 'linear', symbol, side: buy ? 'Buy' : 'Sell', orderType: 'Limit', qty, price: px, timeInForce: 'IOC', positionIdx: idx, orderLinkId: link });
        ackP.catch(() => {});
      }
      const netP = ping(), tn = now(); out.network = (await netP) + (tn - t0);
      if (finP) {
        try {
          // A rejected order never reaches the stream: stop at the rejection instead of waiting out the timeout.
          const rej = ackP.then(a => a.j.retCode !== 0 ? a : new Promise(() => {}));
          const first = await Promise.race([finP.then(f => ({ f })), rej.then(a => ({ a }))]);
          if (first.a) out.error = 'order rejected: ' + first.a.j.retCode + ' ' + (first.a.j.retMsg || '');
          else {
            const { msg, t } = first.f, o = msg.data.find(d => d.orderLinkId === link);
            out.confirmed = t - t0; out.basis = 'real'; out.status = o.orderStatus;
            out.proof = { kind: 'order', id: String(o.orderId), where: 'Bybit order id. There is no public record of a single order' };
            out.reply = pick(o, ['orderId', 'orderLinkId', 'symbol', 'side', 'orderType', 'timeInForce', 'orderStatus', 'cancelType', 'rejectReason', 'price', 'qty', 'cumExecQty', 'positionIdx', 'createdTime', 'updatedTime']);
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
