// Barkhaus — submit-booking edge function v2.2
// Wraps detail inserts in cleanup: if any detail row fails, the orphaned booking is deleted.
// Sends booking confirmation email for admin-created bookings.
//
// v2.2: booking_date now means the CREATION date (matches created_at). The
// SERVICE date for grooming/daycare/studio lives in each detail table's
// service_date column, mirroring how hotel uses checkin_date/checkout_date.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAdmin, sha256 } from "../_shared/security.ts";

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

// Temporarily pause confirmation emails for admin-created bookings while
// historical data is being migrated. Keep the email path in place so this can
// be restored by flipping the flag once the live data migration is complete.
const SEND_ADMIN_CREATED_CONFIRMATION_EMAIL = false;

// ── Email helper ──────────────────────────────────────────────

const BRANCH_BOOKING_EMAILS: Record<string, string> = {
  estancia: "booking.barkhausestancia@gmail.com",
  eastwood: "booking.barkhauseastwood@gmail.com",
};

function branchBookingEmail(branch?: { name?: string } | null): string | null {
  const name = (branch?.name || "").toLowerCase();
  if (name.includes("estancia")) return BRANCH_BOOKING_EMAILS.estancia;
  if (name.includes("eastwood")) return BRANCH_BOOKING_EMAILS.eastwood;
  return null;
}

async function sendBookingConfirmation(details: any) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) { console.error("RESEND_API_KEY not set — skipping email"); return; }
  const cc = branchBookingEmail(details.branch);
  const payload: Record<string, unknown> = {
    from: "Barkhaus Pet Services <hello@barkhaus.ph>",
    to: details.ownerEmail,
    subject: `Booking Confirmed — ${details.refNumber}`,
    html: buildEmailHtml(details),
  };
  if (cc && cc.toLowerCase() !== String(details.ownerEmail || "").toLowerCase()) {
    payload.cc = cc;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
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

function timeToMinutes(value: unknown): number {
  const text = String(value ?? "").trim();
  const display = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (display) {
    let hour = Number(display[1]);
    const minute = Number(display[2]);
    const period = display[3].toUpperCase();
    if (period === "PM" && hour !== 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    return hour * 60 + minute;
  }
  const database = text.match(/^(\d{1,2}):(\d{2})/);
  return database ? Number(database[1]) * 60 + Number(database[2]) : -1;
}

function groomingDuration(body: Record<string, any>): number {
  const base: Record<string, number> = { bath_dry: 30, basic: 60, premium: 120, ala_carte: 60 };
  const hasBuffer = Object.keys(body.addons ?? {}).some((key) => key === "demat" || key === "deshed");
  return (base[body.groomService] ?? 60) + (hasBuffer ? 30 : 0);
}

async function consumeWalkinToken(supabase: any, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !token) return false;
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from("walkin_tokens")
    .delete()
    .eq("id", token)
    .gte("created_at", cutoff)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Walk-in authorization failed: ${error.message}`);
  return !!data;
}

async function claimManualReceipt(
  supabase: any,
  manualPayment: Record<string, any>,
): Promise<string> {
  const path = String(manualPayment?.receiptPath || "");
  const uploadToken = String(manualPayment?.uploadToken || "");
  if (!path || !uploadToken) throw new Error("A valid receipt upload authorization is required.");

  const tokenHash = await sha256(uploadToken);
  const { data: upload, error: uploadError } = await supabase.from("pending_uploads")
    .select("id,bucket_id,object_path,content_type,max_size_bytes")
    .eq("token_hash", tokenHash)
    .eq("object_path", path)
    .eq("purpose", "manual_payment_receipt")
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (uploadError || !upload) throw new Error("Receipt upload authorization is invalid or expired.");

  const slash = path.lastIndexOf("/");
  const folder = slash >= 0 ? path.slice(0, slash) : "";
  const fileName = slash >= 0 ? path.slice(slash + 1) : path;
  const { data: files, error: storageError } = await supabase.storage
    .from(upload.bucket_id)
    .list(folder, { search: fileName, limit: 10 });
  if (storageError) throw new Error(`Could not verify uploaded receipt: ${storageError.message}`);
  const object = (files ?? []).find((file: any) => file.name === fileName);
  const size = Number(object?.metadata?.size ?? 0);
  const mime = String(object?.metadata?.mimetype ?? object?.metadata?.contentType ?? "").toLowerCase();
  if (!object || size <= 0 || size > Number(upload.max_size_bytes) ||
      (mime && mime !== String(upload.content_type).toLowerCase())) {
    throw new Error("Uploaded receipt could not be verified.");
  }

  const { data: claimed, error: claimError } = await supabase.from("pending_uploads")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", upload.id)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();
  if (claimError || !claimed) throw new Error("Receipt upload authorization has already been used.");
  return upload.id;
}

async function assertGroomingAvailable(supabase: any, branchId: string, body: Record<string, any>) {
  if (body.service !== "grooming") return;
  if (!body.groomDate || !body.groomSlot) throw new Error("Grooming date and slot are required.");

  const [{ data: groomers, error: groomerError }, { data: hours, error: hoursError }, { data: blocks, error: blockError }] = await Promise.all([
    supabase.from("groomers").select("id").eq("branch_id", branchId).eq("active", true).eq("is_unavailable", false),
    supabase.from("resource_service_hours").select("resource_id,start_time,end_time,last_service_time")
      .eq("branch_id", branchId).eq("resource_type", "groomer").eq("service_date", body.groomDate).eq("active", true),
    supabase.from("blocked_schedules").select("resource_id,start_time,end_time")
      .eq("resource_type", "groomer").eq("active", true).contains("dates", [body.groomDate]),
  ]);
  if (groomerError) throw new Error(`Could not validate groomers: ${groomerError.message}`);
  if (hoursError) throw new Error(`Could not validate service hours: ${hoursError.message}`);
  if (blockError) throw new Error(`Could not validate blocked schedules: ${blockError.message}`);

  const { data: bookingRows, error: bookingError } = await supabase
    .from("grooming_details")
    .select("booking_id,groomer_id,timeslot,groom_service_key,bookings!inner(branch_id,status)")
    .eq("service_date", body.groomDate)
    .eq("bookings.branch_id", branchId)
    .not("bookings.status", "in", "(cancelled,rejected)");
  if (bookingError) throw new Error(`Could not validate existing grooming bookings: ${bookingError.message}`);

  const bookingIds = (bookingRows ?? []).map((row: any) => row.booking_id).filter(Boolean);
  const durationAddonIds = new Set<string>();
  if (bookingIds.length) {
    const { data: addOns, error: addOnError } = await supabase.from("booking_addons")
      .select("booking_id,addon_key").in("booking_id", bookingIds).in("addon_key", ["demat", "deshed"]);
    if (addOnError) throw new Error(`Could not validate grooming add-ons: ${addOnError.message}`);
    (addOns ?? []).forEach((row: any) => durationAddonIds.add(row.booking_id));
  }

  const start = timeToMinutes(body.groomSlot);
  const end = start + groomingDuration(body);
  const durationFor = (row: any) => {
    const base: Record<string, number> = { bath_dry: 30, basic: 60, premium: 120, ala_carte: 60 };
    return (base[row.groom_service_key] ?? 60) + (durationAddonIds.has(row.booking_id) ? 30 : 0);
  };
  const overlaps = (rangeStart: number, rangeEnd: number) => start < rangeEnd && end > rangeStart;
  const canServe = (groomerId: string) => {
    const window = (hours ?? []).find((row: any) => row.resource_id === groomerId);
    if (!window) return false;
    const windowStart = timeToMinutes(window.start_time);
    const windowEnd = timeToMinutes(window.end_time);
    const lastService = timeToMinutes(window.last_service_time);
    if (start < windowStart || start > lastService || end > windowEnd) return false;
    if ((blocks ?? []).some((row: any) => row.resource_id === groomerId && overlaps(timeToMinutes(row.start_time), timeToMinutes(row.end_time)))) return false;
    return !(bookingRows ?? []).some((row: any) => {
      if (row.groomer_id !== groomerId || !row.timeslot) return false;
      const bookedStart = timeToMinutes(row.timeslot);
      return overlaps(bookedStart, bookedStart + durationFor(row));
    });
  };

  const unassigned = (bookingRows ?? []).filter((row: any) => {
    if (row.groomer_id != null || !row.timeslot) return false;
    const bookedStart = timeToMinutes(row.timeslot);
    return overlaps(bookedStart, bookedStart + durationFor(row));
  }).length;
  const pool = groomers ?? [];
  const selectedId = body.preferredStylistId || null;
  const available = selectedId
    ? pool.some((row: any) => row.id === selectedId) && canServe(selectedId) &&
      unassigned <= pool.filter((row: any) => row.id !== selectedId && canServe(row.id)).length
    : pool.filter((row: any) => canServe(row.id)).length > unassigned;
  if (!available) throw new Error("That grooming slot is no longer available. Please select another time.");
}

async function assertHotelAvailable(supabase: any, branchId: string, body: Record<string, any>) {
  if (body.service !== "hotel") return;
  if (!body.hotelCheckin || !body.hotelCheckout || !body.hotelRoomId) {
    throw new Error("Hotel dates and room selection are required.");
  }
  if (body.hotelCheckout <= body.hotelCheckin) throw new Error("Hotel checkout must be after check-in.");

  const { data: room, error: roomError } = await supabase.from("rooms")
    .select("id,room_type,allowed_sizes")
    .eq("id", body.hotelRoomId)
    .eq("branch_id", branchId)
    .eq("active", true)
    .eq("is_locked", false)
    .maybeSingle();
  if (roomError) throw new Error(`Could not validate room: ${roomError.message}`);
  if (!room) throw new Error("That room is no longer available.");
  if (body.hotelRoom && body.hotelRoom !== room.room_type) {
    throw new Error("That room does not match the selected room type.");
  }
  if (body.petSize && (!Array.isArray(room.allowed_sizes) || !room.allowed_sizes.includes(body.petSize))) {
    throw new Error("That room is not available for this pet size.");
  }

  const { data: overlaps, error: overlapError } = await supabase.from("hotel_details")
    .select("booking_id,bookings!inner(branch_id,status)")
    .eq("room_id", body.hotelRoomId)
    .lt("checkin_date", body.hotelCheckout)
    .gt("checkout_date", body.hotelCheckin)
    .eq("bookings.branch_id", branchId)
    .not("bookings.status", "in", "(cancelled,rejected)")
    .limit(1);
  if (overlapError) throw new Error(`Could not validate room occupancy: ${overlapError.message}`);
  if (overlaps?.length) throw new Error("That room is no longer available. Please select another room.");
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

// Waiver card: lists applicable agreements and their recorded consent status.
function waiverCard(d: any): string {
  const WAIVERS_URL = "https://barkhaus.ph/waivers";
  const generalByService: Record<string, [string, string]> = {
    grooming: ["Grooming Waiver", "grooming-waiver"],
    daycare:  ["Daycare Waiver", "daycare-waiver"],
    hotel:    ["Hotel Waiver", "hotel-waiver"],
  };
  const items: Array<[string, string, boolean]> = [];
  if (generalByService[d.service]) {
    const [label, anchor] = generalByService[d.service];
    items.push([label, anchor, !!d.waiverGeneral]);
  }
  if (d.service === "studio") {
    items.push(["Studio Usage Agreement", "studio-agreement", !!d.waiverStudio]);
  }
  items.push(["Vaccine & Health Declaration", "vaccine-declaration", !!d.waiverVaccine]);
  if (d.seniorWaiverApplicable || d.waiverSeniorMedical) {
    items.push(["Senior & Pre-existing Conditions Waiver", "senior-waiver", !!d.waiverSeniorMedical]);
  }
  if (d.service === "hotel" && d.petAnimal !== "cat") {
    items.push(["Play Park Consent", "playpark-consent", !!d.waiverPlaypark]);
  }
  items.push(["Media Consent", "media-consent", !!d.waiverMedia]);
  if (items.length === 0) return "";

  const rows = items.map(([label, anchor, accepted]) =>
    `<tr><td style="padding:8px 14px;border-bottom:0.5px solid rgba(77,150,185,0.08)">
       <a href="${WAIVERS_URL}#${anchor}" style="color:#B8D4E0;font-size:13px;font-weight:600;text-decoration:none">${label}</a>
       <span style="float:right;color:${accepted ? "#6BCB77" : "#FFCE58"};font-size:11px;font-weight:700">${accepted ? "✓ Accepted" : "Did not consent"}</span>
     </td></tr>`).join("");

  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#1F3D55;border:0.5px solid rgba(77,150,185,0.25);border-radius:10px;overflow:hidden;margin-bottom:14px">
      <tr><td style="padding:9px 14px;font-size:9px;font-weight:700;color:#6AAEC8;text-transform:uppercase;letter-spacing:0.12em;border-bottom:0.5px solid rgba(77,150,185,0.2)">Waivers &amp; consent status</td></tr>
      ${rows}
      <tr><td style="padding:9px 14px;font-size:11px;color:#6AAEC8;line-height:1.5">Tap any item to read the corresponding agreement, or view all at <a href="${WAIVERS_URL}" style="color:#4D96B9;text-decoration:none;font-weight:600">barkhaus.ph/waivers</a>.</td></tr>
    </table>`;
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
    ${waiverCard(d)}
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
  let claimedUploadId: string | null = null;
  let consumedWalkinToken: string | null = null;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const isWalkin = body.booking_source === "walkin" &&
      typeof body.walkinToken === "string" && body.walkinToken.length > 0;
    const isAdminCreated = body.adminCreated === true && !isWalkin;
    const configuredProvider = (Deno.env.get("PAYMENT_GATEWAY_PROVIDER") || "maya").toLowerCase();
    let admin: Record<string, any> | null = null;

    if (isAdminCreated) {
      try {
        admin = await requireAdmin(req, supabase);
      } catch (authError) {
        return new Response(JSON.stringify({
          error: authError instanceof Error ? authError.message : "Admin authentication required",
        }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
    const manual = body.manualPayment?.receiptPath ? body.manualPayment : null;
    if (!isAdminCreated && !isWalkin) {
      if (!manual || configuredProvider !== "manual") {
        return new Response(JSON.stringify({ error: "Direct public booking submission is not enabled." }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else if (manual) {
      return new Response(JSON.stringify({ error: "Manual receipt submissions are only accepted from the public manual-payment flow." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate required fields
    const required = ["location", "service", "petName", "petAnimal", "petGender",
                      "ownerFirst", "ownerLast", "ownerPhone"];
    if (!isAdminCreated && !isWalkin) required.push("ownerEmail");
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
    if (admin && Array.isArray(admin.branch_ids) && admin.branch_ids.length > 0 &&
        !admin.branch_ids.includes(branch.id)) {
      return new Response(JSON.stringify({ error: "This admin does not have access to the selected branch." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate against the same service-hours, cutoff, block, booking, and duration
    // rules used by both booking UIs before creating owner/pet/booking records.
    await assertGroomingAvailable(supabase, branch.id, body);
    await assertHotelAvailable(supabase, branch.id, body);

    if (isWalkin && !(await consumeWalkinToken(supabase, body.walkinToken))) {
      return new Response(JSON.stringify({ error: "Walk-in authorization is invalid, expired, or already used." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (isWalkin) consumedWalkinToken = body.walkinToken;
    if (manual) claimedUploadId = await claimManualReceipt(supabase, manual);

    // 2. Upsert owner
    let ownerId: string;
    const ownerEmail = body.ownerEmail?.trim().toLowerCase() || "";
    const { data: existingOwner } = ownerEmail
      ? await supabase
          .from("owners")
          .select("id")
          .ilike("email", ownerEmail)
          .maybeSingle()
      : { data: null };

    if (existingOwner) {
      ownerId = existingOwner.id;
    } else {
      const { data: newOwner, error: ownerErr } = await supabase
        .from("owners")
        .insert({
          first_name:      body.ownerFirst.trim(),
          last_name:       body.ownerLast.trim(),
          email:           ownerEmail || null,
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

    const initialStatus = (manual || isWalkin) ? "confirmed" : "pending";
    const initialPaymentStatus = "unpaid";
    const bookingSource = isAdminCreated ? (body.booking_source || "admin") : (isWalkin ? "walkin" : "online");

    // 7. Insert booking
    const { data: booking, error: bookingErr } = await supabase
      .from("bookings")
      .insert({
        branch_id:               branch.id,
        owner_id:                ownerId,
        pet_id:                  pet.id,
        service:                 body.service,
        status:                  initialStatus,
        payment_status:          initialPaymentStatus,
        booking_date:            bookingDate,
        subtotal,
        discount_amount:         discountAmt,
        total,
        member_discount_applied: memberDiscountApplied,
        member_code_used:        memberCodeUsed,
        booking_source:          bookingSource,
      })
      .select("id, ref_number")
      .single();
    if (bookingErr) throw new Error(`Booking insert failed: ${bookingErr.message}`);

    bookingId = booking.id;

    // 7b. Record the manual transfer payment (with the uploaded receipt path)
    if (manual) {
      const bankLabels: Record<string, string> = {
        gcash: "GCash",
        bpi:   "BPI",
        bdo:   "BDO",
      };
      const destinationBank = bankLabels[String(manual.method || "").toLowerCase()] || "Manual transfer";
      const { error: payErr } = await supabase.from("payments").insert({
        booking_id:   bookingId,
        amount:       total,
        type:         "downpayment",
        method:       "manual_online",
        receipt_path: manual.receiptPath,
        recorded_by:  "customer",
        notes:        `${destinationBank} receipt submitted — awaiting verification`,
      });
      if (payErr) throw new Error(`Payment insert failed: ${payErr.message}`);
    }

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

    // 10c. Grooming reference photos ("pegs") — paths produced by get-upload-url
    if (body.service === "grooming" && body.groomReferenceImages && Object.keys(body.groomReferenceImages).length > 0) {
      const pegRows = Object.entries(body.groomReferenceImages).map(([key, path]) => ({
        booking_id: bookingId,
        file_path:  path as string,
        file_name:  (body.groomReferenceFileNames && body.groomReferenceFileNames[key]) || (path as string).split("/").pop(),
      }));
      const { error } = await supabase.from("grooming_reference_images").insert(pegRows);
      if (error) console.error("Grooming reference images insert failed (non-fatal):", error.message);
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

    // 12. Send confirmation email for eligible bookings.
    // Online manual-transfer bookings still confirm here. Admin-created booking
    // emails are paused during data migration; flip the flag above to re-enable.
    const shouldSendAdminCreatedEmail =
      body.adminCreated === true && SEND_ADMIN_CREATED_CONFIRMATION_EMAIL;
    if ((shouldSendAdminCreatedEmail || manual) && body.ownerEmail) {
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
          status:          initialStatus,
          bookingSource,
          service:         body.service,
          // Accepted waivers / consents (for the email waiver card + links)
          waiverGeneral:       body.waiverGeneral       === true || body.waiverGeneral       === "true",
          waiverVaccine:       body.waiverVaccine       === true || body.waiverVaccine       === "true",
          waiverSeniorMedical: body.waiverSeniorMedical === true || body.waiverSeniorMedical === "true",
          waiverStudio:        body.waiverStudio        === true || body.waiverStudio        === "true",
          waiverMedia:         body.waiverMedia         === true || body.waiverMedia         === "true",
          waiverPlaypark:      body.waiverPlaypark      === true || body.waiverPlaypark      === "true",
          seniorWaiverApplicable: !!body.waiverTexts?.senior ||
            body.waiverSeniorMedical === true || body.waiverSeniorMedical === "true",
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
      JSON.stringify({
        success: true,
        ref_number: booking.ref_number,
        booking_id: bookingId,
        payment_status: initialPaymentStatus,
      }),
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
    if (claimedUploadId) {
      try {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );
        await supabase.from("pending_uploads")
          .update({ consumed_at: null })
          .eq("id", claimedUploadId);
      } catch (uploadCleanupErr) {
        console.error("Upload authorization rollback failed:", uploadCleanupErr);
      }
    }
    if (consumedWalkinToken) {
      try {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );
        await supabase.from("walkin_tokens").insert({ id: consumedWalkinToken });
      } catch (walkinCleanupErr) {
        console.error("Walk-in token rollback failed:", walkinCleanupErr);
      }
    }

    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
