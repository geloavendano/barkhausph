// Barkhaus — payment-health edge function
// Read-only health probe for the external monitoring canary (GitHub Actions).
// Gated by a shared secret in the `x-health-token` header (PAYMENT_HEALTH_TOKEN
// env var) so the endpoint can't be scraped — it exposes only non-PII counts.
//
// Returns: { ok, checked_at, stale_pending, stale_refs[], cron_job_present,
//            cron_last_status, cron_last_run, cron_recent_failures }
// `ok` is false when there are stale pending bookings or the expiry cron is
// missing / failing — the canary exits non-zero (and notifies) on `ok=false`.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-health-token",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const expected = Deno.env.get("PAYMENT_HEALTH_TOKEN");
  const provided = req.headers.get("x-health-token");
  if (!expected || !provided || provided !== expected) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data, error } = await supabase.rpc("payment_health");
    if (error) throw new Error(error.message);

    const h = (data ?? {}) as Record<string, unknown>;
    // Healthy = no stranded bookings AND the cron exists and its LAST run didn't
    // fail. cron_recent_failures stays in the payload for visibility but is NOT a
    // hard gate — otherwise the check stays red for up to an hour after a broken
    // cron is fixed, while the old failures age out of the 1-hour window.
    const ok =
      Number(h.stale_pending ?? 0) === 0 &&
      h.cron_job_present === true &&
      h.cron_last_status !== "failed";

    return new Response(JSON.stringify({ ok, ...h }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "Unexpected error" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
