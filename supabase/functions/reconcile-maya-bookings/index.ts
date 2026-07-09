// Barkhaus — reconcile-maya-bookings edge function
//
// Purpose: never let a paid booking get cancelled, and heal any that already were.
// The expiry cron calls this instead of the pure-SQL expire_pending_bookings():
//   1) Expiring pending holds (provider=maya): ask Maya first.
//        - Maya shows a successful payment (amount matches) → finalize (re-invoke the
//          webhook: confirm + paid + payment row + charges + email + clears the hold).
//        - Maya reachable & no matching success → cancel + release the hold (old behavior).
//        - Maya UNREACHABLE → skip; retry next tick. Never cancel a maybe-paid booking.
//   2) Recently-cancelled unpaid online bookings → re-check Maya and recover paid ones
//      (mirrors the get-payment-status cancelled-recovery path). Widen with ?sweep=1.
//
// Auth: x-reconcile-token header must equal RECONCILE_TOKEN (deploy --no-verify-jwt).
// Query params:
//   dry=1            report what WOULD happen, mutate nothing (safe preview)
//   sweep=1          widen the cancelled-recovery scan to `days`
//   days=N           lookback for sweep (default 3, max 120)
//   recoverMins=N    lookback for the default (non-sweep) cancelled-recovery (default 120)
//   limit=N          max rows per phase (default 200, max 1000)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-reconcile-token",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function mayaBaseUrl(): string {
  return (Deno.env.get("MAYA_ENVIRONMENT") || "sandbox").toLowerCase() === "production"
    ? "https://pg.maya.ph" : "https://pg-sandbox.paymaya.com";
}
function mayaStatus(p?: Record<string, any> | null): string | null {
  return p?.paymentStatus || p?.status || p?.state || p?.transactionStatus || null;
}
function mayaReference(p?: Record<string, any> | null): string | null {
  return p?.requestReferenceNumber || p?.metadata?.refNumber || p?.metadata?.ref_number
    || p?.metadata?.bookingRef || p?.metadata?.booking_ref || p?.referenceNumber || null;
}
function mayaAmount(p: Record<string, any>): number {
  const raw = p?.totalAmount?.value ?? p?.totalAmount?.amount ?? p?.amount?.value
    ?? p?.amount?.amount ?? p?.amount ?? 0;
  return Number(raw);
}
function isSuccess(s?: string | null): boolean { return s === "PAYMENT_SUCCESS" || s === "SUCCESS"; }

// Reachability matters: only cancel a hold when Maya is reachable and shows no success.
async function mayaRRN(ref: string): Promise<{ reachable: boolean; payments: Record<string, any>[] }> {
  const secret = Deno.env.get("MAYA_SECRET_KEY");
  if (!secret) return { reachable: false, payments: [] };
  try {
    const res = await fetch(`${mayaBaseUrl()}/payments/v1/payment-rrns/${encodeURIComponent(ref)}`, {
      headers: { "Authorization": `Basic ${btoa(secret + ":")}`, "Accept": "application/json" },
    });
    if (res.status === 404) return { reachable: true, payments: [] };  // no payment ever attempted
    if (!res.ok) { console.warn("Maya RRN lookup failed:", res.status); return { reachable: false, payments: [] }; }
    const body = await res.json();
    return { reachable: true, payments: Array.isArray(body) ? body : (body ? [body] : []) };
  } catch (e) {
    console.warn("Maya RRN lookup error:", e instanceof Error ? e.message : e);
    return { reachable: false, payments: [] };
  }
}
function findSuccessfulPayment(ref: string, total: number, payments: Record<string, any>[]): Record<string, any> | null {
  const matching = payments.filter((p) =>
    String(mayaReference(p) || "").trim().toUpperCase() === ref && isSuccess(mayaStatus(p)));
  return matching.find((p) => p.id && mayaAmount(p) === Number(total)) || null;
}

// Finalize a still-pending booking by re-invoking the webhook (full finalize + email).
async function finalizeViaWebhook(ref: string, payment: Record<string, any>): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url) return false;
  const normalized = {
    ...payment,
    paymentStatus: mayaStatus(payment),
    requestReferenceNumber: mayaReference(payment) || ref,
  };
  const res = await fetch(`${url}/functions/v1/handle-payment-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Authorization": `Bearer ${key}`, "apikey": key } : {}) },
    body: JSON.stringify(normalized),
  });
  if (!res.ok) console.warn("finalizeViaWebhook failed:", res.status, await res.text());
  return res.ok;
}

// Recover an already-cancelled booking directly (no pending row to re-invoke the webhook with).
async function directRecover(supabase: any, booking: { id: string; ref_number: string; total: number }, payment: Record<string, any>): Promise<boolean> {
  const paid = mayaAmount(payment);
  if (paid !== Number(booking.total)) { console.warn("recover amount mismatch", booking.ref_number, paid, booking.total); return false; }
  const { data: existing } = await supabase.from("payments").select("id").eq("reference_number", payment.id).maybeSingle();
  if (!existing) {
    const { error } = await supabase.from("payments").insert({
      booking_id: booking.id, amount: paid, type: "downpayment", method: "online",
      reference_number: payment.id, notes: `Maya reconcile — ${payment.id}`, recorded_by: "maya_reconcile",
    });
    if (error) { console.error("recover payment insert failed", booking.ref_number, error.message); return false; }
  }
  const { data: claimed, error: upErr } = await supabase.from("bookings")
    .update({ status: "confirmed", payment_status: "paid", cancellation_reason: null })
    .eq("id", booking.id).eq("status", "cancelled").eq("payment_status", "unpaid")
    .select("id").maybeSingle();
  if (upErr) { console.error("recover update failed", booking.ref_number, upErr.message); return false; }
  if (claimed) {
    await supabase.from("payment_events").insert({
      provider: "maya", event_type: mayaStatus(payment), payment_status: mayaStatus(payment),
      ref_number: booking.ref_number, booking_id: booking.id, gateway_payment_id: payment.id,
      amount: paid, currency: payment?.totalAmount?.currency || payment?.currency || "PHP",
      payment_channel: payment?.paymentScheme || payment?.fundSource?.type || null,
      metadata: { source: "reconcile-maya-bookings" },
    });
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const expected = Deno.env.get("RECONCILE_TOKEN");
  if (!expected || req.headers.get("x-reconcile-token") !== expected) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const sweep = url.searchParams.get("sweep") === "1";
  const days = Math.min(120, Math.max(1, parseInt(url.searchParams.get("days") || "3", 10) || 3));
  const recoverMins = Math.max(5, parseInt(url.searchParams.get("recoverMins") || "120", 10) || 120);
  const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10) || 200));

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const out = { dry, sweep, finalized: [] as any[], cancelled: [] as any[], recovered: [] as any[], skipped: [] as any[], errors: [] as any[] };

  try {
    // ── Phase 1: expiring pending holds — check Maya before cancelling ──
    const nowIso = new Date().toISOString();
    const { data: holds, error: holdErr } = await supabase
      .from("pending_bookings")
      .select("id, ref_number, bookings!inner(id, total, status, payment_status)")
      .eq("payment_provider", "maya")
      .lte("expires_at", nowIso)
      .eq("bookings.status", "pending")
      .eq("bookings.payment_status", "unpaid")
      .limit(limit);
    if (holdErr) out.errors.push({ phase: "holds", error: holdErr.message });

    for (const h of holds ?? []) {
      const b = Array.isArray(h.bookings) ? h.bookings[0] : h.bookings;
      const ref = String(h.ref_number).toUpperCase();
      const { reachable, payments } = await mayaRRN(ref);
      const paid = findSuccessfulPayment(ref, b.total, payments);
      if (paid) {
        if (dry) out.finalized.push({ ref, payment_id: paid.id, would: true });
        else { const ok = await finalizeViaWebhook(ref, paid); out.finalized.push({ ref, payment_id: paid.id, ok }); }
      } else if (reachable) {
        if (dry) out.cancelled.push({ ref, would: true });
        else {
          await supabase.from("bookings").update({ status: "cancelled", cancellation_reason: "Payment window expired" })
            .eq("id", b.id).eq("status", "pending").eq("payment_status", "unpaid");
          await supabase.from("pending_bookings").delete().eq("id", h.id);
          out.cancelled.push({ ref });
        }
      } else {
        out.skipped.push({ ref, reason: "maya_unreachable" });
      }
    }

    // ── Phase 2: recover already-cancelled unpaid online bookings that Maya says are paid ──
    const cutoff = new Date(Date.now() - (sweep ? days * 86400000 : recoverMins * 60000)).toISOString();
    const { data: cancelledRows, error: cxErr } = await supabase
      .from("bookings")
      .select("id, ref_number, total")
      .eq("booking_source", "online").eq("status", "cancelled").eq("payment_status", "unpaid")
      .gt("created_at", cutoff)
      .limit(limit);
    if (cxErr) out.errors.push({ phase: "recover", error: cxErr.message });

    for (const b of cancelledRows ?? []) {
      const ref = String(b.ref_number).toUpperCase();
      const { payments } = await mayaRRN(ref);
      const paid = findSuccessfulPayment(ref, b.total, payments);
      if (paid) {
        if (dry) out.recovered.push({ ref, payment_id: paid.id, amount: mayaAmount(paid), would: true });
        else { const ok = await directRecover(supabase, b, paid); out.recovered.push({ ref, payment_id: paid.id, ok }); }
      }
    }

    return json({ ok: true, ...out });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : "Unexpected error", ...out }, 500);
  }
});
