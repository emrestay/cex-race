// Offline checks of the signing code and the order formatting. Nothing is sent anywhere.
// Binance publishes a full HMAC example (key, secret, query, signature); for Bybit, OKX and Bitget the docs
// publish the exact text to be signed, so the checks below confirm that our helpers build that text.
import { createHmac } from 'node:crypto';
import { hmacHex, hmacB64, toStep, probePrice, decOf, clientId } from '../lib/cex.js';
import { binanceQuery, binanceCred } from '../lib/binance.js';
import { bybitSign, bybitWsAuth, bybitCred } from '../lib/bybit.js';
import { okxSign, okxLogin, okxCred } from '../lib/okx.js';
import { bitgetSign, bitgetLogin, bitgetCred } from '../lib/bitget.js';

let fails = 0; const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fails++; };

// Binance: developers.binance.com/docs/derivatives/usds-margined-futures/general-info, "SIGNED Endpoint Examples
// for POST /fapi/v1/order - HMAC Keys", Example 1.
{
  const secret = '2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9';
  const q = binanceQuery(secret, { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '1', price: '9000', timeInForce: 'GTC', recvWindow: '5000', timestamp: '1591702613943' });
  ok('binance HMAC signature matches the documented example', q.endsWith('&signature=3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9'), q.slice(-40));
  ok('binance credential check', !!binanceCred({ BINANCE_API_KEY: 'k' }).credError && binanceCred({}).cred === null && !!binanceCred({ BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' }).cred);
}
// The base64 form used by OKX and Bitget is the same HMAC, encoded differently.
ok('hmac base64 equals hex digest re-encoded', hmacB64('k', 'm') === Buffer.from(hmacHex('k', 'm'), 'hex').toString('base64'));

// Bybit: bybit-exchange.github.io/docs/v5/guide, "An example for how to generate plain text to encrypt".
{
  const s = 'test-secret';
  ok('bybit GET pre-sign text', bybitSign(s, '1658384314791', 'XXXXXXXXXX', '5000', 'category=option&symbol=BTC-29JUL22-25000-C') === hmacHex(s, '1658384314791XXXXXXXXXX5000category=option&symbol=BTC-29JUL22-25000-C'));
  ok('bybit POST pre-sign text', bybitSign(s, '1658385579423', 'XXXXXXXXXX', '5000', '{"category": "option"}') === hmacHex(s, '1658385579423XXXXXXXXXX5000{"category": "option"}'));
  const a = bybitWsAuth({ key: 'api_key', secret: s }, 1662350400000);
  ok('bybit websocket auth frame', a.op === 'auth' && a.args[0] === 'api_key' && a.args[1] === 1662350400000 && a.args[2] === hmacHex(s, 'GET/realtime1662350400000') && /^[0-9a-f]{64}$/.test(a.args[2]));
  ok('bybit credential check', !!bybitCred({ BYBIT_API_SECRET: 's' }).credError && bybitCred({}).cred === null);
}
// OKX: www.okx.com/docs-v5/en/, "Signing Messages" and the WebSocket "Login" section (secret from the docs example).
{
  const s = '22582BD0CFF14C41EDBF1AB98506286D';
  ok('okx REST pre-sign text', okxSign(s, '2020-12-08T09:08:57.715Z', 'GET', '/api/v5/account/balance?ccy=BTC') === hmacB64(s, '2020-12-08T09:08:57.715ZGET/api/v5/account/balance?ccy=BTC'));
  ok('okx REST pre-sign text with body', okxSign(s, '2020-12-08T09:08:57.715Z', 'POST', '/api/v5/account/set-leverage', '{"instId":"BTC-USDT","lever":"5","mgnMode":"isolated"}') === hmacB64(s, '2020-12-08T09:08:57.715ZPOST/api/v5/account/set-leverage{"instId":"BTC-USDT","lever":"5","mgnMode":"isolated"}'));
  const l = okxLogin({ key: 'k', secret: s, pass: 'p' }, '1538054050').args[0];
  ok('okx login frame', l.apiKey === 'k' && l.passphrase === 'p' && l.timestamp === '1538054050' && l.sign === hmacB64(s, '1538054050GET/users/self/verify'));
  ok('okx credential check', !!okxCred({ OKX_API_KEY: 'k', OKX_API_SECRET: 's' }).credError && !!okxCred({ OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_PASSPHRASE: 'p' }).cred);
}
// Bitget: www.bitget.com/docs/classic/rest-api, "Generate Signature" (the documented content to be signed).
{
  const s = 'test-secret';
  ok('bitget GET pre-sign text', bitgetSign(s, '16273667805456', 'GET', '/api/mix/v2/market/depth', 'limit=20&symbol=BTCUSDT') === hmacB64(s, '16273667805456GET/api/mix/v2/market/depth?limit=20&symbol=BTCUSDT'));
  const body = '{"productType":"usdt-futures","symbol":"BTCUSDT","size":"8","marginMode":"crossed","side":"buy","orderType":"limit","clientOid":"channel#123456"}';
  ok('bitget POST pre-sign text', bitgetSign(s, '16273667805456', 'POST', '/api/v2/mix/order/place-order', '', body) === hmacB64(s, '16273667805456POST/api/v2/mix/order/place-order' + body));
  const l = bitgetLogin({ key: 'k', secret: s, pass: 'p' }, '1538054050').args[0];
  ok('bitget login frame', l.apiKey === 'k' && l.passphrase === 'p' && l.timestamp === '1538054050' && l.sign === hmacB64(s, '1538054050GET/user/verify'));
  ok('bitget credential check', !!bitgetCred({ BITGET_API_KEY: 'k' }).credError && bitgetCred({}).cred === null);
}

// Order formatting
ok('step decimals', decOf('0.0010') === 3 && decOf('1') === 0 && decOf('0.10') === 1 && decOf('1e-5') === 5);
ok('round to step', toStep(0.000844, '0.001', 'up') === '0.001' && toStep(1.23456, '0.01', 'down') === '1.23' && toStep(60250.07, '0.1', 'down') === '60250.0');
ok('probe price sits away from the market', probePrice(61473.7, true, 0.0198, '0.10') === '60256.5' && +probePrice(61473.7, false, 0.02, '0.10') > 61473.7 * 1.0199);
ok('client id form', /^pr[0-9a-z]{18,}$/.test(clientId('pr')) && clientId('pr').length <= 32);
// Binance BTC with the live filters of 2026-11-23 (minQty 0.001, step 0.001, MIN_NOTIONAL 50, band 3%):
{ const px = probePrice(61473.7, true, Math.min(0.02, 0.03 * 0.66), '0.10'), q = toStep(Math.max(0.001, 50 * 1.02 / +px), '0.001', 'up');
  ok('binance BTC probe size', q === '0.001' && +q * +px > 50 && +q * +px < 100, `${q} BTC at ${px} = ${(+q * +px).toFixed(2)} USD`); }

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed'); process.exit(fails ? 1 : 0);
