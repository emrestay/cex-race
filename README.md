# Perp Race: DreamDEX vs the CEXs

A latency derby, run as a horse race: DreamDEX, the onchain order book on Somnia Tokyo mainnet, against Binance, Bybit, OKX and Bitget. Pick a crypto perp, go long or short, and one real order leaves for every venue at the same instant. The first venue to confirm the order crosses the line.

Code: https://github.com/emrestay/cex-race

The code is open so that anyone can check what is measured and run it themselves.

## What a race does

1. One server function (on Vercel, region `hnd1`, Tokyo) opens a connection to every venue and warms it with two pings.
2. It fires all orders in the same instant. Signing happens inside the timed window.
3. The clock for a venue stops when that venue reports the order in its final state. An acknowledgement alone never counts.
4. Every order is priced away from the market so that it cannot trade: no position opens and no fee is paid.

| Venue | Order | Clock stops at | Proof |
|---|---|---|---|
| DreamDEX (Somnia Tokyo mainnet) | limit order via `eth_sendRawTransactionSync`, cancelled right after (untimed) | the transaction receipt | tx on the Somnia explorer |
| Binance USD-M futures | LIMIT IOC via REST `POST /fapi/v1/order` with `newOrderRespType=RESULT` | the REST reply, which carries the final status (`EXPIRED` for an unfilled IOC) | order id and Binance's reply |
| Bybit linear perpetuals | Limit IOC via REST `POST /v5/order/create` | the `order` update on the private stream that reports the order closed | order id and Bybit's order record |
| OKX USDT swaps | `ioc` order via REST `POST /api/v5/trade/order` | the `orders` channel update with state `canceled` (or `filled`) | order id and OKX's order record |
| Bitget USDT-M futures (classic account) | limit `ioc` via REST `POST /api/v2/mix/order/place-order` | the `orders` channel update with status `canceled` (or `filled`) | order id and Bitget's order record |

Exchange orders have no public record, so the results board shows each exchange's own reply for its order (a "reply" button). For Bybit, OKX and Bitget the REST acknowledgement time is kept as `ack`.

Each round also times one small request on the same open connection (the "network" time), so the network part and the venue part can be told apart.

Known differences, stated on the page as well:

- Markets: BTC, ETH, SOL, HYPE, XRP, DOGE, BNB, ZEC (`lib/markets.js`), listed on all five venues.
- The DreamDEX leg is a resting limit order (an IOC order with nothing to match reverts on chain); the exchanges get IOC orders. All are priced away from the market: 3% on DreamDEX, 2% on the exchanges, or less where an exchange's price band is tighter.
- Order sizes are each venue's minimum. Binance and Bybit BTC need about 60 USD of notional; a computed size above 100 USD is refused (`MAX_NOTIONAL_USD`). A venue without credentials on the server is left out of the race.
- The exchange accounts are small standard accounts on public API endpoints, with no fee tier upgrades and no colocation.
- The server leaves Vercel through fixed outbound IPs (Vercel Static IPs, region `hnd1`) for every venue, because Binance only accepts trading API keys tied to an IP allowlist.
- If the event loop stalls by more than 25 ms during a round, the round is run again (at most three attempts).
- The replay on the page is slowed down and gives the first milliseconds more screen time; each horse reaches the line exactly at its venue's confirmation time and the clock shows real milliseconds.

## Layout

```
api/race.js        GET /api/race?market=BTC&side=short  one race (rate limited, cached for 12 s)
api/health.js      GET /api/health                      which venues have credentials, never a secret
lib/race.js        connect, warm, fire, settle, rank
lib/<venue>.js     one adapter per venue (signing, order, final state, proof)
lib/cex.js         shared exchange helpers (HMAC, step rounding, probe price)
lib/markets.js     market mapping for every venue, plus the size guard
public/index.html  the page (vanilla JS, canvas)
dev-server.mjs     local server that runs the same handlers
scripts/           Keychain helper, offline self-test, Vercel env helper
```

## Run it

Node 22 or newer.

```bash
npm install
npm run selftest
npm run dev
```

`npm run dev` serves the page on http://localhost:5209. Credentials are read from environment variables, or on macOS from the Keychain (service `perp-race`):

```bash
node scripts/secrets.mjs list
node scripts/secrets.mjs set BINANCE_API_KEY
```

The names are in `.env.example`. Every exchange is optional; without a key an exchange only reports network time. On a local or preview deployment, add `?noreal` to the page URL to send only the DreamDEX order (production rejects it).

Never commit keys. Use API keys with trade permission only (no withdrawals, no transfers) and keep only a few dollars on each account. The code assumes one-way position mode where it cannot detect the mode (it detects it on Binance, Bybit and OKX).

## Deploy

```bash
vercel link
bash scripts/vercel-env.sh preview
vercel deploy
```

## License

MIT, see `LICENSE`.

The horse, track and fence art in `public/derby/` comes from [Chain Derby](https://github.com/SmoothBot/chain-derby) by SmoothBot (MIT); see `public/derby/CREDITS.txt`. Each venue logo in `public/logos/` belongs to that venue and is used only to identify it (taken from each venue's own site icon).
