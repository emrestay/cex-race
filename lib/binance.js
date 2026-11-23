// Binance USDⓈ-M futures (fapi.binance.com). Docs: https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info
// (SIGNED endpoints: HMAC SHA256 of the query string with the secret key, hex, appended as `signature`;
// API key in the X-MBX-APIKEY header) and .../trade/rest-api (New Order, POST /fapi/v1/order).
// With a key the probe is a real order that cannot fill: a LIMIT IOC priced away from mark, inside the
// symbol's PERCENT_PRICE band. newOrderRespType=RESULT makes the REST reply carry the order's final state
// (for an unfilled IOC: EXPIRED), so the clock stops at that reply. Without a key the lane reports network time.
import { now } from './util.js';
import { MARKETS as STOCKS, MAX_NOTIONAL_USD } from './markets.js';
import { hmacHex, toStep, probePrice, clientId, pick, timedGet, getJson, cached, warm, unlistedStub } from './cex.js';

const HOST = 'https://fapi.binance.com';
// Order status enum (common-definition): NEW, PARTIALLY_FILLED, FILLED, CANCELED, REJECTED, EXPIRED, EXPIRED_IN_MATCH
const FINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'EXPIRED_IN_MATCH']);

export function binanceCred(env) {
  const key = String(env.BINANCE_API_KEY || '').trim(), secret = String(env.BINANCE_API_SECRET || '').trim();
  if (!key && !secret) return { cred: null, credError: null };
  if (!key || !secret) return { cred: null, credError: 'BINANCE_API_KEY and BINANCE_API_SECRET are both required' };
  return { cred: { key, secret }, credError: null };
}
// totalParams = query string (+ body, unused here); the signature goes last.
export const binanceQuery = (secret, params) => { const qs = new URLSearchParams(params).toString(); return qs + '&signature=' + hmacHex(secret, qs); };
async function call(cred, method, path, params) {
  const qs = binanceQuery(cred.secret, { ...params, recvWindow: 5000, timestamp: Date.now() });
  const r = await fetch(HOST + path + '?' + qs, { method, headers: { 'X-MBX-APIKEY': cred.key } });
  const t = now(), j = await r.json().catch(() => ({ code: r.status, msg: 'non-JSON reply' }));
  return { t, j, http: r.status };
}
// A signed read (never an order): balance and position mode.
export async function binanceCheck(env) {
  const { cred, credError } = binanceCred(env); if (!cred) return { ok: false, error: credError || 'no key' };
  try {
    const [b, d] = await Promise.all([call(cred, 'GET', '/fapi/v3/balance', {}), call(cred, 'GET', '/fapi/v1/positionSide/dual', {})]);
    if (!Array.isArray(b.j)) return { ok: false, http: b.http, code: b.j.code, message: b.j.msg };
    return { ok: true, hedgeMode: d.j && d.j.dualSidePosition, balances: b.j.filter(x => +x.balance !== 0).map(x => ({ asset: x.asset, balance: x.balance, available: x.availableBalance })) };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function create(env, stock, side = 'short') {
  const buy = side === 'long', symbol = STOCKS[stock].binance, { cred, credError } = binanceCred(env);
  if (!symbol) return unlistedStub('binance', 'Binance', stock);
  let baseline = null, flt = null, mark = null, dual = false, oid = null;
  const ping = () => timedGet(HOST + '/fapi/v1/time');
  return {
    id: 'binance', real: false,
    async connect() { await ping(); },
    async prepare() {
      baseline = await warm(ping);
      if (!cred) return;
      const info = await cached('binance:info', 600000, () => getJson(HOST + '/fapi/v1/exchangeInfo'));
      const si = (info.symbols || []).find(x => x.symbol === symbol); if (!si || si.status !== 'TRADING') throw new Error(symbol + ' not trading');
      flt = Object.fromEntries(si.filters.map(f => [f.filterType, f]));
      const [p, d] = await Promise.all([getJson(`${HOST}/fapi/v1/premiumIndex?symbol=${symbol}`), cached('binance:dual', 600000, async () => { const { j } = await call(cred, 'GET', '/fapi/v1/positionSide/dual', {}); if (j.code) throw new Error('account check failed: ' + j.code + ' ' + (j.msg || '')); return j; })]);
      mark = +p.markPrice; if (!(mark > 0)) throw new Error('mark price unavailable');
      dual = !!(d && d.dualSidePosition);
      this.real = true;
    },
    ping,
    async fire(t0) {
      const out = { basis: 'none' }; if (credError) out.keyError = credError;
      let ordP = null;
      if (this.real) {
        const tick = flt.PRICE_FILTER.tickSize, step = flt.LOT_SIZE.stepSize, minN = +(flt.MIN_NOTIONAL && flt.MIN_NOTIONAL.notional || 5);
        const band = flt.PERCENT_PRICE ? 1 - +flt.PERCENT_PRICE.multiplierDown : 0.05, off = Math.min(0.02, band * 0.66);
        const px = probePrice(mark, buy, off, tick), qty = toStep(Math.max(+flt.LOT_SIZE.minQty, (minN * 1.02) / +px), step, 'up');
        if (+qty * +px > MAX_NOTIONAL_USD) throw new Error('order size check failed: ' + qty + ' ' + symbol);
        out.kind = 'IOC order'; oid = clientId('pr');
        const params = { symbol, side: buy ? 'BUY' : 'SELL', type: 'LIMIT', timeInForce: 'IOC', quantity: qty, price: px, newClientOrderId: oid, newOrderRespType: 'RESULT' };
        if (dual) params.positionSide = buy ? 'LONG' : 'SHORT';
        ordP = call(cred, 'POST', '/fapi/v1/order', params); // signing happens here, inside the timed window
        ordP.catch(() => {});
      }
      const netP = ping(), tn = now(); out.network = (await netP) + (tn - t0);
      if (ordP) {
        try {
          const { t, j } = await ordP;
          if (j.orderId != null && FINAL.has(j.status)) {
            out.confirmed = t - t0; out.basis = 'real'; out.status = j.status;
            out.proof = { kind: 'order', id: String(j.orderId), where: 'Binance order id. There is no public record of a single order' };
            out.reply = pick(j, ['orderId', 'clientOrderId', 'symbol', 'side', 'positionSide', 'type', 'timeInForce', 'status', 'price', 'origQty', 'executedQty', 'updateTime']);
          } else if (j.orderId != null) out.error = 'the reply was not final: ' + j.status;
          else out.error = 'order rejected: ' + (j.code != null ? `${j.code} ${j.msg || ''}`.trim() : 'no status');
          if (out.confirmed != null && out.network >= out.confirmed && baseline != null) { out.network = baseline; out.networkFrom = 'warm-up'; }
        } catch (e) { out.error = e.message; }
      }
      return out;
    },
    close() {},
  };
}
