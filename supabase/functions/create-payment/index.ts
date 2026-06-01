// Barkhaus — create-payment edge function
// Creates a pending booking row + PayMongo checkout session; returns checkout_url (hosted page).
// success_url and cancel_url handle redirect back to booking.html

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PAYMONGO_BASE = "https://api.paymongo.com/v1";
const SITE_URL      = "https://geloavendano.github.io/barkhausph";

const LOCATION_MAP: Record<string, string> = {
  estancia: "Estancia",
  eastwood: "Eastwood",
};

/** Booking CREATION date (UTC, matches created_at::date).
 *  The SERVICE date now lives in each service's detail table as `service_date`
 *  (grooming_details/daycare_details/studio_details), mirroring how hotel uses
 *  checkin_date/checkout_date. So booking_date means "when the booking was made"
 *  for every service. create-payment doesn't insert detail rows — the webhook
 *  does that after payment — so service_date is set there. */
function bookingDate(): string {
  return new Date().toISOString().split("T")[0];
}

function serviceLineName(body: Record<string, unknown>): string {
  const svc = body.service as string;
  if (svc === "grooming") {
    const g = (body.groomServiceName as string) || "";
    return g ? `Grooming – ${g}` : "Grooming";
  }
  return { hotel: "Pet Hotel Stay", daycare: "Daycare", studio: "Self-Shoot Studio" }[svc]
    ?? "Barkhaus Booking";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const secretKey = Deno.env.get("PAYMONGO_SECRET_KEY")!;
    if (!secretKey) throw new Error("PAYMONGO_SECRET_KEY not configured");

    const body = await req.json();

    // ── Validate required fields ──
    for (const f of ["service","petName","ownerFirst","ownerLast","ownerEmail","ownerPhone","total"]) {
      if (!body[f]) return new Response(
        JSON.stringify({ error: `Missing required field: ${f}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const total          = parseInt(body.total)          || 0;
    const subtotal       = parseInt(body.subtotal)       || total;
    const discountAmount = parseInt(body.discountAmount) || 0;
    const convenienceFee = parseInt(body.convenienceFee) || 0;

    if (total <= 0) return new Response(
      JSON.stringify({ error: "Invalid payment amount" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

    // ── 1. Resolve branch ──
    const branchName = LOCATION_MAP[body.location as string];
    if (!branchName) return new Response(
      JSON.stringify({ error: `Unknown location: ${body.location}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
    const { data: branch, error: branchErr } = await supabase
      .from("branches")
      .select("id")
      .ilike("name", branchName)
      .single();
    if (branchErr || !branch) throw new Error(`Branch not found: ${branchName}`);

    // ── 2. Upsert owner ──
    const email = (body.ownerEmail as string).trim().toLowerCase();
    let ownerId: string;

    const { data: existingOwner } = await supabase
      .from("owners").select("id").ilike("email", email).maybeSingle();

    if (existingOwner) {
      ownerId = existingOwner.id;
      await supabase.from("owners").update({
        first_name:      body.ownerFirst,
        last_name:       body.ownerLast,
        mobile:          body.ownerPhone,
        referral_source: body.ownerSource || null,
      }).eq("id", ownerId);
    } else {
      const { data: newOwner, error: ownerErr } = await supabase
        .from("owners").insert({
          first_name:      body.ownerFirst,
          last_name:       body.ownerLast,
          email,
          mobile:          body.ownerPhone,
          referral_source: body.ownerSource || null,
        }).select("id").single();
      if (ownerErr || !newOwner) throw new Error(`Failed to create owner: ${ownerErr?.message}`);
      ownerId = newOwner.id;
    }

    // ── 3. Upsert pet ──
    const petName = (body.petName as string).trim();
    let petId: string;

    const { data: existingPet } = await supabase
      .from("pets").select("id")
      .eq("owner_id", ownerId).ilike("name", petName).maybeSingle();

    if (existingPet) {
      petId = existingPet.id;
      await supabase.from("pets").update({
        animal_type:   body.petAnimal       || null,
        gender:        body.petGender       || null,
        breed:         body.petBreed        || null,
        age_value:     body.petAge ? parseInt(body.petAge as string) : null,
        age_unit:      body.petAgeUnit      || null,
        size:          body.petSize         || null,
        medical_notes: body.petMedical      || null,
        temperament:   body.petTemperament  || null,
      }).eq("id", petId);
    } else {
      const { data: newPet, error: petErr } = await supabase
        .from("pets").insert({
          owner_id:      ownerId,
          name:          petName,
          animal_type:   body.petAnimal       || null,
          gender:        body.petGender       || null,
          breed:         body.petBreed        || null,
          age_value:     body.petAge ? parseInt(body.petAge as string) : null,
          age_unit:      body.petAgeUnit      || null,
          size:          body.petSize         || null,
          medical_notes: body.petMedical      || null,
          temperament:   body.petTemperament  || null,
        }).select("id").single();
      if (petErr || !newPet) throw new Error(`Failed to create pet: ${petErr?.message}`);
      petId = newPet.id;
    }

    // ── 4. Create booking row (status = pending) ──
    // We generate a candidate ref, but the bookings table may have a DEFAULT or
    // trigger on ref_number that overrides it. We therefore read back the value
    // the database actually stored and treat THAT as authoritative for every
    // downstream use (pending_bookings, PayMongo metadata, success/cancel URLs,
    // the email ref). Otherwise the customer-facing ref would diverge from the
    // ref persisted in the DB / shown in admin.
    let refNumber = "BH-" + Math.random().toString(36).substr(2, 6).toUpperCase();

    const { data: newBooking, error: bookingErr } = await supabase
      .from("bookings").insert({
        ref_number:              refNumber,
        branch_id:               branch.id,
        owner_id:                ownerId,
        pet_id:                  petId,
        service:                 body.service,
        status:                  "pending",
        payment_status:          "unpaid",
        booking_date:            bookingDate(),   // ← creation date (service date lives in detail tables)
        subtotal,
        discount_amount:         discountAmount,
        total,
        member_discount_applied: discountAmount > 0,
        member_code_used:        discountAmount > 0 ? (body.membershipId as string) || null : null,
        booking_source:          "online",
      }).select("id, ref_number").single();
    if (bookingErr || !newBooking) throw new Error(`Failed to create booking: ${bookingErr?.message}`);
    const bookingId = newBooking.id;

    // Authoritative ref — use whatever the DB actually persisted (handles any
    // ref_number DEFAULT/trigger that overrode our inserted value).
    if (newBooking.ref_number && newBooking.ref_number !== refNumber) {
      console.warn(`ref_number overridden by DB: inserted ${refNumber}, stored ${newBooking.ref_number}`);
      refNumber = newBooking.ref_number;
    }

    // ── 5. Store full payload in pending_bookings (webhook uses this to create child records) ──
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString(); // 20-min window
    await supabase.from("pending_bookings").insert({
      ref_number: refNumber,
      payload:    body,
      amount:     total,
      expires_at: expiresAt,
    });

    // ── 6. Build PayMongo line items ──
    const serviceAmount = subtotal - discountAmount;
    const lineItems: object[] = [{
      currency:    "PHP",
      amount:      serviceAmount * 100,
      name:        serviceLineName(body),
      description: discountAmount > 0
        ? `${body.petName} — Member discount applied (−₱${discountAmount})`
        : String(body.petName),
      quantity: 1,
    }];
    if (convenienceFee > 0) {
      lineItems.push({
        currency: "PHP", amount: convenienceFee * 100,
        name: "Convenience Fee", description: "Online booking fee", quantity: 1,
      });
    }

    const ownerName   = `${body.ownerFirst} ${body.ownerLast}`.trim();
    const svcLabel    = { grooming:"Grooming", hotel:"Pet Hotel", daycare:"Daycare", studio:"Studio" }[body.service as string] ?? body.service;
    const description = `Barkhaus ${svcLabel} — ${body.petName} (${ownerName}) — Ref: ${refNumber}`;

    // ── 7. Create PayMongo checkout session ──
    const pmRes = await fetch(`${PAYMONGO_BASE}/checkout_sessions`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Basic ${btoa(secretKey + ":")}`,
      },
      body: JSON.stringify({ data: { attributes: {
        line_items:           lineItems,
        payment_method_types: ["qrph","card","dob","paymaya","gcash","grab_pay"],
        success_url: `${SITE_URL}/booking.html?payment=success&ref=${refNumber}`,
        cancel_url:  `${SITE_URL}/booking.html?payment=cancelled&ref=${refNumber}`,
        reference_number: refNumber,
        description,
        billing: { name: ownerName, email: body.ownerEmail, phone: body.ownerPhone },
        // metadata is read by handle-payment-webhook to reliably match the booking
        metadata: { ref_number: refNumber, booking_id: bookingId, service: body.service },
        statement_descriptor: "BARKHAUS",
      }}}),
    });

    const pmData = await pmRes.json();

    if (!pmRes.ok) {
      console.error("PayMongo error:", JSON.stringify(pmData));
      // Roll back — remove the booking and pending record since payment setup failed
      await supabase.from("bookings").delete().eq("id", bookingId);
      await supabase.from("pending_bookings").delete().eq("ref_number", refNumber);
      throw new Error(pmData?.errors?.[0]?.detail || "Failed to create checkout session");
    }

    const sessionId   = pmData.data.id;
    const checkoutUrl = pmData.data.attributes.checkout_url;

    // Store the PayMongo session ID so the webhook can match by paymongo_link_id
    await supabase.from("pending_bookings")
      .update({ paymongo_link_id: sessionId })
      .eq("ref_number", refNumber);

    console.log(`Booking ${bookingId} | Session ${sessionId} | Ref ${refNumber}`);

    return new Response(
      JSON.stringify({ success: true, checkout_url: checkoutUrl, ref_number: refNumber, booking_id: bookingId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("create-payment error:", err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
