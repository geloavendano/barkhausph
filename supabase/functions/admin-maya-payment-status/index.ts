// Authenticated, read-only Maya payment lookup for Barkhaus admins.
// This function never invokes the webhook finalizer and never writes to the
// booking, pending-booking, payment, or payment-event tables.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAdmin } from "../_shared/security.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
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

function statusOf(payment: Record<string, any>): string | null {
  return payment.paymentStatus
    || payment.status
    || payment.state
    || payment.transactionStatus
    || null;
}

function referenceOf(payment: Record<string, any>): string | null {
  return payment.requestReferenceNumber
    || payment.metadata?.refNumber
    || payment.metadata?.ref_number
    || payment.metadata?.bookingRef
    || payment.metadata?.booking_ref
    || payment.referenceNumber
    || null;
}

function amountOf(payment: Record<string, any>): number {
  return Number(
    payment.totalAmount?.value
    ?? payment.totalAmount?.amount
    ?? payment.amount?.value
    ?? payment.amount?.amount
    ?? payment.amount
    ?? 0,
  );
}

function currencyOf(payment: Record<string, any>): string {
  return payment.totalAmount?.currency
    || payment.amount?.currency
    || payment.currency
    || "PHP";
}

function methodOf(payment: Record<string, any>): string | null {
  return payment.paymentScheme
    || payment.paymentMethod
    || payment.fundSource?.type
    || payment.sourceOfFunds?.type
    || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const admin = await requireAdmin(req, supabase);
    const body = await req.json();
    const ref = String(body?.ref || "").trim().toUpperCase();
    if (!/^BH-[A-Z0-9]+$/.test(ref)) return json({ error: "Invalid booking reference" }, 400);

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("id,branch_id,ref_number")
      .eq("ref_number", ref)
      .maybeSingle();
    if (bookingError) throw new Error(bookingError.message);
    if (!booking) return json({ error: "Booking reference not found" }, 404);

    if (
      Array.isArray(admin.branch_ids)
      && admin.branch_ids.length > 0
      && !admin.branch_ids.includes(booking.branch_id)
    ) {
      return json({ error: "You do not have access to this booking's branch" }, 403);
    }

    const mayaSecret = Deno.env.get("MAYA_SECRET_KEY");
    if (!mayaSecret) throw new Error("Maya credentials are not configured");
    const response = await fetch(
      `${mayaBaseUrl()}/payments/v1/payment-rrns/${encodeURIComponent(ref)}`,
      {
        headers: {
          "Authorization": `Basic ${btoa(mayaSecret + ":")}`,
          "Accept": "application/json",
        },
      },
    );
    if (response.status === 404) return json({ ref, transactions: [] });
    if (!response.ok) {
      console.error("Admin Maya lookup failed:", response.status, await response.text());
      return json({ error: "Maya payment lookup failed" }, 502);
    }

    const payload = await response.json();
    const rows = (Array.isArray(payload) ? payload : payload ? [payload] : [])
      .filter((payment: Record<string, any>) =>
        String(referenceOf(payment) || "").trim().toUpperCase() === ref
      )
      .map((payment: Record<string, any>) => ({
        id: payment.id || payment.paymentId || null,
        status: statusOf(payment),
        amount: amountOf(payment),
        currency: currencyOf(payment),
        payment_method: methodOf(payment),
        fund_source: payment.fundSource?.type || payment.sourceOfFunds?.type || null,
        created_at: payment.createdAt || payment.created_at || null,
        updated_at: payment.updatedAt || payment.updated_at || null,
      }))
      .sort((a: Record<string, any>, b: Record<string, any>) =>
        String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""))
      );

    return json({ ref, transactions: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    const status = /Admin authentication|required|Invalid admin session/i.test(message) ? 403 : 500;
    return json({ error: message }, status);
  }
});
