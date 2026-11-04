/**
 * Universal CCXT Exchange Adapter
 *
 * Uses the ccxt library for unified exchange support:
 *   CoinDCX, Delta Exchange
 *
 * Usage:
 *   import { ExchangeAdapter, decryptBrokerKeys, fetchTickerPrice } from "../_shared/exchange-adapter.ts";
 *
 *   const adapter = ExchangeAdapter.create(exchangeName);
 *   const orderResp = await adapter.placeOrder({ apiKey, apiSecret, ... });
 */

// CCXT is loaded lazily so the module doesn't crash on import if the npm
// package is unavailable in the Deno runtime. The Golden Payload path never
// needs CCXT — it uses native HMAC-SHA256 signing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ccxtCache: any = null;
async function _loadCcxt(): Promise<any> {
  if (_ccxtCache) return _ccxtCache;
  const mod = await import("npm:ccxt@4.4.18");
  _ccxtCache = mod.default ?? mod;
  return _ccxtCache;
}
const pick = async (name: string): Promise<any> => {
  const c = await _loadCcxt();
  return c[name] || c.default?.[name] || c[name.charAt(0).toUpperCase() + name.slice(1)] || c.default?.[name.charAt(0).toUpperCase() + name.slice(1)];
};

// ═══════════════════════════════════════════════════════════════════════
//  CRYPTO HELPERS (vault decryption)
// ═══════════════════════════════════════════════════════════════════════

const _enc = new TextEncoder();
const _dec = new TextDecoder();

async function _deriveVaultKey(): Promise<CryptoKey> {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "fallback-vault-key";
  const baseKey = await crypto.subtle.importKey(
    "raw",
    _enc.encode(serviceKey),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: _enc.encode("cortex-vault-salt-v1"), iterations: 100_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function _fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function decryptValue(ciphertext: string, key: CryptoKey): Promise<string> {
  const combined = _fromBase64(ciphertext);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return _dec.decode(plainBuf);
}

export async function deriveVaultKey(): Promise<CryptoKey> {
  return _deriveVaultKey();
}

// ═══════════════════════════════════════════════════════════════════════
//  BROKER KEY DECRYPTION HELPER
// ═══════════════════════════════════════════════════════════════════════

export interface DecryptedBrokerKeys {
  exchangeName: string;
  apiKey: string;
  apiSecret: string;
}

export async function decryptBrokerKeys(
  adminClient: ReturnType<typeof import("npm:@supabase/supabase-js").createClient>,
  userId: string,
): Promise<DecryptedBrokerKeys | null> {
  const { data: brokerKeyRow, error: bkErr } = await adminClient
    .from("broker_keys")
    .select("id, exchange_name, api_key, api_secret, is_connected")
    .eq("user_id", userId)
    .eq("is_connected", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (bkErr || !brokerKeyRow) return null;

  const vaultKey = await _deriveVaultKey();
  const apiKey = await decryptValue(brokerKeyRow.api_key as string, vaultKey);
  const apiSecret = await decryptValue(brokerKeyRow.api_secret as string, vaultKey);

  return {
    exchangeName: brokerKeyRow.exchange_name as string,
    apiKey,
    apiSecret,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  TICKER PRICE FETCHER (exchange-agnostic via Binance public API)
// ═══════════════════════════════════════════════════════════════════════

export function normalizeCcxtSymbol(symbol: string): string {
  const compact = symbol.replace(/_F$/, "");
  if (compact.includes("/")) return compact;
  if (compact.endsWith("USDT")) return `${compact.slice(0, -4)}/USDT`;
  return compact;
}

export async function getActiveFuturesSymbols(): Promise<string[]> {
  try {
    const res = await fetch("https://public.coindcx.com/market_data/current_prices");
    if (res.ok) {
      const data = await res.json() as Record<string, string>;
      return Object.keys(data).filter((k) => k.startsWith("B-") && k.endsWith("_USDT"));
    }
  } catch {
    // fall through
  }
  return ["B-BTC_USDT", "B-ETH_USDT", "B-XRP_USDT", "B-SOL_USDT", "B-DOGE_USDT", "B-ADA_USDT"];
}

export async function fetchTickerPrice(symbol: string, isFutures: boolean): Promise<number> {
  const compact = symbol.replace(/_F$/, "").replace("/", "").replace(/^B-/, "");
  const base = compact.replace(/(USDT|INR)$/, "");
  // CoinDCX USDT-M futures pairs: B-XRP_USDT, B-ETH_USDT, B-BTC_USDT (INR-M is delisted)
  const futuresPair = `B-${base}_USDT`;
  const spotPair = `${base}USDT`;

  // 1. Try public prices API — returns { "B-XRP_USDT": "1.29", "XRPUSDT": "1.28", ... }
  try {
    const res = await fetch("https://public.coindcx.com/market_data/current_prices");
    if (res.ok) {
      const data = await res.json() as Record<string, string>;
      const lookupKey = isFutures ? futuresPair : spotPair;
      if (data[lookupKey]) {
        const price = parseFloat(data[lookupKey]);
        if (Number.isFinite(price) && price > 0) return price;
      }
      // Fallback: futures tracks spot price closely
      if (isFutures && data[spotPair]) {
        const price = parseFloat(data[spotPair]);
        if (Number.isFinite(price) && price > 0) return price;
      }
    }
  } catch {
    // Fall through to ticker API
  }

  // 2. Fallback: exchange/ticker API (array of { market, last_price })
  try {
    const res = await fetch("https://api.coindcx.com/exchange/ticker");
    if (res.ok) {
      const tickers = await res.json() as Array<{ market: string; last_price: string }>;
      const lookupKey = isFutures ? futuresPair : spotPair;
      const ticker = tickers.find((t) => t.market === lookupKey);
      if (ticker) {
        const price = Number(ticker.last_price);
        if (Number.isFinite(price) && price > 0) return price;
      }
      if (isFutures) {
        const spotTicker = tickers.find((t) => t.market === spotPair);
        if (spotTicker) {
          const price = Number(spotTicker.last_price);
          if (Number.isFinite(price) && price > 0) return price;
        }
      }
    }
  } catch {
    // Fall through to hardcoded fallback
  }

  // 3. Hard fallback prices (in USDT for USDT-M futures)
  const upper = symbol.toUpperCase();
  if (upper.includes("XRP")) return 1.29;
  if (upper.includes("ETH")) return 3000;
  if (upper.includes("BTC")) return 65000;

  throw new Error(`No ticker found for ${isFutures ? futuresPair : spotPair} (symbol=${symbol})`);
}

export async function fetchTickerPricesBatch(
  symbols: Array<{ symbol: string; isFutures: boolean }>,
): Promise<Map<string, number>> {
  const priceMap = new Map<string, number>();
  await Promise.all(symbols.map(async ({ symbol, isFutures }) => {
    try {
      priceMap.set(symbol, await fetchTickerPrice(symbol, isFutures));
    } catch {
      // A missing ticker must not stop other symbols from being monitored.
    }
  }));
  return priceMap;
}

// ═══════════════════════════════════════════════════════════════════════
//  EXCHANGE ADAPTER INTERFACE & TYPES
// ═══════════════════════════════════════════════════════════════════════

export interface OrderRequest {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  marketType: "spot" | "futures";
  quantity?: number;
  reduceOnly?: boolean;
  timestamp?: number;
  leverage?: number;
  settlementCurrency?: string;
}

export interface OrderResponse {
  success: boolean;
  orderId: string;
  entryPrice: number;
  executedQty: number;
  rawResponse: Record<string, unknown>;
  errorDetail?: string;
}

export interface CloseOrderRequest {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  side: "BUY" | "SELL";
  marketType: "spot" | "futures";
  reduceOnly?: boolean;
}

export type ExchangeAdapter = {
  placeOrder(req: OrderRequest): Promise<OrderResponse>;
  closeOrder(req: CloseOrderRequest): Promise<OrderResponse>;
};

// ═══════════════════════════════════════════════════════════════════════
//  EXCHANGE NAME NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════

const SUPPORTED_EXCHANGES = ["coindcx", "delta"] as const;
export type SupportedExchange = typeof SUPPORTED_EXCHANGES[number];

export function normalizeExchangeName(name: string): SupportedExchange {
  const normalized = name
    .toLowerCase()
    .trim()
    .replace("【entity-coindcx¦canonical_name=coindcx】", "coindcx")
    .replace(/\s+/g, "");

  if (normalized.includes("coindcx")) return "coindcx";
  if (normalized.includes("delta")) return "delta";
  throw new Error(`400 Bad Request: Exchange "${name}" not supported in Phase 1. Only CoinDCX and Delta Exchange are supported.`);
}

// ═══════════════════════════════════════════════════════════════════════
//  NATIVE COINDCX ORDER PLACEMENT (HMAC-SHA256 — no CCXT dependency)
// ═══════════════════════════════════════════════════════════════════════

const COINDCX_BASE_URL = "https://api.coindcx.com";

async function hmacSha256Hex(apiSecret: string, message: string): Promise<string> {
  const signingKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(signatureBytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Places a native order on CoinDCX Futures using HMAC-SHA256 signed POST.
 * CoinDCX futures endpoint: POST /exchange/v1/derivatives/futures/orders/create
 * Spot endpoint: POST /exchange/v1/orders/create
 *
 * Payload for futures:
 *   { timestamp, order: { side, pair, order_type, total_quantity, leverage, ... } }
 * Payload for spot:
 *   { side, order_type, market, total_quantity, timestamp }
 */
export async function placeCoinDcxOrder(params: {
  apiKey: string;
  apiSecret: string;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  marketType: "spot" | "futures";
  quantity: number;
  leverage?: number;
  reduceOnly?: boolean;
  price?: number;
  settlementCurrency?: string;
}): Promise<OrderResponse> {
  const {
    apiKey,
    apiSecret,
    symbol,
    side,
    orderType,
    marketType,
    quantity,
    leverage,
    price,
    settlementCurrency,
  } = params;

  const timestamp = Math.floor(Date.now());
  const ccxtSymbol = normalizeCcxtSymbol(symbol);
  const [base, quote] = ccxtSymbol.split("/");
  const isFutures = marketType === "futures";

  let body: Record<string, unknown>;
  let path: string;

  if (isFutures) {
    // CoinDCX USDT-M/INR-M futures: pair is B-{BASE}_USDT, settlement can be INR or USDT
    const pair = `B-${base}_${quote}`;
    const orderTypeStr = orderType === "MARKET" ? "market_order" : "limit_order";
    const order: Record<string, unknown> = {
      side: side.toLowerCase(),
      pair,
      order_type: orderTypeStr,
      total_quantity: quantity,
      leverage: leverage ?? 1,
      notification: "no_notification",
    };
    // INR-M settlement: collateral in INR while pair is USDT-denominated
    if (settlementCurrency) {
      order.settlement_currency = settlementCurrency.toLowerCase();
    }
    if (orderType === "LIMIT" && price) {
      order.price = String(price);
    }
    if (params.reduceOnly) {
      order.reduce_only = true;
    }
    body = { timestamp, order };
    path = "/exchange/v1/derivatives/futures/orders/create";
  } else {
    const market = `${base}${quote}`;
    const orderTypeStr = orderType === "MARKET" ? "market_order" : "limit_order";
    body = {
      side: side.toLowerCase(),
      order_type: orderTypeStr,
      market,
      total_quantity: quantity,
      timestamp,
    };
    if (orderType === "LIMIT" && price) {
      body.price_per_unit = String(price);
    }
    path = "/exchange/v1/orders/create";
  }

  const jsonBody = JSON.stringify(body);
  const signature = await hmacSha256Hex(apiSecret, jsonBody);

  try {
    const response = await fetch(`${COINDCX_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AUTH-APIKEY": apiKey,
        "X-AUTH-SIGNATURE": signature,
      },
      body: jsonBody,
    });

    const rawText = await response.text();
    let rawResponse: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawText);
      if (Array.isArray(parsed) && parsed.length > 0) {
        rawResponse = parsed[0] as Record<string, unknown>;
      } else if (Array.isArray(parsed) && parsed.length === 0) {
        rawResponse = { orders: [] };
      } else {
        rawResponse = parsed as Record<string, unknown>;
      }
    } catch {
      rawResponse = { raw: rawText.slice(0, 1000) };
    }

    if (!response.ok) {
      return {
        success: false,
        orderId: "",
        entryPrice: 0,
        executedQty: 0,
        rawResponse,
        errorDetail: `CoinDCX HTTP ${response.status}: ${rawText.slice(0, 500)}`,
      };
    }

    const orderId = String(rawResponse.id ?? "N/A");
    const entryPrice = Number(rawResponse.price ?? rawResponse.avg_price ?? 0);
    const executedQty = Number(
      rawResponse.total_quantity ?? rawResponse.filled_quantity ?? quantity,
    );

    return {
      success: true,
      orderId,
      entryPrice,
      executedQty,
      rawResponse,
    };
  } catch (err) {
    return {
      success: false,
      orderId: "",
      entryPrice: 0,
      executedQty: 0,
      rawResponse: {},
      errorDetail: `CoinDCX fetch error: ${(err as Error).message}`,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  COINDCX FUTURES LEVERAGE SETUP (must be called before placing orders)
//  CoinDCX ignores leverage in the order payload — it must be set separately.
//  POST /exchange/v1/derivatives/futures/leverage
//  Body: { timestamp, leverage, margin_type, pair }
// ═══════════════════════════════════════════════════════════════════════

export async function setCoinDcxLeverage(params: {
  apiKey: string;
  apiSecret: string;
  pair: string; // e.g. "B-ETH_USDT"
  leverage: number;
  marginType: "isolated" | "cross";
}): Promise<{ success: boolean; status: number; raw: string }> {
  const { apiKey, apiSecret, pair, leverage, marginType } = params;
  const body = JSON.stringify({
    timestamp: Math.floor(Date.now()),
    leverage,
    margin_type: marginType,
    pair,
  });
  const signature = await hmacSha256Hex(apiSecret, body);
  // Try the correct update_leverage endpoint first, then fallback to the old one.
  // The old /leverage endpoint returns 404 on some CoinDCX accounts.
  const endpoints = [
    "/exchange/v1/derivatives/futures/positions/update_leverage",
    "/exchange/v1/derivatives/futures/leverage",
  ];
  for (const ep of endpoints) {
    try {
      const response = await fetch(`${COINDCX_BASE_URL}${ep}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AUTH-APIKEY": apiKey,
          "X-AUTH-SIGNATURE": signature,
        },
        body,
      });
      const rawText = await response.text();
      if (response.ok) {
        return { success: true, status: response.status, raw: rawText.slice(0, 500) };
      }
      // If 404, try next endpoint; for other errors, return immediately
      if (response.status !== 404) {
        return { success: false, status: response.status, raw: rawText.slice(0, 500) };
      }
    } catch (err) {
      // Network error — try next endpoint
      if (ep === endpoints[endpoints.length - 1]) {
        return { success: false, status: 0, raw: (err as Error).message };
      }
    }
  }
  return { success: false, status: 404, raw: "All leverage endpoints returned 404" };
}

// ═══════════════════════════════════════════════════════════════════════
//  COINDCX INR-M FUTURES ORDER (single Golden Payload)
//  CoinDCX INR-M uses B-ETH_USDT pair but settles margin in INR.
// ═══════════════════════════════════════════════════════════════════════

export interface InrMOrderResult {
  success: boolean;
  orderId: string;
  entryPrice: number;
  executedQty: number;
  rawResponse: Record<string, unknown>;
  errorDetail?: string;
}

export async function placeCoinDcxInrMFuturesOrder(params: {
  apiKey: string;
  apiSecret: string;
  base: string; // e.g. "ETH"
  side: "BUY" | "SELL";
  leverage: number;
  ethQuantity: number; // size in ETH (e.g. 0.011)
  inrAmount: number; // size in INR (e.g. 2674.74)
  reduceOnly?: boolean;
}): Promise<InrMOrderResult> {
  const { apiKey, apiSecret, base, side, leverage, ethQuantity, inrAmount, reduceOnly } = params;
  void inrAmount; // INR amount is informational; CoinDCX sizes orders by total_quantity (ETH)
  const timestamp = Math.floor(Date.now());
  const pair = `B-${base}_USDT`;

  // THE GOLDEN PAYLOAD — single strict API call, no variants
  const order: Record<string, unknown> = {
    side: side.toLowerCase(),
    pair,
    order_type: "market_order",
    total_quantity: ethQuantity,
    leverage,
    margin_type: "isolated",
    margin_currency_short_name: "INR",
  };
  // CoinDCX rejects reduce_only on market orders with HTTP 400:
  // "Reduce Only Order is only applicable for Limit Order"
  // To close a position, simply place a reverse market order without reduce_only.
  void reduceOnly;

  const body = { timestamp, order };
  const jsonBody = JSON.stringify(body);
  const signature = await hmacSha256Hex(apiSecret, jsonBody);
  const endpoint = "/exchange/v1/derivatives/futures/orders/create";

  try {
    const response = await fetch(`${COINDCX_BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AUTH-APIKEY": apiKey,
        "X-AUTH-SIGNATURE": signature,
      },
      body: jsonBody,
    });
    const rawText = await response.text();

    if (response.ok) {
      let rawResponse: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(rawText);
        rawResponse = Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : parsed;
      } catch {
        rawResponse = { raw: rawText.slice(0, 1000) };
      }
      return {
        success: true,
        orderId: String(rawResponse.id ?? "N/A"),
        entryPrice: Number(rawResponse.price ?? rawResponse.avg_price ?? 0),
        executedQty: Number(rawResponse.total_quantity ?? rawResponse.filled_quantity ?? ethQuantity),
        rawResponse,
      };
    }

    return {
      success: false,
      orderId: "",
      entryPrice: 0,
      executedQty: 0,
      rawResponse: { status: response.status, body: rawText.slice(0, 1000) },
      errorDetail: `CoinDCX rejected order (HTTP ${response.status}): ${rawText.slice(0, 500)}`,
    };
  } catch (err) {
    return {
      success: false,
      orderId: "",
      entryPrice: 0,
      executedQty: 0,
      rawResponse: {},
      errorDetail: `Network error: ${(err as Error).message}`,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  SINGLE SOURCE OF TRUTH: GOLDEN TRADE EXECUTION ENGINE
//  CEO DIRECTIVE: SINGLE SOURCE OF TRUTH ENGINE. DO NOT ALTER MATH, 102
//  RATE, OR CLAMP LOGIC. APPLIES TO ALL BOTS AND ALL COINS.
// ═══════════════════════════════════════════════════════════════════════

const USD_INR_RATE = 102;
const MIN_MARGIN_INR = 100;
const MIN_LOT_QTY = 0.001;

export interface GoldenTradeInput {
  apiKey: string;
  apiSecret: string;
  baseCoin: string;
  side: "BUY" | "SELL";
  leverage: number;
  marginInr: number;
}

export interface GoldenTradeResult {
  success: boolean;
  orderId: string;
  entryPrice: number;
  executedQty: number;
  quantity: number;
  livePriceUsdt: number;
  livePriceInr: number;
  orderAmountInr: number;
  futuresPair: string;
  goldenPayload: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
  errorDetail?: string;
}

export async function fetchLivePriceUsdt(baseCoin: string): Promise<number> {
  const futuresPair = `B-${baseCoin}_USDT`;
  const spotPair = `${baseCoin}USDT`;
  const inrPair = `${baseCoin}INR`;

  // 1. exchange/ticker API
  try {
    const res = await fetch("https://api.coindcx.com/exchange/ticker");
    if (res.ok) {
      const tickers = await res.json() as Array<{ market: string; last_price: string }>;
      if (Array.isArray(tickers)) {
        let ticker = tickers.find((t) => t.market === futuresPair);
        if (!ticker) ticker = tickers.find((t) => t.market === spotPair);
        if (ticker) {
          const price = parseFloat(ticker.last_price);
          if (Number.isFinite(price) && price > 0) return price;
        }
        const inrTicker = tickers.find((t) => t.market === inrPair);
        if (inrTicker) {
          const price = parseFloat(inrTicker.last_price) / USD_INR_RATE;
          if (Number.isFinite(price) && price > 0) return price;
        }
      }
    }
  } catch { /* fall through */ }

  // 2. public prices API
  try {
    const res = await fetch("https://public.coindcx.com/market_data/current_prices");
    if (res.ok) {
      const data = await res.json() as Record<string, string>;
      const spotPrice = data[futuresPair] ?? data[spotPair];
      if (spotPrice) {
        const price = parseFloat(spotPrice);
        if (Number.isFinite(price) && price > 0) return price;
      }
      const inrPrice = data[inrPair];
      if (inrPrice) {
        const price = parseFloat(inrPrice) / USD_INR_RATE;
        if (Number.isFinite(price) && price > 0) return price;
      }
    }
  } catch { /* fall through */ }

  return 0;
}

export async function calculateOrderQuantity(
  marginInr: number,
  leverage: number,
  livePriceUsdt: number,
): number {
  const orderAmountInr = (marginInr > 0 ? marginInr : MIN_MARGIN_INR) * leverage;
  const livePriceInr = livePriceUsdt * USD_INR_RATE;
  const qtyRaw = orderAmountInr / livePriceInr;
  let qty = Number(qtyRaw.toFixed(3));
  if (qty < MIN_LOT_QTY) qty = MIN_LOT_QTY;
  return qty;
}

export async function executeGoldenTrade(input: GoldenTradeInput): Promise<GoldenTradeResult> {
  const { apiKey, apiSecret, baseCoin, side, leverage, marginInr } = input;
  const futuresPair = `B-${baseCoin}_USDT`;
  const effectiveMargin = marginInr > 0 ? marginInr : MIN_MARGIN_INR;
  const effectiveLeverage = leverage > 0 ? leverage : 10;

  const livePriceUsdt = await fetchLivePriceUsdt(baseCoin);
  if (livePriceUsdt <= 0) {
    return {
      success: false,
      orderId: "",
      entryPrice: 0,
      executedQty: 0,
      quantity: 0,
      livePriceUsdt: 0,
      livePriceInr: 0,
      orderAmountInr: 0,
      futuresPair,
      goldenPayload: {},
      rawResponse: {},
      errorDetail: `Failed to fetch live price for ${baseCoin}. Cannot calculate order quantity.`,
    };
  }

  const livePriceInr = livePriceUsdt * USD_INR_RATE;
  const orderAmountInr = effectiveMargin * effectiveLeverage;
  const qtyRaw = orderAmountInr / livePriceInr;
  let quantity = Number(qtyRaw.toFixed(3));
  if (quantity < MIN_LOT_QTY) quantity = MIN_LOT_QTY;

  const goldenPayload = {
    timestamp: Math.floor(Date.now()),
    order: {
      side: side.toLowerCase(),
      pair: futuresPair,
      order_type: "market_order",
      total_quantity: quantity,
      leverage: effectiveLeverage,
      margin_type: "isolated",
      margin_currency_short_name: "INR",
    },
  };

  // Pre-flight: set leverage
  await setCoinDcxLeverage({
    apiKey,
    apiSecret,
    pair: futuresPair,
    leverage: effectiveLeverage,
    marginType: "isolated",
  });

  // Place INR-M order with the Golden Payload
  const orderResult = await placeCoinDcxInrMFuturesOrder({
    apiKey,
    apiSecret,
    base: baseCoin,
    side,
    leverage: effectiveLeverage,
    ethQuantity: quantity,
    inrAmount: orderAmountInr,
  });

  return {
    success: orderResult.success,
    orderId: orderResult.orderId,
    entryPrice: orderResult.entryPrice,
    executedQty: orderResult.executedQty,
    quantity,
    livePriceUsdt,
    livePriceInr,
    orderAmountInr,
    futuresPair,
    goldenPayload,
    rawResponse: orderResult.rawResponse,
    errorDetail: orderResult.errorDetail,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  CCXT EXCHANGE FACTORY
// ═══════════════════════════════════════════════════════════════════════

export async function createCcxtInstance(
  exchangeId: string,
  apiKey: string,
  apiSecret: string,
  marketType: "spot" | "futures" = "spot",
) {
  const id = normalizeExchangeName(exchangeId);
  const constructorName = id === "coindcx" ? "coindcx" : id;
  const Ctor = await pick(constructorName);
  if (typeof Ctor !== "function") {
    throw new Error(`CCXT class ${id} not found`);
  }

  const options: Record<string, unknown> = {
    apiKey,
    secret: apiSecret,
    enableRateLimit: true,
    timeout: 15000,
    defaultType: marketType === "futures" ? (id === "bybit" ? "linear" : "future") : "spot",
  };

  return new Ctor(options);
}

// ═══════════════════════════════════════════════════════════════════════
//  UNIVERSAL CCXT ADAPTER
// ═══════════════════════════════════════════════════════════════════════

export const ExchangeAdapter = {
  create(exchangeName: string): ExchangeAdapter {
    const normalized = normalizeExchangeName(exchangeName);

    async function _executeOrder(
      apiKey: string,
      apiSecret: string,
      symbol: string,
      side: "BUY" | "SELL",
      orderType: "MARKET" | "LIMIT",
      marketType: "spot" | "futures",
      quantity?: number,
      reduceOnly?: boolean,
      leverage?: number,
      settlementCurrency?: string,
    ): Promise<OrderResponse> {
      // CoinDCX: use native HMAC-SHA256 implementation (no CCXT dependency)
      if (normalized === "coindcx") {
        if (quantity === undefined || quantity <= 0) {
          return {
            success: false,
            orderId: "",
            entryPrice: 0,
            executedQty: 0,
            rawResponse: {},
            errorDetail: "Quantity is required for CoinDCX orders",
          };
        }
        return placeCoinDcxOrder({
          apiKey,
          apiSecret,
          symbol,
          side,
          orderType,
          marketType,
          quantity,
          leverage: leverage ?? 1,
          reduceOnly,
          settlementCurrency,
        });
      }

      // Delta Exchange: use CCXT fallback
      try {
        const exchange = await createCcxtInstance(normalized, apiKey, apiSecret, marketType);

        const ccxtType = orderType.toLowerCase() as "market" | "limit";
        const ccxtSide = side.toLowerCase() as "buy" | "sell";

        const params: Record<string, unknown> = {};
        if (reduceOnly && marketType === "futures") {
          params.reduceOnly = true;
        }

        const orderParams: {
          symbol: string;
          type: "market" | "limit";
          side: "buy" | "sell";
          amount?: number;
          price?: number;
          params: Record<string, unknown>;
        } = {
          symbol,
          type: ccxtType,
          side: ccxtSide,
          params,
        };

        if (quantity !== undefined && quantity > 0) {
          orderParams.amount = quantity;
        }

        if (ccxtType === "limit") {
          // For limit orders, price must be set by caller via the ticker
          // Using market orders for simplicity in execution engine
          orderParams.type = "market";
        }

        const result = await exchange.createOrder(
          orderParams.symbol,
          orderParams.type,
          orderParams.side,
          orderParams.amount ?? undefined,
          orderParams.price,
          orderParams.params,
        );

        const rawResponse = result as unknown as Record<string, unknown>;
        const orderId = String(result.id ?? "N/A");
        const entryPrice = result.average ?? result.price ?? 0;
        const executedQty = result.filled ?? result.amount ?? 0;

        return {
          success: true,
          orderId,
          entryPrice: typeof entryPrice === "number" ? entryPrice : parseFloat(String(entryPrice)),
          executedQty: typeof executedQty === "number" ? executedQty : parseFloat(String(executedQty)),
          rawResponse,
        };
      } catch (err) {
        return {
          success: false,
          orderId: "",
          entryPrice: 0,
          executedQty: 0,
          rawResponse: {},
          errorDetail: `${normalized} error: ${(err as Error).message}`,
        };
      }
    }

    return {
      async placeOrder(req: OrderRequest): Promise<OrderResponse> {
        return _executeOrder(
          req.apiKey,
          req.apiSecret,
          req.symbol,
          req.side,
          req.orderType,
          req.marketType,
          req.quantity,
          req.reduceOnly,
          (req as OrderRequest & { leverage?: number }).leverage,
          (req as OrderRequest & { settlementCurrency?: string }).settlementCurrency,
        );
      },

      async closeOrder(req: CloseOrderRequest): Promise<OrderResponse> {
        // Close order is a market order with reduceOnly for futures
        return _executeOrder(
          req.apiKey,
          req.apiSecret,
          req.symbol,
          req.side,
          "MARKET",
          req.marketType,
          undefined,
          req.reduceOnly ?? true,
        );
      },
    };
  },
};
