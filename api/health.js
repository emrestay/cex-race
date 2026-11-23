// GET /api/health → which venues have real-order credentials. Never returns a secret.
import { burner } from '../lib/dreamdex.js';
import { binanceCred, binanceCheck } from '../lib/binance.js';
import { bybitCred, bybitCheck } from '../lib/bybit.js';
import { okxCred, okxCheck } from '../lib/okx.js';
import { bitgetCred, bitgetCheck } from '../lib/bitget.js';

const EX = { binance: [binanceCred, binanceCheck], bybit: [bybitCred, bybitCheck], okx: [okxCred, okxCheck], bitget: [bitgetCred, bitgetCheck] };

export async function GET(request) {
  const env = process.env, b = burner(env);
  const body = { ok: true, region: env.VERCEL_REGION || 'local', venues: { dreamdex: { network: 'Somnia Tokyo mainnet', burner: b.acct ? b.acct.address : null, ephemeral: b.ephemeral } } };
  for (const [k, [cred]] of Object.entries(EX)) { const c = cred(env); body.venues[k] = { realOrders: !!c.cred, keyError: c.credError }; }
  // On the public production site this endpoint says only what the page needs: no account details, no signed checks.
  if (env.VERCEL_ENV === 'production') {
    const pub = { ok: true, region: body.region, venues: { dreamdex: { network: body.venues.dreamdex.network, burner: body.venues.dreamdex.burner } } };
    for (const k of Object.keys(EX)) pub.venues[k] = { realOrders: body.venues[k].realOrders };
    return new Response(JSON.stringify(pub), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  // ?deep=1 (never on production): a signed read-only call per exchange (balance and account settings), never an order.
  const deep = request && new URL(request.url).searchParams.get('deep') === '1';
  if (deep) await Promise.all(Object.entries(EX).map(async ([k, [, check]]) => { if (body.venues[k].realOrders) body.venues[k].check = await check(env); }));
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
