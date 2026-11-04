/*
 * Strategy-Runner Edge Function — The Core Trading Brain (v2 — exchange adapter)
 *
 * This is the autonomous evaluation engine that runs continuously via pg_cron
 * (every 1 minute). For each active bot it:
 *
 *   1. Fetches all bots with status = 'running' (live or paper)
 *   2. Checks for existing open positions (skip if one is already active)
 *   3. Fetches live OHLCV kline data from Binance for the bot's trading pair
 *   4. Computes technical indicators (RSI, EMA, MACD) on the candle data
 *   5. Evaluates entry conditions based on the bot's configured indicator
 *   6. Runs the RiskCalculator validation layer (license, daily limits, balance)
 *   7. Applies Martingale position sizing if the bot uses that strategy
 *   8. Triggers trade execution via the internal execute-trade edge function
 *
 * The engine/src modules (RiskCalculator, TrailingStopEngine, martingale) are
 * inlined as Deno-compatible modules since edge functions cannot import from
 * the project's engine/src directory at runtime.
 *
 * Called by: pg_cron job 'strategy_runner_cron' (every 1 minute)
 * Manual trigger: POST with service role key Authorization header
 *
 * POST body: { } (no parameters — operates on all active bots)
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  ExchangeAdapter,
  decryptBrokerKeys,
  executeGoldenTrade,
  fetchTickerPrice,
  fetchTickerPricesBatch as sharedFetchTickerPricesBatch,
  type OrderResponse,
} from "../_shared/exchange-adapter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ═══════════════════════════════════════════════════════════════════════
//  DECIMAL MATH (from engine/src/RiskCalculator.ts)
//  String-based BigInt arithmetic — no floating point errors
// ═══════════════════════════════════════════════════════════════════════

function normalizeDecimal(str: string): string {
  if (!str || str === "0" || str === "0.0" || str === "0.00") return "0";
  const negative = str.startsWith("-");
  let s = negative ? str.slice(1) : str;
  if (!s.includes(".")) s = s + ".0";
  s = s.replace(/0+$/, "");
  s = s.replace(/\.$/, "");
  if (s === "" || s === "0") return "0";
  return (negative ? "-" : "") + s;
}

function getDecimalPlaces(str: string): number {
  const parts = str.split(".");
  return parts.length > 1 ? parts[1].length : 0;
}

function shiftRight(str: string, places: number): string {
  if (str === "0") return "0";
  const negative = str.startsWith("-");
  let s = negative ? str.slice(1) : str;
  const dotIndex = s.indexOf(".");
  if (dotIndex === -1) {
    s = s + "0".repeat(places);
  } else {
    const intPart = s.slice(0, dotIndex);
    const decPart = s.slice(dotIndex + 1);
    if (decPart.length >= places) {
      s = intPart + decPart.slice(0, places) + "." + decPart.slice(places);
    } else {
      s = intPart + decPart + "0".repeat(places - decPart.length);
    }
  }
  return (negative ? "-" : "") + normalizeDecimal(s);
}

function shiftLeft(str: string, places: number): string {
  if (str === "0") return "0";
  const negative = str.startsWith("-");
  let s = negative ? str.slice(1) : str;
  s = s.replace(".", "");
  while (s.length <= places) s = "0" + s;
  const insertPos = s.length - places;
  s = s.slice(0, insertPos) + "." + s.slice(insertPos);
  return (negative ? "-" : "") + normalizeDecimal(s);
}

function addDecimals(a: string, b: string): string {
  const maxPlaces = Math.max(getDecimalPlaces(a), getDecimalPlaces(b));
  const ai = shiftRight(a, maxPlaces);
  const bi = shiftRight(b, maxPlaces);
  const result = BigInt(ai) + BigInt(bi);
  return normalizeDecimal(shiftLeft(result.toString(), maxPlaces));
}

function subtractDecimals(a: string, b: string): string {
  const maxPlaces = Math.max(getDecimalPlaces(a), getDecimalPlaces(b));
  const ai = shiftRight(a, maxPlaces);
  const bi = shiftRight(b, maxPlaces);
  const result = BigInt(ai) - BigInt(bi);
  return normalizeDecimal(shiftLeft(result.toString(), maxPlaces));
}

function multiplyDecimals(a: string, b: string): string {
  const aPlaces = getDecimalPlaces(a);
  const bPlaces = getDecimalPlaces(b);
  const totalPlaces = aPlaces + bPlaces;
  const ai = a.replace(".", "").replace("-", "");
  const bi = b.replace(".", "").replace("-", "");
  const negative = (a.startsWith("-") || b.startsWith("-")) && !(a.startsWith("-") && b.startsWith("-"));
  const result = BigInt(ai) * BigInt(bi);
  const raw = shiftLeft(result.toString(), totalPlaces);
  return negative ? normalizeDecimal("-" + raw) : normalizeDecimal(raw);
}

function divideDecimals(a: string, b: string, precision: number = 18): string {
  if (b === "0") throw new Error("Division by zero");
  const aPlaces = getDecimalPlaces(a);
  const bPlaces = getDecimalPlaces(b);
  const shift = bPlaces - aPlaces + precision;
  const ai = a.replace(".", "").replace("-", "");
  const bi = b.replace(".", "").replace("-", "");
  const negative = (a.startsWith("-") || b.startsWith("-")) && !(a.startsWith("-") && b.startsWith("-"));
  let dividend = BigInt(ai);
  if (shift > 0) dividend = dividend * BigInt(10 ** shift);
  else if (shift < 0) {
    const divisor = BigInt(10 ** Math.abs(shift));
    dividend = dividend / divisor;
  }
  const result = dividend / BigInt(bi);
  const raw = shiftLeft(result.toString(), precision);
  return negative ? normalizeDecimal("-" + raw) : normalizeDecimal(raw);
}

function compareDecimals(a: string, b: string): number {
  const maxPlaces = Math.max(getDecimalPlaces(a), getDecimalPlaces(b));
  const ai = BigInt(shiftRight(a, maxPlaces));
  const bi = BigInt(shiftRight(b, maxPlaces));
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
}

function absDecimal(a: string): string {
  return a.startsWith("-") ? a.slice(1) : a;
}

// ═══════════════════════════════════════════════════════════════════════
//  RISK CALCULATOR (from engine/src/RiskCalculator.ts)
// ═══════════════════════════════════════════════════════════════════════

interface RiskConfig {
  maxTradesPerDay: number;
  maxDailyLossThreshold: string;
  maxDrawdownPct: string;
  tpPct: string;
  slPct: string;
  maxLeverage: number;
  tradeSizing: "fixed_quote" | "percent_balance" | "risk_based";
  sizingValue: string;
  riskPerTradePct: string;
  maxNotional: string;
  trailingEnabled: boolean;
  trailingDistancePct: string;
}

interface ValidationContext {
  licenseValid: boolean;
  licenseExpiry: string | null;
  botStatus: "active" | "paused";
  isPaperMode: boolean;
  dailyTradeCount: number;
  dailyLoss: string;
  availableBalance: string;
  currentDrawdownPct: string;
}

type ValidationRejection =
  | "LICENSE_INVALID"
  | "LICENSE_EXPIRED"
  | "BOT_PAUSED"
  | "DAILY_TRADE_LIMIT_REACHED"
  | "DAILY_LOSS_BREACHED"
  | "INSUFFICIENT_BALANCE"
  | "MAX_DRAWDOWN_BREACHED"
  | "MAX_NOTIONAL_EXCEEDED";

interface ValidationResult {
  approved: boolean;
  rejections: ValidationRejection[];
  computedSize: string | null;
}

function calculatePositionSize(
  config: RiskConfig,
  balance: string,
  entryPrice: string,
): string {
  switch (config.tradeSizing) {
    case "fixed_quote":
      return config.sizingValue;
    case "percent_balance": {
      const pct = divideDecimals(config.sizingValue, "100", 18);
      return multiplyDecimals(balance, pct);
    }
    case "risk_based": {
      const riskPct = divideDecimals(config.riskPerTradePct, "100", 18);
      const riskAmount = multiplyDecimals(balance, riskPct);
      const slPct = divideDecimals(config.slPct, "100", 18);
      if (slPct === "0") return "0";
      const slDistance = multiplyDecimals(entryPrice, slPct);
      if (slDistance === "0") return "0";
      const rawSize = divideDecimals(riskAmount, slDistance, 18);
      if (compareDecimals(rawSize, "0") <= 0) return "0";
      return rawSize;
    }
    default:
      return "0";
  }
}

function clampNotional(positionSize: string, maxNotional: string): string {
  if (compareDecimals(positionSize, maxNotional) > 0) return maxNotional;
  return positionSize;
}

function validateOrder(
  config: RiskConfig,
  ctx: ValidationContext,
  entryPrice: string,
): ValidationResult {
  const rejections: ValidationRejection[] = [];

  if (!ctx.licenseValid) rejections.push("LICENSE_INVALID");

  if (ctx.licenseExpiry) {
    const now = new Date();
    const expiry = new Date(ctx.licenseExpiry);
    if (expiry < now) rejections.push("LICENSE_EXPIRED");
  }

  if (ctx.botStatus !== "active") rejections.push("BOT_PAUSED");

  const dailyLossBreached =
    compareDecimals(absDecimal(ctx.dailyLoss), config.maxDailyLossThreshold) >= 0 &&
    ctx.dailyLoss.startsWith("-");

  if (dailyLossBreached) rejections.push("DAILY_LOSS_BREACHED");

  if (ctx.dailyTradeCount >= config.maxTradesPerDay) {
    rejections.push("DAILY_TRADE_LIMIT_REACHED");
  }

  if (compareDecimals(ctx.currentDrawdownPct, config.maxDrawdownPct) >= 0) {
    rejections.push("MAX_DRAWDOWN_BREACHED");
  }

  const computedSize = calculatePositionSize(config, ctx.availableBalance, entryPrice);
  const clampedSize = clampNotional(computedSize, config.maxNotional);

  if (compareDecimals(clampedSize, "0") <= 0) {
    rejections.push("INSUFFICIENT_BALANCE");
  }

  if (compareDecimals(clampedSize, ctx.availableBalance) > 0) {
    rejections.push("INSUFFICIENT_BALANCE");
  }

  const hardBlocks: ValidationRejection[] = ["LICENSE_INVALID", "LICENSE_EXPIRED", "BOT_PAUSED"];
  const hasHardBlock = rejections.some((r) => hardBlocks.includes(r));
  const approved = rejections.length === 0 && !hasHardBlock;

  return {
    approved,
    rejections,
    computedSize: approved ? clampedSize : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  MARTINGALE STRATEGY (from engine/src/trading/strategies/martingale.ts)
// ═══════════════════════════════════════════════════════════════════════

interface MartingaleConfig {
  martingale_multiplier: number;
  max_martingale_steps: number;
  base_position_size: number;
  max_drawdown_pct: number;
}

interface MartingaleState {
  current_step: number;
  current_position_size: number;
  total_pnl: number;
  starting_capital: number;
  halted: boolean;
  halt_reason: string | null;
}

function createMartingaleState(config: MartingaleConfig): MartingaleState {
  return {
    current_step: 0,
    current_position_size: config.base_position_size,
    total_pnl: 0,
    starting_capital: config.base_position_size,
    halted: false,
    halt_reason: null,
  };
}

function processMartingaleResult(
  state: MartingaleState,
  pnl: number,
  config: MartingaleConfig,
): { next_position_size: number; new_state: MartingaleState } {
  if (state.halted) {
    return { next_position_size: 0, new_state: state };
  }

  const was_loss = pnl < 0;
  let newStep = state.current_step;
  let nextSize = state.current_position_size;
  const totalPnl = state.total_pnl + pnl;
  let halted = false;
  let haltReason: string | null = null;

  if (was_loss) {
    newStep = state.current_step + 1;
    if (newStep >= config.max_martingale_steps) {
      halted = true;
      haltReason = `Max martingale steps (${config.max_martingale_steps}) reached.`;
      nextSize = 0;
    } else {
      nextSize = state.current_position_size * config.martingale_multiplier;
    }
  } else {
    newStep = 0;
    nextSize = config.base_position_size;
  }

  const drawdownPct = (totalPnl / state.starting_capital) * 100;
  if (drawdownPct <= -config.max_drawdown_pct) {
    halted = true;
    haltReason = `Max drawdown (${config.max_drawdown_pct}%) breached.`;
    nextSize = 0;
  }

  return {
    next_position_size: nextSize,
    new_state: {
      current_step: newStep,
      current_position_size: nextSize,
      total_pnl: totalPnl,
      starting_capital: state.starting_capital,
      halted,
      halt_reason: haltReason,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  TECHNICAL INDICATORS
//  Computed from live Binance OHLCV kline data
// ═══════════════════════════════════════════════════════════════════════

interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

/** Relative Strength Index — standard 14-period */
function computeRSI(candles: Candle[], period: number = 14): number | null {
  if (candles.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smooth the remaining candles (Wilder's smoothing)
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + (-diff)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Exponential Moving Average */
function computeEMA(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

/** MACD: returns { macd, signal, histogram } */
function computeMACD(
  candles: Candle[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): { macd: number; signal: number; histogram: number } | null {
  const closes = candles.map((c) => c.close);
  if (closes.length < slowPeriod + signalPeriod) return null;

  // Compute fast and slow EMA series
  const kFast = 2 / (fastPeriod + 1);
  const kSlow = 2 / (slowPeriod + 1);

  const fastEMA: number[] = [];
  const slowEMA: number[] = [];

  // Seed with SMA
  let fastSeed = closes.slice(0, fastPeriod).reduce((a, b) => a + b, 0) / fastPeriod;
  let slowSeed = closes.slice(0, slowPeriod).reduce((a, b) => a + b, 0) / slowPeriod;
  fastEMA.push(fastSeed);
  slowEMA.push(slowSeed);

  for (let i = fastPeriod; i < closes.length; i++) {
    fastSeed = closes[i] * kFast + fastSeed * (1 - kFast);
    fastEMA.push(fastSeed);
  }
  for (let i = slowPeriod; i < closes.length; i++) {
    slowSeed = closes[i] * kSlow + slowSeed * (1 - kSlow);
    slowEMA.push(slowSeed);
  }

  // MACD line = fast EMA - slow EMA (aligned at same index)
  const macdLine: number[] = [];
  const offset = slowPeriod - fastPeriod;
  for (let i = 0; i < slowEMA.length; i++) {
    macdLine.push(fastEMA[i + offset] - slowEMA[i]);
  }

  // Signal line = EMA of MACD line
  const kSignal = 2 / (signalPeriod + 1);
  let signalSeed = macdLine.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
  for (let i = signalPeriod; i < macdLine.length; i++) {
    signalSeed = macdLine[i] * kSignal + signalSeed * (1 - kSignal);
  }

  const macd = macdLine[macdLine.length - 1];
  const signal = signalSeed;
  return { macd, signal, histogram: macd - signal };
}

// ═══════════════════════════════════════════════════════════════════════
//  SIGNAL EVALUATION
//  Determines whether the bot's configured entry conditions are met
// ═══════════════════════════════════════════════════════════════════════

interface SignalResult {
  shouldEnter: boolean;
  signalType: "BUY" | "SELL" | "NONE";
  reason: string;
  indicator: string;
  rsi: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
}

function evaluateEntryConditions(
  bot: BotRow,
  candles: Candle[],
): SignalResult {
  const result: SignalResult = {
    shouldEnter: false,
    signalType: "NONE",
    reason: "No signal",
    indicator: bot.indicator ?? "none",
    rsi: null,
    emaFast: null,
    emaSlow: null,
    macd: null,
  };

  const lastClose = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const direction = bot.trade_direction ?? "long";
  const buySignal = direction === "short" ? "SELL" : "BUY";

  // ── Indicators explicitly OFF — force immediate market entry ──
  if (bot.indicators_enabled === false) {
    result.shouldEnter = true;
    result.signalType = buySignal;
    result.reason = `Indicators OFF — forced market entry at ${lastClose}`;
    return result;
  }

  // ── Strategy-specific entry logic by bot_type ──
  const botType = bot.bot_type ?? "scalper";

  // SCALPER: Fast EMA crossover (9 vs 21) + RSI momentum confirmation
  if (botType === "scalper" || botType === "scalping") {
    const closes = candles.map((c) => c.close);
    result.emaFast = computeEMA(closes, 9);
    result.emaSlow = computeEMA(closes, 21);
    result.rsi = computeRSI(candles, 14);

    if (result.emaFast === null || result.emaSlow === null) {
      result.reason = "Insufficient candles for scalper EMA crossover";
      return result;
    }

    const bullishCross = result.emaFast > result.emaSlow;
    const bearishCross = result.emaFast < result.emaSlow;
    const rsiBullish = result.rsi !== null && result.rsi > 40 && result.rsi < 70;
    const rsiBearish = result.rsi !== null && result.rsi > 30 && result.rsi < 60;

    if (direction === "long" && bullishCross && rsiBullish) {
      result.shouldEnter = true;
      result.signalType = "BUY";
      result.reason = `Scalper: EMA-9 (${result.emaFast.toFixed(2)}) > EMA-21 (${result.emaSlow.toFixed(2)}) + RSI ${result.rsi!.toFixed(1)} — bullish momentum entry`;
    } else if (direction === "short" && bearishCross && rsiBearish) {
      result.shouldEnter = true;
      result.signalType = "SELL";
      result.reason = `Scalper: EMA-9 (${result.emaFast.toFixed(2)}) < EMA-21 (${result.emaSlow.toFixed(2)}) + RSI ${result.rsi!.toFixed(1)} — bearish momentum entry`;
    } else {
      result.reason = `Scalper: EMA-9 ${result.emaFast.toFixed(2)} vs EMA-21 ${result.emaSlow.toFixed(2)}, RSI ${result.rsi?.toFixed(1) ?? "N/A"} — no confirmed entry`;
    }
    return result;
  }

  // DCA: Enter on initial position; subsequent entries on price drop or RSI oversold
  // Since the open-position check already prevents duplicates, DCA enters when
  // price has dropped at least 1% from recent high (averaging down) or RSI < 35
  if (botType === "dca") {
    const recentHigh = Math.max(...candles.slice(-20).map((c) => c.high));
    const dropPct = ((recentHigh - lastClose) / recentHigh) * 100;
    result.rsi = computeRSI(candles, 14);

    const priceDropEntry = dropPct >= 1.0;
    const oversoldEntry = result.rsi !== null && result.rsi < 35;

    if (direction === "long" && (priceDropEntry || oversoldEntry)) {
      result.shouldEnter = true;
      result.signalType = "BUY";
      result.reason = `DCA: price ${dropPct.toFixed(2)}% below recent high${oversoldEntry ? ` + RSI oversold ${result.rsi!.toFixed(1)}` : ""} — averaging down entry`;
    } else if (direction === "short" && dropPct <= -1.0) {
      result.shouldEnter = true;
      result.signalType = "SELL";
      result.reason = `DCA: price ${Math.abs(dropPct).toFixed(2)}% above recent low — averaging up entry`;
    } else {
      result.reason = `DCA: price ${dropPct.toFixed(2)}% from recent high, RSI ${result.rsi?.toFixed(1) ?? "N/A"} — no DCA entry condition`;
    }
    return result;
  }

  // GRID: Calculate upper/lower range from recent high/low, enter at grid lines
  if (botType === "grid") {
    const lookback = candles.slice(-30);
    const rangeHigh = Math.max(...lookback.map((c) => c.high));
    const rangeLow = Math.min(...lookback.map((c) => c.low));
    const range = rangeHigh - rangeLow;
    if (range <= 0) {
      result.reason = "Grid: zero range detected";
      return result;
    }
    const gridLevels = 4;
    const gridSpacing = range / gridLevels;
    const lowerGrid = rangeLow + gridSpacing;
    const upperGrid = rangeHigh - gridSpacing;

    if (direction === "long" && lastClose <= lowerGrid) {
      result.shouldEnter = true;
      result.signalType = "BUY";
      result.reason = `Grid: price ${lastClose} at lower grid line ${lowerGrid.toFixed(4)} (range ${rangeLow.toFixed(4)}-${rangeHigh.toFixed(4)}) — buy at support`;
    } else if (direction === "short" && lastClose >= upperGrid) {
      result.shouldEnter = true;
      result.signalType = "SELL";
      result.reason = `Grid: price ${lastClose} at upper grid line ${upperGrid.toFixed(4)} (range ${rangeLow.toFixed(4)}-${rangeHigh.toFixed(4)}) — sell at resistance`;
    } else {
      result.reason = `Grid: price ${lastClose} mid-range (${rangeLow.toFixed(4)}-${rangeHigh.toFixed(4)}), lower=${lowerGrid.toFixed(4)}, upper=${upperGrid.toFixed(4)} — no grid trigger`;
    }
    return result;
  }

  // MARTINGALE: Entry based on EMA trend direction; position sizing handled later
  if (botType === "martingale") {
    const closes = candles.map((c) => c.close);
    result.emaFast = computeEMA(closes, 9);
    result.emaSlow = computeEMA(closes, 21);
    result.rsi = computeRSI(candles, 14);

    if (result.emaFast === null || result.emaSlow === null) {
      result.reason = "Insufficient candles for martingale EMA trend";
      return result;
    }

    const trendBullish = result.emaFast > result.emaSlow;
    const trendBearish = result.emaFast < result.emaSlow;

    if (direction === "long" && trendBullish) {
      result.shouldEnter = true;
      result.signalType = "BUY";
      result.reason = `Martingale: EMA trend bullish (9>${result.emaSlow.toFixed(2)}) + RSI ${result.rsi?.toFixed(1) ?? "N/A"} — recovery entry`;
    } else if (direction === "short" && trendBearish) {
      result.shouldEnter = true;
      result.signalType = "SELL";
      result.reason = `Martingale: EMA trend bearish (9<${result.emaSlow.toFixed(2)}) + RSI ${result.rsi?.toFixed(1) ?? "N/A"} — recovery entry`;
    } else {
      result.reason = `Martingale: EMA trend not aligned (${result.emaFast.toFixed(2)} vs ${result.emaSlow.toFixed(2)}) — waiting for trend confirmation`;
    }
    return result;
  }

  // COPIER / TRAILING: Follow trend momentum with trailing stop logic
  // Uses EMA-20 slope + MACD histogram for trend confirmation
  if (botType === "copier" || botType === "trailing" || bot.strategy === "trailing") {
    const closes = candles.map((c) => c.close);
    result.emaFast = computeEMA(closes, 20);
    result.macd = computeMACD(candles);

    if (result.emaFast === null) {
      result.reason = "Insufficient candles for trailing EMA-20";
      return result;
    }

    const ema20Prev = computeEMA(closes.slice(0, -1), 20);
    const slope = ema20Prev !== null ? result.emaFast - ema20Prev : 0;
    const macdBullish = result.macd !== null && result.macd.histogram > 0;
    const macdBearish = result.macd !== null && result.macd.histogram < 0;

    if (direction === "long" && slope > 0 && macdBullish) {
      result.shouldEnter = true;
      result.signalType = "BUY";
      result.reason = `Trailing: EMA-20 rising (slope ${slope.toFixed(6)}) + MACD hist ${result.macd!.histogram.toFixed(6)} — bullish trend follow`;
    } else if (direction === "short" && slope < 0 && macdBearish) {
      result.shouldEnter = true;
      result.signalType = "SELL";
      result.reason = `Trailing: EMA-20 falling (slope ${slope.toFixed(6)}) + MACD hist ${result.macd!.histogram.toFixed(6)} — bearish trend follow`;
    } else {
      result.reason = `Trailing: EMA-20 slope ${slope.toFixed(6)}, MACD hist ${result.macd?.histogram.toFixed(6) ?? "N/A"} — no aligned trend`;
    }
    return result;
  }

  // ── Custom / fallback: indicator-based logic ──
  if (!bot.indicators_enabled || !bot.indicator) {
    // No indicator configured — use momentum (price vs EMA-20) as default
    if (candles.length >= 20) {
      const ema20 = computeEMA(candles.map((c) => c.close), 20);
      if (ema20 !== null) {
        result.emaFast = ema20;
        if (direction === "long" && lastClose > ema20) {
          result.shouldEnter = true;
          result.signalType = "BUY";
          result.reason = `Price ${lastClose} above EMA-20 ${ema20.toFixed(4)} — bullish momentum`;
        } else if (direction === "short" && lastClose < ema20) {
          result.shouldEnter = true;
          result.signalType = "SELL";
          result.reason = `Price ${lastClose} below EMA-20 ${ema20.toFixed(4)} — bearish momentum`;
        }
      }
    }
    return result;
  }

  const indicator = bot.indicator.toUpperCase();

  if (indicator === "RSI") {
    result.rsi = computeRSI(candles, 14);
    if (result.rsi === null) {
      result.reason = "Insufficient candles for RSI(14)";
      return result;
    }

    if (direction === "long" && result.rsi < 30) {
      result.shouldEnter = true;
      result.signalType = "BUY";
      result.reason = `RSI(14) = ${result.rsi.toFixed(2)} — oversold, long entry signal`;
    } else if (direction === "short" && result.rsi > 70) {
      result.shouldEnter = true;
      result.signalType = "SELL";
      result.reason = `RSI(14) = ${result.rsi.toFixed(2)} — overbought, short entry signal`;
    } else {
      result.reason = `RSI(14) = ${result.rsi.toFixed(2)} — no entry signal`;
    }
    return result;
  }

  if (indicator === "MACD" || indicator === "MACD DIVERGENCE") {
    result.macd = computeMACD(candles);
    if (result.macd === null) {
      result.reason = "Insufficient candles for MACD";
      return result;
    }

    if (direction === "long" && result.macd.histogram > 0) {
      result.shouldEnter = true;
      result.signalType = "BUY";
      result.reason = `MACD histogram = ${result.macd.histogram.toFixed(6)} > 0 — bullish crossover`;
    } else if (direction === "short" && result.macd.histogram < 0) {
      result.shouldEnter = true;
      result.signalType = "SELL";
      result.reason = `MACD histogram = ${result.macd.histogram.toFixed(6)} < 0 — bearish crossover`;
    } else {
      result.reason = `MACD histogram = ${result.macd.histogram.toFixed(6)} — no crossover signal`;
    }
    return result;
  }

  if (indicator === "EMA" || indicator === "EMA CROSSOVER") {
    const closes = candles.map((c) => c.close);
    result.emaFast = computeEMA(closes, 9);
    result.emaSlow = computeEMA(closes, 21);

    if (result.emaFast === null || result.emaSlow === null) {
      result.reason = "Insufficient candles for EMA crossover";
      return result;
    }

    if (direction === "long" && result.emaFast > result.emaSlow) {
      result.shouldEnter = true;
      result.signalType = "BUY";
      result.reason = `EMA-9 (${result.emaFast.toFixed(4)}) > EMA-21 (${result.emaSlow.toFixed(4)}) — golden cross`;
    } else if (direction === "short" && result.emaFast < result.emaSlow) {
      result.shouldEnter = true;
      result.signalType = "SELL";
      result.reason = `EMA-9 (${result.emaFast.toFixed(4)}) < EMA-21 (${result.emaSlow.toFixed(4)}) — death cross`;
    } else {
      result.reason = `EMA-9 (${result.emaFast.toFixed(4)}) vs EMA-21 (${result.emaSlow.toFixed(4)}) — no crossover`;
    }
    return result;
  }

  // SMC Order Blocks — detect recent sharp moves
  if (indicator === "SMC ORDER BLOCKS" || indicator === "ORDER BLOCKS") {
    if (candles.length < 10) {
      result.reason = "Insufficient candles for order block detection";
      return result;
    }

    const recent = candles.slice(-5);
    const maxBody = Math.max(...recent.map((c) => Math.abs(c.close - c.open)));
    const avgBody = candles.slice(-20).reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / Math.min(20, candles.length);

    if (maxBody > avgBody * 2) {
      result.shouldEnter = true;
      result.signalType = buySignal;
      result.reason = `Order block detected: max body ${maxBody.toFixed(4)} > 2x avg ${avgBody.toFixed(4)}`;
    } else {
      result.reason = `No significant order block (max body ${maxBody.toFixed(4)} <= 2x avg ${avgBody.toFixed(4)})`;
    }
    return result;
  }

  result.reason = `Unknown indicator: ${bot.indicator}`;
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
//  BINANCE OHLCV DATA FETCHER
// ═══════════════════════════════════════════════════════════════════════

interface KlineResponse {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
}

async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number,
  isFutures: boolean,
): Promise<Candle[]> {
  const baseUrl = isFutures
    ? "https://fapi.binance.com/fapi/v1/klines"
    : "https://api.binance.com/api/v3/klines";

  const url = `${baseUrl}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const raw = await resp.json() as unknown[][];

    return raw.map((k) => ({
      openTime: Number(k[0]),
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
      volume: parseFloat(k[5] as string),
      closeTime: Number(k[6]),
    }));
  } catch {
    return [];
  }
}

/** Maps bot_type to a Binance kline interval */
function getKlineInterval(botType: string | null): string {
  switch (botType) {
    case "scalper":
      return "5m";
    case "grid":
      return "15m";
    case "dca":
      return "1h";
    case "martingale":
      return "15m";
    case "copier":
      return "15m";
    case "custom":
      return "15m";
    default:
      return "15m";
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════════════

interface BotRow {
  id: string;
  user_id: string;
  name: string;
  market_type: "spot" | "futures";
  coin: string;
  strategy: string;
  status: string;
  trade_direction: "long" | "short" | null;
  bot_type: string | null;
  order_type: "market" | "limit" | null;
  leverage: number | null;
  capital: number | null;
  indicators_enabled: boolean | null;
  indicator: string | null;
  quantity_mode: string | null;
  quantity_value: number | null;
  percent_value: number | null;
  max_trades_per_day: number | null;
  rr_ratio: number | null;
  tp_sl_mode: string | null;
  take_profit: number | null;
  stop_loss: number | null;
  trailing_enabled: boolean | null;
  trailing_distance: number | null;
  max_daily_loss: number | null;
  max_daily_profit: number | null;
  cooldown_minutes: number | null;
  is_paper_mode: boolean | null;
  martingale_multiplier: number | null;
  max_martingale_steps: number | null;
}

interface RiskSettingsRow {
  global_kill_switch: boolean;
  max_leverage: number;
  max_daily_loss_pct: number;
  auto_disable_on_breach: boolean;
  ai_circuit_breaker: boolean;
  max_slippage_pct: number;
}

interface LicenseRow {
  plan_name: string;
  is_active: boolean;
  valid_until: string | null;
  bot_limit: number | null;
}

interface UserFundsRow {
  balance: number;
  unrealized_pnl: number;
  realized_pnl: number;
}

// ═══════════════════════════════════════════════════════════════════════
//  LOGGING
// ═══════════════════════════════════════════════════════════════════════

async function logApiCall(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  broker: string,
  endpoint: string,
  status: "success" | "error" | "pending",
  latencyMs: number,
  detail: string,
): Promise<void> {
  const { error: logErr } = await adminClient.from("broker_api_logs").insert({
    user_id: userId,
    broker,
    endpoint,
    status,
    latency_ms: latencyMs,
    detail,
  });
  if (logErr) {
    console.error(`logApiCall insert failed (${broker}/${endpoint}):`, logErr.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  TRADE EXECUTION (internal call to execute-trade edge function)
// ═══════════════════════════════════════════════════════════════════════

async function triggerTradeExecution(
  supabaseUrl: string,
  serviceRoleKey: string,
  botId: string,
  userId: string,
  adminClient: ReturnType<typeof createClient>,
): Promise<{ success: boolean; detail: string }> {
  const startTime = Date.now();

  try {
    // Fetch the user's access token to pass to execute-trade
    // execute-trade requires a user JWT for auth.getUser — but the cron job
    // only has the service role key. We call execute-trade's logic directly
    // by inserting the position ourselves using the admin client, after
    // performing the same risk checks here.

    // For now, we perform the trade inline (same logic as execute-trade but
    // with admin client privileges) to avoid the JWT roundtrip problem.

    const { data: botData } = await adminClient
      .from("bots")
      .select("*")
      .eq("id", botId)
      .maybeSingle();

    if (!botData) {
      return { success: false, detail: "Bot not found" };
    }

    const bot = botData as BotRow;

    // Paper mode — simulate (only when explicitly enabled by the user)
    if (bot.is_paper_mode === true) {
      const symbol = `${bot.coin.toUpperCase()}USDT`;
      const side = bot.trade_direction === "short" ? "SELL" : "BUY";
      const isFutures = bot.market_type === "futures";

      // Fetch current price — NEVER use $0; abort on failure
      let paperPrice: number;
      try {
        paperPrice = await fetchTickerPrice(symbol, isFutures);
      } catch (priceErr) {
        await logApiCall(adminClient, userId, "PAPER", "/price-fetch", "error", 0,
          `Failed to fetch live price for ${symbol}: ${(priceErr as Error).message}`);
        return { success: false, detail: `Paper trade aborted: could not fetch live price for ${symbol}. ${(priceErr as Error).message}` };
      }

      const { data: posData } = await adminClient.from("positions").insert({
        bot_id: bot.id,
        user_id: userId,
        symbol,
        side,
        entry_price: paperPrice,
        quantity: bot.capital ?? 0,
        leverage: bot.leverage ?? 1,
        take_profit_pct: bot.take_profit,
        stop_loss_pct: bot.stop_loss,
        trailing_enabled: bot.trailing_enabled ?? false,
        trailing_distance_pct: bot.trailing_distance,
        fixed_profit: bot.max_daily_profit ?? null,
        fixed_loss: bot.max_daily_loss ?? null,
        max_trades_per_day: bot.max_trades_per_day ?? null,
        max_daily_loss: bot.max_daily_loss ?? null,
        max_daily_profit: bot.max_daily_profit ?? null,
        trailing_stop_loss_pct: bot.trailing_distance ?? null,
        status: "open",
        is_paper: true,
      }).select("*").maybeSingle();

      // Also insert into trades table so the trade appears in Trade History
      const tradeQty = bot.capital ?? 0;
      const tradeLev = bot.leverage ?? 1;
      await adminClient.from("trades").insert({
        client_id: userId,
        client_name: bot.name ?? "AI Bot",
        coin: bot.coin,
        market_type: bot.market_type,
        direction: bot.trade_direction ?? "long",
        entry_price: paperPrice,
        amount: tradeQty,
        quantity: tradeQty,
        leverage: tradeLev,
        position_size: tradeQty * tradeLev,
        tp_pct: bot.take_profit ?? null,
        sl_pct: bot.stop_loss ?? null,
        status: "open",
        executed_by: bot.name ?? "AI Bot",
        fixed_profit: bot.max_daily_profit ?? null,
        fixed_loss: bot.max_daily_loss ?? null,
        max_trades_per_day: bot.max_trades_per_day ?? null,
        max_daily_loss: bot.max_daily_loss ?? null,
        max_daily_profit: bot.max_daily_profit ?? null,
        trailing_stop_loss: bot.trailing_distance ?? null,
      });

      // Also insert into trade_history for Dashboard P&L
      await adminClient.from("trade_history").insert({
        user_id: userId,
        timestamp: new Date().toISOString(),
        pair: symbol,
        side: side as "BUY" | "SELL",
        amount: tradeQty,
        price: paperPrice,
        pnl: 0,
        strategy: bot.strategy ?? bot.bot_type ?? "ai",
      });

      await logApiCall(
        adminClient,
        userId,
        "PAPER",
        "/strategy-runner/simulated-order",
        "success",
        Date.now() - startTime,
        `PAPER: ${side} ${symbol} @ ${paperPrice} | strategy=${bot.strategy} | bot_type=${bot.bot_type}`,
      );

      return { success: true, detail: `Paper trade executed @ ${paperPrice}` };
    }

    // LIVE mode — CoinDCX INR-M Golden Payload (same logic as execute-trade)
    const brokerKeys = await decryptBrokerKeys(adminClient, userId);
    if (!brokerKeys) {
      await logApiCall(adminClient, userId, "SYSTEM", "/strategy-runner/no-broker", "error", 0, "No connected broker for live trade");
      return { success: false, detail: "No connected broker" };
    }

    const baseCoin = bot.coin.toUpperCase();
    const symbol = `${baseCoin}USDT`;
    const side = bot.trade_direction === "short" ? "SELL" : "BUY";
    const requestedLeverage = bot.leverage ?? 1;
    const marginInr = bot.capital && bot.capital > 0 ? bot.capital : 100;

    const startTime = Date.now();
    const golden = await executeGoldenTrade({
      apiKey: brokerKeys.apiKey,
      apiSecret: brokerKeys.apiSecret,
      baseCoin,
      side: side as "BUY" | "SELL",
      leverage: requestedLeverage,
      marginInr,
    });

    if (!golden.success && golden.livePriceUsdt <= 0) {
      return { success: false, detail: golden.errorDetail ?? `Failed to fetch live price for ${baseCoin}.` };
    }

    const latencyMs = Date.now() - startTime;
    const orderStatus = golden.success ? "success" : "error";
    const orderDetail = golden.success
      ? `Order ${side} ${symbol} filled. OrderId: ${golden.orderId}`
      : golden.errorDetail ?? "Unknown error";

    await logApiCall(adminClient, userId, brokerKeys.exchangeName, "/order", orderStatus, latencyMs, orderDetail);

    // Record position if order succeeded
    if (golden.success) {
      const entryPrice = golden.entryPrice;
      const quantity = golden.executedQty;

      await adminClient.from("positions").insert({
        bot_id: bot.id,
        user_id: userId,
        symbol,
        side,
        entry_price: entryPrice,
        quantity,
        leverage: bot.leverage ?? 1,
        take_profit_pct: bot.take_profit,
        stop_loss_pct: bot.stop_loss,
        trailing_enabled: bot.trailing_enabled ?? false,
        trailing_distance_pct: bot.trailing_distance,
        fixed_profit: bot.max_daily_profit ?? null,
        fixed_loss: bot.max_daily_loss ?? null,
        max_trades_per_day: bot.max_trades_per_day ?? null,
        max_daily_loss: bot.max_daily_loss ?? null,
        max_daily_profit: bot.max_daily_profit ?? null,
        trailing_stop_loss_pct: bot.trailing_distance ?? null,
        status: "open",
        is_paper: false,
        exchange_order_id: golden.orderId,
      });

      // Also insert into trades table so the trade appears in Trade History
      const liveLev = bot.leverage ?? 1;
      await adminClient.from("trades").insert({
        client_id: userId,
        client_name: bot.name ?? "AI Bot",
        coin: bot.coin,
        market_type: bot.market_type,
        direction: bot.trade_direction ?? "long",
        entry_price: entryPrice,
        amount: quantity,
        quantity: quantity,
        leverage: liveLev,
        position_size: quantity * liveLev,
        tp_pct: bot.take_profit ?? null,
        sl_pct: bot.stop_loss ?? null,
        status: "open",
        executed_by: bot.name ?? "AI Bot",
        fixed_profit: bot.max_daily_profit ?? null,
        fixed_loss: bot.max_daily_loss ?? null,
        max_trades_per_day: bot.max_trades_per_day ?? null,
        max_daily_loss: bot.max_daily_loss ?? null,
        max_daily_profit: bot.max_daily_profit ?? null,
        trailing_stop_loss: bot.trailing_distance ?? null,
      });

      // Also insert into trade_history for Dashboard P&L
      await adminClient.from("trade_history").insert({
        user_id: userId,
        timestamp: new Date().toISOString(),
        pair: symbol,
        side: side as "BUY" | "SELL",
        amount: quantity,
        price: entryPrice,
        pnl: 0,
        strategy: bot.strategy ?? bot.bot_type ?? "ai",
      });
    }

    // Auto-disable bot on error if configured
    if (orderStatus === "error") {
      const { data: riskData } = await adminClient
        .from("risk_settings")
        .select("auto_disable_on_breach")
        .limit(1)
        .maybeSingle();
      if (riskData?.auto_disable_on_breach) {
        await adminClient.from("bots").update({ status: "paused" }).eq("id", bot.id);
      }
    }

    return { success: orderStatus === "success", detail: orderDetail };
  } catch (err) {
    return { success: false, detail: `Trade execution error: ${(err as Error).message}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  PARALLEL KLINE BATCH FETCHER
//  Fetches all unique (symbol, interval, isFutures) combos in one Promise.all
// ═══════════════════════════════════════════════════════════════════════

async function fetchKlinesBatch(
  botConfigs: Array<{ symbol: string; interval: string; isFutures: boolean }>,
): Promise<Map<string, Candle[]>> {
  const cache = new Map<string, Candle[]>();
  const uniqueKeys = new Set<string>();
  const fetches: Promise<void>[] = [];

  for (const cfg of botConfigs) {
    const key = `${cfg.symbol}|${cfg.interval}|${cfg.isFutures}`;
    if (uniqueKeys.has(key)) continue;
    uniqueKeys.add(key);

    fetches.push(
      (async () => {
        const candles = await fetchKlines(cfg.symbol, cfg.interval, 100, cfg.isFutures);
        cache.set(key, candles);
      })(),
    );
  }

  await Promise.all(fetches);
  return cache;
}

// Re-export the shared batch ticker fetcher for internal use
const fetchTickerPricesAll = sharedFetchTickerPricesBatch;

// ═══════════════════════════════════════════════════════════════════════
//  INLINE POSITION EXIT — TP/SL/TRAILING evaluation every 5 seconds
//  Closes positions across positions + trades tables, logs to broker_api_logs
// ═══════════════════════════════════════════════════════════════════════

interface OpenPositionRow {
  id: string;
  bot_id: string | null;
  user_id: string;
  symbol: string;
  side: "BUY" | "SELL";
  entry_price: number;
  quantity: number;
  leverage: number;
  take_profit_pct: number | null;
  stop_loss_pct: number | null;
  trailing_enabled: boolean;
  trailing_distance_pct: number | null;
  highest_price: number | null;
  lowest_price: number | null;
  is_paper: boolean;
  exchange_order_id: string | null;
}

async function checkAndClosePositions(
  adminClient: ReturnType<typeof createClient>,
  priceMap: Map<string, number>,
  botMarketMap: Map<string, "spot" | "futures">,
): Promise<{ closed: number; details: string[] }> {
  const { data: openPositions } = await adminClient
    .from("positions")
    .select("id, bot_id, user_id, symbol, side, entry_price, quantity, leverage, take_profit_pct, stop_loss_pct, trailing_enabled, trailing_distance_pct, highest_price, lowest_price, is_paper, exchange_order_id")
    .eq("status", "open");

  const positions = (openPositions as OpenPositionRow[]) ?? [];
  const closedDetails: string[] = [];
  let closedCount = 0;

  for (const pos of positions) {
    const isFutures = pos.bot_id ? (botMarketMap.get(pos.bot_id) === "futures") : false;
    const livePrice = priceMap.get(pos.symbol);
    if (livePrice === undefined) continue;

    const direction: "long" | "short" = pos.side === "BUY" ? "long" : "short";
    const entry = pos.entry_price;
    let shouldClose = false;
    let closeReason = "";
    let closeStatus: "closed_tp" | "closed_sl" = "closed_tp";

    if (direction === "long") {
      const tpPct = pos.take_profit_pct;
      const slPct = pos.stop_loss_pct;

      if (tpPct && tpPct > 0) {
        const tpPrice = entry * (1 + tpPct / 100);
        if (livePrice >= tpPrice) {
          shouldClose = true;
          closeReason = `TP hit: ${livePrice} >= ${tpPrice.toFixed(2)}`;
          closeStatus = "closed_tp";
        }
      }

      if (!shouldClose && slPct && slPct > 0) {
        const slPrice = entry * (1 - slPct / 100);
        if (livePrice <= slPrice) {
          shouldClose = true;
          closeReason = `SL hit: ${livePrice} <= ${slPrice.toFixed(2)}`;
          closeStatus = "closed_sl";
        }
      }

      if (!shouldClose && pos.trailing_enabled && pos.trailing_distance_pct) {
        const trailDist = pos.trailing_distance_pct / 100;
        const currentHigh = Math.max(pos.highest_price ?? entry, livePrice);
        const trailingStop = currentHigh * (1 - trailDist);
        if (livePrice <= trailingStop && currentHigh > entry) {
          shouldClose = true;
          closeReason = `Trailing stop hit: ${livePrice} <= ${trailingStop.toFixed(2)}`;
          closeStatus = "closed_tp";
        }
      }
    } else {
      const tpPct = pos.take_profit_pct;
      const slPct = pos.stop_loss_pct;

      if (tpPct && tpPct > 0) {
        const tpPrice = entry * (1 - tpPct / 100);
        if (livePrice <= tpPrice) {
          shouldClose = true;
          closeReason = `TP hit (short): ${livePrice} <= ${tpPrice.toFixed(2)}`;
          closeStatus = "closed_tp";
        }
      }

      if (!shouldClose && slPct && slPct > 0) {
        const slPrice = entry * (1 + slPct / 100);
        if (livePrice >= slPrice) {
          shouldClose = true;
          closeReason = `SL hit (short): ${livePrice} >= ${slPrice.toFixed(2)}`;
          closeStatus = "closed_sl";
        }
      }

      if (!shouldClose && pos.trailing_enabled && pos.trailing_distance_pct) {
        const trailDist = pos.trailing_distance_pct / 100;
        const currentLow = Math.min(pos.lowest_price ?? entry, livePrice);
        const trailingStop = currentLow * (1 + trailDist);
        if (livePrice >= trailingStop && currentLow < entry) {
          shouldClose = true;
          closeReason = `Trailing stop hit (short): ${livePrice} >= ${trailingStop.toFixed(2)}`;
          closeStatus = "closed_tp";
        }
      }
    }

    if (!shouldClose) {
      // Update trailing high/low watermarks
      const updates: Record<string, number> = {};
      if (direction === "long" && livePrice > (pos.highest_price ?? entry)) {
        updates.highest_price = livePrice;
      }
      if (direction === "short" && livePrice < (pos.lowest_price ?? entry)) {
        updates.lowest_price = livePrice;
      }
      if (Object.keys(updates).length > 0) {
        await adminClient.from("positions").update(updates).eq("id", pos.id);
      }
      continue;
    }

    // Calculate realized PnL
    const priceDiff = direction === "long"
      ? subtractDecimals(livePrice.toString(), entry.toString())
      : subtractDecimals(entry.toString(), livePrice.toString());
    const grossPnl = multiplyDecimals(priceDiff, pos.quantity.toString());
    const realizedPnl = parseFloat(multiplyDecimals(grossPnl, pos.leverage.toString()));
    const coinFromSymbol = pos.symbol.replace("USDT", "");

    // For LIVE positions, send a real close order via the exchange adapter
    if (!pos.is_paper) {
      const brokerKeys = await decryptBrokerKeys(adminClient, pos.user_id);
      if (!brokerKeys) {
        await logApiCall(adminClient, pos.user_id, "SYSTEM", "/strategy-runner/no-broker-close", "error", 0, `No connected broker for ${pos.symbol} — force-closing in DB only`);
        closedDetails.push(`${pos.symbol}: no broker, DB force-close only`);
      } else {
        try {
          const adapter = ExchangeAdapter.create(brokerKeys.exchangeName);
          const closeSide = pos.side === "BUY" ? "SELL" : "BUY";
          const isFutures = pos.bot_id ? (botMarketMap.get(pos.bot_id) === "futures") : false;
          const closeStartTime = Date.now();

          const closeResp = await adapter.closeOrder({
            apiKey: brokerKeys.apiKey,
            apiSecret: brokerKeys.apiSecret,
            symbol: pos.symbol,
            side: closeSide,
            marketType: isFutures ? "futures" : "spot",
            reduceOnly: isFutures,
          });
          const closeLatency = Date.now() - closeStartTime;

          if (closeResp.success) {
            await logApiCall(adminClient, pos.user_id, brokerKeys.exchangeName, "/close-order", "success", closeLatency, `Close order ${closeSide} ${pos.symbol} filled. OrderId: ${closeResp.orderId} | reason=${closeReason}`);
          } else {
            await logApiCall(adminClient, pos.user_id, brokerKeys.exchangeName, "/close-order", "error", closeLatency, `${closeResp.errorDetail} | reason=${closeReason}`);
            closedDetails.push(`${pos.symbol}: exchange close failed, force-closing DB — ${closeResp.errorDetail}`);
          }
        } catch (closeErr) {
          await logApiCall(adminClient, pos.user_id, "SYSTEM", "/strategy-runner/close-error", "error", 0, `Failed to close ${pos.symbol} on exchange (force-closing DB): ${(closeErr as Error).message}`);
          closedDetails.push(`${pos.symbol}: exchange error, force-closing DB — ${(closeErr as Error).message}`);
        }
      }
    }

    // ALWAYS close in DB — it is the source of truth for the UI
    await adminClient.from("positions").update({
      status: closeStatus,
      close_price: livePrice,
      close_pnl: realizedPnl,
      closed_at: new Date().toISOString(),
      unrealized_pnl: realizedPnl,
    }).eq("id", pos.id);

    // Close in trades table (match by client_id + coin + status=open)
    await adminClient.from("trades").update({
      status: closeStatus,
    }).eq("client_id", pos.user_id)
      .eq("coin", coinFromSymbol)
      .eq("status", "open");

    // Insert into trade_history for Dashboard P&L
    await adminClient.from("trade_history").insert({
      user_id: pos.user_id,
      timestamp: new Date().toISOString(),
      pair: pos.symbol,
      side: pos.side,
      amount: pos.quantity,
      price: livePrice,
      pnl: realizedPnl,
      strategy: "auto-exit",
    });

    // Log the close
    await logApiCall(
      adminClient,
      pos.user_id,
      pos.is_paper ? "PAPER" : "EXCHANGE",
      "/strategy-runner/auto-close",
      "success",
      0,
      `AUTO-CLOSE ${closeStatus}: ${pos.symbol} @ ${livePrice} | ${closeReason} | pnl=${realizedPnl}`,
    );

    closedCount++;
    closedDetails.push(`${pos.symbol}: ${closeReason} (pnl=${realizedPnl})`);
  }

  return { closed: closedCount, details: closedDetails };
}

// ═══════════════════════════════════════════════════════════════════════
//  MAIN HANDLER — 5-SECOND SUB-TICK LOOP (50s max runtime)
// ═══════════════════════════════════════════════════════════════════════

const TICK_INTERVAL_MS = 5000;
const MAX_RUNTIME_MS = 50000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const runStartTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── STARTUP HEARTBEAT ──
    // Insert immediately so the Broker Response UI proves the cron is alive,
    // even if everything below crashes.
    const startupTs = new Date().toISOString();
    const { error: heartbeatErr } = await adminClient.from("broker_api_logs").insert({
      user_id: "00000000-0000-0000-0000-000000000000",
      broker: "CRON",
      endpoint: "POST /functions/v1/strategy-runner",
      status: "success",
      latency_ms: 0,
      detail: `Strategy runner started at ${startupTs}`,
    });
    if (heartbeatErr) {
      console.error("Startup heartbeat insert failed:", heartbeatErr.message);
    }

    // This function is called by pg_cron with the service role key.
    // It can also be called manually with a Bearer token.
    const authHeader = req.headers.get("Authorization") ?? "";
    const isCronCall = authHeader.includes(serviceRoleKey) || !authHeader.startsWith("Bearer ");

    // 1. Fetch global risk settings
    const { data: riskData } = await adminClient
      .from("risk_settings")
      .select("*")
      .limit(1)
      .maybeSingle();
    const risk = (riskData as RiskSettingsRow | null) ?? {
      global_kill_switch: false,
      max_leverage: 125,
      max_daily_loss_pct: 10,
      auto_disable_on_breach: true,
      ai_circuit_breaker: false,
      max_slippage_pct: 1.5,
    };

    // 2. Kill switch check — halt everything
    if (risk.global_kill_switch) {
      await logApiCall(adminClient, "00000000-0000-0000-0000-000000000000", "CRON", "POST /functions/v1/strategy-runner", "success", Date.now() - runStartTime, "Kill switch active — all trading halted");
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        reason: "Global kill switch is active — all trading halted",
        timestamp: new Date().toISOString(),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── ORPHANED POSITION RECOVERY ──
    // If a bot was set to 'inactive' but still has open positions (e.g. exchange
    // close failed during kill switch), force-close those orphaned positions now.
    const { data: inactiveBotsData } = await adminClient
      .from("bots")
      .select("id, market_type, user_id, coin")
      .eq("status", "inactive");

    const inactiveBots = (inactiveBotsData as Array<{ id: string; market_type: "spot" | "futures"; user_id: string; coin: string }>) ?? [];
    if (inactiveBots.length > 0) {
      const inactiveBotIds = inactiveBots.map(b => b.id);
      const { data: orphanedPositions } = await adminClient
        .from("positions")
        .select("id, bot_id, user_id, symbol, side, entry_price, quantity, leverage, is_paper")
        .eq("status", "open")
        .in("bot_id", inactiveBotIds);

      const orphans = (orphanedPositions as Array<{ id: string; bot_id: string; user_id: string; symbol: string; side: "BUY" | "SELL"; entry_price: number; quantity: number; leverage: number; is_paper: boolean }>) ?? [];

      if (orphans.length > 0) {
        const orphanBotMap = new Map<string, { market_type: "spot" | "futures"; user_id: string; coin: string }>();
        for (const ib of inactiveBots) {
          orphanBotMap.set(ib.id, { market_type: ib.market_type, user_id: ib.user_id, coin: ib.coin });
        }

        const orphanSymbols = [...new Set(orphans.map(o => {
          const botInfo = orphanBotMap.get(o.bot_id);
          return { symbol: o.symbol, isFutures: botInfo?.market_type === "futures" };
        }))];
        const orphanPriceMap = await fetchTickerPricesAll(orphanSymbols);

        for (const pos of orphans) {
          const botInfo = orphanBotMap.get(pos.bot_id);
          const isFutures = botInfo?.market_type === "futures";
          const livePrice = orphanPriceMap.get(pos.symbol);
          if (livePrice === undefined) {
            await logApiCall(adminClient, pos.user_id, "SYSTEM", "/strategy-runner/orphan-close", "error", 0, `Cannot close orphaned ${pos.symbol} — no live price`);
            continue;
          }

          const direction: "long" | "short" = pos.side === "BUY" ? "long" : "short";
          const priceDiff = direction === "long"
            ? subtractDecimals(livePrice.toString(), pos.entry_price.toString())
            : subtractDecimals(pos.entry_price.toString(), livePrice.toString());
          const grossPnl = multiplyDecimals(priceDiff, pos.quantity.toString());
          const realizedPnl = parseFloat(multiplyDecimals(grossPnl, pos.leverage.toString()));
          const coinFromSymbol = pos.symbol.replace("USDT", "");

          // For live positions, attempt close order via exchange adapter (best-effort)
          if (!pos.is_paper) {
            const brokerKeys = await decryptBrokerKeys(adminClient, pos.user_id);
            if (!brokerKeys) {
              await logApiCall(adminClient, pos.user_id, "SYSTEM", "/strategy-runner/orphan-close", "error", 0, `No broker for orphaned ${pos.symbol} — force-closing in DB only`);
            } else {
              try {
                const adapter = ExchangeAdapter.create(brokerKeys.exchangeName);
                const closeSide = pos.side === "BUY" ? "SELL" : "BUY";
                const closeStartTime = Date.now();

                const closeResp = await adapter.closeOrder({
                  apiKey: brokerKeys.apiKey,
                  apiSecret: brokerKeys.apiSecret,
                  symbol: pos.symbol,
                  side: closeSide,
                  marketType: isFutures ? "futures" : "spot",
                  reduceOnly: isFutures,
                });
                const closeLatency = Date.now() - closeStartTime;

                if (closeResp.success) {
                  await logApiCall(adminClient, pos.user_id, brokerKeys.exchangeName, "/strategy-runner/orphan-close", "success", closeLatency, `ORPHAN CLOSE: ${pos.symbol} ${closeSide} filled. OrderId: ${closeResp.orderId}`);
                } else {
                  await logApiCall(adminClient, pos.user_id, brokerKeys.exchangeName, "/strategy-runner/orphan-close", "error", closeLatency, `ORPHAN CLOSE exchange error (force-closing DB): ${closeResp.errorDetail}`);
                }
              } catch (closeErr) {
                await logApiCall(adminClient, pos.user_id, "SYSTEM", "/strategy-runner/orphan-close", "error", 0, `Orphan close exchange error for ${pos.symbol} (force-closing DB): ${(closeErr as Error).message}`);
              }
            }
          }

          // ALWAYS close in DB — force-close orphaned positions regardless of exchange result
          await adminClient.from("positions").update({
            status: "closed_manual",
            close_price: livePrice,
            close_pnl: realizedPnl,
            closed_at: new Date().toISOString(),
            unrealized_pnl: realizedPnl,
          }).eq("id", pos.id);

          // Close in trades table
          await adminClient.from("trades").update({
            status: "closed_manual",
          }).eq("client_id", pos.user_id)
            .eq("coin", coinFromSymbol)
            .eq("status", "open");

          // Insert into trade_history
          await adminClient.from("trade_history").insert({
            user_id: pos.user_id,
            timestamp: new Date().toISOString(),
            pair: pos.symbol,
            side: pos.side,
            amount: pos.quantity,
            price: livePrice,
            pnl: realizedPnl,
            strategy: "orphan-recovery",
          });

          await logApiCall(
            adminClient,
            pos.user_id,
            pos.is_paper ? "PAPER" : "EXCHANGE",
            "/strategy-runner/orphan-close",
            "success",
            0,
            `ORPHAN RECOVERY CLOSE: ${pos.symbol} @ ${livePrice} | pnl=${realizedPnl} (bot was inactive with open position)`,
          );
          closedCount++;
        }
      }
    }

    // 3. Fetch all active bots (status = 'running')
    const { data: botsData, error: botsErr } = await adminClient
      .from("bots")
      .select("*")
      .eq("status", "running");

    if (botsErr) {
      return new Response(JSON.stringify({ error: botsErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const bots = (botsData as BotRow[]) ?? [];
    if (bots.length === 0) {
      await logApiCall(adminClient, "00000000-0000-0000-0000-000000000000", "CRON", "POST /functions/v1/strategy-runner", "success", Date.now() - runStartTime, "No active bots to evaluate");
      return new Response(JSON.stringify({
        success: true,
        evaluated: 0,
        traded: 0,
        message: "No active bots to evaluate",
        timestamp: new Date().toISOString(),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Fetch latest sentiment for circuit breaker check (once per cron invocation)
    let sentimentBlocked = false;
    let sentimentClassification = "neutral";
    if (risk.ai_circuit_breaker) {
      const { data: sentimentData } = await adminClient
        .from("sentiment_scores")
        .select("overall_score, classification, long_entries_blocked")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (sentimentData) {
        sentimentClassification = (sentimentData as { classification: string }).classification;
        if ((sentimentData as { long_entries_blocked: boolean }).long_entries_blocked) {
          sentimentBlocked = true;
        }
      }
    }

    // 5. Fetch all active licenses (batch — once per cron invocation)
    const userIds = [...new Set(bots.map((b) => b.user_id))];
    const { data: licensesData } = await adminClient
      .from("licenses")
      .select("user_id, plan_name, is_active, valid_until, bot_limit")
      .in("user_id", userIds)
      .eq("is_active", true);

    const licenseMap = new Map<string, LicenseRow>();
    for (const lic of (licensesData as LicenseRow[]) ?? []) {
      if (!licenseMap.has(lic.user_id)) {
        licenseMap.set(lic.user_id, lic);
      }
    }

    // 6. Fetch all user funds (batch — once per cron invocation)
    const { data: fundsData } = await adminClient
      .from("user_funds")
      .select("user_id, balance, unrealized_pnl, realized_pnl")
      .in("user_id", userIds);

    const fundsMap = new Map<string, UserFundsRow>();
    for (const fund of (fundsData as (UserFundsRow & { user_id: string })[]) ?? []) {
      fundsMap.set(fund.user_id, {
        balance: fund.balance,
        unrealized_pnl: fund.unrealized_pnl,
        realized_pnl: fund.realized_pnl,
      });
    }

    // Build bot market-type map for position exit lookups
    const botMarketMap = new Map<string, "spot" | "futures">();
    for (const b of bots) {
      botMarketMap.set(b.id, b.market_type);
    }

    // ── Results array (shared between copier sync and tick loop) ──
    const results: Array<{
      botId: string;
      botName: string;
      userId: string;
      action: string;
      detail: string;
      signal?: string;
    }> = [];

    // ── COPIER BOT SYNC: Invoke sync-copy-trades for active copier bots ──
    // Runs once per cron invocation (not per tick) to avoid duplicate syncs.
    const copierBots = bots.filter((b) => b.bot_type === "copier");
    let copierSynced = 0;
    if (copierBots.length > 0 && !risk.global_kill_switch) {
      try {
        const syncResp = await fetch(`${supabaseUrl}/functions/v1/sync-copy-trades`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceRoleKey}`,
          },
          body: JSON.stringify({}), // empty body = scan mode
        });
        if (syncResp.ok) {
          const syncData = await syncResp.json() as { totalSynced?: number };
          copierSynced = syncData.totalSynced ?? 0;
          if (copierSynced > 0) {
            results.push({
              botId: "copier-sync",
              botName: "Copy Trading Engine",
              userId: "system",
              action: "COPIER_SYNC",
              detail: `Synced ${copierSynced} copy trades across ${copierBots.length} copier bots`,
            });
          }
        }
      } catch (syncErr) {
        results.push({
          botId: "copier-sync",
          botName: "Copy Trading Engine",
          userId: "system",
          action: "COPIER_SYNC_FAILED",
          detail: `Copy trade sync error: ${(syncErr as Error).message}`,
        });
      }
    }

    // ── 5-SECOND SUB-TICK LOOP (v2: copier sync wired) ──
    // Runs up to 10 sub-ticks spaced 5s apart, strictly exiting before 50s
    // total runtime so consecutive pg_cron invocations never overlap.
    let evaluatedCount = 0;
    let tradedCount = 0;
    let skippedCount = 0;
    let closedCount = 0;

    const MAX_TICKS = 10;
    for (let tick = 0; tick < MAX_TICKS; tick++) {
      const tickStart = Date.now();
      const elapsed = tickStart - runStartTime;
      if (elapsed > MAX_RUNTIME_MS - TICK_INTERVAL_MS) break;

      // ── (a) Parallel kline fetch for all unique (symbol, interval, isFutures) ──
      const botKlineConfigs = bots.map((b) => ({
        symbol: `${b.coin.toUpperCase()}USDT`,
        interval: getKlineInterval(b.bot_type),
        isFutures: b.market_type === "futures",
      }));
      const klineCache = await fetchKlinesBatch(botKlineConfigs);

      // ── (b) Parallel ticker price fetch for position-exit evaluation ──
      const tickerSyms = [...new Set(
        bots.map((b) => ({
          symbol: `${b.coin.toUpperCase()}USDT`,
          isFutures: b.market_type === "futures",
        })),
      )];
      const priceMap = await fetchTickerPricesAll(tickerSyms);

      // ── (c) Inline position exit: TP/SL/trailing on all open positions ──
      const exitResult = await checkAndClosePositions(adminClient, priceMap, botMarketMap);
      closedCount += exitResult.closed;

      // ── (d) Re-query open positions every tick so bots can't double-enter ──
      const { data: openPosTick } = await adminClient
        .from("positions")
        .select("bot_id")
        .eq("status", "open");

      const botsWithOpenPositions = new Set(
        ((openPosTick as { bot_id: string | null }[]) ?? [])
          .map((p) => p.bot_id)
          .filter(Boolean) as string[],
      );

      // ── (e) Evaluate each bot for new entry on this tick ──
      for (const bot of bots) {
        evaluatedCount++;

        if (botsWithOpenPositions.has(bot.id)) {
          skippedCount++;
          if (tick === 0) {
            results.push({
              botId: bot.id,
              botName: bot.name,
              userId: bot.user_id,
              action: "SKIP",
              detail: "Already has an open position",
            });
          }
          continue;
        }

        // License check
        const license = licenseMap.get(bot.user_id);
        if (!license || !license.is_active) {
          skippedCount++;
          if (tick === 0) {
            results.push({
              botId: bot.id,
              botName: bot.name,
              userId: bot.user_id,
              action: "SKIP",
              detail: "No active license",
            });
          }
          continue;
        }

        // Strategy tier validation — check bot_templates.required_tier against user's plan
        const planName = (license.plan_name ?? "starter").toLowerCase();
        const botStrategyId = (bot as BotRow & { strategy_id?: string }).strategy_id;

        if (botStrategyId) {
          const { data: templateData } = await adminClient
            .from("bot_templates")
            .select("required_tier, strategy_id")
            .or(`strategy_id.eq.${botStrategyId},name.eq.${botStrategyId}`)
            .limit(1)
            .maybeSingle();

          const requiredTier = (templateData as { required_tier?: string } | null)?.required_tier ?? "enterprise";
          const TIER_RANK: Record<string, number> = { starter: 0, pro: 1, enterprise: 2 };
          const PLAN_RANK: Record<string, number> = { starter: 0, pro: 1, enterprise: 2 };
          const planRank = PLAN_RANK[planName] ?? 0;
          const tierRank = TIER_RANK[requiredTier] ?? 2;

          if (planRank < tierRank) {
            skippedCount++;
            if (tick === 0) {
              results.push({
                botId: bot.id,
                botName: bot.name,
                userId: bot.user_id,
                action: "REJECTED",
                detail: `Strategy '${botStrategyId}' locked for plan ${planName} (requires ${requiredTier})`,
              });
            }
            continue;
          }
        }

        // AI sentiment circuit breaker
        if (sentimentBlocked && (bot.trade_direction ?? "long") === "long") {
          skippedCount++;
          if (tick === 0) {
            results.push({
              botId: bot.id,
              botName: bot.name,
              userId: bot.user_id,
              action: "SKIP",
              detail: `AI circuit breaker: long entries blocked (sentiment: ${sentimentClassification})`,
            });
          }
          continue;
        }

        // Leverage cap
        const requestedLeverage = bot.leverage ?? 1;
        if (requestedLeverage > risk.max_leverage) {
          skippedCount++;
          if (tick === 0) {
            results.push({
              botId: bot.id,
              botName: bot.name,
              userId: bot.user_id,
              action: "SKIP",
              detail: `Leverage ${requestedLeverage}x exceeds platform max ${risk.max_leverage}x`,
            });
          }
          continue;
        }

        // Fetch from parallel cache
        const symbol = `${bot.coin.toUpperCase()}USDT`;
        const interval = getKlineInterval(bot.bot_type);
        const isFutures = bot.market_type === "futures";
        const cacheKey = `${symbol}|${interval}|${isFutures}`;
        const candles = klineCache.get(cacheKey) ?? [];

        if (candles.length < 20) {
          skippedCount++;
          if (tick === 0) {
            results.push({
              botId: bot.id,
              botName: bot.name,
              userId: bot.user_id,
              action: "SKIP",
              detail: `Insufficient candle data (${candles.length} candles for ${symbol} ${interval})`,
            });
          }
          continue;
        }

        // Evaluate entry conditions
        const signal = evaluateEntryConditions(bot, candles);

        if (!signal.shouldEnter) {
          skippedCount++;
          if (tick === 0) {
            results.push({
              botId: bot.id,
              botName: bot.name,
              userId: bot.user_id,
              action: "WAIT",
              detail: signal.reason,
              signal: signal.signalType,
            });
          }
          continue;
        }

        // ── Daily Limit Enforcement ──
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const { data: todayClosed } = await adminClient
          .from("positions")
          .select("close_pnl")
          .eq("user_id", bot.user_id)
          .in("status", ["closed_tp", "closed_sl", "closed_manual"])
          .gte("closed_at", todayStart.toISOString());

        const todayRows = (todayClosed as { close_pnl: number | null }[]) ?? [];
        const todayTradeCount = todayRows.length;
        const todayRealizedPnl = todayRows.reduce(
          (sum, r) => sum + (r.close_pnl ?? 0),
          0,
        );

        // ── Risk Calculator Validation ──
        const funds = fundsMap.get(bot.user_id);
        const isPaper = bot.is_paper_mode ?? false;
        const availableBalance = isPaper
          ? "10000"
          : (funds ? funds.balance.toString() : "0");
        const dailyLoss = todayRealizedPnl < 0 ? todayRealizedPnl.toString() : "0";

        const tradeSizing: "fixed_quote" | "percent_balance" | "risk_based" =
          bot.quantity_mode === "percent" ? "percent_balance" : "fixed_quote";
        const sizingValue =
          bot.quantity_mode === "percent"
            ? (bot.percent_value ?? 10).toString()
            : (bot.quantity_value ?? bot.capital ?? 5000).toString();

        const riskConfig: RiskConfig = {
          maxTradesPerDay: bot.max_trades_per_day ?? 20,
          maxDailyLossThreshold: (bot.max_daily_loss ?? 500).toString(),
          maxDrawdownPct: "20",
          tpPct: (bot.take_profit ?? 5).toString(),
          slPct: (bot.stop_loss ?? 2).toString(),
          maxLeverage: risk.max_leverage,
          tradeSizing,
          sizingValue,
          riskPerTradePct: "1",
          maxNotional: "1000000",
          trailingEnabled: bot.trailing_enabled ?? false,
          trailingDistancePct: (bot.trailing_distance ?? 1.5).toString(),
        };

        const currentPrice = candles[candles.length - 1].close.toString();

        const validationCtx: ValidationContext = {
          licenseValid: license.is_active,
          licenseExpiry: license.valid_until,
          botStatus: "active",
          isPaperMode: bot.is_paper_mode ?? false,
          dailyTradeCount: todayTradeCount,
          dailyLoss,
          availableBalance,
          currentDrawdownPct: "0",
        };

        const validation = validateOrder(riskConfig, validationCtx, currentPrice);

        // ── Max Daily Profit Enforcement ──
        if (bot.max_daily_profit && todayRealizedPnl >= bot.max_daily_profit) {
          skippedCount++;
          if (tick === 0) {
            results.push({
              botId: bot.id,
              botName: bot.name,
              userId: bot.user_id,
              action: "REJECTED",
              detail: `Daily profit target reached: ${todayRealizedPnl} >= ${bot.max_daily_profit}`,
              signal: signal.signalType,
            });
          }
          continue;
        }

        if (!validation.approved) {
          skippedCount++;
          if (tick === 0) {
            results.push({
              botId: bot.id,
              botName: bot.name,
              userId: bot.user_id,
              action: "REJECTED",
              detail: `Risk check failed: ${validation.rejections.join(", ")}`,
              signal: signal.signalType,
            });
          }

          if (
            risk.auto_disable_on_breach &&
            (validation.rejections.includes("LICENSE_INVALID") ||
              validation.rejections.includes("LICENSE_EXPIRED"))
          ) {
            await adminClient.from("bots").update({ status: "paused" }).eq("id", bot.id);
          }
          continue;
        }

        // ── Martingale position sizing (if applicable) ──
        let finalSize = validation.computedSize ?? sizingValue;

        if (bot.bot_type === "martingale" && bot.martingale_multiplier && bot.max_martingale_steps) {
          const { data: recentPositions } = await adminClient
            .from("positions")
            .select("close_pnl, status")
            .eq("bot_id", bot.id)
            .in("status", ["closed_tp", "closed_sl", "closed_manual"])
            .order("closed_at", { ascending: false })
            .limit(20);

          const closedPositions = (recentPositions as { close_pnl: number | null; status: string }[]) ?? [];

          if (closedPositions.length > 0) {
            const martingaleConfig: MartingaleConfig = {
              martingale_multiplier: bot.martingale_multiplier,
              max_martingale_steps: bot.max_martingale_steps,
              base_position_size: parseFloat(sizingValue),
              max_drawdown_pct: 20,
            };

            let state = createMartingaleState(martingaleConfig);
            for (const pos of closedPositions.reverse()) {
              const pnl = pos.close_pnl ?? 0;
              const result = processMartingaleResult(state, pnl, martingaleConfig);
              state = result.new_state;
              if (state.halted) break;
            }

            if (state.halted) {
              skippedCount++;
              if (tick === 0) {
                results.push({
                  botId: bot.id,
                  botName: bot.name,
                  userId: bot.user_id,
                  action: "HALTED",
                  detail: `Martingale halted: ${state.halt_reason}`,
                  signal: signal.signalType,
                });
              }
              await adminClient.from("bots").update({ status: "paused" }).eq("id", bot.id);
              continue;
            }

            if (state.current_position_size > 0) {
              finalSize = state.current_position_size.toString();
            }
          }
        }

        // ── Execute the trade ──
        if (compareDecimals(finalSize, "0") > 0) {
          await adminClient.from("bots").update({
            capital: parseFloat(finalSize),
          }).eq("id", bot.id);
        }

        const tradeResult = await triggerTradeExecution(
          supabaseUrl,
          serviceRoleKey,
          bot.id,
          bot.user_id,
          adminClient,
        );

        if (tradeResult.success) {
          tradedCount++;
          results.push({
            botId: bot.id,
            botName: bot.name,
            userId: bot.user_id,
            action: "TRADED",
            detail: `[tick ${tick}] ${signal.signalType} — ${signal.reason} | ${tradeResult.detail}`,
            signal: signal.signalType,
          });
        } else {
          results.push({
            botId: bot.id,
            botName: bot.name,
            userId: bot.user_id,
            action: "TRADE_FAILED",
            detail: `[tick ${tick}] ${signal.signalType} — ${signal.reason} | FAILED: ${tradeResult.detail}`,
            signal: signal.signalType,
          });
        }
      }

      // ── Sleep until next 5-second boundary (unless this is the last tick) ──
      const tickElapsed = Date.now() - tickStart;
      const sleepMs = TICK_INTERVAL_MS - tickElapsed;
      if (sleepMs > 0 && tick < MAX_TICKS - 1) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
    }

    // 7. Scan-complete heartbeat log — ONE summary per cron minute
    const scanDetail = `5s-engine: ${evaluatedCount} evals, ${tradedCount} traded, ${skippedCount} skipped, ${closedCount} positions closed. ` +
      results.filter(r => r.action === "TRADED" || r.action === "TRADE_FAILED").slice(0, 3).map(r => `${r.botName}: ${r.action}`).join("; ");
    const scanBots = [...new Set(bots.map(b => `${b.coin}/${b.bot_type ?? b.strategy}`))].slice(0, 3).join(", ");
    await logApiCall(
      adminClient,
      bots[0]?.user_id ?? "00000000-0000-0000-0000-000000000000",
      bots[0]?.is_paper_mode ? "PAPER" : "EXCHANGE",
      "GET /api/v3/klines",
      "success",
      Math.round(Date.now() - runStartTime),
      `Market scan: ${scanBots} — ${scanDetail}`,
    );

    // 8. Cleanup — delete logs older than 24 hours
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await adminClient.from("broker_api_logs").delete().lt("created_at", cutoff);

    return new Response(JSON.stringify({
      success: true,
      evaluated: evaluatedCount,
      traded: tradedCount,
      skipped: skippedCount,
      closed: closedCount,
      ticks: Math.min(MAX_TICKS, Math.ceil((Date.now() - runStartTime) / TICK_INTERVAL_MS)),
      killSwitchActive: risk.global_kill_switch,
      sentimentCircuitBreaker: sentimentBlocked,
      sentimentClassification,
      timestamp: new Date().toISOString(),
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    // FATAL CRASH LOGGING — ensure the UI shows why the runner failed
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const crashClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      await crashClient.from("broker_api_logs").insert({
        user_id: "00000000-0000-0000-0000-000000000000",
        broker: "CRON",
        endpoint: "POST /functions/v1/strategy-runner",
        status: "error",
        latency_ms: Date.now() - runStartTime,
        detail: `FATAL: ${(err as Error).message}`,
      });
    } catch {
      // If even the error log fails, there's nothing more we can do
    }
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

