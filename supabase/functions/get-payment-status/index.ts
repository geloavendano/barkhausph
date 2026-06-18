// Returns the minimal state needed by the hosted-checkout return page.
// The unguessable booking reference is used only to report whether the payment
// webhook has finalized the booking; no owner or booking details are exposed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const ref = new URL(req.url).searchParams.get("ref")?.trim().toUpperCase();
  if (!ref || !/^BH-[A-Z0-9]+$/.test(ref)) {
    return new Response(JSON.stringify({ error: "Invalid booking reference" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data, error } = await supabase.from("bookings")
    .select("status,payment_status")
    .eq("ref_number", ref)
    .maybeSingle();

  if (error) return new Response(JSON.stringify({ error: "Status lookup failed" }), {
    status: 500, headers: { ...CORS, "Content-Type": "application/json" },
  });

  return new Response(JSON.stringify({
    found: !!data,
    confirmed: data?.status === "confirmed" && data?.payment_status === "paid",
    status: data?.status || null,
    payment_status: data?.payment_status || null,
  }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
});
