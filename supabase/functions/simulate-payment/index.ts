// Barkhaus — simulate-payment edge function (STAGING ONLY)
//
// Barkhaus has no Maya sandbox, so staging fakes the payment result. The tester picks a scenario on
// the staging booking flow and this function posts a Maya-shaped event to the REAL webhook, which
// then runs the same order lookup, confirmation, payment rows and email as a live payment.
//
// It refuses to run against the production database. That check is the project's own id, not a
// setting: production can never satisfy it, whatever env vars are set, and even if this function is
// deployed there by mistake it answers 404. See docs/decisions/2026-09-20-accounts-orders-release.md
//
// POST { ref, scenario }   scenario: "paid" | "failed" | "expired"
//   ref is the order ref (which for a 1-item order is the booking's ref).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PRODUCTION_PROJECT_REF = "dxttnbtfhpanyiyduevn";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function isProductionProject(): boolean {
  return (Deno.env.get("SUPABASE_URL") || "").includes(PRODUCTION_PROJECT_REF);
}

const SCENARIOS: Record<string, string> = {
  paid:    "PAYMENT_SUCCESS",
  failed:  "PAYMENT_FAILED",
  expired: "PAYMENT_EXPIRED",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Layer 1: never on production, whatever the settings say.
  if (isProductionProject()) return json({ error: "Not found" }, 404);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const simulationToken = Deno.env.get("SIMULATION_TOKEN");
  if (!simulationToken) return json({ error: "SIMULATION_TOKEN is not set on this staging project" }, 500);

  try {
    const { ref, scenario } = await req.json();
    const status = SCENARIOS[String(scenario || "paid")];
    if (!status) return json({ error: `Unknown scenario: ${scenario}` }, 400);
    const orderRef = String(ref || "").trim().toUpperCase();
    if (!/^BH-[A-Z0-9-]+$/.test(orderRef)) return json({ error: "Invalid reference" }, 400);

    const supabase = createClient(supabaseUrl, serviceKey);

    // What the customer would have been charged: the order total, or the single hold's amount.
    const { data: order } = await supabase.from("booking_orders")
      .select("id, order_ref, amount").eq("order_ref", orderRef).maybeSingle();
    let amount = order?.amount ?? null;
    if (amount === null) {
      const { data: hold } = await supabase.from("pending_bookings")
        .select("amount").eq("ref_number", orderRef).maybeSingle();
      amount = hold?.amount ?? null;
    }
    if (amount === null) return json({ error: "No pending checkout found for that reference" }, 404);

    // A Maya-shaped event. The webhook accepts it without calling Maya only because this project is
    // not production and the simulation token matches.
    const event = {
      id: `SIM-${crypto.randomUUID()}`,
      isPaid: status === "PAYMENT_SUCCESS",
      status,
      paymentStatus: status,
      requestReferenceNumber: orderRef,
      totalAmount: { value: amount, currency: "PHP" },
      paymentScheme: "SIMULATED",
      metadata: { orderId: order?.id ?? null, orderRef, simulated: true },
    };

    const res = await fetch(`${supabaseUrl}/functions/v1/handle-payment-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-simulated-payment": simulationToken,
        "Authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey,
      },
      body: JSON.stringify(event),
    });
    const webhookBody = await res.json().catch(() => ({}));

    return json({
      simulated: true, scenario, status, ref: orderRef, amount,
      webhook_status: res.status, webhook: webhookBody,
    }, res.ok ? 200 : 502);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
