// Barkhaus — create-maya-checkout edge function
// Creates a pending booking row + Maya Checkout session; returns checkout_url.
// success_url and cancel_url handle redirect back to booking.html

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { randomToken, sha256 } from "../_shared/security.ts";
import { assertHostedInventory, inventoryLockKey } from "../_shared/inventory.ts";
import { assertAttachmentsExist, attachmentEntries } from "../_shared/attachments.ts";
import { loadPricing, validateMembership, computeBookingPrice } from "../_shared/pricing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SITE_URL = Deno.env.get("SITE_URL") || "https://barkhaus.ph";

// Staging has no Maya sandbox: the order is created as usual, then the tester is sent to the
// simulator page instead of Maya's. Decided by the project's own id, never by a setting, so
// production always goes to Maya.
const PRODUCTION_PROJECT_REF = "dxttnbtfhpanyiyduevn";
function isProductionProject(): boolean {
  return (Deno.env.get("SUPABASE_URL") || "").includes(PRODUCTION_PROJECT_REF);
}

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

function hotelStayDates(checkin: unknown, checkout: unknown): string[] {
  const start = String(checkin ?? "");
  const end = String(checkout ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end <= start) return [];
  const cursor = new Date(`${start}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime())) return [];
  const dates: string[] = [];
  while (cursor.toISOString().slice(0, 10) < end && dates.length < 370) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (cursor.toISOString().slice(0, 10) < end) throw new Error("Hotel stay exceeds the supported date range.");
  return dates;
}

async function assertHotelRoomNotBlocked(supabase: any, branchId: string, body: Record<string, any>) {
  if (body.service !== "hotel" || !body.hotelRoomId) return;
  const stayDates = hotelStayDates(body.hotelCheckin, body.hotelCheckout);
  if (!stayDates.length) throw new Error("Hotel checkout must be after check-in.");
  const { data: blocks, error } = await supabase.from("blocked_schedules")
    .select("id").eq("branch_id", branchId).eq("resource_type", "room")
    .eq("resource_id", body.hotelRoomId).eq("active", true)
    .overlaps("dates", stayDates).limit(1);
  if (error) throw new Error(`Could not validate room blocks: ${error.message}`);
  if (blocks?.length) throw new Error("That room is blocked for one or more selected nights. Please select another room.");
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

type Created = {
  bookings: string[];
  details: { table: string; bookingId: string }[];
  refs: string[];
  mutexes: { key: string; token: string }[];
  orderId: string | null;
};

type Hold = {
  bookingId: string; refNumber: string; service: string; petName: string;
  subtotal: number; discountAmount: number; convenienceFee: number; total: number;
};

class CheckoutError extends Error {
  constructor(message: string, readonly status = 400, readonly payload?: Record<string, unknown>) { super(message); }
}

async function releaseMutexes(supabase: any, created: Created) {
  for (const m of created.mutexes.splice(0)) {
    try { await supabase.rpc("release_inventory_mutex", { p_lock_key: m.key, p_lock_token: m.token }); } catch {}
  }
}

// Undo everything this request created (payment setup failed, or an item could not be held).
async function rollback(supabase: any, created: Created) {
  await releaseMutexes(supabase, created);
  try {
    for (const d of created.details) await supabase.from(d.table).delete().eq("booking_id", d.bookingId);
    for (const ref of created.refs) await supabase.from("pending_bookings").delete().eq("ref_number", ref);
    for (const id of created.bookings) await supabase.from("bookings").delete().eq("id", id);
    if (created.orderId) await supabase.from("booking_orders").delete().eq("id", created.orderId);
  } catch {}
  created.details = []; created.refs = []; created.bookings = []; created.orderId = null;
}

// One cart item -> one pending booking, created exactly as a single booking always was: server-side
// pricing, inventory lock, pet upsert, booking row, detail row, add-ons/vaccines/waivers, pending hold.
// Locks are kept until the whole order is written, so a later item cannot take the same room or slot.
async function createHold(
  supabase: any,
  ctx: { branchId: string; ownerId: string; expiresAt: string; cancellationTokenHash: string; pricing: any },
  body: Record<string, any>,
  opts: { withConvenienceFee: boolean },
  created: Created,
): Promise<Hold> {
  const accepted = (value: unknown) => value === true || value === "true";
  if (!accepted(body.waiverHouseRules)) throw new CheckoutError("General House Rules acceptance is required.");
  if (body.service === "grooming" && !accepted(body.waiverGroomingPolicy)) {
    throw new CheckoutError("Grooming Services Booking Policy acceptance is required.");
  }
  if (body.service === "hotel" && !accepted(body.waiverHotelCancellation)) {
    throw new CheckoutError("Hotel Cancellation and Refund Policy acceptance is required.");
  }
  for (const f of ["service", "petName", "ownerFirst", "ownerLast", "ownerEmail", "ownerPhone", "total"]) {
    if (!body[f]) throw new CheckoutError(`Missing required field: ${f}`);
  }

  const vaccineAttachmentEntries = attachmentEntries(body.vaccineDocuments, body.vaccineFileNames, "vaccine_document");
  const groomReferenceEntries = body.service === "grooming"
    ? attachmentEntries(body.groomReferenceImages, body.groomReferenceFileNames, "grooming_reference")
    : [];
  await assertAttachmentsExist(supabase, [...vaccineAttachmentEntries, ...groomReferenceEntries]);

  const branch = { id: ctx.branchId };
  const ownerId = ctx.ownerId;

  // ── Authoritative server-side pricing ──
  // The charged amount is ALWAYS recomputed from the pricing table + booking inputs; client-supplied
  // total/subtotal/discount/fee are ignored. The convenience fee is an ORDER-level charge, so it is
  // added to the first item only: one fee per checkout, however many services it holds.
  const membership = await validateMembership(supabase, body.membershipId, body.petName, branch.id);
  const priced = computeBookingPrice(body, ctx.pricing, membership);
  if (!priced.priceable || priced.total <= 0) throw new CheckoutError("Invalid payment amount");
  const subtotal       = priced.subtotal;
  const discountAmount = priced.discountAmount;
  const convenienceFee = opts.withConvenienceFee ? priced.convenienceFee : 0;
  const total          = subtotal - discountAmount + convenienceFee;
  const clientTotal = parseInt(body.total) || 0;
  if (opts.withConvenienceFee && clientTotal !== total) {
    console.warn(`[repricing] client total ₱${clientTotal} != server ₱${total} for ${body.service} — charging server amount`);
  }

  const mutexKey = inventoryLockKey(branch.id, body);
  if (mutexKey) {
    const mutexToken = randomToken(16);
    const { data: acquired, error: mutexError } = await supabase.rpc("acquire_inventory_mutex", {
      p_lock_key: mutexKey, p_lock_token: mutexToken, p_ttl_seconds: 120,
    });
    if (mutexError) throw new CheckoutError(`Could not reserve inventory: ${mutexError.message}`, 500);
    if (!acquired) {
      throw new CheckoutError("This inventory is being reserved by another customer. Please try again.", 200,
        { conflict: body.service === "hotel" ? "room" : "slot" });
    }
    created.mutexes.push({ key: mutexKey, token: mutexToken });
    try {
      // Sees the holds already written for earlier items in this same cart.
      await assertHostedInventory(supabase, branch.id, body);
      await assertHotelRoomNotBlocked(supabase, branch.id, body);
    } catch (inventoryError) {
      throw new CheckoutError(
        inventoryError instanceof Error ? inventoryError.message : "Inventory is unavailable.", 200,
        { conflict: body.service === "hotel" ? "room" : "slot" });
    }
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
      member_discount_applied: priced.memberValid,
      member_code_used:        priced.memberCode,
      booking_source:          "online",
    }).select("id, ref_number").single();
  if (bookingErr || !newBooking) throw new Error(`Failed to create booking: ${bookingErr?.message}`);
  const bookingId = newBooking.id;
  created.bookings.push(bookingId);

  // Authoritative ref — use whatever the DB actually persisted (handles any
  // ref_number DEFAULT/trigger that overrode our inserted value).
  if (newBooking.ref_number && newBooking.ref_number !== refNumber) {
    console.warn(`ref_number overridden by DB: inserted ${refNumber}, stored ${newBooking.ref_number}`);
    refNumber = newBooking.ref_number;
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
  if (detailTable) created.details.push({ table: detailTable, bookingId });
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
    // Grooming reference photos ("pegs") — online never persisted these before,
    // so the customer's uploads were silently dropped. Save them up front.
    if (body.groomReferenceImages && Object.keys(body.groomReferenceImages).length > 0) {
      const { error: pegErr } = await supabase.from("grooming_reference_images").insert(
        groomReferenceEntries.map(({ path, fileName }) => ({
          booking_id: bookingId, file_path: path,
          file_name: fileName,
        }))
      );
      if (pegErr) console.error("Grooming reference images hold insert failed (non-fatal):", pegErr.message);
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

  // Persist declared vaccines, uploaded documents, and waivers up front (same as
  // submit-booking) so they survive even if the booking is finalized via a recovery
  // path. The webhook re-establishes these idempotently on normal payment. Non-fatal.
  if (body.vaccines && Object.keys(body.vaccines).length > 0) {
    const { error: vErr } = await supabase.from("pet_vaccines").insert(
      Object.entries(body.vaccines as Record<string, unknown>).map(([name, confirmed]) => ({
        booking_id: bookingId, vaccine_name: name.replace(/_/g, " "),
        confirmed: confirmed === true || confirmed === "true",
      }))
    );
    if (vErr) console.error("Vaccines hold insert failed (non-fatal):", vErr.message);
  }
  if (body.vaccineDocuments && Object.keys(body.vaccineDocuments).length > 0) {
    const { error: dErr } = await supabase.from("vaccine_documents").insert(
      vaccineAttachmentEntries.map(({ path, fileName }) => ({
        booking_id: bookingId, file_path: path,
        file_name: fileName,
      }))
    );
    if (dErr) console.error("Vaccine documents hold insert failed (non-fatal):", dErr.message);
  }
  {
    const { error: wErr } = await supabase.from("waivers").insert({
      booking_id:                bookingId,
      general_terms:             body.waiverGeneral === true,
      house_rules_accepted:      accepted(body.waiverHouseRules),
      grooming_booking_policy:   body.service === "grooming" ? accepted(body.waiverGroomingPolicy) : null,
      hotel_cancellation_policy: body.service === "hotel" ? accepted(body.waiverHotelCancellation) : null,
      health_declaration:        body.waiverVaccine === true,
      senior_medical_waiver:     body.waiverSeniorMedical === true,
      studio_agreement:          body.waiverStudio === true,
      media_consent:             body.waiverMedia === true,
      waiver_texts:              body.waiverTexts || null,
      waiver_version:            "2.0",
    });
    if (wErr) console.error("Waiver hold insert failed (non-fatal):", wErr.message);
  }

  // ── 5. Store this item's payload in pending_bookings (the webhook builds child records from it) ──
  const { error: pendingErr } = await supabase.from("pending_bookings").insert({
    ref_number: refNumber,
    payload:    body,
    amount:     total,
    expires_at: ctx.expiresAt,
    payment_provider: "maya",
    cancellation_token_hash: ctx.cancellationTokenHash,
  });
  if (pendingErr) throw new CheckoutError(`Failed to create pending checkout: ${pendingErr.message}`, 500);
  created.refs.push(refNumber);

  return {
    bookingId, refNumber, service: String(body.service), petName: String(body.petName),
    subtotal, discountAmount, convenienceFee, total,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let supabase: any = null;
  const created: Created = { bookings: [], details: [], refs: [], mutexes: [], orderId: null };
  try {
    supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const publicKey = Deno.env.get("MAYA_PUBLIC_KEY") || "";
    // Staging never calls Maya (see step 8), so it does not need Maya keys.
    if (!publicKey && isProductionProject()) throw new Error("MAYA_PUBLIC_KEY not configured");

    const requestBody = await req.json();
    // One shape for both callers: today's site posts a single booking, the cart posts { items: [...] }.
    // A 1-item order is priced, held, charged and emailed exactly as a single booking always was.
    const items: Record<string, any>[] = Array.isArray(requestBody?.items) && requestBody.items.length > 0
      ? requestBody.items
      : [requestBody];
    const maxItems = Math.max(1, parseInt(Deno.env.get("MAX_ORDER_ITEMS") || "5", 10) || 5);
    if (items.length > maxItems) {
      return new Response(JSON.stringify({ error: `An order can hold at most ${maxItems} booking${maxItems > 1 ? "s" : ""}.` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const first = items[0];
    // One order = one payment = one customer at one branch.
    const sameOwner = items.every((i) => String(i.ownerEmail || "").trim().toLowerCase() === String(first.ownerEmail || "").trim().toLowerCase());
    const sameBranch = items.every((i) => i.location === first.location);
    if (!sameOwner || !sameBranch) {
      return new Response(JSON.stringify({ error: "Every booking in one checkout must be for the same customer and branch." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── 1. Resolve branch ──
    const branchName = LOCATION_MAP[first.location as string];
    if (!branchName) return new Response(
      JSON.stringify({ error: `Unknown location: ${first.location}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
    const { data: branch, error: branchErr } = await supabase
      .from("branches")
      .select("id")
      .ilike("name", branchName)
      .single();
    if (branchErr || !branch) throw new Error(`Branch not found: ${branchName}`);

    const pricing = await loadPricing(supabase);
    if (!pricing.loaded) throw new Error("Pricing table unavailable — cannot price booking");

    // ── 2. Upsert owner (one customer per order) ──
    const body = first;
    const email = (first.ownerEmail as string).trim().toLowerCase();
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


    // ── 3–5. One hold per item ──
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const cancellationToken = randomToken();
    const cancellationTokenHash = await sha256(cancellationToken);
    const ctx = { branchId: branch.id, ownerId, expiresAt, cancellationTokenHash, pricing };

    const holds: Hold[] = [];
    for (const [index, item] of items.entries()) {
      holds.push(await createHold(supabase, ctx, item, { withConvenienceFee: index === 0 }, created));
    }

    // ── 6. The order. Its ref is the first booking's ref, so a 1-item order reads like today ──
    const orderRef       = holds[0].refNumber;
    const orderAmount    = holds.reduce((sum, h) => sum + h.total, 0);
    const convenienceFee = holds[0].convenienceFee;
    const { data: order, error: orderErr } = await supabase.from("booking_orders").insert({
      order_ref:               orderRef,
      owner_id:                ownerId,
      branch_id:               branch.id,
      amount:                  orderAmount,
      convenience_fee:         convenienceFee,
      item_count:              holds.length,
      status:                  "pending",
      payment_provider:        "maya",
      cancellation_token_hash: cancellationTokenHash,
      expires_at:              expiresAt,
    }).select("id, order_ref").single();
    if (orderErr || !order) throw new Error(`Failed to create order: ${orderErr?.message}`);
    created.orderId = order.id;

    for (const h of holds) {
      const { error: linkErr } = await supabase.from("bookings").update({ order_id: order.id }).eq("id", h.bookingId);
      if (linkErr) throw new Error(`Failed to link booking to order: ${linkErr.message}`);
    }
    const { error: holdLinkErr } = await supabase.from("pending_bookings")
      .update({ order_ref: orderRef }).in("ref_number", holds.map((h) => h.refNumber));
    if (holdLinkErr) throw new Error(`Failed to link holds to order: ${holdLinkErr.message}`);

    await releaseMutexes(supabase, created);

    // ── 7. Maya line items: one per booking, plus the single convenience fee ──
    const lineItems: object[] = holds.map((h, i) => {
      const serviceAmount = h.subtotal - h.discountAmount;
      return {
        name:        serviceLineName(items[i]),
        code:        String(h.service || "booking"),
        description: h.discountAmount > 0
          ? `${h.petName} — Member discount applied (−₱${h.discountAmount})`
          : String(h.petName),
        quantity: "1",
        amount: { value: serviceAmount },
        totalAmount: { value: serviceAmount },
      };
    });
    if (convenienceFee > 0) {
      lineItems.push({
        name: "Convenience Fee", code: "convenience_fee",
        description: "Online booking fee", quantity: "1",
        amount: { value: convenienceFee }, totalAmount: { value: convenienceFee },
      });
    }

    const ownerName = `${first.ownerFirst} ${first.ownerLast}`.trim();

    // ── 8. Payment step ──
    if (!isProductionProject()) {
      // Staging: no Maya call. The simulator page asks the tester for the outcome and
      // simulate-payment then drives the real webhook with it.
      const simulatedSession = `SIM-${crypto.randomUUID()}`;
      await supabase.from("pending_bookings").update({ gateway_checkout_id: simulatedSession })
        .in("ref_number", holds.map((h) => h.refNumber));
      await supabase.from("booking_orders").update({ gateway_checkout_id: simulatedSession }).eq("id", order.id);
      console.log(`STAGING order ${order.order_ref} | ${holds.length} booking(s) | simulator`);
      created.bookings = []; created.details = []; created.refs = []; created.orderId = null;
      return new Response(
        JSON.stringify({
          success: true,
          simulated: true,
          checkout_url: `/simulate-payment.html?ref=${orderRef}&amount=${orderAmount}`,
          ref_number: orderRef,
          booking_id: holds[0].bookingId,
          booking_refs: holds.map((h) => h.refNumber),
          cancellation_token: cancellationToken,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── 8b. ONE Maya Checkout session for the whole order (production) ──
    const mayaRes = await fetch(`${mayaBaseUrl()}/checkout/v1/checkouts`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Basic ${btoa(publicKey + ":")}`,
      },
      body: JSON.stringify({
        totalAmount: { value: orderAmount, currency: "PHP" },
        buyer: {
          firstName: first.ownerFirst,
          lastName: first.ownerLast,
          contact: { email: first.ownerEmail, phone: first.ownerPhone },
        },
        items: lineItems,
        redirectUrl: {
          success: `${SITE_URL}/booking.html?payment=success&provider=maya&ref=${orderRef}`,
          failure: `${SITE_URL}/booking.html?payment=failed&provider=maya&ref=${orderRef}`,
          cancel:  `${SITE_URL}/booking.html?payment=cancelled&provider=maya&ref=${orderRef}`,
        },
        requestReferenceNumber: orderRef,
        // bookingId/refNumber stay for legacy lookups; a 1-item order reads exactly as before.
        metadata: {
          orderId: order.id, orderRef,
          bookingId: holds[0].bookingId, refNumber: orderRef,
          service: holds[0].service, ownerName,
        },
      }),
    });

    const mayaData = await mayaRes.json();

    if (!mayaRes.ok) {
      console.error("Maya error:", JSON.stringify(mayaData));
      await rollback(supabase, created);
      throw new Error(mayaData?.message || mayaData?.error || "Failed to create Maya checkout");
    }

    const sessionId   = mayaData.checkoutId || mayaData.id;
    const checkoutUrl = mayaData.redirectUrl;
    if (!sessionId || !checkoutUrl) throw new Error("Maya returned an incomplete checkout response");

    // Provider-neutral identifiers on the order and every hold.
    const { error: correlationErr } = await supabase.from("pending_bookings")
      .update({ gateway_checkout_id: sessionId })
      .in("ref_number", holds.map((h) => h.refNumber));
    // The webhook also matches requestReferenceNumber, so this is recoverable.
    if (correlationErr) console.error("Maya checkout correlation update failed:", correlationErr.message);
    await supabase.from("booking_orders").update({ gateway_checkout_id: sessionId }).eq("id", order.id);

    console.log(`Order ${order.order_ref} | ${holds.length} booking(s) | Session ${sessionId}`);
    created.bookings = []; created.details = []; created.refs = []; created.orderId = null;

    return new Response(
      JSON.stringify({
        success: true,
        checkout_url: checkoutUrl,
        ref_number: orderRef,
        booking_id: holds[0].bookingId,
        booking_refs: holds.map((h) => h.refNumber),
        cancellation_token: cancellationToken,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    if (supabase) await rollback(supabase, created);
    if (err instanceof CheckoutError) {
      return new Response(JSON.stringify({ error: err.message, ...(err.payload || {}) }),
        { status: err.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    console.error("create-maya-checkout error:", err instanceof Error ? err.message : err);
    const message = err instanceof Error ? err.message : "Unexpected error";
    const status = /^Uploaded file could not be verified/i.test(message) ? 400 : 500;
    return new Response(
      JSON.stringify({ error: message }),
      { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
