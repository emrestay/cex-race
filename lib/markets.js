// The race runs on crypto perps that DreamDEX lists on Somnia Tokyo mainnet and that every exchange lists too
// (checked live on 2026-11-23 against each exchange's public instrument list: Binance /fapi/v1/exchangeInfo,
// Bybit /v5/market/instruments-info?category=linear, OKX /api/v5/public/instruments?instType=SWAP,
// Bitget /api/v2/mix/market/contracts?productType=USDT-FUTURES).
// dd: DreamDEX perp pool on Somnia Tokyo mainnet (chain 50321), bd: its base token decimals.
// binance / bybit / bitget: USDT-margined perpetual symbol, okx: SWAP instrument id (null = not listed there).
export const MARKETS = {
  BTC: { dd: '0x143ebd385cc90bd178086a8f432c9084f889ef30', bd: 8, binance: 'BTCUSDT', bybit: 'BTCUSDT', okx: 'BTC-USDT-SWAP', bitget: 'BTCUSDT' },
  ETH: { dd: '0x440992f9910d635201209deb679f8f0c57a6a758', bd: 18, binance: 'ETHUSDT', bybit: 'ETHUSDT', okx: 'ETH-USDT-SWAP', bitget: 'ETHUSDT' },
  SOL: { dd: '0x8508a90867806d2118277372d704b97efde055b3', bd: 9, binance: 'SOLUSDT', bybit: 'SOLUSDT', okx: 'SOL-USDT-SWAP', bitget: 'SOLUSDT' },
  HYPE: { dd: '0x81151ad4cdf422fd660a04accb6693c0486e6ccf', bd: 6, binance: 'HYPEUSDT', bybit: 'HYPEUSDT', okx: 'HYPE-USDT-SWAP', bitget: 'HYPEUSDT' },
  XRP: { dd: '0x4ac6ac5824cf9de6dfa67d37b431c5d8016360a7', bd: 6, binance: 'XRPUSDT', bybit: 'XRPUSDT', okx: 'XRP-USDT-SWAP', bitget: 'XRPUSDT' },
  DOGE: { dd: '0x6441273abb267b06e88a62b06e3b2995aade65ee', bd: 8, binance: 'DOGEUSDT', bybit: 'DOGEUSDT', okx: 'DOGE-USDT-SWAP', bitget: 'DOGEUSDT' },
  BNB: { dd: '0x86818cc4e82013eab08c9dac6573ddf27a8cab6b', bd: 18, binance: 'BNBUSDT', bybit: 'BNBUSDT', okx: 'BNB-USDT-SWAP', bitget: 'BNBUSDT' },
  ZEC: { dd: '0xfc0f39f888d6d4f56848786cb494ca8c74213b94', bd: 8, binance: 'ZECUSDT', bybit: 'ZECUSDT', okx: 'ZEC-USDT-SWAP', bitget: 'ZECUSDT' },
};
// Every probe order is sized at the venue minimum. Binance BTC and ETH need about 50 and 20 USD of notional
// and Bybit BTC needs 0.001 BTC (about 62 USD), so the cap here is higher than on the DEX race. A computed
// size worth more than this is refused, so a units mistake can never send a large order.
export const MAX_NOTIONAL_USD = 100;
