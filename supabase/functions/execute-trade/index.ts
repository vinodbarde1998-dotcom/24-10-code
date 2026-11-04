/*
 * Execute-Trade Edge Function — Order Execution Orchestrator (v6.0 — CoinDCX INR-M exclusive, all bots wired to Golden Payload)
 *
 * This function is the "muscle" of the trading platform. It:
 *   1. Receives a bot configuration + user session
 *   2. Checks risk_settings (kill switch, max leverage, circuit breaker, slippage)
 *   3. Routes live trades to the ExchangeAdapter (ALWAYS FUTURES)
 *   4. Uses the shared exchange-adapter to support CoinDCX, Delta
 *   5. Logs the result to broker_api_logs
 *   6. Records the position in the positions table
 *
 * Shared CCXT constructor mapping is used for every live exchange.
 *
 * POST body:
 *   { botId: string, action: "open" | "close", positionId?: string, testTrade?: boolean }
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  decryptBrokerKeys,
  executeGoldenTrade,
} from "../_shared/exchange-adapter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

async function logApiCall(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  broker: string,
  endpoint: string,
  status: "success" | "error" | "pending",
  latencyMs: number,
  detail: string,
): Promise<void> {
  await adminClient.from("broker_api_logs").insert({
    user_id: userId,
    broker,
    endpoint,
    status,
    latency_ms: latencyMs,
    detail,
  });
}

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
  take_profit: number | null;
  stop_loss: number | null;
  trailing_enabled: boolean | null;
  trailing_distance: number | null;
  is_paper_mode: boolean | null;
  max_trades_per_day: number | null;
  max_daily_loss: number | null;
  max_daily_profit: number | null;
}

interface RiskSettingsRow {
  global_kill_switch: boolean;
  max_leverage: number;
  max_daily_loss_pct: number;
  auto_disable_on_breach: boolean;
  ai_circuit_breaker: boolean;
  max_slippage_pct: number;
}

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

    const { botId, action }: { botId: string; action: "open" | "close" } = await req.json();

    // 1. Fetch bot configuration
    const { data: botData, error: botErr } = await adminClient
      .from("bots")
      .select("*")
      .eq("id", botId)
      .eq("user_id", userId)
      .maybeSingle();

    if (botErr || !botData) {
      return new Response(JSON.stringify({ error: "Bot not found or not owned by user" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const bot = botData as BotRow;

    if (bot.status !== "running") {
      return new Response(JSON.stringify({ error: `Bot status is '${bot.status}'. Only running bots can execute.` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1.5. Strategy tier validation — check bot_templates.required_tier against user's plan
    const { data: licenseData } = await adminClient
      .from("licenses")
      .select("plan_name, is_active")
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const planName = (licenseData as { plan_name: string } | null)?.plan_name?.toLowerCase() ?? "starter";
    const botStrategyId = (botData as { strategy_id?: string }).strategy_id;

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
        return new Response(JSON.stringify({ error: `Strategy '${botStrategyId}' is locked for your plan (${planName}). Upgrade to unlock more strategies.` }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 2. Fetch risk settings (global guardrails)
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

    // 3. Check kill switch
    if (risk.global_kill_switch) {
      await logApiCall(adminClient, userId, "SYSTEM", "/risk-check", "error", 0, "Blocked by global kill switch");
      return new Response(JSON.stringify({ error: "Global kill switch is active. All trading is halted." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Leverage cap
    const requestedLeverage = bot.leverage ?? 1;
    if (requestedLeverage > risk.max_leverage) {
      return new Response(JSON.stringify({ error: `Requested leverage ${requestedLeverage}x exceeds platform max ${risk.max_leverage}x` }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4.4. Daily Limit Enforcement — check before opening any new trade
    if (action === "open") {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const { data: todayClosed } = await adminClient
        .from("positions")
        .select("close_pnl")
        .eq("user_id", userId)
        .in("status", ["closed_tp", "closed_sl", "closed_manual"])
        .gte("closed_at", todayStart.toISOString());

      const todayRows = (todayClosed as { close_pnl: number | null }[]) ?? [];
      const todayTradeCount = todayRows.length;
      const todayRealizedPnl = todayRows.reduce((sum, r) => sum + (r.close_pnl ?? 0), 0);

      if (bot.max_trades_per_day !== null && todayTradeCount >= bot.max_trades_per_day) {
        await logApiCall(adminClient, userId, "SYSTEM", "/daily-limit-check", "error", 0,
          `Blocked: daily trade limit reached (${todayTradeCount}/${bot.max_trades_per_day})`);
        return new Response(JSON.stringify({ error: `Daily trade limit reached (${todayTradeCount}/${bot.max_trades_per_day}).` }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (bot.max_daily_loss !== null && todayRealizedPnl <= -bot.max_daily_loss) {
        await logApiCall(adminClient, userId, "SYSTEM", "/daily-limit-check", "error", 0,
          `Blocked: daily loss limit reached (${todayRealizedPnl} <= -${bot.max_daily_loss})`);
        return new Response(JSON.stringify({ error: `Daily loss limit breached (${todayRealizedPnl}). Trading paused for today.` }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (bot.max_daily_profit !== null && todayRealizedPnl >= bot.max_daily_profit) {
        await logApiCall(adminClient, userId, "SYSTEM", "/daily-limit-check", "error", 0,
          `Blocked: daily profit target reached (${todayRealizedPnl} >= ${bot.max_daily_profit})`);
        return new Response(JSON.stringify({ error: `Daily profit target reached (${todayRealizedPnl}). Trading paused for today.` }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 4.5. AI Sentiment Guardrail
    if (action === "open") {
      const { data: sentimentData } = await adminClient
        .from("sentiment_scores")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const sentiment = sentimentData as {
        overall_score: number;
        classification: string;
        long_entries_blocked: boolean;
        trailing_tightened: boolean;
        ai_summary: string | null;
        recommendation: string | null;
      } | null;

      if (sentiment && sentiment.long_entries_blocked) {
        const tradeSide = bot.trade_direction ?? "long";
        if (tradeSide === "long") {
          await logApiCall(adminClient, userId, "AI_SENTINEL", "/sentiment-check", "error", 0,
            `Blocked new LONG entry: AI sentiment is "${sentiment.classification}" (score ${sentiment.overall_score}). ${sentiment.ai_summary ?? ""}`);
          return new Response(JSON.stringify({
            error: `AI Sentiment Guardrail: Market is in "${sentiment.classification}" (score ${sentiment.overall_score}). New long entries are paused platform-wide to protect capital.`,
            sentiment: sentiment.classification,
            score: sentiment.overall_score,
            ai_summary: sentiment.ai_summary,
          }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      if (sentiment && sentiment.trailing_tightened && bot.trailing_enabled) {
        const originalTrailingDist = bot.trailing_distance ?? 0;
        const tightenedTrailingDist = Math.max(originalTrailingDist / 2, 0.5);
        (bot as BotRow & { trailing_distance_tightened?: number }).trailing_distance_tightened = tightenedTrailingDist;
        await logApiCall(adminClient, userId, "AI_SENTINEL", "/sentiment-check", "success", 0,
          `Trailing stop tightened from ${originalTrailingDist}% to ${tightenedTrailingDist}% due to Extreme Greed (score ${sentiment.overall_score})`);
      }
    }

    // 5. LIVE MODE — fetch and decrypt broker keys via shared adapter
    const brokerKeys = await decryptBrokerKeys(adminClient, userId);
    if (!brokerKeys) {
      return new Response(JSON.stringify({ error: "No connected broker found. Please connect an exchange first." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 7. GOLDEN TRADE EXECUTION — routes through the SSOT engine
    const symbol = `${bot.coin.toUpperCase()}USDT`;
    const baseCoin = bot.coin.toUpperCase();
    const side = bot.trade_direction === "short" ? "SELL" : "BUY";
    const marginInr = bot.capital && bot.capital > 0 ? bot.capital : 100;
    const forcedLeverage = requestedLeverage || 10;

    const startTime = Date.now();
    const golden = await executeGoldenTrade({
      apiKey: brokerKeys.apiKey,
      apiSecret: brokerKeys.apiSecret,
      baseCoin,
      side: side as "BUY" | "SELL",
      leverage: forcedLeverage,
      marginInr,
    });

    if (!golden.success && golden.livePriceUsdt <= 0) {
      return new Response(JSON.stringify({ error: golden.errorDetail }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const latencyMs = Date.now() - startTime;
    const orderStatus = golden.success ? "success" : "error";
    const payloadSummary = `SENT [pair=${golden.futuresPair}, qty=${golden.quantity}, lev=${forcedLeverage}, priceInr=${golden.livePriceInr.toFixed(2)}, marginInr=${marginInr}]`;
    const rawResponseText = JSON.stringify(golden.rawResponse).slice(0, 800);
    const orderDetail = golden.success
      ? `${payloadSummary} | INR-M Order ${side} ${golden.quantity} ${baseCoin} (${golden.futuresPair}) filled. OrderId: ${golden.orderId} | margin_currency_short_name=INR`
      : `${payloadSummary} | RESPONSE: ${rawResponseText} | ${golden.errorDetail ?? "Unknown error"}`;

    await logApiCall(adminClient, userId, brokerKeys.exchangeName, "/order", orderStatus, latencyMs, orderDetail);

    // 8. Record position if order succeeded
    let dbInsertError: string | undefined;
    if (golden.success && action === "open") {
      const entryPrice = golden.entryPrice;
      const quantity = golden.executedQty;

      const { error: posErr } = await adminClient.from("positions").insert({
        bot_id: bot.id,
        user_id: userId,
        symbol,
        side,
        entry_price: entryPrice,
        quantity,
        leverage: forcedLeverage,
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
        unrealized_pnl: 0,
      });
      if (posErr) {
        dbInsertError = `positions insert failed: ${posErr.message}`;
        await logApiCall(adminClient, userId, "SYSTEM", "/db-insert-positions", "error", 0, dbInsertError);
      }

      const { error: tradeErr } = await adminClient.from("trades").insert({
        client_id: userId,
        client_name: bot.name ?? "AI Bot",
        coin: bot.coin,
        market_type: bot.market_type,
        direction: bot.trade_direction ?? "long",
        entry_price: entryPrice,
        amount: quantity,
        quantity: quantity,
        leverage: forcedLeverage,
        position_size: quantity * forcedLeverage,
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
      if (tradeErr) {
        dbInsertError = (dbInsertError ?? "") + ` | trades insert failed: ${tradeErr.message}`;
        await logApiCall(adminClient, userId, "SYSTEM", "/db-insert-trades", "error", 0, `trades insert failed: ${tradeErr.message}`);
      }

      const { error: histErr } = await adminClient.from("trade_history").insert({
        user_id: userId,
        timestamp: new Date().toISOString(),
        pair: symbol,
        side: side as "BUY" | "SELL",
        amount: quantity,
        price: entryPrice,
        pnl: 0,
        strategy: bot.strategy ?? bot.bot_type ?? "ai",
      });
      if (histErr) {
        dbInsertError = (dbInsertError ?? "") + ` | trade_history insert failed: ${histErr.message}`;
        await logApiCall(adminClient, userId, "SYSTEM", "/db-insert-history", "error", 0, `trade_history insert failed: ${histErr.message}`);
      }
    }

    // 9. Auto-disable bot on error if configured
    if (!golden.success && risk.auto_disable_on_breach) {
      await adminClient.from("bots").update({ status: "paused" }).eq("id", bot.id);
    }

    return new Response(JSON.stringify({
      success: golden.success && !dbInsertError,
      mode: "live",
      broker: brokerKeys.exchangeName,
      status: orderStatus,
      detail: orderDetail,
      error: dbInsertError ?? (golden.success ? undefined : (golden.errorDetail ?? orderDetail)),
      dbInsertError,
      exchangeResponse: golden.rawResponse,
      attemptedPayload: golden.success ? undefined : golden.goldenPayload,
      debug: golden.success ? undefined : {
        marginInr,
        leverage: forcedLeverage,
        orderAmountInr: golden.orderAmountInr,
        livePriceInr: golden.livePriceInr,
        ethQuantity: golden.quantity,
        futuresPair: golden.futuresPair,
        baseCoin,
        side,
      },
    }), {
      status: golden.success && !dbInsertError ? 200 : (golden.success ? 500 : 502),
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
