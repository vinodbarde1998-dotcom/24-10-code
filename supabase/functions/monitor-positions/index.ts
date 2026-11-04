/*
 * Monitor-Positions Edge Function — Automated Price & Risk Worker
 *
 * This is the "Eyes" of the trading platform. It runs the evaluation loop
 * that autonomously closes positions when risk thresholds are breached.
 *
 * Flow:
 *   1. Fetches all open positions from the positions table
 *   2. Fetches live ticker prices from Binance for each unique symbol
 *   3. For each position, evaluates:
 *      a. Fixed Take Profit — price hit the TP target
 *      b. Fixed Stop Loss — price hit the SL floor
 *      c. Trailing Stop — dynamically moving stop (uses TrailingStopEngine math)
 *   4. Updates trailing stop state (highest_price, lowest_price, current_stop_loss) in DB
 *   5. If any threshold is breached, closes the position via the exchange API
 *      (paper mode: simulates the close; live mode: sends signed SELL/BUY order)
 *   6. Logs exit reason to broker_api_logs and updates position status to closed
 *
 * Called periodically by the frontend usePositionMonitor hook (every 10s)
 * or by an external cron/scheduler.
 *
 * POST body: { } (uses the authenticated user's session)
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  decryptBrokerKeys,
  fetchLivePriceUsdt,
  placeCoinDcxInrMFuturesOrder,
} from "../_shared/exchange-adapter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Decimal math (inline copies of RiskCalculator primitives) ───

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

// ─── P&L calculation ───

function calculatePnl(
  entryPrice: string,
  exitPrice: string,
  quantity: string,
  direction: "long" | "short",
  leverage: number,
): string {
  const priceDiff = direction === "long"
    ? subtractDecimals(exitPrice, entryPrice)
    : subtractDecimals(entryPrice, exitPrice);
  const grossPnl = multiplyDecimals(priceDiff, quantity);
  return multiplyDecimals(grossPnl, leverage.toString());
}

// ─── Types ───

interface PositionRow {
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
  current_stop_loss: number | null;
  highest_price: number | null;
  lowest_price: number | null;
  unrealized_pnl: number;
  status: string;
  is_paper: boolean;
  exchange_order_id: string | null;
  fixed_profit: number | null;
  fixed_loss: number | null;
  max_trades_per_day: number | null;
  max_daily_loss: number | null;
  max_daily_profit: number | null;
  trailing_stop_loss_pct: number | null;
}

interface BotRow {
  id: string;
  user_id: string;
  market_type: "spot" | "futures";
  coin: string;
  trade_direction: "long" | "short" | null;
  order_type: "market" | "limit" | null;
}

// ─── Price Oracle (uses SSOT fetchLivePriceUsdt from exchange-adapter) ───

async function fetchTickerPrices(symbols: string[]): Promise<Map<string, number>> {
  const priceMap = new Map<string, number>();
  if (symbols.length === 0) return priceMap;

  await Promise.all(symbols.map(async (symbol) => {
    const cleanSymbol = symbol.replace(/_F$/, "");
    const baseCoin = cleanSymbol.replace(/(USDT|INR)$/, "").replace(/^B-/, "");
    try {
      const price = await fetchLivePriceUsdt(baseCoin);
      if (Number.isFinite(price) && price > 0) {
        priceMap.set(symbol, price);
      }
    } catch {
      // A missing ticker is retried during the next monitoring cycle.
    }
  }));
  return priceMap;
}

// ─── Trailing Stop Evaluation ───

interface TrailingUpdate {
  newStopLoss: string;
  newHighest: string;
  newLowest: string;
  wasMoved: boolean;
  shouldTrigger: boolean;
  reason: string;
}

function evaluateTrailingStop(
  direction: "long" | "short",
  currentPriceStr: string,
  highestPriceStr: string,
  lowestPriceStr: string,
  currentStopLossStr: string,
  trailingDistancePctStr: string,
): TrailingUpdate {
  const distPct = divideDecimals(trailingDistancePctStr, "100", 18);

  if (direction === "long") {
    const newHighest = compareDecimals(currentPriceStr, highestPriceStr) > 0
      ? currentPriceStr
      : highestPriceStr;

    const trailingAmount = multiplyDecimals(newHighest, distPct);
    const proposedStop = subtractDecimals(newHighest, trailingAmount);

    const wasMoved = compareDecimals(proposedStop, currentStopLossStr) > 0;
    const newStopLoss = wasMoved ? proposedStop : currentStopLossStr;
    const shouldTrigger = compareDecimals(currentPriceStr, newStopLoss) <= 0;

    return {
      newStopLoss: normalizeDecimal(newStopLoss),
      newHighest,
      newLowest: lowestPriceStr,
      wasMoved,
      shouldTrigger,
      reason: wasMoved
        ? `Trailing stop moved up to ${newStopLoss} (high: ${newHighest})`
        : shouldTrigger
        ? `Price ${currentPriceStr} hit trailing stop ${newStopLoss}`
        : "No movement",
    };
  } else {
    const newLowest = compareDecimals(currentPriceStr, lowestPriceStr) < 0
      ? currentPriceStr
      : lowestPriceStr;

    const trailingAmount = multiplyDecimals(newLowest, distPct);
    const proposedStop = addDecimals(newLowest, trailingAmount);

    const wasMoved = compareDecimals(proposedStop, currentStopLossStr) < 0;
    const newStopLoss = wasMoved ? proposedStop : currentStopLossStr;
    const shouldTrigger = compareDecimals(currentPriceStr, newStopLoss) >= 0;

    return {
      newStopLoss: normalizeDecimal(newStopLoss),
      newHighest: highestPriceStr,
      newLowest,
      wasMoved,
      shouldTrigger,
      reason: wasMoved
        ? `Trailing stop moved down to ${newStopLoss} (low: ${newLowest})`
        : shouldTrigger
        ? `Price ${currentPriceStr} hit trailing stop ${newStopLoss}`
        : "No movement",
    };
  }
}

// ─── Close Position via Exchange ───

async function closePositionOnExchange(
  adminClient: ReturnType<typeof createClient>,
  position: PositionRow,
  _bot: BotRow | null,
  exitPrice: number,
  exitReason: string,
): Promise<{ success: boolean; detail: string }> {
  const userId = position.user_id;

  // Paper mode — simulate close
  if (position.is_paper) {
    const pnl = calculatePnl(
      position.entry_price.toString(),
      exitPrice.toString(),
      position.quantity.toString(),
      position.side === "BUY" ? "long" : "short",
      position.leverage,
    );

    const closeStatus = exitReason.includes("PROFIT") ? "closed_tp" : exitReason.includes("STOP_LOSS") || exitReason.includes("TRAILING_STOP_LOSS") ? "closed_sl" : "closed_manual";

    await adminClient.from("positions").update({
      status: closeStatus,
      close_price: exitPrice,
      close_pnl: parseFloat(pnl),
      closed_at: new Date().toISOString(),
      unrealized_pnl: parseFloat(pnl),
    }).eq("id", position.id);

    // Sync the matching trade row to closed status
    const coinFromSymbol = position.symbol.replace(/USDT$/, "");
    await adminClient.from("trades").update({
      status: closeStatus,
    }).eq("client_id", userId).eq("coin", coinFromSymbol).eq("status", "open").limit(1);

    await adminClient.from("broker_api_logs").insert({
      user_id: userId,
      broker: "PAPER",
      endpoint: "/simulated-close",
      status: "success",
      latency_ms: 0,
      detail: `PAPER CLOSE: ${position.symbol} @ ${exitPrice} | reason=${exitReason} | pnl=${pnl}`,
    });

    return { success: true, detail: `Paper position closed: ${exitReason}` };
  }

  // Live mode — fetch and decrypt broker keys via shared adapter
  const brokerKeys = await decryptBrokerKeys(adminClient, userId);
  if (!brokerKeys) {
    return { success: false, detail: "No connected broker found for close order" };
  }

  const closeSide = position.side === "BUY" ? "SELL" : "BUY";
  const baseCoin = position.symbol.replace(/USDT$/, "").replace(/^B-/, "");

  const startTime = Date.now();

  try {
    const closeResp = await placeCoinDcxInrMFuturesOrder({
      apiKey: brokerKeys.apiKey,
      apiSecret: brokerKeys.apiSecret,
      base: baseCoin,
      side: closeSide,
      leverage: position.leverage,
      ethQuantity: position.quantity,
      inrAmount: position.quantity * exitPrice,
    });

    const latencyMs = Date.now() - startTime;
    const closeStatus = closeResp.success ? "success" : "error";
    const closeDetail = closeResp.success
      ? `Close order ${closeSide} ${position.quantity} ${position.symbol} filled. OrderId: ${closeResp.orderId}`
      : `Close order failed: ${closeResp.errorDetail ?? "unknown error"}`;

    await adminClient.from("broker_api_logs").insert({
      user_id: userId,
      broker: brokerKeys.exchangeName,
      endpoint: "/auto-close",
      status: closeStatus,
      latency_ms: latencyMs,
      detail: `${closeDetail} | reason=${exitReason}`,
    });

    if (!closeResp.success) {
      return { success: false, detail: closeDetail };
    }

    const finalExitPrice = closeResp.entryPrice > 0 ? closeResp.entryPrice : exitPrice;

    // Update position on success
    const pnl = calculatePnl(
      position.entry_price.toString(),
      finalExitPrice.toString(),
      position.quantity.toString(),
      position.side === "BUY" ? "long" : "short",
      position.leverage,
    );

    const closeStatusValue = exitReason.includes("PROFIT") ? "closed_tp" : exitReason.includes("STOP_LOSS") || exitReason.includes("TRAILING_STOP_LOSS") ? "closed_sl" : "closed_manual";

    await adminClient.from("positions").update({
      status: closeStatusValue,
      close_price: finalExitPrice,
      close_pnl: parseFloat(pnl),
      closed_at: new Date().toISOString(),
      unrealized_pnl: parseFloat(pnl),
    }).eq("id", position.id);

    const coinFromSymbol = position.symbol.replace(/USDT$/, "");
    await adminClient.from("trades").update({
      status: closeStatusValue,
    }).eq("client_id", userId).eq("coin", coinFromSymbol).eq("status", "open").limit(1);

    // Record in trade_history
    await adminClient.from("trade_history").insert({
      user_id: userId,
      timestamp: new Date().toISOString(),
      pair: position.symbol,
      side: closeSide as "BUY" | "SELL",
      amount: position.quantity,
      price: finalExitPrice,
      pnl: parseFloat(pnl),
      strategy: exitReason,
    });

    return { success: true, detail: closeDetail };
  } catch (fetchErr) {
    const latencyMs = Date.now() - startTime;
    const closeDetail = `Network error on close: ${(fetchErr as Error).message}`;
    await adminClient.from("broker_api_logs").insert({
      user_id: userId,
      broker: brokerKeys.exchangeName,
      endpoint: "/auto-close",
      status: "error",
      latency_ms: latencyMs,
      detail: `${closeDetail} | reason=${exitReason}`,
    });
    return { success: false, detail: closeDetail };
  }
}

// ─── Main Handler ───

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userData, error: userError } = await adminClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    // 1. Fetch all open positions for this user
    const { data: positionsData, error: posErr } = await adminClient
      .from("positions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "open");

    if (posErr) {
      return new Response(JSON.stringify({ error: posErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const positions = (positionsData as PositionRow[]) ?? [];
    if (positions.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        monitored: 0,
        closed: 0,
        trailingUpdates: 0,
        message: "No open positions to monitor",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Fetch bot configs for all positions (need market_type, trade_direction)
    const botIds = [...new Set(positions.map((p) => p.bot_id).filter(Boolean))] as string[];
    const { data: botsData } = await adminClient
      .from("bots")
      .select("id, user_id, market_type, coin, trade_direction, order_type")
      .in("id", botIds);

    const botMap = new Map<string, BotRow>();
    for (const b of (botsData as BotRow[]) ?? []) {
      botMap.set(b.id, b);
    }

    // 3. Fetch live prices for all unique symbols
    // For futures positions, we append _F to the symbol to distinguish the price source
    const symbolSet = new Set<string>();
    for (const pos of positions) {
      const bot = pos.bot_id ? botMap.get(pos.bot_id) : null;
      const isFutures = bot?.market_type === "futures";
      symbolSet.add(isFutures ? pos.symbol + "_F" : pos.symbol);
    }
    const priceMap = await fetchTickerPrices([...symbolSet]);

    // 4. Evaluate each position
    let closedCount = 0;
    let trailingUpdateCount = 0;
    const results: Array<{ positionId: string; symbol: string; action: string; detail: string }> = [];

    for (const pos of positions) {
      const bot = pos.bot_id ? botMap.get(pos.bot_id) : null;
      const isFutures = bot?.market_type === "futures";
      const priceKey = isFutures ? pos.symbol + "_F" : pos.symbol;
      const currentPrice = priceMap.get(priceKey);

      if (currentPrice === undefined) {
        results.push({
          positionId: pos.id,
          symbol: pos.symbol,
          action: "SKIP",
          detail: "No live price available",
        });
        continue;
      }

      const currentPriceStr = currentPrice.toString();
      const entryPriceStr = pos.entry_price.toString();
      const direction: "long" | "short" = pos.side === "BUY" ? "long" : "short";

      // ── Evaluate Fixed Take Profit ──
      let shouldClose = false;
      let exitReason = "";
      let exitPrice = currentPrice;

      if (pos.take_profit_pct && pos.take_profit_pct > 0) {
        const tpPctStr = pos.take_profit_pct.toString();
        const tpDecimal = divideDecimals(tpPctStr, "100", 18);
        const tpTarget = direction === "long"
          ? addDecimals(entryPriceStr, multiplyDecimals(entryPriceStr, tpDecimal))
          : subtractDecimals(entryPriceStr, multiplyDecimals(entryPriceStr, tpDecimal));

        if (direction === "long" && compareDecimals(currentPriceStr, tpTarget) >= 0) {
          shouldClose = true;
          exitReason = "TAKE_PROFIT_HIT";
        } else if (direction === "short" && compareDecimals(currentPriceStr, tpTarget) <= 0) {
          shouldClose = true;
          exitReason = "TAKE_PROFIT_HIT";
        }
      }

      // ── Evaluate Fixed Stop Loss ──
      if (!shouldClose && pos.stop_loss_pct && pos.stop_loss_pct > 0) {
        const slPctStr = pos.stop_loss_pct.toString();
        const slDecimal = divideDecimals(slPctStr, "100", 18);
        const slFloor = direction === "long"
          ? subtractDecimals(entryPriceStr, multiplyDecimals(entryPriceStr, slDecimal))
          : addDecimals(entryPriceStr, multiplyDecimals(entryPriceStr, slDecimal));

        if (direction === "long" && compareDecimals(currentPriceStr, slFloor) <= 0) {
          shouldClose = true;
          exitReason = "STOP_LOSS_HIT";
        } else if (direction === "short" && compareDecimals(currentPriceStr, slFloor) >= 0) {
          shouldClose = true;
          exitReason = "STOP_LOSS_HIT";
        }
      }

      // ── Evaluate Trailing Stop ──
      if (!shouldClose && pos.trailing_enabled && pos.trailing_distance_pct && pos.trailing_distance_pct > 0) {
        const highestStr = (pos.highest_price ?? pos.entry_price).toString();
        const lowestStr = (pos.lowest_price ?? pos.entry_price).toString();
        const currentStopStr = (pos.current_stop_loss ?? pos.entry_price).toString();
        const trailingDistStr = pos.trailing_distance_pct.toString();

        const trailingResult = evaluateTrailingStop(
          direction,
          currentPriceStr,
          highestStr,
          lowestStr,
          currentStopStr,
          trailingDistStr,
        );

        // Update trailing stop state in DB if moved
        if (trailingResult.wasMoved || trailingResult.shouldTrigger) {
          await adminClient.from("positions").update({
            current_stop_loss: parseFloat(trailingResult.newStopLoss),
            highest_price: parseFloat(trailingResult.newHighest),
            lowest_price: parseFloat(trailingResult.newLowest),
            updated_at: new Date().toISOString(),
          }).eq("id", pos.id);

          trailingUpdateCount++;
        }

        if (trailingResult.shouldTrigger) {
          shouldClose = true;
          exitReason = "TRAILING_STOP_HIT";
        }
      }

      // ── Evaluate Trailing Stop Loss (absolute % from peak) ──
      // This is the advanced risk control from the trades table — it works
      // identically to trailing_distance_pct but uses the separate
      // trailing_stop_loss_pct column for compatibility with manual trades.
      if (!shouldClose && pos.trailing_stop_loss_pct && pos.trailing_stop_loss_pct > 0) {
        const tslPctStr = pos.trailing_stop_loss_pct.toString();
        const tslDecimal = divideDecimals(tslPctStr, "100", 18);
        const highestStr = (pos.highest_price ?? pos.entry_price).toString();
        const lowestStr = (pos.lowest_price ?? pos.entry_price).toString();
        const currentStopStr = (pos.current_stop_loss ?? pos.entry_price).toString();

        if (direction === "long") {
          const newHighest = compareDecimals(currentPriceStr, highestStr) > 0 ? currentPriceStr : highestStr;
          const tslAmount = multiplyDecimals(newHighest, tslDecimal);
          const proposedStop = subtractDecimals(newHighest, tslAmount);
          const wasMoved = compareDecimals(proposedStop, currentStopStr) > 0;
          const newStopLoss = wasMoved ? proposedStop : currentStopStr;
          const shouldTrigger = compareDecimals(currentPriceStr, newStopLoss) <= 0;

          if (wasMoved || shouldTrigger) {
            await adminClient.from("positions").update({
              current_stop_loss: parseFloat(newStopLoss),
              highest_price: parseFloat(newHighest),
              updated_at: new Date().toISOString(),
            }).eq("id", pos.id);
            trailingUpdateCount++;
          }

          if (shouldTrigger) {
            shouldClose = true;
            exitReason = "TRAILING_STOP_LOSS_HIT";
          }
        } else {
          const newLowest = compareDecimals(currentPriceStr, lowestStr) < 0 ? currentPriceStr : lowestStr;
          const tslAmount = multiplyDecimals(newLowest, tslDecimal);
          const proposedStop = addDecimals(newLowest, tslAmount);
          const wasMoved = compareDecimals(proposedStop, currentStopStr) < 0;
          const newStopLoss = wasMoved ? proposedStop : currentStopStr;
          const shouldTrigger = compareDecimals(currentPriceStr, newStopLoss) >= 0;

          if (wasMoved || shouldTrigger) {
            await adminClient.from("positions").update({
              current_stop_loss: parseFloat(newStopLoss),
              lowest_price: parseFloat(newLowest),
              updated_at: new Date().toISOString(),
            }).eq("id", pos.id);
            trailingUpdateCount++;
          }

          if (shouldTrigger) {
            shouldClose = true;
            exitReason = "TRAILING_STOP_LOSS_HIT";
          }
        }
      }

      // ── Evaluate Fixed Profit Target (absolute amount) ──
      if (!shouldClose && pos.fixed_profit && pos.fixed_profit > 0) {
        const currentPnl = calculatePnl(
          entryPriceStr,
          currentPriceStr,
          pos.quantity.toString(),
          direction,
          pos.leverage,
        );
        if (compareDecimals(currentPnl, pos.fixed_profit.toString()) >= 0) {
          shouldClose = true;
          exitReason = "FIXED_PROFIT_TARGET_HIT";
        }
      }

      // ── Evaluate Fixed Loss Stop (absolute amount) ──
      if (!shouldClose && pos.fixed_loss && pos.fixed_loss > 0) {
        const currentPnl = calculatePnl(
          entryPriceStr,
          currentPriceStr,
          pos.quantity.toString(),
          direction,
          pos.leverage,
        );
        if (compareDecimals(currentPnl, "-" + pos.fixed_loss.toString()) <= 0) {
          shouldClose = true;
          exitReason = "FIXED_LOSS_STOP_HIT";
        }
      }

      // ── Update unrealized P&L for open positions ──
      if (!shouldClose) {
        const pnl = calculatePnl(
          entryPriceStr,
          currentPriceStr,
          pos.quantity.toString(),
          direction,
          pos.leverage,
        );
        await adminClient.from("positions").update({
          unrealized_pnl: parseFloat(pnl),
          updated_at: new Date().toISOString(),
        }).eq("id", pos.id);
      }

      // ── Close position if threshold breached ──
      if (shouldClose) {
        const closeResult = await closePositionOnExchange(
          adminClient,
          pos,
          bot,
          exitPrice,
          exitReason,
        );

        if (closeResult.success) {
          closedCount++;
          results.push({
            positionId: pos.id,
            symbol: pos.symbol,
            action: "CLOSED",
            detail: `${exitReason} @ ${exitPrice} — ${closeResult.detail}`,
          });
        } else {
          results.push({
            positionId: pos.id,
            symbol: pos.symbol,
            action: "CLOSE_FAILED",
            detail: closeResult.detail,
          });
        }
      } else if (!shouldClose) {
        results.push({
          positionId: pos.id,
          symbol: pos.symbol,
          action: "MONITORED",
          detail: `Price: ${currentPrice} — within limits`,
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      monitored: positions.length,
      closed: closedCount,
      trailingUpdates: trailingUpdateCount,
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
