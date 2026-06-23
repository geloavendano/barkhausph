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

function isFinalStatus(status?: string | null): boolean {
  return ["PAYMENT_SUCCESS", "PAYMENT_FAILED", "PAYMENT_EXPIRED", "PAYMENT_CANCELLED", "SUCCESS"].includes(status || "");
}

function isSuccessfulMayaStatus(status?: string | null): boolean {
  return status === "PAYMENT_SUCCESS" || status === "SUCCESS";
}

function mayaAmount(payload: Record<string, any>): number {
  return Number(payload?.totalAmount?.value ?? payload?.totalAmount?.amount ?? payload?.amount ?? 0);
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
  const payment = payments.find((item) => isSuccessfulMayaStatus(mayaStatus(item))) || payments[0];
  if (!payment?.id || !isFinalStatus(mayaStatus(payment))) return null;
  return payment;
}

async function nudgeMayaFinalizer(ref: string): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) return;

  const payment = await lookupMayaPayment(ref);
  if (!payment) return;

  const webhookRes = await fetch(`${supabaseUrl}/functions/v1/handle-payment-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payment, paymentStatus: mayaStatus(payment) }),
  });
  if (!webhookRes.ok) {
    console.warn("Maya fallback finalizer failed:", webhookRes.status, await webhookRes.text());
  }
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
    const payment = mayaPayments.find((item) => isSuccessfulMayaStatus(mayaStatus(item))) || mayaPayments[0] || null;
    const paidAmount = payment ? mayaAmount(payment) : 0;
    if (isSuccessfulMayaStatus(mayaStatus(payment))) {
      const { data: booking } = await supabase.from("bookings")
        .select("id,total")
        .eq("ref_number", ref)
        .maybeSingle();
      if (booking && paidAmount === Number(booking.total)) {
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
          const { data: existingPayment } = await supabase.from("payments")
            .select("id")
            .eq("reference_number", payment.id)
            .maybeSingle();
          if (!existingPayment) {
            await supabase.from("payments").insert({
              booking_id: booking.id,
              amount: paidAmount,
              type: "downpayment",
              method: "online",
              reference_number: payment.id,
              notes: `Maya recovery — ${payment.id}`,
              recorded_by: "maya_status_recovery",
            });
          }
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
