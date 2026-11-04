/*
 * Trigger-Panic-Sell Edge Function — Emergency Global Liquidation
 *
 * When the Kill Switch / Panic Button is activated, this function:
 *   1. Pauses all active bots platform-wide
 *   2. Flips risk_settings.global_kill_switch to true
 *   3. Fetches ALL open positions across ALL users
 *   4. For each position:
 *      a. Paper positions → simulate close with current ticker price
 *      b. Live positions → decrypt broker keys, send MARKET CLOSE to Binance
 *   5. Marks every position as closed_manual with realized P&L
 *   6. Logs every action to broker_api_logs
 *
 * POST body: { mode: "user" | "admin", bot_id?: string }
 *   - "user": liquidates only the caller's positions
 *   - "admin": liquidates ALL users' positions (requires admin role)
 *   - bot_id: if provided, liquidates ONLY positions for that specific bot and stops only that bot
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  ExchangeAdapter,
  deriveVaultKey,
  decryptValue,
  type OrderResponse,
} from "../_shared/exchange-adapter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Decimal math ───

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
  status: string;
  is_paper: boolean;
  exchange_order_id: string | null;
}

interface BotRow {
  id: string;
  market_type: "spot" | "futures";
}

interface BrokerKeyRow {
  user_id: string;
  exchange_name: string;
  api_key: string;
  api_secret: string;
}

// ─── Price Oracle ───

async function fetchTickerPrices(symbols: string[]): Promise<Map<string, number>> {
  const priceMap = new Map<string, number>();
  if (symbols.length === 0) return priceMap;

  const spotSymbols = symbols.filter((s) => !s.includes("_F"));
  const futuresSymbols = symbols.filter((s) => s.includes("_F")).map((s) => s.replace("_F", ""));

  const fetches: Promise<void>[] = [];

  if (spotSymbols.length > 0) {
    fetches.push(
      (async () => {
        try {
          const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(
            JSON.stringify(spotSymbols),
          )}`;
          const resp = await fetch(url);
          if (resp.ok) {
            const data = await resp.json() as Array<{ symbol: string; price: string }>;
            for (const item of data) priceMap.set(item.symbol, parseFloat(item.price));
          }
        } catch { /* non-fatal */ }
      })(),
    );
  }

  if (futuresSymbols.length > 0) {
    fetches.push(
      (async () => {
        try {
          const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbols=${encodeURIComponent(
            JSON.stringify(futuresSymbols),
          )}`;
          const resp = await fetch(url);
          if (resp.ok) {
            const data = await resp.json() as Array<{ symbol: string; price: string }>;
            for (const item of data) priceMap.set(item.symbol + "_F", parseFloat(item.price));
          }
        } catch { /* non-fatal */ }
      })(),
    );
  }

  await Promise.all(fetches);
  return priceMap;
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

    const { data: userData, error: userError } = await adminClient.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const callerUserId = userData.user.id;
    const body = await req.json().catch(() => ({})) as { mode?: string; bot_id?: string };
    const mode = body.mode === "admin" ? "admin" : "user";
    const bot_id = body.bot_id;
    const isTargeted = !!bot_id;
    const modeResolved = mode;

    // For admin mode, verify the caller has an admin role
    if (modeResolved === "admin") {
      const { data: profileData } = await adminClient
        .from("profiles")
        .select("role")
        .eq("id", callerUserId)
        .maybeSingle();
      const role = (profileData as { role?: string } | null)?.role;
      if (role !== "admin" && role !== "super_admin") {
        return new Response(JSON.stringify({ error: "Admin access required for global liquidation" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 1. For global panic: pause bots + activate kill switch immediately.
    //    For targeted bot close: set bot to inactive IMMEDIATELY to prevent
    //    the strategy-runner from opening new positions while we close existing ones.
    //    This also fixes the RUNNING -> closed race condition.
    if (!isTargeted) {
      const botFilter = modeResolved === "admin" ? {} : { user_id: callerUserId };
      await adminClient.from("bots")
        .update({ status: "paused", updated_at: new Date().toISOString() })
        .in("status", ["running", "paper"])
        .match(botFilter);
    } else {
      // Immediately set bot to inactive — DB is source of truth.
      // Positions will be force-closed below regardless of exchange result.
      await adminClient.from("bots")
        .update({ status: "inactive", updated_at: new Date().toISOString() })
        .eq("id", bot_id!);
    }

    // 2. Activate global kill switch (only for global panic, not targeted bot close)
    if (!isTargeted) {
      await adminClient.from("risk_settings")
        .update({ global_kill_switch: true, updated_at: new Date().toISOString() })
        .neq("id", "00000000-0000-0000-0000-000000000000");
    }

    // 3. Fetch open positions (filtered by bot_id if targeted)
    const posQuery = adminClient
      .from("positions")
      .select("*")
      .eq("status", "open");

    if (isTargeted) {
      posQuery.eq("bot_id", bot_id!);
    } else if (modeResolved === "user") {
      posQuery.eq("user_id", callerUserId);
    }

    const { data: positionsData, error: posErr } = await posQuery;

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
        mode: modeResolved,
        bot_id: bot_id ?? null,
        botsPaused: !isTargeted,
        killSwitchActivated: !isTargeted,
        positionsClosed: 0,
        message: isTargeted ? "Bot stopped. No open positions to close." : "Panic sell triggered. No open positions to liquidate.",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Fetch bot configs for market_type
    const botIds = [...new Set(positions.map((p) => p.bot_id).filter(Boolean))] as string[];
    const { data: botsData } = await adminClient
      .from("bots")
      .select("id, market_type")
      .in("id", botIds);
    const botMap = new Map<string, BotRow>();
    for (const b of (botsData as BotRow[]) ?? []) botMap.set(b.id, b);

    // 5. Fetch live prices for all symbols
    const symbolSet = new Set<string>();
    for (const pos of positions) {
      const bot = pos.bot_id ? botMap.get(pos.bot_id) : null;
      const isFutures = bot?.market_type === "futures";
      symbolSet.add(isFutures ? pos.symbol + "_F" : pos.symbol);
    }
    const priceMap = await fetchTickerPrices([...symbolSet]);

    // 6. Fetch all connected broker keys for affected users (admin mode needs all)
    const userIds = [...new Set(positions.map((p) => p.user_id))];
    const { data: brokerKeysData } = await adminClient
      .from("broker_keys")
      .select("user_id, exchange_name, api_key, api_secret")
      .eq("is_connected", true)
      .in("user_id", userIds)
      .order("created_at", { ascending: false });

    // Keep only the most recent key per user
    const brokerKeyMap = new Map<string, BrokerKeyRow>();
    for (const bk of (brokerKeysData as BrokerKeyRow[]) ?? []) {
      if (!brokerKeyMap.has(bk.user_id)) brokerKeyMap.set(bk.user_id, bk);
    }

    const vaultKey = await deriveVaultKey();

    // 7. Liquidate each position
    let closedCount = 0;
    let failedCount = 0;
    const results: Array<{ positionId: string; symbol: string; action: string; detail: string }> = [];

    for (const pos of positions) {
      const bot = pos.bot_id ? botMap.get(pos.bot_id) : null;
      const isFutures = bot?.market_type === "futures";
      const priceKey = isFutures ? pos.symbol + "_F" : pos.symbol;
      const currentPrice = priceMap.get(priceKey);

      const direction: "long" | "short" = pos.side === "BUY" ? "long" : "short";

      if (currentPrice === undefined) {
        // No live price — use entry price as fallback and force-close in DB
        const fallbackPrice = pos.entry_price;
        const noPricePnl = calculatePnl(
          pos.entry_price.toString(),
          fallbackPrice.toString(),
          pos.quantity.toString(),
          direction,
          pos.leverage,
        );
        await adminClient.from("positions").update({
          status: "closed_manual",
          close_price: fallbackPrice,
          close_pnl: parseFloat(noPricePnl),
          closed_at: new Date().toISOString(),
          unrealized_pnl: parseFloat(noPricePnl),
        }).eq("id", pos.id);
        const noPriceCoin = pos.symbol.replace("USDT", "");
        await adminClient.from("trades").update({ status: "closed_manual" })
          .eq("client_id", pos.user_id).eq("coin", noPriceCoin).eq("status", "open");
        await adminClient.from("trade_history").insert({
          user_id: pos.user_id, timestamp: new Date().toISOString(), pair: pos.symbol,
          side: pos.side, amount: pos.quantity, price: fallbackPrice, pnl: parseFloat(noPricePnl),
          strategy: isTargeted ? "bot-close" : "panic-sell",
        });
        closedCount++;
        results.push({ positionId: pos.id, symbol: pos.symbol, action: "CLOSED_DB_ONLY", detail: "No live price, DB force-closed at entry price" });
        continue;
      }

      // Paper positions: simulate close
      if (pos.is_paper) {
        const pnl = calculatePnl(
          pos.entry_price.toString(),
          currentPrice.toString(),
          pos.quantity.toString(),
          direction,
          pos.leverage,
        );

        await adminClient.from("positions").update({
          status: "closed_manual",
          close_price: currentPrice,
          close_pnl: parseFloat(pnl),
          closed_at: new Date().toISOString(),
          unrealized_pnl: parseFloat(pnl),
        }).eq("id", pos.id);

        // Sync close to trades table
        const coinFromSymbol = pos.symbol.replace("USDT", "");
        await adminClient.from("trades").update({
          status: "closed_manual",
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
          price: currentPrice,
          pnl: parseFloat(pnl),
          strategy: isTargeted ? "bot-close" : "panic-sell",
        });

        await adminClient.from("broker_api_logs").insert({
          user_id: pos.user_id,
          broker: "PAPER",
          endpoint: isTargeted ? "/bot-close" : "/panic-close",
          status: "success",
          latency_ms: 0,
          detail: `${isTargeted ? "BOT CLOSE" : "PANIC CLOSE"}: ${pos.symbol} @ ${currentPrice} | pnl=${pnl}`,
        });

        closedCount++;
        results.push({ positionId: pos.id, symbol: pos.symbol, action: "CLOSED", detail: `Paper panic close @ ${currentPrice}` });
        continue;
      }

      // Live positions: send MARKET CLOSE to exchange (best-effort)
      const brokerKey = brokerKeyMap.get(pos.user_id);
      if (!brokerKey) {
        // No broker — force-close in DB using current ticker price
        const noBrokerPnl = calculatePnl(
          pos.entry_price.toString(),
          currentPrice.toString(),
          pos.quantity.toString(),
          direction,
          pos.leverage,
        );
        await adminClient.from("positions").update({
          status: "closed_manual",
          close_price: currentPrice,
          close_pnl: parseFloat(noBrokerPnl),
          closed_at: new Date().toISOString(),
          unrealized_pnl: parseFloat(noBrokerPnl),
        }).eq("id", pos.id);
        const noBrokerCoin = pos.symbol.replace("USDT", "");
        await adminClient.from("trades").update({ status: "closed_manual" })
          .eq("client_id", pos.user_id).eq("coin", noBrokerCoin).eq("status", "open");
        await adminClient.from("trade_history").insert({
          user_id: pos.user_id, timestamp: new Date().toISOString(), pair: pos.symbol,
          side: pos.side, amount: pos.quantity, price: currentPrice, pnl: parseFloat(noBrokerPnl),
          strategy: isTargeted ? "bot-close" : "panic-sell",
        });
        await adminClient.from("broker_api_logs").insert({
          user_id: pos.user_id, broker: "SYSTEM", endpoint: isTargeted ? "/bot-close" : "/panic-close",
          status: "warning", latency_ms: 0,
          detail: `CLOSE: ${pos.symbol} no broker — DB force-closed @ ${currentPrice}`,
        });
        closedCount++;
        results.push({ positionId: pos.id, symbol: pos.symbol, action: "CLOSED_DB_ONLY", detail: "No broker, DB force-closed" });
        continue;
      }

      try {
        const apiKey = await decryptValue(brokerKey.api_key, vaultKey);
        const apiSecret = await decryptValue(brokerKey.api_secret, vaultKey);
        const closeSide = pos.side === "BUY" ? "SELL" : "BUY";

        const adapter = ExchangeAdapter.create(brokerKey.exchange_name);
        const startTime = Date.now();
        const closeResp: OrderResponse = await adapter.closeOrder({
          apiKey,
          apiSecret,
          symbol: pos.symbol,
          side: closeSide,
          marketType: isFutures ? "futures" : "spot",
          reduceOnly: isFutures,
        });
        const latencyMs = Date.now() - startTime;

        // Determine exit price: use exchange fill price on success, fall back to ticker price
        let exitPrice: number;
        let exchangeSucceeded = closeResp.success;

        if (exchangeSucceeded) {
          exitPrice = closeResp.entryPrice > 0 ? closeResp.entryPrice : currentPrice;
        } else {
          await adminClient.from("broker_api_logs").insert({
            user_id: pos.user_id,
            broker: brokerKey.exchange_name,
            endpoint: isTargeted ? "/bot-close" : "/panic-close",
            status: "error",
            latency_ms: latencyMs,
            detail: `PANIC CLOSE exchange error (force-closing in DB): ${closeResp.errorDetail ?? "unknown"}`,
          });
          exitPrice = currentPrice;
        }

        const pnl = calculatePnl(
          pos.entry_price.toString(),
          exitPrice.toString(),
          pos.quantity.toString(),
          direction,
          pos.leverage,
        );

        // ALWAYS update DB — it is the source of truth for the UI
        await adminClient.from("positions").update({
          status: "closed_manual",
          close_price: exitPrice,
          close_pnl: parseFloat(pnl),
          closed_at: new Date().toISOString(),
          unrealized_pnl: parseFloat(pnl),
        }).eq("id", pos.id);

        // Sync close to trades table
        const liveCoinFromSymbol = pos.symbol.replace("USDT", "");
        await adminClient.from("trades").update({
          status: "closed_manual",
        }).eq("client_id", pos.user_id)
          .eq("coin", liveCoinFromSymbol)
          .eq("status", "open");

        // Insert into trade_history for Dashboard P&L
        await adminClient.from("trade_history").insert({
          user_id: pos.user_id,
          timestamp: new Date().toISOString(),
          pair: pos.symbol,
          side: pos.side,
          amount: pos.quantity,
          price: exitPrice,
          pnl: parseFloat(pnl),
          strategy: isTargeted ? "bot-close" : "panic-sell",
        });

        await adminClient.from("broker_api_logs").insert({
          user_id: pos.user_id,
          broker: brokerKey.exchange_name,
          endpoint: isTargeted ? "/bot-close" : "/panic-close",
          status: exchangeSucceeded ? "success" : "warning",
          latency_ms: latencyMs,
          detail: `${isTargeted ? "BOT CLOSE" : "PANIC CLOSE"}: ${pos.symbol} ${closeSide} ${exchangeSucceeded ? "filled" : "DB-forced"}. OrderId: ${closeResp.orderId ?? "N/A"} | pnl=${pnl}`,
        });

        closedCount++;
        results.push({
          positionId: pos.id,
          symbol: pos.symbol,
          action: exchangeSucceeded ? "CLOSED" : "CLOSED_DB_ONLY",
          detail: `Close @ ${exitPrice} (orderId: ${closeResp.orderId ?? "N/A"})${exchangeSucceeded ? "" : " [exchange failed, DB force-closed]"}`,
        });
      } catch (fetchErr) {
        // Network/decryption error — log it but STILL force-close in DB
        await adminClient.from("broker_api_logs").insert({
          user_id: pos.user_id,
          broker: brokerKey.exchange_name,
          endpoint: isTargeted ? "/bot-close" : "/panic-close",
          status: "error",
          latency_ms: 0,
          detail: `PANIC CLOSE network error (force-closing in DB): ${(fetchErr as Error).message}`,
        });

        const fallbackPnl = calculatePnl(
          pos.entry_price.toString(),
          currentPrice.toString(),
          pos.quantity.toString(),
          direction,
          pos.leverage,
        );

        await adminClient.from("positions").update({
          status: "closed_manual",
          close_price: currentPrice,
          close_pnl: parseFloat(fallbackPnl),
          closed_at: new Date().toISOString(),
          unrealized_pnl: parseFloat(fallbackPnl),
        }).eq("id", pos.id);

        const errCoinFromSymbol = pos.symbol.replace("USDT", "");
        await adminClient.from("trades").update({
          status: "closed_manual",
        }).eq("client_id", pos.user_id)
          .eq("coin", errCoinFromSymbol)
          .eq("status", "open");

        await adminClient.from("trade_history").insert({
          user_id: pos.user_id,
          timestamp: new Date().toISOString(),
          pair: pos.symbol,
          side: pos.side,
          amount: pos.quantity,
          price: currentPrice,
          pnl: parseFloat(fallbackPnl),
          strategy: isTargeted ? "bot-close" : "panic-sell",
        });

        closedCount++;
        results.push({ positionId: pos.id, symbol: pos.symbol, action: "CLOSED_DB_ONLY", detail: `Network error, DB force-closed @ ${currentPrice}` });
      }
    }

    // Bot was already set to inactive at the top of the handler to prevent races.
    // No duplicate update needed here.

    return new Response(JSON.stringify({
      success: true,
      mode: modeResolved,
      bot_id: bot_id ?? null,
      botsPaused: !isTargeted,
      killSwitchActivated: !isTargeted,
      positionsClosed: closedCount,
      positionsFailed: failedCount,
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

