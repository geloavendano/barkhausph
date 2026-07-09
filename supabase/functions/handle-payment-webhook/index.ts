// Barkhaus — handle-payment-webhook edge function
// Includes booking confirmation email via Resend

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHmac } from "https://deno.land/std@0.168.0/node/crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, paymongo-signature",
};

function mayaBaseUrl(): string {
  return (Deno.env.get("MAYA_ENVIRONMENT") || "sandbox").toLowerCase() === "production"
    ? "https://pg.maya.ph"
    : "https://pg-sandbox.paymaya.com";
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

function mayaCheckoutId(payload?: Record<string, any> | null): string | null {
  return payload?.checkoutId || payload?.checkout?.id || payload?.metadata?.checkoutId || null;
}

function isBookingRef(value?: string | null): boolean {
  return /^BH-[A-Z0-9]+$/i.test(String(value || ""));
}

function isSuccessfulMayaStatus(status?: string | null): boolean {
  return status === "PAYMENT_SUCCESS" || status === "SUCCESS";
}

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

// ── Shared charge builder ──────────────────────────────────────
// Derives the itemised charge list from the booking payload so the same
// breakdown can be used for both the DB insert and the email template.
type ChargeItem = { type: string; label: string; amount: number };

function chargesFromPayload(body: Record<string, unknown>, subtotal: number, discountAmt: number): ChargeItem[] {
  const lateFee       = parseInt(body.hotelLateTotal as string) || 0;
  const convFee       = parseInt(body.convenienceFee as string) || 0;
  const groomSvcPrice = parseInt(body.groomServicePrice as string) || 0;

  const svcLabel = (body.service === "grooming" && body.groomServiceName)
    ? `Grooming – ${body.groomServiceName}`
    : ({ hotel: "Pet Hotel Stay", daycare: "Daycare", studio: "Self-Shoot Studio" } as Record<string, string>)[body.service as string]
    ?? "Barkhaus Booking";

  // Grooming: base = service package price (add-ons accounted for via addonRows)
  // All others: base = subtotal minus any late-pickup fee
  const baseAmt = body.service === "grooming" ? groomSvcPrice : subtotal - lateFee;

  const rows: ChargeItem[] = [];
  if (baseAmt > 0)  rows.push({ type: "base_service",    label: svcLabel,           amount: baseAmt });
  if (lateFee > 0)  rows.push({
    type: "late_pickup",
    label: body.hotelLateIsAdditionalNight ? "Additional night (pickup after 8 PM)" : "Late pick-up fee",
    amount: lateFee,
  });
  if (discountAmt > 0) rows.push({ type: "member_discount", label: "Member discount",  amount: discountAmt });
  if (convFee > 0)  rows.push({ type: "convenience_fee", label: "Convenience fee",  amount: convFee });
  return rows;
}

// ── Email helpers ─────────────────────────────────────────────

const BRANCH_BOOKING_EMAILS: Record<string, string> = {
  estancia: "booking.barkhausestancia@gmail.com",
  eastwood: "booking.barkhauseastwood@gmail.com",
};
const PAYMENT_ALERT_EMAILS = ["gelo@hey.com"];

function branchBookingEmail(branch?: { name?: string } | null): string | null {
  const name = (branch?.name || "").toLowerCase();
  if (name.includes("estancia")) return BRANCH_BOOKING_EMAILS.estancia;
  if (name.includes("eastwood")) return BRANCH_BOOKING_EMAILS.eastwood;
  return null;
}

function branchBookingEmailFromLocation(location?: string | null): string | null {
  const loc = String(location || "").toLowerCase();
  if (loc.includes("estancia")) return BRANCH_BOOKING_EMAILS.estancia;
  if (loc.includes("eastwood")) return BRANCH_BOOKING_EMAILS.eastwood;
  return null;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function recordPaymentEvent(supabase: any, event: Record<string, unknown>) {
  const { data, error } = await supabase.from("payment_events").insert(event).select("id").single();
  if (error) {
    console.error("Payment event audit insert failed:", error.message);
    return null;
  }
  return data?.id ?? null;
}

async function markPaymentEventAlerted(supabase: any, eventId: string | null, alertError?: string | null) {
  if (!eventId) return;
  const payload = alertError
    ? { alert_sent: false, alert_error: alertError.slice(0, 500) }
    : { alert_sent: true, alert_error: null };
  const { error } = await supabase.from("payment_events").update(payload).eq("id", eventId);
  if (error) console.error("Payment event alert audit update failed:", error.message);
}

async function sendPaymentFailureAlert(details: Record<string, any>) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY not set");

  const branchEmail = branchBookingEmailFromLocation(details.location);
  const recipients = Array.from(new Set([
    ...(branchEmail ? [branchEmail] : Object.values(BRANCH_BOOKING_EMAILS)),
    ...PAYMENT_ALERT_EMAILS,
  ]));

  const ref = details.refNumber || "Unknown ref";
  const eventType = details.eventType || "Unknown event";
  const amount = Number(details.amount || 0).toLocaleString("en-PH");
  const action = eventType === "PAYMENT_EXPIRED"
    ? "The pending booking hold was expired and inventory was released."
    : "The booking hold remains active until customer retry/edit or the 15-minute expiry.";

  const rows = [
    ["Booking ref", ref],
    ["Maya event", eventType],
    ["Maya payment ID", details.paymentId || "—"],
    ["Checkout ID", details.checkoutId || "—"],
    ["Amount", details.amount ? `PHP ${amount}` : "—"],
    ["Branch", details.location || "—"],
    ["Service", details.service || "—"],
    ["Pet", details.petName || "—"],
    ["Owner", [details.ownerFirst, details.ownerLast].filter(Boolean).join(" ") || "—"],
    ["Owner email", details.ownerEmail || "—"],
    ["Action", action],
  ];

  const htmlRows = rows.map(([label, value]) => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;color:#64748b">${escapeHtml(label)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:600">${escapeHtml(value)}</td>
    </tr>
  `).join("");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Barkhaus Pet Services <hello@barkhaus.ph>",
      to: recipients,
      subject: `Maya payment alert — ${eventType} — ${ref}`,
      html: `<!doctype html>
        <html><body style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px">
          <div style="max-width:640px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
            <div style="padding:18px 22px;background:#0B1F2A;color:#fff">
              <h1 style="margin:0;font-size:18px">Maya payment alert</h1>
              <p style="margin:6px 0 0;color:#bae6fd">${escapeHtml(ref)}</p>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:14px">${htmlRows}</table>
          </div>
        </body></html>`,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function sendBookingConfirmation(details: any) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) { console.error("RESEND_API_KEY not set — skipping email"); return; }
  const cc = branchBookingEmail(details.branch);
  const payload: Record<string, unknown> = {
    from: "Barkhaus Pet Services <hello@barkhaus.ph>",
    to:   details.ownerEmail,
    subject: `Booking Confirmed — ${details.refNumber}`,
    html: buildEmailHtml(details),
  };
  if (cc && cc.toLowerCase() !== String(details.ownerEmail || "").toLowerCase()) {
    payload.cc = cc;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
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

function detailRow(label: string, value: string): string {
  return `<tr style="border-bottom:0.5px solid rgba(77,150,185,0.12)">
    <td style="padding:9px 14px;color:#6AAEC8;width:42%;font-size:12px;font-weight:600;white-space:nowrap">${label}</td>
    <td style="padding:9px 14px;color:#B8D4E0;font-size:13px">${value}</td>
  </tr>`;
}

function bookingDetailRows(d: any): string {
  const svcLabel: Record<string, string> = {
    grooming: "Grooming", hotel: "Pet Hotel", daycare: "Daycare", studio: "Studio",
  };
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
    if (d.daycareOpenTime) {
      rows += detailRow("Drop-off", "Open time") + detailRow("Pick-up", "Open time");
    } else {
      if (d.daycareDropoff) rows += detailRow("Drop-off", d.daycareDropoff);
      rows += detailRow("Pick-up", d.daycarePickup ?? "—");
    }
    if (d.daycareNotes) rows += detailRow("Daycare notes", d.daycareNotes);
  }
  if (d.service === "studio") {
    if (d.studioDate) rows += detailRow("Date", fmtDate(d.studioDate));
    if (d.studioSlot) rows += detailRow("Time slot", d.studioSlot);
  }
  return rows;
}

function petDetailRows(d: any): string {
  const sizeLabels: Record<string, string> = {
    tiny: "Tiny", small_dog: "Small", medium_dog: "Medium Dog",
    large_dog: "Large Dog", giant_dog: "Giant Dog", cat: "Cat",
  };
  const tempLabels: Record<string, string> = {
    friendly_all: "Friendly with all", friendly_shy: "Friendly but shy",
    selective: "Selective", reactive: "Reactive", first_time: "First time",
  };
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
    if (d.vetClinic || d.vetContact) {
      if (d.vetClinic)  rows += detailRow("Vet clinic",   d.vetClinic);
      if (d.vetContact) rows += detailRow("Vet contact",  d.vetContact);
      if (d.vetAddress) rows += detailRow("Vet address",  d.vetAddress);
    }
    if (d.emergencyName || d.emergencyPhone) {
      if (d.emergencyName)  rows += detailRow("Emergency contact", d.emergencyName);
      if (d.emergencyPhone) rows += detailRow("Emergency phone",   d.emergencyPhone);
    }
    if (d.hotelFeeding) rows += detailRow("Feeding instructions", d.hotelFeeding);
    if (d.hotelMeds)    rows += detailRow("Medications",          d.hotelMeds);
  }
  return rows;
}

function ownerDetailRows(d: any): string {
  let rows = detailRow("Name",   `${d.ownerFirstName} ${d.ownerLastName || ""}`.trim());
  if (d.ownerEmail)  rows += detailRow("Email",  d.ownerEmail);
  if (d.ownerMobile) rows += detailRow("Mobile", d.ownerMobile);
  return rows;
}

function paymentSummaryRows(
  charges: Array<{ type: string; label: string; amount: number }>,
  addonRows: Array<{ addon_name: string; price: number }>,
  total: number,
): string {
  const stdRow = (label: string, value: string) =>
    `<tr style="border-bottom:0.5px solid rgba(77,150,185,0.08)">
      <td style="padding:8px 14px;color:#6AAEC8;width:55%;font-size:13px">${label}</td>
      <td style="padding:8px 14px;color:#B8D4E0;font-size:13px;text-align:right">${value}</td>
    </tr>`;
  const discRow = (label: string, value: string) =>
    `<tr style="border-bottom:0.5px solid rgba(77,150,185,0.08)">
      <td style="padding:8px 14px;color:#6AAEC8;width:55%;font-size:13px">${label}</td>
      <td style="padding:8px 14px;color:#6BCB77;font-size:13px;text-align:right">${value}</td>
    </tr>`;
  const dimRow = (label: string, value: string) =>
    `<tr style="border-bottom:0.5px solid rgba(77,150,185,0.08)">
      <td style="padding:8px 14px;color:#4D96B9;width:55%;font-size:12px">${label}</td>
      <td style="padding:8px 14px;color:#4D96B9;font-size:12px;text-align:right">${value}</td>
    </tr>`;
  const totalRow = (label: string, value: string) =>
    `<tr>
      <td style="padding:10px 14px;color:#F0EDE6;width:55%;font-size:14px;font-weight:700;border-top:0.5px solid rgba(77,150,185,0.3)">${label}</td>
      <td style="padding:10px 14px;color:#FFCE58;font-size:14px;font-weight:700;text-align:right;border-top:0.5px solid rgba(77,150,185,0.3)">${value}</td>
    </tr>`;

  let rows = "";
  const base = charges.find(c => c.type === "base_service");
  if (base && base.amount > 0) rows += stdRow(base.label, `₱${base.amount.toLocaleString()}`);
  for (const a of (addonRows || [])) {
    if ((a.price || 0) > 0) rows += stdRow(a.addon_name, `₱${a.price.toLocaleString()}`);
  }
  const late = charges.find(c => c.type === "late_pickup");
  if (late && late.amount > 0) rows += stdRow(late.label, `₱${late.amount.toLocaleString()}`);
  const disc = charges.find(c => c.type === "member_discount");
  if (disc && disc.amount > 0) rows += discRow("Member discount", `−₱${disc.amount.toLocaleString()}`);
  const conv = charges.find(c => c.type === "convenience_fee");
  if (conv && conv.amount > 0) rows += dimRow("Convenience fee", `₱${conv.amount.toLocaleString()}`);
  rows += totalRow("Total · Paid", `₱${total.toLocaleString()}`);
  return rows;
}

function waiverCard(d: any): string {
  const WAIVERS_URL = "https://barkhaus.ph/waivers";
  const generalByService: Record<string, [string, string]> = {
    grooming: ["Grooming Waiver", "grooming-waiver"],
    daycare:  ["Daycare Waiver", "daycare-waiver"],
    hotel:    ["Hotel Waiver", "hotel-waiver"],
  };
  const items: Array<[string, string, boolean]> = [];
  if (d.waiverHouseRules != null) {
    items.push(["General House Rules", "general-house-rules", !!d.waiverHouseRules]);
  }
  if (generalByService[d.service]) {
    const [label, anchor] = generalByService[d.service];
    items.push([label, anchor, !!d.waiverGeneral]);
  }
  if (d.service === "grooming" && d.waiverGroomingPolicy != null) {
    items.push(["Grooming Services Booking Policy", "grooming-booking-policy", !!d.waiverGroomingPolicy]);
  }
  if (d.service === "hotel" && d.waiverHotelCancellation != null) {
    items.push(["Hotel Cancellation and Refund Policy", "hotel-cancellation-policy", !!d.waiverHotelCancellation]);
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

function bookingPolicyNotice(d: any): string {
  let text = "";
  if (d.service === "grooming") {
    text = `A one-time reschedule may be requested at least <strong style="color:#4D96B9">3 hours before</strong> the appointment. A 15-minute grace period applies; later arrival may forfeit the slot. All grooming down payments are <strong style="color:#FFCE58">non-refundable</strong>, including no-shows, forfeited late arrivals, and cancellations.`;
  } else if (d.service === "hotel") {
    text = `A one-time reschedule may be requested at least <strong style="color:#4D96B9">7 days before check-in</strong>, subject to availability. Cancellations at least 7 days before check-in are eligible for a 50% refund; cancellations 6 days or less before check-in are eligible for a 25% refund. Rescheduled bookings are final, no-shows forfeit all payments, and approved refunds are processed within 3-7 banking days.`;
  } else {
    text = `For booking changes or cancellations, please <strong style="color:#4D96B9">contact the branch directly</strong>.`;
  }
  return `<div style="background:rgba(77,150,185,0.1);border:0.5px solid rgba(77,150,185,0.25);border-radius:10px;padding:12px 14px;margin-bottom:22px">
    <p style="margin:0;font-size:13px;color:#B8D4E0;line-height:1.55">📋 ${text}</p>
  </div>`;
}

function buildEmailHtml(d: any): string {
  const bookingDate = new Date().toLocaleDateString("en-PH", {
    month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
    timeZone: "Asia/Manila",
  });

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
    <p style="font-weight:700;font-size:22px;color:#F0EDE6;margin:0 0 6px">Hi ${d.ownerFirstName}! 🐾</p>
    <p style="color:#B8D4E0;margin:0 0 22px;line-height:1.65;font-size:13px">
      Great news — <strong style="color:#F0EDE6">${d.petName}'s</strong> booking is all set and we're so excited to see them!
    </p>
    <div style="margin-bottom:22px">
      <span style="font-size:11px;font-weight:700;padding:4px 12px;border-radius:999px;background:rgba(107,203,119,0.15);color:#6BCB77;border:0.5px solid #6BCB77">Confirmed</span>
      <span style="font-size:12px;color:#6AAEC8;font-weight:600;margin-left:8px">${d.refNumber}</span>
      <span style="font-size:11px;color:#6AAEC8;margin-left:8px">· ${bookingDate}</span>
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
      ${paymentSummaryRows(d.charges, d.addonRows, d.total)}
    </table>

    <div style="background:rgba(255,206,88,0.08);border:0.5px solid rgba(255,206,88,0.25);border-radius:10px;padding:12px 14px;margin-bottom:14px">
      <p style="margin:0;font-size:13px;color:#B8D4E0;line-height:1.55">
        ⏰ Please arrive <strong style="color:#FFCE58">15 minutes before</strong> your scheduled time to make check-in a breeze!
      </p>
    </div>
    ${bookingPolicyNotice(d)}
    <p style="color:#6AAEC8;font-size:13px;line-height:1.6;margin:0 0 16px">
      Can't wait to see ${d.petName}! If you have any questions, reach out to your branch directly. 🐶
    </p>
    <p style="color:#4D96B9;font-size:11px;line-height:1.6;margin:0;padding:10px 14px;background:rgba(77,150,185,0.08);border-radius:8px;border:0.5px solid rgba(77,150,185,0.2)">
      📭 This is a no-reply email. Please contact your branch by phone or Instagram for changes or cancellations.
    </p>
  </td></tr>
  <tr><td style="border-top:0.5px solid rgba(77,150,185,0.25);padding:18px 28px;background:#0F1C26">
    <p style="font-size:9px;font-weight:700;color:#6AAEC8;margin:0 0 12px;text-transform:uppercase;letter-spacing:0.12em">Your branch</p>
    <p style="font-weight:700;font-size:16px;color:#F0EDE6;margin:0 0 3px">Barkhaus ${d.branch.name}</p>
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

// ── Main handler ──────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const rawBody = await req.text();
  console.log("Webhook received, body length:", rawBody.length);

  try {
    const event = JSON.parse(rawBody);
    const isMaya = !!(event?.id && mayaStatus(event));
    const provider = isMaya ? "maya" : "paymongo";

    // PayMongo signs its webhook. Maya's documented security model uses source
    // IP allowlisting; we additionally retrieve the payment server-to-server
    // below and reconcile its status, reference, currency, and amount.
    const webhookSecret = Deno.env.get("PAYMONGO_WEBHOOK_SECRET");
    if (!isMaya && webhookSecret) {
      const sigHeader = req.headers.get("paymongo-signature");
      if (!sigHeader) {
        return new Response(JSON.stringify({ error: "Missing signature" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const parts: Record<string, string> = {};
      sigHeader.split(",").forEach((part) => {
        const eq = part.indexOf("=");
        if (eq > -1) parts[part.slice(0, eq)] = part.slice(eq + 1);
      });
      const expectedSig = createHmac("sha256", webhookSecret)
        .update(`${parts["t"]}.${rawBody}`)
        .digest("hex");
      const receivedSig = parts["te"] || parts["li"];
      if (receivedSig !== expectedSig) {
        console.error("Signature mismatch");
        return new Response(JSON.stringify({ error: "Invalid signature" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    const eventType = isMaya ? mayaStatus(event) : event?.data?.attributes?.type;
    console.log("Provider:", provider, "event type:", eventType);

    const paidEvent = isMaya
      ? isSuccessfulMayaStatus(eventType)
      : eventType === "payment.paid" || eventType === "checkout_session.payment.paid";

    if (!paidEvent && !isMaya) {
      return new Response(JSON.stringify({ received: true, skipped: eventType }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Normalize event structure ───────────────────────────────────────────────
    // PayMongo fires TWO events for every online payment:
    //   1. payment.paid                    → event.data.attributes.data = payment object
    //   2. checkout_session.payment.paid   → event.data.attributes.data = checkout session object
    //                                         actual payment is at .attributes.payments[0]
    //                                         booking metadata is at .attributes.metadata
    //
    // We normalise to a single paymentId/paidAmount/bookingMetadata regardless of event type.
    // Both events will then share the same paymentId, so the payments-table idempotency
    // check stops the second event before it does any duplicate work.

    const eventData  = isMaya ? event : event?.data?.attributes?.data;
    const eventAttrs = isMaya ? event : eventData?.attributes;

    let paymentId:      string = "";
    let paidAmount:     number = 0;
    let description:    string = "";
    let bookingMeta:    Record<string, string> | null = null;

    if (isMaya) {
      const mayaSecret = Deno.env.get("MAYA_SECRET_KEY");
      if (!mayaSecret) throw new Error("MAYA_SECRET_KEY not configured");

      const verifyRes = await fetch(`${mayaBaseUrl()}/payments/v1/payments/${encodeURIComponent(event.id)}`, {
        headers: { "Authorization": `Basic ${btoa(mayaSecret + ":")}`, "Accept": "application/json" },
      });
      const verified = await verifyRes.json();
      if (!verifyRes.ok) {
        console.error("Maya payment verification failed:", verifyRes.status, JSON.stringify(verified));
        return new Response(JSON.stringify({ error: "Unable to verify Maya payment" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const verifiedStatus = mayaStatus(verified);
      const verifiedRef = mayaReference(verified);
      const eventRef = mayaReference(event);
      const verifiedCheckoutId = mayaCheckoutId(verified);
      const eventCheckoutId = mayaCheckoutId(event);
      const statusesMatch = verifiedStatus === eventType ||
        (isSuccessfulMayaStatus(verifiedStatus) && isSuccessfulMayaStatus(eventType));
      const refsConflict = verifiedRef && eventRef && verifiedRef !== eventRef &&
        isBookingRef(verifiedRef) && isBookingRef(eventRef);
      if (verified.id !== event.id || !statusesMatch || refsConflict) {
        console.error("Maya webhook does not match retrieved payment");
        return new Response(JSON.stringify({ error: "Maya payment verification mismatch" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const verifiedCurrency = verified?.totalAmount?.currency || verified?.currency;
      if (verifiedCurrency && verifiedCurrency !== "PHP") {
        console.error("Unexpected Maya payment currency:", verifiedCurrency);
        return new Response(JSON.stringify({ error: "Payment currency mismatch" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      paymentId   = verified.id || event.id || "";
      paidAmount  = mayaAmount(verified);
      bookingMeta = (verified.metadata || event.metadata || null) as Record<string, string> | null;
      if (verifiedCheckoutId && eventCheckoutId && verifiedCheckoutId !== eventCheckoutId) {
        console.warn("Maya checkout ID mismatch between event and verified payment:", eventCheckoutId, verifiedCheckoutId);
      }
      description = `Maya ${verified.paymentScheme || verified.fundSource?.type || "checkout"}`;
      console.log("Maya event — payment:", paymentId, "amount:", paidAmount);
    } else if (eventType === "checkout_session.payment.paid") {
      // eventData = checkout session; get the actual payment from its payments array
      const actualPayment = eventAttrs?.payments?.[0];
      paymentId   = actualPayment?.id || "";
      paidAmount  = Math.floor((actualPayment?.attributes?.amount || 0) / 100);
      // Booking metadata was set on the checkout session (not the payment)
      bookingMeta = (eventAttrs?.metadata as Record<string, string>) || null;
      description = eventAttrs?.description || actualPayment?.attributes?.description || "";
      console.log("CS event — session:", eventData?.id, "payment:", paymentId, "amount:", paidAmount);
    } else {
      // payment.paid — eventData IS the payment object
      paymentId   = eventData?.id || "";
      paidAmount  = Math.floor((eventAttrs?.amount || 0) / 100);
      bookingMeta = (eventAttrs?.metadata as Record<string, string>) || null;
      description = eventAttrs?.description || "";
      console.log("Payment event — payment:", paymentId, "amount:", paidAmount);
    }

    // ── Extract booking identity ─────────────────────────────────────────────────
    // Prefer metadata set by create-payment (reliable, no text-parsing required).
    // Fall back to parsing the description for backward compatibility.
    const bookingIdFromMeta = bookingMeta?.booking_id || bookingMeta?.bookingId || null;
    const refFromMeta       = bookingMeta?.ref_number || bookingMeta?.refNumber || null;
    const refFromDesc       = description.match(/Ref:\s*(BH-[A-Z0-9]+)/i)?.[1] || null;
      const refNumber         = isMaya
        ? (mayaReference(event) || refFromMeta || refFromDesc || null)
        : (refFromMeta || refFromDesc || null);

    console.log("bookingId (meta):", bookingIdFromMeta, "ref:", refNumber);

    let paymentEventId: string | null = null;
    if (isMaya) {
      paymentEventId = await recordPaymentEvent(supabase, {
        provider,
        event_type: eventType,
        payment_status: eventType,
        ref_number: refNumber,
        booking_id: bookingIdFromMeta,
        gateway_checkout_id: mayaCheckoutId(eventData),
        gateway_payment_id: paymentId || null,
        amount: paidAmount || null,
        currency: eventData?.totalAmount?.currency || eventData?.currency || null,
        payment_channel: eventData?.paymentScheme || eventData?.fundSource?.type || null,
        metadata: {
          source: "handle-payment-webhook",
          event_ref: mayaReference(event),
          verified_ref: mayaReference(eventData),
          verified_status: eventType,
        },
      });
    }

    if (!bookingIdFromMeta && !refNumber) {
      // payment.paid events from checkout-session payments carry no metadata or
      // description on the payment object itself — those live on the checkout
      // session and arrive via checkout_session.payment.paid instead.
      // Return 200 so PayMongo does NOT retry: retrying creates a window where
      // the fallback path can run concurrently with checkout_session.payment.paid
      // and create a duplicate booking with a random ref_number.
      console.log("No booking identifiers on event (expected for payment.paid from checkout) — ack and skip");
      return new Response(JSON.stringify({ received: true, note: "No identifiers — handled by checkout_session event" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Idempotency: bail if this provider payment ID is already recorded ────────
    if (paymentId) {
      const { data: existingPay } = await supabase
        .from("payments")
        .select("booking_id")
        .eq("reference_number", paymentId)
        .maybeSingle();
      if (existingPay) {
        console.log("Payment already recorded:", paymentId, "— skipping duplicate event");
        return new Response(
          JSON.stringify({ received: true, note: "Already processed", booking_id: existingPay.booking_id }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ── Find pending record ──────────────────────────────────────────────────────
    // Priority: provider checkout/payment IDs → legacy PayMongo session ID → reference.
    let pending: any = null;

    if (isMaya && mayaCheckoutId(eventData)) {
      const { data } = await supabase.from("pending_bookings")
        .select("*").eq("gateway_checkout_id", mayaCheckoutId(eventData)).maybeSingle();
      pending = data;
    }
    if (isMaya && !pending && paymentId) {
      const { data } = await supabase.from("pending_bookings")
        .select("*").eq("gateway_payment_id", paymentId).maybeSingle();
      pending = data;
    }
    if (!pending && eventType === "checkout_session.payment.paid" && eventData?.id) {
      const { data } = await supabase.from("pending_bookings")
        .select("*").eq("paymongo_link_id", eventData.id).maybeSingle();
      pending = data;
    }
    if (!pending && refNumber) {
      const { data } = await supabase.from("pending_bookings")
        .select("*").eq("ref_number", refNumber).maybeSingle();
      pending = data;
    }
    if (!pending && bookingIdFromMeta) {
      // Pending may have already been cleaned up by the other event — check the
      // booking itself to decide if this is truly a duplicate or a late arrival.
      const { data: eb } = await supabase.from("bookings")
        .select("id, status, payment_status")
        .eq("id", bookingIdFromMeta)
        .maybeSingle();
      if (eb?.status === "confirmed" && eb?.payment_status === "paid") {
        console.log("Booking already confirmed (no pending found):", bookingIdFromMeta);
        return new Response(JSON.stringify({ received: true, note: "Already processed", booking_id: bookingIdFromMeta }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
    // Maya PAYMENT_EXPIRED can arrive after the pending hold was already released
    // (the expiry cron deleted it, or a prior event cleaned it up). Without this,
    // the function would short-circuit below and leave the booking stranded at
    // pending/unpaid forever. Cancel the orphaned booking directly by ref / id.
    // The status+payment guard makes it idempotent and never touches a booking
    // that was meanwhile confirmed + paid.
    if (!pending && isMaya && eventType === "PAYMENT_EXPIRED" && (refNumber || bookingIdFromMeta)) {
      const base = supabase.from("bookings")
        .update({ status: "cancelled", cancellation_reason: "Payment window expired" })
        .eq("status", "pending")
        .eq("payment_status", "unpaid");
      const { data: cancelled } = refNumber
        ? await base.eq("ref_number", refNumber).select("id").maybeSingle()
        : await base.eq("id", bookingIdFromMeta).select("id").maybeSingle();
      console.log("Expired with no pending — orphaned booking cancel:", cancelled?.id ?? "no match", "ref:", refNumber);
      return new Response(
        JSON.stringify({ received: true, note: "Expired — orphaned booking cancelled", booking_id: cancelled?.id ?? null }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!pending) {
      console.log("Pending not found — already processed or expired");
      return new Response(JSON.stringify({ received: true, note: "Already processed or expired" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (isMaya && paymentId && !pending.gateway_payment_id) {
      await supabase.from("pending_bookings")
        .update({ gateway_payment_id: paymentId })
        .eq("id", pending.id);
    }
    if (isMaya && paymentEventId) {
      await supabase.from("payment_events")
        .update({
          pending_booking_id: pending.id,
          ref_number: pending.ref_number || refNumber,
          gateway_checkout_id: mayaCheckoutId(eventData) || pending.gateway_checkout_id || null,
          gateway_payment_id: paymentId || pending.gateway_payment_id || null,
        })
        .eq("id", paymentEventId);
    }

    // Maya expiry is final and releases the pending booking. Cancel/failed
    // webhooks can arrive during wallet/browser handoff even when a later
    // success event follows, so keep those holds until retry/edit or the
    // 15-minute expiry job releases them.
    if (isMaya && !paidEvent) {
      try {
        await sendPaymentFailureAlert({
          ...(pending.payload || {}),
          eventType,
          refNumber: pending.ref_number || refNumber,
          amount: paidAmount || pending.amount,
          paymentId,
          checkoutId: mayaCheckoutId(eventData) || pending.gateway_checkout_id,
        });
        await markPaymentEventAlerted(supabase, paymentEventId);
      } catch (alertErr) {
        const message = alertErr instanceof Error ? alertErr.message : String(alertErr);
        console.error("Maya payment alert failed:", message);
        await markPaymentEventAlerted(supabase, paymentEventId, message);
      }
      if (eventType === "PAYMENT_EXPIRED") {
        await supabase.from("bookings").update({ status: "cancelled" })
          .eq("ref_number", pending.ref_number).eq("status", "pending");
        await supabase.from("pending_bookings").delete().eq("id", pending.id);
      }
      return new Response(JSON.stringify({ received: true, status: eventType }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (paidAmount !== Number(pending.amount)) {
      console.error("Payment amount mismatch:", paidAmount, "expected:", pending.amount);
      return new Response(JSON.stringify({ error: "Payment amount mismatch" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = pending.payload;
    console.log("Payload service:", body.service, "owner:", body.ownerEmail);

    // ── 1. Branch ──
    const { data: branch } = await supabase.from("branches")
      .select("id, name, address, city, hours_weekday, hours_weekend, phone")
      .ilike("name", body.location === "estancia" ? "%Estancia%" : "%Eastwood%")
      .single();
    if (!branch) throw new Error("Branch not found: " + body.location);

    // ── 2. Find existing booking (created by create-payment) ────────────────────
    let bookingId:         string | null = null;
    let ownerId:           string | null = null;
    let petId:             string | null = null;
    let createdByPaymentFn = false;

    // Try booking_id UUID first (most reliable), then fall back to ref_number.
    // Both lookups are attempted so a transient UUID miss doesn't incorrectly
    // trigger the fallback path and create a duplicate booking.
    let eb: Record<string, any> | null = null;
    if (bookingIdFromMeta) {
      const { data } = await supabase.from("bookings")
        .select("id, ref_number, status, payment_status, owner_id, pet_id")
        .eq("id", bookingIdFromMeta).maybeSingle();
      eb = data;
      if (!eb) console.warn("UUID lookup missed for", bookingIdFromMeta, "— trying ref_number");
    }
    if (!eb && refNumber) {
      const { data } = await supabase.from("bookings")
        .select("id, ref_number, status, payment_status, owner_id, pet_id")
        .eq("ref_number", refNumber).maybeSingle();
      eb = data;
    }

    // If the event didn't carry a ref_number (e.g. payment.paid omits it while
    // checkout_session.payment.paid does not), read it from the DB row so that
    // finalRef, the email subject, and the fallback booking all use the correct
    // value instead of null → random.
    // Declared with let so we can reassign; the outer const declarations above
    // use || null so these are already the best values from the event.
    let resolvedRef: string | null = refNumber;
    if (!resolvedRef && eb?.ref_number) resolvedRef = eb.ref_number;

    if (eb) {
      if (eb.status === "confirmed" && eb.payment_status === "paid") {
        console.log("Already confirmed:", eb.id, "ref:", eb.ref_number, "— skipping");
        await supabase.from("pending_bookings").delete().eq("id", pending.id);
        return new Response(JSON.stringify({ received: true, note: "Already processed", booking_id: eb.id }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      bookingId          = eb.id;
      ownerId            = eb.owner_id;
      petId              = eb.pet_id;
      createdByPaymentFn = true;
      console.log("Found booking:", bookingId, "ref:", eb.ref_number, "— will confirm");
    }

    // ── 3. Membership ──
    let memberDiscountApplied = false;
    let memberCodeUsed: string | null = null;
    if (body.membershipId && ownerId) {
      const { data: member } = await supabase.from("members").select("id, active")
        .eq("member_code", body.membershipId.trim().toUpperCase()).maybeSingle();
      if (member?.active) {
        memberDiscountApplied = true;
        memberCodeUsed = body.membershipId.trim().toUpperCase();
        await supabase.from("members").update({ owner_id: ownerId })
          .eq("member_code", memberCodeUsed!).is("owner_id", null);
      }
    }

    // ── 4. Confirm or create booking ────────────────────────────────────────────
    const subtotal    = parseInt(body.subtotal)       || 0;
    const discountAmt = parseInt(body.discountAmount) || 0;
    const total       = parseInt(body.total)          || subtotal - discountAmt;

    if (createdByPaymentFn && bookingId) {
      // Atomic status transition: UPDATE WHERE status = 'pending' ensures only one
      // of the two simultaneous PayMongo events (payment.paid + checkout_session.payment.paid)
      // successfully claims the booking. The other gets 0 rows back and exits cleanly.
      const { data: claimed } = await supabase.from("bookings")
        .update({
          status:                  "confirmed",
          payment_status:          "paid",
          member_discount_applied: memberDiscountApplied,
          member_code_used:        memberCodeUsed,
        })
        .eq("id", bookingId)
        .eq("status", "pending")      // ← atomic claim guard
        .select("id")
        .maybeSingle();

      if (!claimed) {
        // Another concurrent event already confirmed this booking
        console.log("Booking already claimed by concurrent event:", bookingId, "— skipping");
        await supabase.from("pending_bookings").delete().eq("id", pending.id);
        return new Response(
          JSON.stringify({ received: true, note: "Concurrent event already processed", booking_id: bookingId }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Insert booking_charges so admin panel and email have the full breakdown
      const primaryCharges = chargesFromPayload(body, subtotal, discountAmt);
      if (primaryCharges.length > 0) {
        await supabase.from("booking_charges").insert(
          primaryCharges.map((c, i) => ({ ...c, booking_id: bookingId!, sort_order: i }))
        );
      }

    } else {
      // ── Fallback: create-payment didn't run or booking row was missing ──────────
      // Build everything from scratch using the pending_bookings payload.

      const email = body.ownerEmail.trim().toLowerCase();
      const { data: existingOwner } = await supabase.from("owners").select("id").ilike("email", email).maybeSingle();
      if (existingOwner) {
        ownerId = existingOwner.id;
        await supabase.from("owners").update({
          first_name: body.ownerFirst, last_name: body.ownerLast,
          mobile: body.ownerPhone, referral_source: body.ownerSource || null,
        }).eq("id", ownerId!);
      } else {
        const { data: newOwner, error: ownerErr } = await supabase.from("owners").insert({
          first_name: body.ownerFirst.trim(), last_name: body.ownerLast.trim(),
          email, mobile: body.ownerPhone.trim(), referral_source: body.ownerSource || null,
        }).select("id").single();
        if (ownerErr) throw new Error(`Owner insert failed: ${ownerErr.message}`);
        ownerId = newOwner.id;
      }

      if (body.membershipId) {
        const { data: member } = await supabase.from("members").select("id, active")
          .eq("member_code", body.membershipId.trim().toUpperCase()).maybeSingle();
        if (member?.active) {
          memberDiscountApplied = true;
          memberCodeUsed = body.membershipId.trim().toUpperCase();
          await supabase.from("members").update({ owner_id: ownerId })
            .eq("member_code", memberCodeUsed!).is("owner_id", null);
        }
      }

      const petName = body.petName.trim();
      const { data: existingPet } = await supabase.from("pets").select("id")
        .eq("owner_id", ownerId!).ilike("name", petName).maybeSingle();
      if (existingPet) {
        petId = existingPet.id;
        await supabase.from("pets").update({
          animal_type: body.petAnimal || null, gender: body.petGender || null,
          breed: body.petBreed?.trim() || null,
          age_value: body.petAge ? parseInt(body.petAge) : null, age_unit: body.petAgeUnit || "years",
          size: body.petSize || null, medical_notes: body.petMedical?.trim() || null,
          temperament: body.petTemperament || null,
        }).eq("id", petId!);
      } else {
        const { data: newPet, error: petErr } = await supabase.from("pets").insert({
          owner_id: ownerId!, name: petName,
          animal_type: body.petAnimal || null, gender: body.petGender || null,
          breed: body.petBreed?.trim() || null,
          age_value: body.petAge ? parseInt(body.petAge) : null, age_unit: body.petAgeUnit || "years",
          size: body.petSize || null, medical_notes: body.petMedical?.trim() || null,
          temperament: body.petTemperament || null,
        }).select("id").single();
        if (petErr) throw new Error(`Pet insert failed: ${petErr.message}`);
        petId = newPet.id;
      }

      const { data: newBooking, error: bookingErr } = await supabase.from("bookings").insert({
        ref_number:              resolvedRef ?? ("BH-" + Math.random().toString(36).substr(2, 6).toUpperCase()),
        branch_id:               branch.id,
        owner_id:                ownerId!, pet_id: petId!,
        service:                 body.service, status: "confirmed", payment_status: "paid",
        booking_date:            new Date().toISOString().split("T")[0],   // creation date (service date lives in detail tables)
        subtotal, discount_amount: discountAmt, total,
        member_discount_applied: memberDiscountApplied, member_code_used: memberCodeUsed,
        booking_source:          "online",
      }).select("id").single();
      if (bookingErr) throw new Error(`Booking insert failed: ${bookingErr.message}`);
      bookingId = newBooking.id;

      const fallbackCharges = chargesFromPayload(body, subtotal, discountAmt);
      if (fallbackCharges.length > 0) {
        await supabase.from("booking_charges").insert(
          fallbackCharges.map((c, i) => ({ ...c, booking_id: bookingId!, sort_order: i }))
        );
      }
    }

    // ── 5. Service details ──
    // Each upsert uses onConflict:"booking_id" so retries are safe.
    // If the table is missing the UNIQUE constraint the upsert falls back to a
    // plain INSERT; a duplicate-key error on retry is treated as a non-fatal
    // warning (the row already exists from the first successful run) rather than
    // aborting the entire webhook and leaving payment/email undelivered.
    const upsertDetail = async (table: string, row: Record<string, unknown>) => {
      const { error } = await (supabase.from(table) as any).upsert(row, { onConflict: "booking_id" });
      if (error) {
        // 23505 = unique_violation — row already exists from a prior run; safe to continue
        if (error.code === "23505" || error.message?.includes("duplicate")) {
          console.warn(`${table} already exists for booking ${row.booking_id} — skipping duplicate`);
        } else {
          throw new Error(`${table} upsert failed: ${error.message}`);
        }
      }
    };

    if (body.service === "hotel") {
      await upsertDetail("hotel_details", {
        booking_id: bookingId!, checkin_date: body.hotelCheckin, checkout_date: body.hotelCheckout,
        dropoff_time: body.hotelDropoff || null, pickup_time: body.hotelPickup || null,
        pickup_hour: parseInt(body.hotelPickupHour) || 14,
        room_type: body.hotelRoom || null, room_id: body.hotelRoomId || null,
        playpark_consent: body.playparkConsent === "yes",
        feeding_instructions: body.hotelFeeding || null, medications: body.hotelMeds || null,
        vet_clinic: body.vetClinic || null, vet_contact: body.vetContact || null, vet_address: body.vetAddress || null,
        emergency_name: body.emergencyName || null, emergency_phone: body.emergencyPhone || null,
      });
    }
    if (body.service === "grooming") {
      await upsertDetail("grooming_details", {
        booking_id: bookingId!, timeslot: body.groomSlot,
        service_date: body.groomDate || null,   // service date lives here (mirrors hotel)
        preferred_stylist: body.preferredStylist || "any",
        groomer_id: body.preferredStylistId || null,
        groom_service_key: body.groomService || "", groom_service_name: body.groomServiceName || "",
        special_requests: body.groomNotes || null,
      });
    }
    if (body.service === "daycare") {
      const openTime = body.daycareOpenTime === true;
      await upsertDetail("daycare_details", {
        booking_id: bookingId!,
        service_date: body.daycareDate || null,   // service date lives here (mirrors hotel)
        dropoff_time: body.daycareDropoff || "", dropoff_hour: parseInt(body.daycareDropoffHour) || 0,
        pickup_time: openTime ? null : (body.daycarePickup || null),
        pickup_hour: openTime ? null : (parseInt(body.daycarePickupHour) || null),
        hours_total: openTime ? 0 : Math.max(0, (parseInt(body.daycarePickupHour)||0) - (parseInt(body.daycareDropoffHour)||0)),
        open_time: openTime, notes: body.daycareNotes || null,
      });
    }
    if (body.service === "studio") {
      await upsertDetail("studio_details", {
        booking_id: bookingId!, timeslot: body.studioSlot || "",
        service_date: body.studioDate || null,   // service date lives here (mirrors hotel)
      });
    }

    // ── 6. Add-ons, vaccines, waivers ──
    if (body.service === "grooming" && body.addons && Object.keys(body.addons).length > 0) {
      // Idempotent: create-maya-checkout now pre-inserts these up front, so clear
      // any existing rows before re-establishing from the authoritative payload.
      await supabase.from("booking_addons").delete().eq("booking_id", bookingId!);
      await supabase.from("booking_addons").insert(
        Object.entries(body.addons as Record<string, number>).map(([key, price]) => ({
          booking_id: bookingId!, addon_key: key,
          addon_name: ADDON_NAMES[key] ?? key.replace(/_/g, " "),
          price: price as number,
        }))
      );
    }
    // These may have been pre-inserted up front by create-maya-checkout, so each
    // clears existing rows before re-establishing from the authoritative payload.
    if (body.vaccines && Object.keys(body.vaccines).length > 0) {
      await supabase.from("pet_vaccines").delete().eq("booking_id", bookingId!);
      await supabase.from("pet_vaccines").insert(
        Object.entries(body.vaccines as Record<string, boolean>).map(([name, confirmed]) => ({
          booking_id: bookingId!, vaccine_name: name.replace(/_/g, " "), confirmed,
        }))
      );
    }
    // Vaccine document uploads (paths from get-upload-url, carried in the payload)
    if (body.vaccineDocuments && Object.keys(body.vaccineDocuments).length > 0) {
      await supabase.from("vaccine_documents").delete().eq("booking_id", bookingId!);
      const { error: docErr } = await supabase.from("vaccine_documents").insert(
        Object.entries(body.vaccineDocuments as Record<string, string>).map(([key, path]) => ({
          booking_id: bookingId!,
          file_path:  path,
          file_name:  (body.vaccineFileNames && body.vaccineFileNames[key]) || path.split("/").pop(),
        }))
      );
      if (docErr) console.error("Vaccine documents insert failed (non-fatal):", docErr.message);
    }
    // Grooming reference photos ("pegs")
    if (body.service === "grooming" && body.groomReferenceImages && Object.keys(body.groomReferenceImages).length > 0) {
      await supabase.from("grooming_reference_images").delete().eq("booking_id", bookingId!);
      const { error: pegErr } = await supabase.from("grooming_reference_images").insert(
        Object.entries(body.groomReferenceImages as Record<string, string>).map(([key, path]) => ({
          booking_id: bookingId!,
          file_path:  path,
          file_name:  (body.groomReferenceFileNames && body.groomReferenceFileNames[key]) || path.split("/").pop(),
        }))
      );
      if (pegErr) console.error("Grooming reference images insert failed (non-fatal):", pegErr.message);
    }
    await supabase.from("waivers").delete().eq("booking_id", bookingId!);
    await supabase.from("waivers").insert({
      booking_id:            bookingId!,
      general_terms:         body.waiverGeneral        === true,
      house_rules_accepted:  body.waiverHouseRules == null
        ? null
        : body.waiverHouseRules === true || body.waiverHouseRules === "true",
      grooming_booking_policy: body.service === "grooming"
        ? body.waiverGroomingPolicy == null
          ? null
          : body.waiverGroomingPolicy === true || body.waiverGroomingPolicy === "true"
        : null,
      hotel_cancellation_policy: body.service === "hotel"
        ? body.waiverHotelCancellation == null
          ? null
          : body.waiverHotelCancellation === true || body.waiverHotelCancellation === "true"
        : null,
      health_declaration:    body.waiverVaccine         === true,
      senior_medical_waiver: body.waiverSeniorMedical   === true,
      studio_agreement:      body.waiverStudio          === true,
      media_consent:         body.waiverMedia           === true,
      waiver_texts:          body.waiverTexts           || null,
      waiver_version:        "2.0",
    });

    // ── 7. Payment record ──
    const paymentChannel = isMaya
      ? (event.paymentScheme || event.fundSource?.type || "checkout")
      : (eventAttrs?.source?.type || "qrph");
    await supabase.from("payments").insert({
      booking_id:       bookingId!, amount: paidAmount,
      type:             "downpayment", method: "online",
      reference_number: paymentId || null,
      notes:            `${isMaya ? "Maya" : "PayMongo"} ${paymentChannel} — ${paymentId}`,
      recorded_by:      `${provider}_webhook`,
    });

    // ── 8. Delete pending ──
    await supabase.from("pending_bookings").delete().eq("id", pending.id);

    const finalRef = resolvedRef || "—";
    console.log("SUCCESS — booking_id:", bookingId, "ref:", finalRef);

    // ── 9. Send confirmation email ──
    try {
      let hotelRoomName = body.hotelRoom || null;
      if (body.service === "hotel" && body.hotelRoomId) {
        const { data: room } = await supabase.from("rooms").select("name").eq("id", body.hotelRoomId).maybeSingle();
        if (room?.name) hotelRoomName = room.name;
      }

      // Build charges from payload — reliable for both primary and fallback paths.
      // (booking_charges rows may not be queryable yet at this point in the same transaction)
      const emailCharges = chargesFromPayload(body, subtotal, discountAmt);

      const { data: addonData } = await supabase
        .from("booking_addons")
        .select("addon_name, price")
        .eq("booking_id", bookingId!);

      // Derive vaccine status from the payload (mirrors booking.js logic)
      const vaccFileCount   = body.vaccineDocuments ? Object.keys(body.vaccineDocuments).length : 0;
      const bringVaccines   = body.bringVaccines === true || body.bringVaccines === "true";
      const vaccineStatus   = vaccFileCount > 0
        ? `${vaccFileCount} file${vaccFileCount > 1 ? "s" : ""} uploaded`
        : bringVaccines ? "Will bring to venue" : "Not provided";

      await sendBookingConfirmation({
        ownerEmail:      body.ownerEmail,
        ownerFirstName:  body.ownerFirst,
        ownerLastName:   body.ownerLast   || "",
        ownerMobile:     body.ownerPhone  || "",
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
        waiverGeneral:       body.waiverGeneral       === true || body.waiverGeneral       === "true",
        waiverHouseRules: body.waiverHouseRules == null
          ? null
          : body.waiverHouseRules === true || body.waiverHouseRules === "true",
        waiverGroomingPolicy: body.waiverGroomingPolicy == null
          ? null
          : body.waiverGroomingPolicy === true || body.waiverGroomingPolicy === "true",
        waiverHotelCancellation: body.waiverHotelCancellation == null
          ? null
          : body.waiverHotelCancellation === true || body.waiverHotelCancellation === "true",
        waiverVaccine:       body.waiverVaccine       === true || body.waiverVaccine       === "true",
        waiverSeniorMedical: body.waiverSeniorMedical === true || body.waiverSeniorMedical === "true",
        waiverStudio:        body.waiverStudio        === true || body.waiverStudio        === "true",
        waiverMedia:         body.waiverMedia         === true || body.waiverMedia         === "true",
        waiverPlaypark:      body.waiverPlaypark      === true || body.waiverPlaypark      === "true",
        seniorWaiverApplicable: !!body.waiverTexts?.senior ||
          body.waiverSeniorMedical === true || body.waiverSeniorMedical === "true",
        refNumber:       finalRef,
        service:         body.service,
        branch,
        total,
        charges:         emailCharges,
        addonRows:       addonData    || [],
        groomServiceName: body.groomServiceName || null,
        addons:           body.addons
          ? Object.keys(body.addons as Record<string, unknown>)
              .map((k) => ADDON_NAMES[k] ?? k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
          : [],
        groomerName:      body.preferredStylist || null,
        groomDate:        body.groomDate  || null,
        groomSlot:        body.groomSlot  || null,
        hotelRoomName,
        checkinDate:     body.hotelCheckin  || null,
        checkoutDate:    body.hotelCheckout || null,
        dropoffTime:     body.hotelDropoff  || null,
        pickupTime:      body.hotelPickup   || null,
        playparkConsent: body.playparkConsent === "yes",
        daycareDate:     body.daycareDate    || null,
        daycareDropoff:  body.daycareDropoff || null,
        daycarePickup:   body.daycarePickup  || null,
        daycareOpenTime: body.daycareOpenTime === true,
        studioDate: body.studioDate || null,
        studioSlot: body.studioSlot || null,
      });
    } catch (emailErr) {
      console.error("Email send failed (non-fatal):", emailErr);
    }

    return new Response(
      JSON.stringify({ received: true, booking_id: bookingId, ref_number: finalRef }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("handle-payment-webhook FATAL:", err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unexpected error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
