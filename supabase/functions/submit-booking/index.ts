// Barkhaus — submit-booking edge function v2.2
// Wraps detail inserts in cleanup: if any detail row fails, the orphaned booking is deleted.
// Sends booking confirmation email for admin-created bookings.
//
// v2.2: booking_date now means the CREATION date (matches created_at). The
// SERVICE date for grooming/daycare/studio lives in each detail table's
// service_date column, mirroring how hotel uses checkin_date/checkout_date.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Full add-on display names (mirror booking.js / handle-payment-webhook).
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

// ── Email helper ──────────────────────────────────────────────

async function sendBookingConfirmation(details: any) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) { console.error("RESEND_API_KEY not set — skipping email"); return; }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Barkhaus Pet Services <hello@barkhaus.ph>",
      to: details.ownerEmail,
      subject: `Booking Confirmed — ${details.refNumber}`,
      html: buildEmailHtml(details),
    }),
  });

  if (!res.ok) console.error("Resend error:", await res.text());
}

function fmtDate(d?: string) {
  if (!d) return "—";
  try {
    return new Date(d + "T00:00:00").toLocaleDateString("en-PH", {
      weekday: "short", month: "long", day: "numeric", year: "numeric",
    });
  } catch { return d; }
}

// Derive the itemised charge list from the payload (mirrors handle-payment-webhook).
type ChargeItem = { type: string; label: string; amount: number };
function chargesFromPayload(body: Record<string, unknown>, subtotal: number, discountAmt: number): ChargeItem[] {
  const lateFee       = parseInt(body.hotelLateTotal as string) || 0;
  const convFee       = parseInt(body.convenienceFee as string) || 0;
  const groomSvcPrice = parseInt(body.groomServicePrice as string) || 0;
  const svcLabel = (body.service === "grooming" && body.groomServiceName)
    ? `Grooming – ${body.groomServiceName}`
    : ({ hotel: "Pet Hotel Stay", daycare: "Daycare", studio: "Self-Shoot Studio" } as Record<string, string>)[body.service as string]
    ?? "Barkhaus Booking";
  const baseAmt = body.service === "grooming" ? groomSvcPrice : subtotal - lateFee;
  const rows: ChargeItem[] = [];
  if (baseAmt > 0)     rows.push({ type: "base_service",    label: svcLabel,           amount: baseAmt });
  if (lateFee > 0)     rows.push({ type: "late_pickup",     label: "Late pick-up fee", amount: lateFee });
  if (discountAmt > 0) rows.push({ type: "member_discount", label: "Member discount",  amount: discountAmt });
  if (convFee > 0)     rows.push({ type: "convenience_fee", label: "Convenience fee",  amount: convFee });
  return rows;
}

function detailRow(label: string, value: string): string {
  return `<tr style="border-bottom:0.5px solid rgba(77,150,185,0.12)">
    <td style="padding:9px 14px;color:#6AAEC8;width:42%;font-size:12px;font-weight:600;white-space:nowrap">${label}</td>
    <td style="padding:9px 14px;color:#B8D4E0;font-size:13px">${value}</td>
  </tr>`;
}

function bookingDetailRows(d: any): string {
  const svcLabel: Record<string, string> = { grooming: "Grooming", hotel: "Pet Hotel", daycare: "Daycare", studio: "Studio" };
  let rows = detailRow("Branch", d.branch.name) + detailRow("Service", svcLabel[d.service] ?? d.service);
  if (d.service === "grooming") {
    if (d.groomServiceName) rows += detailRow("Package", d.groomServiceName);
    if (d.addons?.length)   rows += detailRow("Add-ons", d.addons.join(", "));
    if (d.groomerName && d.groomerName !== "any") {
      const gName = (d.groomerName as string).replace(/\b\w/g, (c: string) => c.toUpperCase());
      rows += detailRow("Groomer", gName);
    }
    if (d.groomDate && d.groomSlot) rows += detailRow("Date & time", `${fmtDate(d.groomDate)} · ${d.groomSlot}`);
    if (d.groomNotes) rows += detailRow("Grooming notes", d.groomNotes);
  }
  if (d.service === "hotel") {
    if (d.hotelRoomName) rows += detailRow("Room", d.hotelRoomName);
    if (d.checkinDate)   rows += detailRow("Check-in",  fmtDate(d.checkinDate)  + (d.dropoffTime ? ` · ${d.dropoffTime}` : ""));
    if (d.checkoutDate)  rows += detailRow("Check-out", fmtDate(d.checkoutDate) + (d.pickupTime  ? ` · ${d.pickupTime}`  : ""));
    rows += detailRow("Play park", d.playparkConsent ? "Yes, with consent" : "No");
  }
  if (d.service === "daycare") {
    if (d.daycareDate) rows += detailRow("Date", fmtDate(d.daycareDate));
    if (d.daycareOpenTime) rows += detailRow("Drop-off", "Open time") + detailRow("Pick-up", "Open time");
    else { if (d.daycareDropoff) rows += detailRow("Drop-off", d.daycareDropoff); rows += detailRow("Pick-up", d.daycarePickup ?? "—"); }
    if (d.daycareNotes) rows += detailRow("Daycare notes", d.daycareNotes);
  }
  if (d.service === "studio") {
    if (d.studioDate) rows += detailRow("Date", fmtDate(d.studioDate));
    if (d.studioSlot) rows += detailRow("Time slot", d.studioSlot);
  }
  return rows;
}

function petDetailRows(d: any): string {
  const sizeLabels: Record<string, string> = { tiny: "Tiny", small_dog: "Small", medium_dog: "Medium Dog", large_dog: "Large Dog", giant_dog: "Giant Dog", cat: "Cat" };
  const tempLabels: Record<string, string> = { friendly_all: "Friendly with all", friendly_shy: "Friendly but shy", selective: "Selective", reactive: "Reactive", first_time: "First time" };
  let rows = detailRow("Name", d.petName);
  if (d.petAnimal) rows += detailRow("Animal", d.petAnimal.charAt(0).toUpperCase() + d.petAnimal.slice(1));
  if (d.petGender) rows += detailRow("Sex",    d.petGender.charAt(0).toUpperCase() + d.petGender.slice(1));
  if (d.petBreed)  rows += detailRow("Breed",  d.petBreed);
  if (d.petAge)    rows += detailRow("Age",    `${d.petAge} ${d.petAgeUnit || "years"}`);
  if (d.petSize)   rows += detailRow("Size",   sizeLabels[d.petSize] || d.petSize);
  if (d.petTemperament) rows += detailRow("Temperament", tempLabels[d.petTemperament] || d.petTemperament);
  if (d.petMedical?.trim()) rows += detailRow("Medical notes", d.petMedical.trim());
  if (d.membershipId) rows += detailRow("Membership", `${d.membershipId} ✓`);
  return rows;
}

function healthCareRows(d: any): string {
  let rows = detailRow("Vaccine records", d.vaccineStatus || "Not provided");
  if (d.service === "hotel") {
    if (d.vetClinic)  rows += detailRow("Vet clinic",   d.vetClinic);
    if (d.vetContact) rows += detailRow("Vet contact",  d.vetContact);
    if (d.vetAddress) rows += detailRow("Vet address",  d.vetAddress);
    if (d.emergencyName)  rows += detailRow("Emergency contact", d.emergencyName);
    if (d.emergencyPhone) rows += detailRow("Emergency phone",   d.emergencyPhone);
    if (d.hotelFeeding) rows += detailRow("Feeding instructions", d.hotelFeeding);
    if (d.hotelMeds)    rows += detailRow("Medications",          d.hotelMeds);
  }
  return rows;
}

function ownerDetailRows(d: any): string {
  let rows = detailRow("Name", `${d.ownerFirstName} ${d.ownerLastName || ""}`.trim());
  if (d.ownerEmail)  rows += detailRow("Email",  d.ownerEmail);
  if (d.ownerMobile) rows += detailRow("Mobile", d.ownerMobile);
  return rows;
}

function paymentSummaryRows(charges: ChargeItem[], addonRows: Array<{ addon_name: string; price: number }>, total: number): string {
  const stdRow = (label: string, value: string) =>
    `<tr style="border-bottom:0.5px solid rgba(77,150,185,0.08)"><td style="padding:8px 14px;color:#6AAEC8;width:55%;font-size:13px">${label}</td><td style="padding:8px 14px;color:#B8D4E0;font-size:13px;text-align:right">${value}</td></tr>`;
  const discRow = (label: string, value: string) =>
    `<tr style="border-bottom:0.5px solid rgba(77,150,185,0.08)"><td style="padding:8px 14px;color:#6AAEC8;width:55%;font-size:13px">${label}</td><td style="padding:8px 14px;color:#6BCB77;font-size:13px;text-align:right">${value}</td></tr>`;
  const totalRow = (label: string, value: string) =>
    `<tr><td style="padding:10px 14px;color:#F0EDE6;width:55%;font-size:14px;font-weight:700;border-top:0.5px solid rgba(77,150,185,0.3)">${label}</td><td style="padding:10px 14px;color:#FFCE58;font-size:14px;font-weight:700;text-align:right;border-top:0.5px solid rgba(77,150,185,0.3)">${value}</td></tr>`;
  let rows = "";
  const base = charges.find(c => c.type === "base_service");
  if (base && base.amount > 0) rows += stdRow(base.label, `₱${base.amount.toLocaleString()}`);
  for (const a of (addonRows || [])) if ((a.price || 0) > 0) rows += stdRow(a.addon_name, `₱${a.price.toLocaleString()}`);
  const late = charges.find(c => c.type === "late_pickup");
  if (late && late.amount > 0) rows += stdRow("Late pickup fee", `₱${late.amount.toLocaleString()}`);
  const disc = charges.find(c => c.type === "member_discount");
  if (disc && disc.amount > 0) rows += discRow("Member discount", `−₱${disc.amount.toLocaleString()}`);
  rows += totalRow("Total · Pay on arrival", `₱${total.toLocaleString()}`);
  return rows;
}

function buildEmailHtml(d: any): string {
  const bookingDate = new Date().toLocaleDateString("en-PH", {
    month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });

  const statusColor: Record<string, string> = {
    confirmed: "#6BCB77", pending: "#FFCE58",
    checked_in: "#4D96B9", completed: "#6AAEC8",
  };
  const statusBg: Record<string, string> = {
    confirmed: "rgba(107,203,119,0.15)", pending: "rgba(255,206,88,0.15)",
    checked_in: "rgba(77,150,185,0.15)", completed: "rgba(106,174,200,0.15)",
  };
  const sc = statusColor[d.status] ?? "#FFCE58";
  const sb = statusBg[d.status] ?? "rgba(255,206,88,0.15)";
  const statusLabel = d.status.replace(/_/g, " ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Booking Confirmation — Barkhaus</title>
</head>
<body style="margin:0;padding:0;background:#0F1C26;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0F1C26;padding:24px 0">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#1A3044;border-radius:14px;border:0.5px solid rgba(77,150,185,0.3);overflow:hidden;max-width:560px;width:100%">
  <tr><td style="background:#0F1C26;padding:22px 28px;text-align:center;border-bottom:0.5px solid rgba(77,150,185,0.2)">
    <img src="https://barkhaus.ph/images/Barkhaus%20Pet%20Hotel%20Logo.png" alt="Barkhaus Pet Services" height="40" style="display:block;margin:0 auto">
  </td></tr>
  <tr><td style="padding:28px">
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:700;font-size:22px;color:#F0EDE6;margin:0 0 6px">Hi ${d.ownerFirstName}! 🐾</p>
    <p style="color:#B8D4E0;margin:0 0 22px;line-height:1.65;font-size:13px">
      Great news — <strong style="color:#F0EDE6">${d.petName}'s</strong> booking has been recorded and we're so excited to see them! Here's everything you need to know before your visit.
    </p>
    <div style="margin-bottom:20px">
      <span style="font-size:11px;font-weight:700;padding:4px 12px;border-radius:999px;background:${sb};color:${sc};border:0.5px solid ${sc}">${statusLabel}</span>
      <span style="font-size:12px;color:#6AAEC8;font-weight:600;margin-left:8px">${d.refNumber}</span>
      <span style="font-size:11px;color:#6AAEC8;margin-left:8px">· ${bookingDate}</span>
    </div>
    <div style="background:rgba(255,206,88,0.08);border:0.5px solid rgba(255,206,88,0.3);border-radius:10px;padding:12px 14px;margin-bottom:20px">
      <p style="margin:0;font-size:13px;color:#B8D4E0;line-height:1.55">
        ⚠️ <strong style="color:#FFCE58">Payment required in store.</strong> Please settle your payment at the branch upon arrival to confirm your booking.
      </p>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1F3D55;border:0.5px solid rgba(77,150,185,0.25);border-radius:10px;overflow:hidden;margin-bottom:14px">
      <tr><td style="padding:9px 14px;font-size:9px;font-weight:700;color:#6AAEC8;text-transform:uppercase;letter-spacing:0.12em;border-bottom:0.5px solid rgba(77,150,185,0.2)">Booking details</td></tr>
      ${bookingDetailRows(d)}
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1F3D55;border:0.5px solid rgba(77,150,185,0.25);border-radius:10px;overflow:hidden;margin-bottom:14px">
      <tr><td style="padding:9px 14px;font-size:9px;font-weight:700;color:#6AAEC8;text-transform:uppercase;letter-spacing:0.12em;border-bottom:0.5px solid rgba(77,150,185,0.2)">Pet details</td></tr>
      ${petDetailRows(d)}
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1F3D55;border:0.5px solid rgba(77,150,185,0.25);border-radius:10px;overflow:hidden;margin-bottom:14px">
      <tr><td style="padding:9px 14px;font-size:9px;font-weight:700;color:#6AAEC8;text-transform:uppercase;letter-spacing:0.12em;border-bottom:0.5px solid rgba(77,150,185,0.2)">Health &amp; care</td></tr>
      ${healthCareRows(d)}
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1F3D55;border:0.5px solid rgba(77,150,185,0.25);border-radius:10px;overflow:hidden;margin-bottom:14px">
      <tr><td style="padding:9px 14px;font-size:9px;font-weight:700;color:#6AAEC8;text-transform:uppercase;letter-spacing:0.12em;border-bottom:0.5px solid rgba(77,150,185,0.2)">Owner details</td></tr>
      ${ownerDetailRows(d)}
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1F3D55;border:0.5px solid rgba(77,150,185,0.25);border-radius:10px;overflow:hidden;margin-bottom:20px">
      <tr><td colspan="2" style="padding:9px 14px;font-size:9px;font-weight:700;color:#6AAEC8;text-transform:uppercase;letter-spacing:0.12em;border-bottom:0.5px solid rgba(77,150,185,0.2)">Payment summary</td></tr>
      ${paymentSummaryRows(d.charges || [], d.addonRows || [], d.total)}
    </table>
    <div style="background:rgba(255,206,88,0.08);border:0.5px solid rgba(255,206,88,0.25);border-radius:10px;padding:12px 14px;margin-bottom:14px">
      <p style="margin:0;font-size:13px;color:#B8D4E0;line-height:1.55">
        ⏰ Please arrive <strong style="color:#FFCE58">15 minutes before</strong> your scheduled time to make check-in a breeze!
      </p>
    </div>
    <div style="background:rgba(77,150,185,0.1);border:0.5px solid rgba(77,150,185,0.25);border-radius:10px;padding:12px 14px;margin-bottom:22px">
      <p style="margin:0;font-size:13px;color:#B8D4E0;line-height:1.55">
        📋 Need to reschedule or cancel? Please <strong style="color:#4D96B9">call the branch directly</strong> at least 24 hours before your appointment. We totally understand — just give us a heads up so we can open the slot for another furry guest!
      </p>
    </div>
    <p style="color:#6AAEC8;font-size:13px;line-height:1.6;margin:0 0 16px">
      Can't wait to see ${d.petName}! If you have any questions before your visit, reach out to your branch directly using the details below. 🐶
    </p>
    <p style="color:#4D96B9;font-size:11px;line-height:1.6;margin:0;padding:10px 14px;background:rgba(77,150,185,0.08);border-radius:8px;border:0.5px solid rgba(77,150,185,0.2)">
      📭 This is a no-reply email. Please do not reply directly — contact your branch by phone or Instagram for any changes or cancellations.
    </p>
  </td></tr>
  <tr><td style="border-top:0.5px solid rgba(77,150,185,0.25);padding:18px 28px;background:#0F1C26">
    <p style="font-size:9px;font-weight:700;color:#6AAEC8;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.12em">Your branch</p>
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:700;font-size:16px;color:#F0EDE6;margin:0 0 3px">Barkhaus ${d.branch.name}</p>
    <p style="font-size:12px;color:#B8D4E0;margin:0 0 3px">${d.branch.address}, ${d.branch.city}</p>
    <p style="font-size:12px;color:#6AAEC8;margin:0 0 8px">${d.branch.hours_weekday} · ${d.branch.hours_weekend}</p>
    <p style="font-size:12px;color:#4D96B9;font-weight:600;margin:0">📞 ${d.branch.phone} &nbsp;·&nbsp; 📸 @barkhausph</p>
    <hr style="border:none;border-top:0.5px solid rgba(77,150,185,0.2);margin:14px 0">
    <p style="font-size:11px;color:#4D96B9;text-align:center;margin:0">© 2026 Barkhaus Pet Services · All rights reserved</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── End email helper ───────────────────────────────────────────

Deno.serve(async (req) => {

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let bookingId: string | null = null;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();

    // Validate required fields
    const required = ["location", "service", "petName", "petAnimal", "petGender",
                      "ownerFirst", "ownerLast", "ownerEmail", "ownerPhone"];
    for (const field of required) {
      if (!body[field]) {
        return new Response(
          JSON.stringify({ error: `Missing required field: ${field}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // 1. Resolve branch — fetch full row for email footer
    const { data: branch, error: branchErr } = await supabase
      .from("branches")
      .select("id, name, address, city, hours_weekday, hours_weekend, phone")
      .ilike("name", body.location === "estancia" ? "%Estancia%" : "%Eastwood%")
      .single();
    if (branchErr || !branch) throw new Error(`Branch not found: ${body.location}`);

    // 2. Upsert owner
    let ownerId: string;
    const { data: existingOwner } = await supabase
      .from("owners")
      .select("id")
      .ilike("email", body.ownerEmail.trim())
      .maybeSingle();

    if (existingOwner) {
      ownerId = existingOwner.id;
    } else {
      const { data: newOwner, error: ownerErr } = await supabase
        .from("owners")
        .insert({
          first_name:      body.ownerFirst.trim(),
          last_name:       body.ownerLast.trim(),
          email:           body.ownerEmail.trim().toLowerCase(),
          mobile:          body.ownerPhone.trim(),
          referral_source: body.ownerSource || null,
        })
        .select("id")
        .single();
      if (ownerErr) throw new Error(`Owner insert failed: ${ownerErr.message}`);
      ownerId = newOwner.id;
    }

    // 3. Insert pet
    const { data: pet, error: petErr } = await supabase
      .from("pets")
      .insert({
        owner_id:      ownerId,
        name:          body.petName.trim(),
        animal_type:   body.petAnimal,
        gender:        body.petGender,
        breed:         body.petBreed?.trim() || null,
        age_value:     body.petAge ? parseInt(body.petAge) : null,
        age_unit:      body.petAgeUnit || "years",
        size:          body.petSize || null,
        medical_notes: body.petMedical?.trim() || null,
        temperament:   body.petTemperament || null,
      })
      .select("id")
      .single();
    if (petErr) throw new Error(`Pet insert failed: ${petErr.message}`);

    // 4. Validate membership
    let memberDiscountApplied = false;
    let memberCodeUsed: string | null = null;
    if (body.membershipId) {
      const { data: member } = await supabase
        .from("members")
        .select("id, active")
        .eq("member_code", body.membershipId.trim().toUpperCase())
        .maybeSingle();
      if (member?.active) {
        memberDiscountApplied = true;
        memberCodeUsed = body.membershipId.trim().toUpperCase();
        await supabase
          .from("members")
          .update({ owner_id: ownerId })
          .eq("member_code", memberCodeUsed)
          .is("owner_id", null);
      }
    }

    // 5. Totals
    const subtotal    = parseInt(body.subtotal)       || 0;
    const discountAmt = parseInt(body.discountAmount) || 0;
    const total       = parseInt(body.total)           || subtotal - discountAmt;

    // 6. booking_date = CREATION date (UTC, matches created_at::date).
    // The service date for grooming/daycare/studio now lives in each detail
    // table's service_date column (mirrors hotel's checkin_date/checkout_date).
    const bookingDate = new Date().toISOString().split("T")[0];

    // 7. Insert booking
    const { data: booking, error: bookingErr } = await supabase
      .from("bookings")
      .insert({
        branch_id:               branch.id,
        owner_id:                ownerId,
        pet_id:                  pet.id,
        service:                 body.service,
        status:                  "pending",
        booking_date:            bookingDate,
        subtotal,
        discount_amount:         discountAmt,
        total,
        member_discount_applied: memberDiscountApplied,
        member_code_used:        memberCodeUsed,
        booking_source:          body.booking_source || "admin",
      })
      .select("id, ref_number")
      .single();
    if (bookingErr) throw new Error(`Booking insert failed: ${bookingErr.message}`);

    bookingId = booking.id;

    // 8. Service detail rows
    if (body.service === "hotel") {
      const pickupHour = parseInt(body.hotelPickupHour) || 14;
      const { error } = await supabase.from("hotel_details").insert({
        booking_id:           bookingId,
        checkin_date:         body.hotelCheckin,
        checkout_date:        body.hotelCheckout,
        dropoff_time:         body.hotelDropoff   || null,
        pickup_time:          body.hotelPickup    || null,
        pickup_hour:          pickupHour,
        room_type:            body.hotelRoom      || null,
        room_id:              body.hotelRoomId    || null,
        playpark_consent:     body.playparkConsent === "yes",
        feeding_instructions: body.hotelFeeding   || null,
        medications:          body.hotelMeds      || null,
        vet_clinic:           body.vetClinic      || null,
        vet_contact:          body.vetContact     || null,
        vet_address:          body.vetAddress     || null,
        emergency_name:       body.emergencyName  || null,
        emergency_phone:      body.emergencyPhone || null,
      });
      if (error) throw new Error(`Hotel details insert failed: ${error.message}`);
    }

    if (body.service === "grooming") {
      const { error } = await supabase.from("grooming_details").insert({
        booking_id:         bookingId,
        service_date:       body.groomDate          || null,  // service date lives here (mirrors hotel)
        timeslot:           body.groomSlot,
        preferred_stylist:  body.preferredStylist   || "any",
        groomer_id:         body.preferredStylistId || null,
        groom_service_key:  body.groomService       || "",
        groom_service_name: body.groomServiceName   || "",
        special_requests:   body.groomNotes         || null,
      });
      if (error) throw new Error(`Grooming details insert failed: ${error.message}`);
    }

    if (body.service === "daycare") {
      const openTime   = body.daycareOpenTime === true;
      const dropH      = parseInt(body.daycareDropoffHour) || 0;
      const pickH      = openTime ? null : (parseInt(body.daycarePickupHour) || null);
      const hoursTotal = (pickH && pickH > dropH) ? pickH - dropH : 0;
      const { error } = await supabase.from("daycare_details").insert({
        booking_id:   bookingId,
        service_date: body.daycareDate || null,  // service date lives here (mirrors hotel)
        dropoff_time: body.daycareDropoff || "",
        dropoff_hour: dropH,
        pickup_time:  openTime ? null : (body.daycarePickup || null),
        pickup_hour:  pickH,
        hours_total:  hoursTotal,
        open_time:    openTime,
        notes:        body.daycareNotes  || null,
      });
      if (error) throw new Error(`Daycare details insert failed: ${error.message}`);
    }

    if (body.service === "studio") {
      const { error } = await supabase.from("studio_details").insert({
        booking_id:   bookingId,
        service_date: body.studioDate || null,  // service date lives here (mirrors hotel)
        timeslot:     body.studioSlot || "",
      });
      if (error) throw new Error(`Studio details insert failed: ${error.message}`);
    }

    // 9. Grooming add-ons
    if (body.service === "grooming" && body.addons && Object.keys(body.addons).length > 0) {
      const addonRows = Object.entries(body.addons).map(([key, price]) => ({
        booking_id: bookingId,
        addon_key:  key,
        addon_name: ADDON_NAMES[key] ?? key.replace(/_/g, " "),
        price:      price as number,
      }));
      const { error } = await supabase.from("booking_addons").insert(addonRows);
      if (error) throw new Error(`Addons insert failed: ${error.message}`);
    }

    // 10. Vaccine records
    if (body.vaccines && Object.keys(body.vaccines).length > 0) {
      const vaccineRows = Object.entries(body.vaccines).map(([name, confirmed]) => ({
        booking_id:   bookingId,
        vaccine_name: name.replace(/_/g, " "),
        confirmed:    confirmed as boolean,
      }));
      const { error } = await supabase.from("pet_vaccines").insert(vaccineRows);
      if (error) throw new Error(`Vaccines insert failed: ${error.message}`);
    }

    // 10b. Vaccine document uploads (paths produced by get-upload-url, passed in payload)
    if (body.vaccineDocuments && Object.keys(body.vaccineDocuments).length > 0) {
      const docRows = Object.entries(body.vaccineDocuments).map(([key, path]) => ({
        booking_id: bookingId,
        file_path:  path as string,
        file_name:  (body.vaccineFileNames && body.vaccineFileNames[key]) || (path as string).split("/").pop(),
      }));
      const { error } = await supabase.from("vaccine_documents").insert(docRows);
      if (error) console.error("Vaccine documents insert failed (non-fatal):", error.message);
    }

    // 11. Waivers
    const { error: waiverErr } = await supabase.from("waivers").insert({
      booking_id:            bookingId,
      general_terms:         body.waiverGeneral       === true,
      health_declaration:    body.waiverVaccine        === true,
      senior_medical_waiver: body.waiverSeniorMedical === true,
      studio_agreement:      body.waiverStudio         === true,
      media_consent:         body.waiverMedia          === true,
      waiver_texts:          body.waiverTexts          || null,
      waiver_version:        "1.0",
    });
    if (waiverErr) throw new Error(`Waiver insert failed: ${waiverErr.message}`);

    // 12. Send confirmation email for admin-created bookings
    // Only fires when adminCreated is true — online bookings get their email
    // from handle-payment-webhook after payment is confirmed.
    if (body.adminCreated === true && body.ownerEmail) {
      try {
        // Look up room name for hotel bookings
        let hotelRoomName = body.hotelRoom || null;
        if (body.service === "hotel" && body.hotelRoomId) {
          const { data: room } = await supabase
            .from("rooms").select("name").eq("id", body.hotelRoomId).maybeSingle();
          if (room?.name) hotelRoomName = room.name;
        }

        // Derive vaccine status from uploaded docs / "will bring" flag.
        const vaccFileCount = body.vaccineDocuments ? Object.keys(body.vaccineDocuments).length : 0;
        const bringVaccines = body.bringVaccines === true || body.bringVaccines === "true";
        const vaccineStatus = vaccFileCount > 0
          ? `${vaccFileCount} file${vaccFileCount > 1 ? "s" : ""} uploaded`
          : bringVaccines ? "Will bring to venue" : "Not provided";

        // Add-ons with proper display names, for both the detail row and the bill.
        const addonNames = body.addons
          ? Object.keys(body.addons).map((k) => ADDON_NAMES[k] ?? k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
          : [];
        const emailAddonRows = body.addons
          ? Object.entries(body.addons).map(([k, price]) => ({
              addon_name: ADDON_NAMES[k] ?? k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
              price: Number(price) || 0,
            }))
          : [];
        const emailCharges = chargesFromPayload(body, subtotal, discountAmt);

        await sendBookingConfirmation({
          ownerEmail:      body.ownerEmail,
          ownerFirstName:  body.ownerFirst,
          ownerLastName:   body.ownerLast  || "",
          ownerMobile:     body.ownerPhone || "",
          petName:         body.petName,
          petAnimal:       body.petAnimal       || null,
          petGender:       body.petGender       || null,
          petBreed:        body.petBreed        || null,
          petAge:          body.petAge          || null,
          petAgeUnit:      body.petAgeUnit      || "years",
          petSize:         body.petSize         || null,
          petTemperament:  body.petTemperament  || null,
          petMedical:      body.petMedical      || null,
          membershipId:    body.membershipId    || null,
          vaccineStatus,
          vetClinic:       body.vetClinic       || null,
          vetContact:      body.vetContact      || null,
          vetAddress:      body.vetAddress      || null,
          emergencyName:   body.emergencyName   || null,
          emergencyPhone:  body.emergencyPhone  || null,
          hotelFeeding:    body.hotelFeeding    || null,
          hotelMeds:       body.hotelMeds       || null,
          groomNotes:      body.groomNotes      || null,
          daycareNotes:    body.daycareNotes    || null,
          refNumber:       booking.ref_number,
          status:          "pending",
          bookingSource:   body.booking_source || "admin",
          service:         body.service,
          branch,
          total,
          charges:         emailCharges,
          addonRows:       emailAddonRows,
          // Grooming
          groomServiceName: body.groomServiceName || null,
          addons:           addonNames,
          groomerName:      body.preferredStylist || null,
          groomDate:        body.groomDate || null,
          groomSlot:        body.groomSlot || null,
          // Hotel
          hotelRoomName,
          checkinDate:      body.hotelCheckin || null,
          checkoutDate:     body.hotelCheckout || null,
          dropoffTime:      body.hotelDropoff || null,
          pickupTime:       body.hotelPickup || null,
          playparkConsent:  body.playparkConsent === "yes",
          // Daycare
          daycareDate:      body.daycareDate || null,
          daycareDropoff:   body.daycareDropoff || null,
          daycarePickup:    body.daycarePickup || null,
          daycareOpenTime:  body.daycareOpenTime === true,
          // Studio
          studioDate:       body.studioDate || null,
          studioSlot:       body.studioSlot || null,
        });
      } catch (emailErr) {
        console.error("Email send failed (non-fatal):", emailErr);
      }
    }

    // 13. Success
    return new Response(
      JSON.stringify({ success: true, ref_number: booking.ref_number, booking_id: bookingId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("submit-booking error:", err);

    // Rollback: delete the booking row if detail inserts failed after it was created
    if (bookingId) {
      try {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );
        await supabase.from("bookings").delete().eq("id", bookingId);
        console.log("Rolled back orphaned booking:", bookingId);
      } catch (cleanupErr) {
        console.error("Rollback failed:", cleanupErr);
      }
    }

    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
