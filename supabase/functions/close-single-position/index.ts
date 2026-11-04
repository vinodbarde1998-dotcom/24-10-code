/*
 * Close-Single-Position Edge Function — Manual Square-Off (v3)
 *
 * Executes a REVERSE MARKET ORDER on CoinDCX first. Only if the exchange
 * confirms the close, the DB is updated to closed_manual.
 *
 * POST body: { position_id: string }
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

function calculatePnl(entryPrice: number, exitPrice: number, quantity: number, direction: "long" | "short", leverage: number): number {
  const priceDiff = direction === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return priceDiff * quantity * leverage;
}

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

    const { data: userData, error: userError } = await adminClient.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const callerUserId = userData.user.id;
    const body = await req.json().catch(() => ({})) as { position_id?: string };
    const position_id = body.position_id;

    if (!position_id) {
      return new Response(JSON.stringify({ error: "position_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: posData, error: posErr } = await adminClient
      .from("positions")
      .select("*")
      .eq("id", position_id)
      .maybeSingle();

    if (posErr || !posData) {
      return new Response(JSON.stringify({ error: "Position not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const pos = posData as PositionRow;

    if (pos.status !== "open") {
      return new Response(JSON.stringify({ error: "Position is already closed" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify ownership (unless admin)
    const { data: profileData } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", callerUserId)
      .maybeSingle();
    const role = (profileData as { role?: string } | null)?.role;
    const isAdmin = role === "admin" || role === "super_admin";

    if (!isAdmin && pos.user_id !== callerUserId) {
      return new Response(JSON.stringify({ error: "You can only close your own positions" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const direction: "long" | "short" = pos.side === "BUY" ? "long" : "short";
    const closeSide: "BUY" | "SELL" = pos.side === "BUY" ? "SELL" : "BUY";
    const baseCoin = pos.symbol.replace(/USDT$/, "").replace(/^B-/, "");
    const coinFromSymbol = pos.symbol.replace("USDT", "");

    // Fetch live price for PnL calculation
    let currentPrice: number = pos.entry_price;
    try {
      const livePrice = await fetchLivePriceUsdt(baseCoin);
      if (livePrice > 0) currentPrice = livePrice;
    } catch { /* fallback to entry price */ }

    // ── Paper positions: simulate close without exchange ──
    if (pos.is_paper) {
      const pnl = calculatePnl(pos.entry_price, currentPrice, pos.quantity, direction, pos.leverage);
      await adminClient.from("positions").update({
        status: "closed_manual", close_price: currentPrice, close_pnl: pnl,
        closed_at: new Date().toISOString(), unrealized_pnl: pnl,
      }).eq("id", pos.id);
      await adminClient.from("trades").update({ status: "closed_manual" })
        .eq("client_id", pos.user_id).eq("coin", coinFromSymbol).eq("status", "open");
      await adminClient.from("trade_history").insert({
        user_id: pos.user_id, timestamp: new Date().toISOString(), pair: pos.symbol,
        side: closeSide, amount: pos.quantity, price: currentPrice, pnl,
        strategy: "manual-exit",
      });
      return new Response(JSON.stringify({
        success: true, position_id: pos.id, action: "CLOSED",
        detail: `Paper square-off @ ${currentPrice}`, pnl,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Live positions: MUST place reverse order on CoinDCX FIRST ──
    const brokerKeys = await decryptBrokerKeys(adminClient, pos.user_id);
    if (!brokerKeys) {
      return new Response(JSON.stringify({
        error: "No connected broker found. Cannot square off — connect an exchange first.",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let exchangeOrderId = "";
    let exchangeSucceeded = false;
    let exchangeDetail = "";

    try {
      const closeResp = await placeCoinDcxInrMFuturesOrder({
        apiKey: brokerKeys.apiKey,
        apiSecret: brokerKeys.apiSecret,
        base: baseCoin,
        side: closeSide,
        leverage: pos.leverage,
        ethQuantity: pos.quantity,
        inrAmount: pos.quantity * currentPrice,
        reduceOnly: true,
      });

      if (closeResp.success) {
        exchangeSucceeded = true;
        exchangeOrderId = closeResp.orderId;
        if (closeResp.entryPrice > 0) currentPrice = closeResp.entryPrice;
        exchangeDetail = `CoinDCX close filled. OrderId: ${exchangeOrderId}`;
        await adminClient.from("broker_api_logs").insert({
          user_id: pos.user_id, broker: brokerKeys.exchangeName,
          endpoint: "/square-off", status: "success", latency_ms: 0,
          detail: `SQUARE OFF: ${pos.symbol} ${closeSide} ${pos.quantity} filled. OrderId: ${exchangeOrderId}`,
        });
      } else {
        exchangeDetail = closeResp.errorDetail ?? "Unknown CoinDCX error";
        await adminClient.from("broker_api_logs").insert({
          user_id: pos.user_id, broker: brokerKeys.exchangeName,
          endpoint: "/square-off", status: "error", latency_ms: 0,
          detail: `SQUARE OFF FAILED: ${exchangeDetail}`,
        });
        return new Response(JSON.stringify({
          success: false,
          error: `CoinDCX close order failed: ${exchangeDetail}`,
        }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    } catch (exchangeErr) {
      exchangeDetail = `Exchange error: ${(exchangeErr as Error).message}`;
      await adminClient.from("broker_api_logs").insert({
        user_id: pos.user_id, broker: brokerKeys.exchangeName,
        endpoint: "/square-off", status: "error", latency_ms: 0,
        detail: `SQUARE OFF network error: ${exchangeDetail}`,
      });
      return new Response(JSON.stringify({
        success: false,
        error: `CoinDCX close order failed: ${exchangeDetail}`,
      }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── STEP B: ONLY if CoinDCX succeeded, update the DB ──
    const pnl = calculatePnl(pos.entry_price, currentPrice, pos.quantity, direction, pos.leverage);

    const { error: posUpdateErr } = await adminClient.from("positions").update({
      status: "closed_manual", close_price: currentPrice, close_pnl: pnl,
      closed_at: new Date().toISOString(), unrealized_pnl: pnl,
    }).eq("id", pos.id);

    if (posUpdateErr) {
      await adminClient.from("broker_api_logs").insert({
        user_id: pos.user_id, broker: "SYSTEM",
        endpoint: "/square-off-db", status: "error", latency_ms: 0,
        detail: `positions update failed: ${posUpdateErr.message}`,
      });
      return new Response(JSON.stringify({
        success: false,
        error: `Exchange closed but DB update failed: ${posUpdateErr.message}`,
      }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    await adminClient.from("trades").update({ status: "closed_manual" })
      .eq("client_id", pos.user_id).eq("coin", coinFromSymbol).eq("status", "open");

    await adminClient.from("trade_history").insert({
      user_id: pos.user_id, timestamp: new Date().toISOString(), pair: pos.symbol,
      side: closeSide, amount: pos.quantity, price: currentPrice, pnl,
      strategy: "manual-exit",
    });

    // Admin audit log
    if (isAdmin && pos.user_id !== callerUserId) {
      await adminClient.from("admin_activity_log").insert({
        admin_id: callerUserId, admin_email: userData.user.email ?? "admin",
        action_type: "admin_action", severity: "warning",
        message: `Admin squared off position ${pos.symbol} for user ${pos.user_id} | pnl=${pnl}`,
      });
    }

    return new Response(JSON.stringify({
      success: true, position_id: pos.id, action: "CLOSED",
      detail: `Square-off @ ${currentPrice} (orderId: ${exchangeOrderId})`,
      pnl,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
