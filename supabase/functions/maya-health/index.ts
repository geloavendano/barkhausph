// Read-only Maya connectivity probe for external uptime monitoring.
// It looks up the latest Maya reference already recorded in payment_events and
// verifies that Maya's authenticated payment lookup API returns a valid response.
// It never creates a checkout or modifies booking/payment state.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-health-token",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function mayaBaseUrl(): string {
  return (Deno.env.get("MAYA_ENVIRONMENT") || "sandbox").toLowerCase() === "production"
    ? "https://pg.maya.ph"
    : "https://pg-sandbox.paymaya.com";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const expected = Deno.env.get("BETTERSTACK_HEALTH_TOKEN");
  const provided = req.headers.get("x-health-token");
  if (!expected || !provided || provided !== expected) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  try {
    const mayaSecret = Deno.env.get("MAYA_SECRET_KEY");
    if (!mayaSecret) return json({ ok: false, error: "maya_secret_missing" }, 503);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: event, error } = await supabase
      .from("payment_events")
      .select("ref_number")
      .eq("provider", "maya")
      .not("ref_number", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!event?.ref_number) return json({ ok: false, error: "no_maya_reference" }, 503);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(
        `${mayaBaseUrl()}/payments/v1/payment-rrns/${encodeURIComponent(event.ref_number)}`,
        {
          headers: {
            "Authorization": `Basic ${btoa(mayaSecret + ":")}`,
            "Accept": "application/json",
          },
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
    }

    const latencyMs = Date.now() - startedAt;
    const payload = response.ok ? await response.json().catch(() => null) : null;
    const validPayload = Array.isArray(payload) ? payload.length > 0 : !!payload;
    if (!response.ok || !validPayload) {
      return json({
        ok: false,
        error: "maya_lookup_failed",
        api_status: response.status,
        latency_ms: latencyMs,
      }, 503);
    }

    return json({
      ok: true,
      checked_at: new Date().toISOString(),
      api_status: response.status,
      latency_ms: latencyMs,
    });
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error ? error.message : "unexpected_error",
    }, 503);
  }
});
