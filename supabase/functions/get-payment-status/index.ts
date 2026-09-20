// Returns the minimal state needed by the hosted-checkout return page.
// The unguessable booking reference is used only to report whether the payment
// webhook has finalized the booking; no owner or booking details are exposed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function mayaBaseUrl(): string {
  return (Deno.env.get("MAYA_ENVIRONMENT") || "sandbox").toLowerCase() === "production"
    ? "https://pg.maya.ph"
    : "https://pg-sandbox.paymaya.com";
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function mayaStatus(payload?: Record<string, any> | null): string | null {
  return payload?.paymentStatus || payload?.status || payload?.state || payload?.transactionStatus || null;
}

function mayaReference(payload?: Record<string, any> | null): string | null {
  return payload?.requestReferenceNumber
    || payload?.metadata?.refNumber
    || payload?.metadata?.ref_number
    || payload?.metadata?.bookingRef
    || payload?.metadata?.booking_ref
    || payload?.referenceNumber
    || null;
}

function isFinalStatus(status?: string | null): boolean {
  return ["PAYMENT_SUCCESS", "PAYMENT_FAILED", "PAYMENT_EXPIRED", "PAYMENT_CANCELLED", "SUCCESS"].includes(status || "");
}

function isSuccessfulMayaStatus(status?: string | null): boolean {
  return status === "PAYMENT_SUCCESS" || status === "SUCCESS";
}

function mayaAmount(payload: Record<string, any>): number {
  const raw = payload?.totalAmount?.value
    ?? payload?.totalAmount?.amount
    ?? payload?.amount?.value
    ?? payload?.amount?.amount
    ?? payload?.amount
    ?? 0;
  return Number(raw);
}

async function lookupMayaPayments(ref: string): Promise<Record<string, any>[]> {
  const mayaSecret = Deno.env.get("MAYA_SECRET_KEY");
  if (!mayaSecret) return [];

  const lookupRes = await fetch(`${mayaBaseUrl()}/payments/v1/payment-rrns/${encodeURIComponent(ref)}`, {
    headers: { "Authorization": `Basic ${btoa(mayaSecret + ":")}`, "Accept": "application/json" },
  });
  if (!lookupRes.ok) {
    console.warn("Maya RRN lookup failed:", lookupRes.status, await lookupRes.text());
    return [];
  }

  const lookupBody = await lookupRes.json();
  return Array.isArray(lookupBody) ? lookupBody : (lookupBody ? [lookupBody] : []);
}

async function lookupMayaPayment(ref: string): Promise<Record<string, any> | null> {
  const payments = await lookupMayaPayments(ref);
  const matching = payments.filter((item) =>
    String(mayaReference(item) || "").trim().toUpperCase() === ref
  );
  const payment = matching.find((item) => isSuccessfulMayaStatus(mayaStatus(item))) || matching[0];
  if (!payment?.id || !isFinalStatus(mayaStatus(payment))) return null;
  return payment;
}

async function nudgeMayaFinalizer(ref: string): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl) return;

  const payment = await lookupMayaPayment(ref);
  if (!payment) return;
  const normalizedPayment = {
    ...payment,
    paymentStatus: mayaStatus(payment),
    requestReferenceNumber: payment.requestReferenceNumber || payment.metadata?.refNumber || payment.metadata?.ref_number || payment.referenceNumber || ref,
  };

  const webhookRes = await fetch(`${supabaseUrl}/functions/v1/handle-payment-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(serviceRoleKey ? { "Authorization": `Bearer ${serviceRoleKey}`, "apikey": serviceRoleKey } : {}),
    },
    body: JSON.stringify(normalizedPayment),
  });
  if (!webhookRes.ok) {
    console.warn("Maya fallback finalizer failed:", webhookRes.status, await webhookRes.text());
  }
}

// ── Orders (2026-09) ─────────────────────────────────────────────────────────
// A hosted checkout can cover several bookings. The ref the customer returns with is the ORDER ref
// (which, for a 1-item order, is also the booking's ref). The page shows one outcome for the order,
// so the children's states have to be summarised into one.
type OrderChild = { ref_number: string; status: string; payment_status: string };
type OrderSummary = { status: string; payment_status: string; confirmed: boolean };

// children: every booking in the order, e.g.
//   [{ ref_number: "BH-3CE089", status: "confirmed", payment_status: "paid" },
//    { ref_number: "BH-9F21AB", status: "pending",   payment_status: "unpaid" }]
// Returns what the confirmation page shows for the whole order. `confirmed: true` makes the page say
// "Booking confirmed" and stop polling; false keeps it waiting (or shows the cancelled state).
function orderStatusFromChildren(children: OrderChild[]): OrderSummary {
  if (children.length === 0) return { status: "cancelled", payment_status: "unpaid", confirmed: false };

  const paid = children.filter((c) => c.status === "confirmed" && c.payment_status === "paid");
  if (paid.length === children.length) return { status: "confirmed", payment_status: "paid", confirmed: true };

  // Still waiting on the payment: keep the page polling rather than showing a verdict too early.
  if (children.some((c) => c.status === "pending" && c.payment_status === "unpaid")) {
    return { status: "pending", payment_status: "unpaid", confirmed: false };
  }

  if (children.every((c) => c.status === "cancelled")) {
    return { status: "cancelled", payment_status: "unpaid", confirmed: false };
  }

  // Mixed and settled (e.g. one booking paid, another cancelled). The customer DID pay, so stop
  // polling and show the confirmation; the page lists each booking with its own state, and the
  // "partial" status lets it flag the ones that need attention.
  return { status: "partial", payment_status: paid.length > 0 ? "paid" : "unpaid", confirmed: paid.length > 0 };
}

async function orderChildren(supabase: any, orderId: string): Promise<OrderChild[]> {
  const { data } = await supabase.from("bookings")
    .select("ref_number,status,payment_status")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  return (data ?? []) as OrderChild[];
}

async function findOrderForRef(supabase: any, ref: string) {
  const { data: byRef } = await supabase.from("booking_orders").select("id,order_ref,amount,status").eq("order_ref", ref).maybeSingle();
  if (byRef) return byRef;
  const { data: booking } = await supabase.from("bookings").select("order_id").eq("ref_number", ref).maybeSingle();
  if (!booking?.order_id) return null;
  const { data: byId } = await supabase.from("booking_orders").select("id,order_ref,amount,status").eq("id", booking.order_id).maybeSingle();
  return byId ?? null;
}

async function bookingStatus(supabase: any, ref: string) {
  return await supabase.from("bookings")
    .select("status,payment_status")
    .eq("ref_number", ref)
    .maybeSingle();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const ref = new URL(req.url).searchParams.get("ref")?.trim().toUpperCase();
  if (!ref || !/^BH-[A-Z0-9]+$/.test(ref)) {
    return json({ error: "Invalid booking reference" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Order path: report on every booking in the order ──────────────────────
  const order = await findOrderForRef(supabase, ref);
  if (order) {
    let children = await orderChildren(supabase, order.id);
    const anyUnpaid = children.some((c) => c.status === "pending" && c.payment_status === "unpaid");
    if (anyUnpaid) {
      const { data: hold } = await supabase.from("pending_bookings")
        .select("payment_provider").eq("order_ref", order.order_ref).limit(1).maybeSingle();
      if (hold?.payment_provider === "maya") {
        // The webhook resolves the order and finalizes every booking in it.
        await nudgeMayaFinalizer(order.order_ref);
        children = await orderChildren(supabase, order.id);
      }
    }
    const summary = orderStatusFromChildren(children);
    return json({
      found: children.length > 0,
      confirmed: summary.confirmed,
      status: summary.status,
      payment_status: summary.payment_status,
      order_ref: order.order_ref,
      bookings: children,
    });
  }

  // ── Legacy single booking (no order row) ──────────────────────────────────
  let { data, error } = await bookingStatus(supabase, ref);
  if (error) return json({ error: "Status lookup failed" }, 500);

  if (data?.status === "pending" && data?.payment_status === "unpaid") {
    const { data: pending } = await supabase.from("pending_bookings")
      .select("payment_provider")
      .eq("ref_number", ref)
      .maybeSingle();
    if (pending?.payment_provider === "maya") {
      await nudgeMayaFinalizer(ref);
      const refreshed = await bookingStatus(supabase, ref);
      if (!refreshed.error) data = refreshed.data;
    }
  }

  if (data?.status === "cancelled" && data?.payment_status === "unpaid") {
    const mayaPayments = await lookupMayaPayments(ref);
    const payment = mayaPayments.find((item) =>
      isSuccessfulMayaStatus(mayaStatus(item))
      && String(mayaReference(item) || "").trim().toUpperCase() === ref
    ) || null;
    const paidAmount = payment ? mayaAmount(payment) : 0;
    if (isSuccessfulMayaStatus(mayaStatus(payment))) {
      const { data: booking } = await supabase.from("bookings")
        .select("id,total")
        .eq("ref_number", ref)
        .maybeSingle();
      if (booking && paidAmount === Number(booking.total)) {
        const { data: existingPayment } = await supabase.from("payments")
          .select("id")
          .eq("reference_number", payment.id)
          .maybeSingle();
        if (!existingPayment) {
          const { error: paymentError } = await supabase.from("payments").insert({
              booking_id: booking.id,
              amount: paidAmount,
              type: "downpayment",
              method: "online",
              reference_number: payment.id,
              notes: `Maya recovery — ${payment.id}`,
              recorded_by: "maya_status_recovery",
          });
          if (paymentError) {
            console.error("Maya paid recovery payment insert failed:", paymentError.message);
            return json({
              found: true,
              confirmed: false,
              status: data.status,
              payment_status: data.payment_status,
            });
          }
        }

        const { error: updateError } = await supabase.from("bookings")
          .update({
            status: "confirmed",
            payment_status: "paid",
            cancellation_reason: null,
          })
          .eq("id", booking.id)
          .eq("status", "cancelled")
          .eq("payment_status", "unpaid");
        if (updateError) {
          console.error("Maya paid recovery update failed:", updateError.message);
        } else {
          await supabase.from("payment_events").insert({
            provider: "maya",
            event_type: mayaStatus(payment),
            payment_status: mayaStatus(payment),
            ref_number: ref,
            booking_id: booking.id,
            gateway_payment_id: payment.id,
            amount: paidAmount,
            currency: payment?.totalAmount?.currency || payment?.currency || "PHP",
            payment_channel: payment?.paymentScheme || payment?.fundSource?.type || null,
            metadata: { source: "get-payment-status-recovery" },
          });
          const refreshed = await bookingStatus(supabase, ref);
          if (!refreshed.error) data = refreshed.data;
        }
      } else {
        console.warn("Maya paid recovery skipped due to amount mismatch:", paidAmount, booking?.total);
      }
    }
  }

  const response: Record<string, unknown> = {
    found: !!data,
    confirmed: data?.status === "confirmed" && data?.payment_status === "paid",
    status: data?.status || null,
    payment_status: data?.payment_status || null,
  };
  return json(response);
});
