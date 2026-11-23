// Shared helpers for the exchange adapters: HMAC signing, number formatting from step sizes, the probe price,
// timed requests on warm keep-alive connections and a small cache for exchange metadata.
import { createHmac, randomBytes } from 'node:crypto';
import { now } from './util.js';

export const hmacHex = (secret, msg) => createHmac('sha256', secret).update(msg).digest('hex');
export const hmacB64 = (secret, msg) => createHmac('sha256', secret).update(msg).digest('base64');

// Decimal places of a step such as "0.0010" or "1e-5".
export const decOf = x => { const s = String(x); if (/e-/i.test(s)) return Number(s.split(/e-/i)[1]); const t = s.includes('.') ? s.replace(/0+$/, '') : s; return (t.split('.')[1] || '').length; };
// Round to a step: 'up', 'down' or nearest; returns the value formatted with the step's decimals.
export function toStep(x, step, mode) {
  const st = +step, k = mode === 'up' ? Math.ceil(x / st - 1e-9) : mode === 'down' ? Math.floor(x / st + 1e-9) : Math.round(x / st);
  return (k * st).toFixed(decOf(step));
}
// The probe price: `off` away from mark, on the side where it cannot trade, rounded further away to the tick.
export const probePrice = (mark, buy, off, tick) => toStep(mark * (buy ? 1 - off : 1 + off), tick, buy ? 'down' : 'up');
// A client order id: unique, short, letters and digits only (every exchange here accepts that form).
export const clientId = prefix => prefix + Date.now().toString(36) + randomBytes(5).toString('hex');
export const pick = (o, ks) => o && typeof o === 'object' ? Object.fromEntries(ks.filter(k => o[k] != null && o[k] !== '').map(k => [k, o[k]])) : null;

// One small GET, timed. Used as the "network" lane and to warm the keep-alive pool before the race.
export async function timedGet(url) { const t = now(); const r = await fetch(url, { cache: 'no-store' }); await r.arrayBuffer(); if (!r.ok) throw new Error('HTTP ' + r.status); return now() - t; }
export async function getJson(url, headers) { const r = await fetch(url, { cache: 'no-store', headers }); const j = await r.json().catch(() => null); if (!r.ok && !j) throw new Error(new URL(url).pathname + ' HTTP ' + r.status); return j; }

// Exchange metadata changes rarely: keep it for ten minutes per process.
const memo = new Map();
export async function cached(key, ms, fn) {
  const c = memo.get(key); if (c && Date.now() - c.at < ms) return c.v;
  const v = await fn(); memo.set(key, { at: Date.now(), v }); return v;
}

// Two pings in parallel, twice: the ping and the order leave at the same instant, so two connections must be
// open and warm. Returns the best round trip seen (the fallback network figure).
export async function warm(ping) { const a = await Promise.all([ping(), ping()]), b = await Promise.all([ping(), ping()]); return Math.min(...a, ...b); }

// A venue that does not list the chosen market sits the race out.
export const unlistedStub = (id, name, stock) => ({ id, real: false, async connect() {}, async prepare() {}, async ping() { return 0; }, async fire() { return { basis: 'none', unlisted: true, error: `${stock} is not listed on ${name}` }; }, close() {} });
