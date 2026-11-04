import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface CreateClientRequest {
  email: string;
  password: string;
  fullName: string;
  mobile: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { email, password, fullName, mobile }: CreateClientRequest = await req.json();

    // Verify caller is an authorized admin before proceeding
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerToken = authHeader.replace("Bearer ", "");
    const { data: callerData, error: callerError } = await adminClient.auth.getUser(callerToken);
    if (callerError || !callerData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized — authentication required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: callerRole } = await adminClient
      .from("admin_roles")
      .select("role, is_active")
      .eq("user_id", callerData.user.id)
      .maybeSingle();
    const callerRoleRow = callerRole as { role: string; is_active: boolean } | null;
    const isMasterEmail = callerData.user.email === "vinodbardev@gmail.com";
    const isAuthorizedAdmin =
      isMasterEmail ||
      (callerRoleRow &&
        callerRoleRow.is_active &&
        (callerRoleRow.role === "super_admin" || callerRoleRow.role === "sub_admin"));
    if (!isAuthorizedAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden — only admin users can create client accounts" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!email || !password || !fullName) {
      return new Response(JSON.stringify({ error: "Missing required fields: email, password, fullName" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, mobile_number: mobile },
    });

    if (authError) {
      return new Response(JSON.stringify({ error: authError.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = authData.user.id;

    // Insert profile (upsert in case a trigger already created one)
    const { error: profileError } = await adminClient.from("profiles").upsert({
      id: userId,
      email,
      mobile_number: mobile,
    }, { onConflict: "id" });

    if (profileError) {
      console.error("Profile insert error:", profileError.message);
    }

    // Initialize user funds at zero (upsert to avoid duplicate-key errors)
    const { error: fundError } = await adminClient.from("user_funds").upsert({
      user_id: userId,
      exchange_name: "manual",
      balance: 0,
      unrealized_pnl: 0,
      realized_pnl: 0,
      manual_trading_enabled: false,
    }, { onConflict: "user_id" });

    if (fundError) {
      console.error("Fund insert error:", fundError.message);
    }

    // Create a default starter license so the client appears with valid license info
    const { error: licenseError } = await adminClient.from("licenses").upsert({
      user_id: userId,
      plan_name: "starter",
      is_active: true,
      valid_until: new Date(Date.now() + 30 * 86400000).toISOString(),
      bot_limit: 2,
      allowed_bots: [],
    }, { onConflict: "user_id" });

    if (licenseError) {
      console.error("License insert error:", licenseError.message);
    }

    await adminClient.from("client_updates").insert({
      client_id: userId,
      update_type: "license_update",
      title: "Account Created by Admin",
      message: `Welcome! Your account has been created with a starter plan (30-day trial). An admin can upgrade your license anytime.`,
      severity: "success",
      executed_by: "Master Admin",
    });

    return new Response(JSON.stringify({ success: true, userId }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
