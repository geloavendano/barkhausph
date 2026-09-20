// Barkhaus — reconcile-maya-bookings edge function
//
// Purpose: never let a paid booking get cancelled, and heal any that already were.
// The expiry cron calls this instead of the pure-SQL expire_pending_bookings():
// Orders (2026-09): Maya only knows the ORDER ref (one payment per hosted checkout), so holds and
// cancelled bookings that belong to an order are grouped by order_ref and checked against the ORDER
// total. Never look an order's booking up by its own ref: Maya returns 404 and that reads as "never
// paid", which is how a paid booking used to get cancelled. Bookings with no order use the old path.
//
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
async function directRecover(
  supabase: any,
  booking: { id: string; ref_number: string; total: number },
  payment: Record<string, any>,
  order?: { amount: number; order_ref: string } | null,
): Promise<boolean> {
  const paid = mayaAmount(payment);
  // The Maya payment covers the whole order; each booking records its own share.
  const expectedTotal = order ? Number(order.amount) : Number(booking.total);
  const bookingShare = Number(booking.total);
  if (paid !== expectedTotal) { console.warn("recover amount mismatch", booking.ref_number, paid, expectedTotal); return false; }
  // Per (payment, booking): every booking in an order shares one payment ID.
  const { data: existing } = await supabase.from("payments").select("id")
    .eq("reference_number", payment.id).eq("booking_id", booking.id).maybeSingle();
  if (!existing) {
    const { error } = await supabase.from("payments").insert({
      booking_id: booking.id, amount: bookingShare, type: "downpayment", method: "online",
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
    // pending_bookings has no FK to bookings, so we join the two in JS by ref_number.
    const nowIso = new Date().toISOString();
    const { data: rawHolds, error: holdErr } = await supabase
      .from("pending_bookings")
      .select("id, ref_number, order_ref")
      .eq("payment_provider", "maya")
      .lte("expires_at", nowIso)
      .limit(limit);
    if (holdErr) out.errors.push({ phase: "holds", error: holdErr.message });

    const pendingByRef = new Map<string, string[]>();
    const orderRefByBookingRef = new Map<string, string>();
    for (const h of rawHolds ?? []) {
      const r = String(h.ref_number).toUpperCase();
      if (!pendingByRef.has(r)) pendingByRef.set(r, []);
      pendingByRef.get(r)!.push(h.id);
      if (h.order_ref) orderRefByBookingRef.set(r, String(h.order_ref).toUpperCase());
    }
    const holdRefs = [...pendingByRef.keys()];

    let holdBookings: any[] = [];
    if (holdRefs.length > 0) {
      const { data: hb, error: hbErr } = await supabase
        .from("bookings")
        .select("id, ref_number, total, status, payment_status, order_id")
        .in("ref_number", holdRefs)
        .eq("status", "pending")
        .eq("payment_status", "unpaid");
      if (hbErr) out.errors.push({ phase: "holds_bookings", error: hbErr.message });
      holdBookings = hb ?? [];
    }

    // Group by order: one Maya lookup and one decision per order (legacy holds group alone).
    const holdGroups = new Map<string, { orderRef: string | null; bookings: any[] }>();
    for (const b of holdBookings) {
      const ref = String(b.ref_number).toUpperCase();
      const orderRef = orderRefByBookingRef.get(ref) ?? null;
      const key = orderRef ?? `booking:${ref}`;
      if (!holdGroups.has(key)) holdGroups.set(key, { orderRef, bookings: [] });
      holdGroups.get(key)!.bookings.push(b);
    }

    for (const [, group] of holdGroups) {
      // What Maya was asked to collect: the order total for an order, the booking total otherwise.
      let lookupRef = String(group.bookings[0].ref_number).toUpperCase();
      let expectedTotal = Number(group.bookings[0].total);
      let order: any = null;
      if (group.orderRef) {
        const { data } = await supabase.from("booking_orders").select("*").eq("order_ref", group.orderRef).maybeSingle();
        if (!data) { out.skipped.push({ ref: group.orderRef, reason: "order_row_missing" }); continue; }
        order = data;
        lookupRef = String(order.order_ref).toUpperCase();
        expectedTotal = Number(order.amount);
      }

      const { reachable, payments } = await mayaRRN(lookupRef);
      const paid = findSuccessfulPayment(lookupRef, expectedTotal, payments);
      const refsInGroup = group.bookings.map((b: any) => String(b.ref_number).toUpperCase());

      if (paid) {
        // Re-invoking the webhook finalizes every hold in the order (or the single legacy hold).
        if (dry) out.finalized.push({ ref: lookupRef, bookings: refsInGroup, payment_id: paid.id, would: true });
        else { const ok = await finalizeViaWebhook(lookupRef, paid); out.finalized.push({ ref: lookupRef, bookings: refsInGroup, payment_id: paid.id, ok }); }
      } else if (reachable) {
        if (dry) out.cancelled.push({ ref: lookupRef, bookings: refsInGroup, would: true });
        else {
          for (const b of group.bookings) {
            await supabase.from("bookings").update({ status: "cancelled", cancellation_reason: "Payment window expired" })
              .eq("id", b.id).eq("status", "pending").eq("payment_status", "unpaid");
            for (const pid of pendingByRef.get(String(b.ref_number).toUpperCase()) ?? []) {
              await supabase.from("pending_bookings").delete().eq("id", pid);
            }
          }
          if (order) {
            await supabase.from("pending_bookings").delete().eq("order_ref", order.order_ref);
            await supabase.from("booking_orders").update({ status: "cancelled", updated_at: new Date().toISOString() })
              .eq("id", order.id).eq("status", "pending");
          }
          out.cancelled.push({ ref: lookupRef, bookings: refsInGroup });
        }
      } else {
        out.skipped.push({ ref: lookupRef, bookings: refsInGroup, reason: "maya_unreachable" });
      }
    }

    // ── Phase 2: recover already-cancelled unpaid online bookings that Maya says are paid ──
    const cutoff = new Date(Date.now() - (sweep ? days * 86400000 : recoverMins * 60000)).toISOString();
    const { data: cancelledRows, error: cxErr } = await supabase
      .from("bookings")
      .select("id, ref_number, total, order_id")
      .eq("booking_source", "online").eq("status", "cancelled").eq("payment_status", "unpaid")
      .gt("created_at", cutoff)
      .limit(limit);
    if (cxErr) out.errors.push({ phase: "recover", error: cxErr.message });

    // Group cancelled bookings by order, so an order is checked once against its own ref and total.
    const cancelledGroups = new Map<string, { order: any | null; bookings: any[] }>();
    const orderIds = [...new Set((cancelledRows ?? []).map((b: any) => b.order_id).filter(Boolean))];
    const ordersById = new Map<string, any>();
    if (orderIds.length > 0) {
      const { data: orderRows } = await supabase.from("booking_orders").select("*").in("id", orderIds);
      for (const o of orderRows ?? []) ordersById.set(o.id, o);
    }
    for (const b of cancelledRows ?? []) {
      const order = b.order_id ? ordersById.get(b.order_id) ?? null : null;
      const key = order ? `order:${order.id}` : `booking:${b.id}`;
      if (!cancelledGroups.has(key)) cancelledGroups.set(key, { order, bookings: [] });
      cancelledGroups.get(key)!.bookings.push(b);
    }

    for (const [, group] of cancelledGroups) {
      const order = group.order;
      const lookupRef = String(order ? order.order_ref : group.bookings[0].ref_number).toUpperCase();
      const expectedTotal = Number(order ? order.amount : group.bookings[0].total);
      const { payments } = await mayaRRN(lookupRef);
      const paid = findSuccessfulPayment(lookupRef, expectedTotal, payments);
      if (!paid) continue;
      for (const b of group.bookings) {
        const ref = String(b.ref_number).toUpperCase();
        if (dry) { out.recovered.push({ ref, order_ref: order?.order_ref ?? null, payment_id: paid.id, amount: mayaAmount(paid), would: true }); continue; }
        const ok = await directRecover(supabase, b, paid, order);
        out.recovered.push({ ref, order_ref: order?.order_ref ?? null, payment_id: paid.id, ok });
      }
      if (!dry && order) {
        await supabase.from("booking_orders")
          .update({ status: "paid", paid_at: new Date().toISOString(), gateway_payment_id: paid.id, updated_at: new Date().toISOString() })
          .eq("id", order.id).neq("status", "paid");
      }
    }

    return json({ ok: true, ...out });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : "Unexpected error", ...out }, 500);
  }
});
