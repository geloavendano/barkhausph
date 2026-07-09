// Barkhaus — create-maya-checkout edge function
// Creates a pending booking row + Maya Checkout session; returns checkout_url.
// success_url and cancel_url handle redirect back to booking.html

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { randomToken, sha256 } from "../_shared/security.ts";
import { assertHostedInventory, inventoryLockKey } from "../_shared/inventory.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SITE_URL = Deno.env.get("SITE_URL") || "https://barkhaus.ph";

function mayaBaseUrl(): string {
  return (Deno.env.get("MAYA_ENVIRONMENT") || "sandbox").toLowerCase() === "production"
    ? "https://pg.maya.ph"
    : "https://pg-sandbox.paymaya.com";
}

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

// Add-on display names (mirror submit-booking / handle-payment-webhook) so the
// breakdown reads the same regardless of booking source or finalization path.
const ADDON_NAMES: Record<string, string> = {
  nail_trim:       "Nail Trim and Filing",
  ear_clean:       "Ear Cleaning",
  teeth:           "Teeth Brushing",
  sanitary:        "Sanitary Clean",
  antitick:        "Anti-tick and Flea Bath",
  whitening:       "Whitening Bath",
  paw_pads:        "Paw Pads Trim",
  anal_gland:      "Anal Gland Expression",
  face_trim:       "Face Trim",
  deshed:          "Deshedding",
  demat:           "Dematting",
  premium_shampoo: "Premium Shampoo",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let supabase: any = null;
  let mutexKey: string | null = null;
  let mutexToken: string | null = null;
  let createdBookingId: string | null = null;
  let createdDetailTable: string | null = null;
  let createdRefNumber: string | null = null;
  try {
    supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const publicKey = Deno.env.get("MAYA_PUBLIC_KEY")!;
    if (!publicKey) throw new Error("MAYA_PUBLIC_KEY not configured");

    const body = await req.json();
    const accepted = (value: unknown) => value === true || value === "true";
    if (!accepted(body.waiverHouseRules)) {
      return new Response(JSON.stringify({ error: "General House Rules acceptance is required." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (body.service === "grooming" && !accepted(body.waiverGroomingPolicy)) {
      return new Response(JSON.stringify({ error: "Grooming Services Booking Policy acceptance is required." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (body.service === "hotel" && !accepted(body.waiverHotelCancellation)) {
      return new Response(JSON.stringify({ error: "Hotel Cancellation and Refund Policy acceptance is required." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    mutexKey = inventoryLockKey(branch.id, body);
    if (mutexKey) {
      mutexToken = randomToken(16);
      const { data: acquired, error: mutexError } = await supabase.rpc("acquire_inventory_mutex", {
        p_lock_key: mutexKey,
        p_lock_token: mutexToken,
        p_ttl_seconds: 120,
      });
      if (mutexError) throw new Error(`Could not reserve inventory: ${mutexError.message}`);
      if (!acquired) {
        mutexKey = null;
        mutexToken = null;
        return new Response(JSON.stringify({
          conflict: body.service === "hotel" ? "room" : "slot",
          error: "This inventory is being reserved by another customer. Please try again.",
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      try {
        await assertHostedInventory(supabase, branch.id, body);
      } catch (inventoryError) {
        await supabase.rpc("release_inventory_mutex", {
          p_lock_key: mutexKey,
          p_lock_token: mutexToken,
        });
        mutexKey = null;
        mutexToken = null;
        return new Response(JSON.stringify({
          conflict: body.service === "hotel" ? "room" : "slot",
          error: inventoryError instanceof Error ? inventoryError.message : "Inventory is unavailable.",
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

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
    // downstream use (pending_bookings, Maya metadata, success/cancel URLs,
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
    createdBookingId = bookingId;
    createdRefNumber = refNumber;

    // Authoritative ref — use whatever the DB actually persisted (handles any
    // ref_number DEFAULT/trigger that overrode our inserted value).
    if (newBooking.ref_number && newBooking.ref_number !== refNumber) {
      console.warn(`ref_number overridden by DB: inserted ${refNumber}, stored ${newBooking.ref_number}`);
      refNumber = newBooking.ref_number;
      createdRefNumber = refNumber;
    }

    // ── 4b. Create the service detail row up front (best-effort) ──
    // Holds service_date + the schedule, so this PENDING booking shows on the
    // admin calendar immediately — before payment. The webhook later upserts the
    // same row (onConflict booking_id) after payment, so this is idempotent.
    // Non-fatal: if it fails, the booking still proceeds and the webhook creates
    // the detail row post-payment (the booking just won't appear on the calendar
    // until then). Requires a UNIQUE constraint on booking_id in each detail table
    // so the webhook's upsert updates this row rather than erroring.
    const detailTableFor: Record<string, string> = {
      hotel: "hotel_details", grooming: "grooming_details",
      daycare: "daycare_details", studio: "studio_details",
    };
    const detailTable = detailTableFor[body.service as string] || null;
    createdDetailTable = detailTable;
    if (body.service === "hotel") {
      const { error } = await supabase.from("hotel_details").insert({
          booking_id: bookingId,
          checkin_date: body.hotelCheckin, checkout_date: body.hotelCheckout,
          dropoff_time: body.hotelDropoff || null, pickup_time: body.hotelPickup || null,
          pickup_hour: parseInt(body.hotelPickupHour) || 14,
          room_type: body.hotelRoom || null, room_id: body.hotelRoomId || null,
          playpark_consent: body.playparkConsent === "yes",
          feeding_instructions: body.hotelFeeding || null, medications: body.hotelMeds || null,
          vet_clinic: body.vetClinic || null, vet_contact: body.vetContact || null, vet_address: body.vetAddress || null,
          emergency_name: body.emergencyName || null, emergency_phone: body.emergencyPhone || null,
      });
      if (error) throw new Error(`Hotel inventory hold failed: ${error.message}`);
    } else if (body.service === "grooming") {
      const { error } = await supabase.from("grooming_details").insert({
          booking_id: bookingId, service_date: body.groomDate || null,
          timeslot: body.groomSlot,
          preferred_stylist: body.preferredStylist || "any",
          groomer_id: body.preferredStylistId || null,
          groom_service_key: body.groomService || "", groom_service_name: body.groomServiceName || "",
          special_requests: body.groomNotes || null,
      });
      if (error) throw new Error(`Grooming inventory hold failed: ${error.message}`);
      // Persist add-ons up front so the itemised breakdown survives even if the
      // booking is later finalized via a recovery path (not the full webhook).
      // Mirrors submit-booking; the webhook re-establishes these idempotently on
      // normal payment. Non-fatal so an add-on hiccup never blocks checkout.
      if (body.addons && Object.keys(body.addons).length > 0) {
        const { error: addonErr } = await supabase.from("booking_addons").insert(
          Object.entries(body.addons as Record<string, unknown>).map(([key, price]) => ({
            booking_id: bookingId, addon_key: key,
            addon_name: ADDON_NAMES[key] ?? key.replace(/_/g, " "),
            price: Number(price) || 0,
          }))
        );
        if (addonErr) console.error("Add-on hold insert failed (non-fatal):", addonErr.message);
      }
    } else if (body.service === "daycare") {
        const openTime = body.daycareOpenTime === true;
        const { error } = await supabase.from("daycare_details").insert({
          booking_id: bookingId, service_date: body.daycareDate || null,
          dropoff_time: body.daycareDropoff || "", dropoff_hour: parseInt(body.daycareDropoffHour) || 0,
          pickup_time: openTime ? null : (body.daycarePickup || null),
          pickup_hour: openTime ? null : (parseInt(body.daycarePickupHour) || null),
          hours_total: openTime ? 0 : Math.max(0, (parseInt(body.daycarePickupHour)||0) - (parseInt(body.daycareDropoffHour)||0)),
          open_time: openTime, notes: body.daycareNotes || null,
        });
        if (error) throw new Error(`Daycare detail insert failed: ${error.message}`);
    } else if (body.service === "studio") {
      const { error } = await supabase.from("studio_details").insert({
          booking_id: bookingId, service_date: body.studioDate || null,
          timeslot: body.studioSlot || "", studio_id: body._reservedStudioId || null,
      });
      if (error) throw new Error(`Studio inventory hold failed: ${error.message}`);
    }

    // ── 5. Store full payload in pending_bookings (webhook uses this to create child records) ──
    // Keep the inventory hold short; expired pending bookings are released by expire_pending_bookings().
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const cancellationToken = randomToken();
    const cancellationTokenHash = await sha256(cancellationToken);
    const { error: pendingErr } = await supabase.from("pending_bookings").insert({
      ref_number: refNumber,
      payload:    body,
      amount:     total,
      expires_at: expiresAt,
      payment_provider: "maya",
      cancellation_token_hash: cancellationTokenHash,
    });
    if (pendingErr) {
      if (detailTable) await supabase.from(detailTable).delete().eq("booking_id", bookingId);
      await supabase.from("bookings").delete().eq("id", bookingId);
      throw new Error(`Failed to create pending checkout: ${pendingErr.message}`);
    }

    if (mutexKey && mutexToken) {
      await supabase.rpc("release_inventory_mutex", {
        p_lock_key: mutexKey,
        p_lock_token: mutexToken,
      });
      mutexKey = null;
      mutexToken = null;
    }

    // ── 6. Build Maya line items ──
    const serviceAmount = subtotal - discountAmount;
    const lineItems: object[] = [{
      name:        serviceLineName(body),
      code:        String(body.service || "booking"),
      description: discountAmount > 0
        ? `${body.petName} — Member discount applied (−₱${discountAmount})`
        : String(body.petName),
      quantity: "1",
      amount: { value: serviceAmount },
      totalAmount: { value: serviceAmount },
    }];
    if (convenienceFee > 0) {
      lineItems.push({
        name: "Convenience Fee", code: "convenience_fee",
        description: "Online booking fee", quantity: "1",
        amount: { value: convenienceFee }, totalAmount: { value: convenienceFee },
      });
    }

    const ownerName   = `${body.ownerFirst} ${body.ownerLast}`.trim();

    // ── 7. Create Maya Checkout session ──
    const mayaRes = await fetch(`${mayaBaseUrl()}/checkout/v1/checkouts`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Basic ${btoa(publicKey + ":")}`,
      },
      body: JSON.stringify({
        totalAmount: { value: total, currency: "PHP" },
        buyer: {
          firstName: body.ownerFirst,
          lastName: body.ownerLast,
          contact: { email: body.ownerEmail, phone: body.ownerPhone },
        },
        items: lineItems,
        redirectUrl: {
          success: `${SITE_URL}/booking.html?payment=success&provider=maya&ref=${refNumber}`,
          failure: `${SITE_URL}/booking.html?payment=failed&provider=maya&ref=${refNumber}`,
          cancel:  `${SITE_URL}/booking.html?payment=cancelled&provider=maya&ref=${refNumber}`,
        },
        requestReferenceNumber: refNumber,
        metadata: { bookingId, refNumber, service: body.service, ownerName },
      }),
    });

    const mayaData = await mayaRes.json();

    if (!mayaRes.ok) {
      console.error("Maya error:", JSON.stringify(mayaData));
      // Roll back — remove the detail row, booking, and pending record since
      // payment setup failed. Delete the detail row first in case the FK to
      // bookings isn't ON DELETE CASCADE.
      if (detailTable) await supabase.from(detailTable).delete().eq("booking_id", bookingId);
      await supabase.from("bookings").delete().eq("id", bookingId);
      await supabase.from("pending_bookings").delete().eq("ref_number", refNumber);
      throw new Error(mayaData?.message || mayaData?.error || "Failed to create Maya checkout");
    }

    const sessionId   = mayaData.checkoutId || mayaData.id;
    const checkoutUrl = mayaData.redirectUrl;
    if (!sessionId || !checkoutUrl) throw new Error("Maya returned an incomplete checkout response");

    // Store provider-neutral identifiers; legacy PayMongo data remains intact.
    const { error: correlationErr } = await supabase.from("pending_bookings")
      .update({ gateway_checkout_id: sessionId })
      .eq("ref_number", refNumber);
    // The webhook also matches requestReferenceNumber, so this is recoverable.
    if (correlationErr) console.error("Maya checkout correlation update failed:", correlationErr.message);

    console.log(`Booking ${bookingId} | Session ${sessionId} | Ref ${refNumber}`);
    createdBookingId = null;
    createdDetailTable = null;
    createdRefNumber = null;

    return new Response(
      JSON.stringify({
        success: true,
        checkout_url: checkoutUrl,
        ref_number: refNumber,
        booking_id: bookingId,
        cancellation_token: cancellationToken,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    if (supabase && mutexKey && mutexToken) {
      try {
        await supabase.rpc("release_inventory_mutex", {
          p_lock_key: mutexKey,
          p_lock_token: mutexToken,
        });
      } catch {}
    }
    if (supabase && createdBookingId) {
      try {
        if (createdDetailTable) {
          await supabase.from(createdDetailTable).delete().eq("booking_id", createdBookingId);
        }
        if (createdRefNumber) {
          await supabase.from("pending_bookings").delete().eq("ref_number", createdRefNumber);
        }
        await supabase.from("bookings").delete().eq("id", createdBookingId);
      } catch {}
    }
    console.error("create-maya-checkout error:", err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
