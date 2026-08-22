// Barkhaus — server-side pricing authority
//
// Computes the amount a customer must pay from the `pricing` table + the booking
// inputs, so the charged amount is NEVER trusted from the client. This mirrors,
// line for line, the public booking site (pricing.js + booking.js buildSummary)
// and the admin lib (admin-src/src/lib/pricing.js). Keep all three in sync.
//
// Formula summary (must match the public site exactly):
//   grooming : base = GROOM_PRICES[service][size]; add-ons at their own price
//              (face_trim = FACE_TRIM[size], assessment add-ons = 0, premium
//              includes face_trim free); member discount applies to base only.
//   hotel    : sum of per-night cage rate (weekday/weekend, rate_calendar can
//              override a date to weekend); + late-pickup fee OR an extra night
//              when pickup is after 8 PM; member discount applies to the nights
//              only (not the late fee).
//   daycare  : base (first 3 h) + extra hours × per-size hourly; member discount
//              applies to the full daycare amount.
//   All online bookings add the convenience fee. Total = subtotal − discount + fee.

type Sizes = Record<string, number>;

export interface PricingData {
  groom: Record<string, Sizes>;
  faceTrim: Sizes;
  addons: Record<string, { price: number; assessment: boolean; sizeDependent: boolean }>;
  hotel: { weekday: Sizes; weekend: Sizes };
  hotelLateRate: number;
  daycare: Sizes;
  daycareExtra: Sizes;
  memberDiscount: Record<string, number>;         // service -> rate 0..1
  renewalMemberDiscount: Record<string, number>;
  convenienceFee: number;
  rateCalendar: Record<string, string>;           // 'YYYY-MM-DD' -> rateDayType
  loaded: boolean;
}

export interface PricedBooking {
  priceable: boolean;
  subtotal: number;
  discountAmount: number;
  convenienceFee: number;
  total: number;
  memberValid: boolean;
  memberCode: string | null;
  membershipType: string;
}

export interface Membership {
  valid: boolean;
  membershipType: string;
  code: string | null;
}

// Add-on metadata (mirrors pricing.js ADDONS). assessment add-ons are priced
// in-store (0 at checkout); sizeDependent means the price comes from FACE_TRIM.
const ADDON_META: Record<string, { assessment: boolean; sizeDependent: boolean }> = {
  nail_trim:       { assessment: false, sizeDependent: false },
  ear_clean:       { assessment: false, sizeDependent: false },
  teeth:           { assessment: false, sizeDependent: false },
  sanitary:        { assessment: false, sizeDependent: false },
  antitick:        { assessment: false, sizeDependent: false },
  whitening:       { assessment: false, sizeDependent: false },
  paw_pads:        { assessment: false, sizeDependent: false },
  anal_gland:      { assessment: false, sizeDependent: false },
  face_trim:       { assessment: false, sizeDependent: true  },
  deshed:          { assessment: true,  sizeDependent: false },
  demat:           { assessment: true,  sizeDependent: false },
  premium_shampoo: { assessment: false, sizeDependent: false },
};

// Which add-ons each grooming service permits (null = all). Mirrors ADDON_ENABLED.
const ADDON_ENABLED: Record<string, string[] | null> = {
  bath_dry:  null,
  basic:     ["face_trim", "antitick", "whitening", "demat", "deshed", "premium_shampoo"],
  premium:   ["face_trim", "antitick", "whitening", "demat", "deshed", "premium_shampoo"],
  ala_carte: null,
};

// The hotel rate key is the cage type, not the pet's own size. Mirrors CAGE_RATE_SIZE.
const CAGE_RATE_SIZE: Record<string, string> = {
  small_cage:   "small_dog",
  medium_cage:  "medium_dog",
  large_cage:   "large_dog",
  single_cabin: "cat_single_cabin",
  villa:        "cat_villa",
};

/** Load and shape all rate data from the `pricing` + `rate_calendar` tables. */
export async function loadPricing(supabase: any): Promise<PricingData> {
  const p: PricingData = {
    groom: {}, faceTrim: {}, addons: {},
    hotel: { weekday: {}, weekend: {} }, hotelLateRate: 0,
    daycare: {}, daycareExtra: {},
    memberDiscount: {}, renewalMemberDiscount: {}, convenienceFee: 0,
    rateCalendar: {}, loaded: false,
  };
  for (const [k, meta] of Object.entries(ADDON_META)) p.addons[k] = { price: 0, ...meta };

  const { data: rows, error } = await supabase
    .from("pricing")
    .select("category,service_key,size_key,day_type,price,membership_type");
  if (error) throw new Error(`Failed to load pricing: ${error.message}`);

  for (const r of (rows || [])) {
    const cat = r.category, svc = r.service_key, sz = r.size_key, day = r.day_type, price = Number(r.price) || 0;
    if (cat === "grooming" && svc && sz) {
      (p.groom[svc] ||= {})[sz] = price;
    } else if (cat === "face_trim" && sz) {
      p.faceTrim[sz] = price;
    } else if (cat === "addon" && svc) {
      const a = p.addons[svc];
      if (a && !a.assessment && !a.sizeDependent) a.price = price;
    } else if (cat === "hotel" && svc === "late_pickup") {
      p.hotelLateRate = price;
    } else if (cat === "hotel" && sz && day) {
      ((p.hotel as any)[day] ||= {})[sz] = price;
    } else if (cat === "daycare" && sz) {
      if (svc === "additional_hour") p.daycareExtra[sz] = price;
      else p.daycare[sz] = price;
    } else if (cat === "member_discount" && svc) {
      if (r.membership_type === "renewal") p.renewalMemberDiscount[svc] = price / 100;
      else p.memberDiscount[svc] = price / 100;
    } else if (cat === "convenience") {
      p.convenienceFee = price;
    }
  }

  try {
    const { data: cal } = await supabase.from("rate_calendar").select("rate_date,rate_day_type,active");
    for (const r of (cal || [])) {
      if (!r || !r.rate_date || r.active === false) continue;
      p.rateCalendar[String(r.rate_date).slice(0, 10)] = r.rate_day_type || "weekend";
    }
  } catch { /* rate_calendar is optional */ }

  p.loaded = Array.isArray(rows) && rows.length > 0;
  return p;
}

// ── Date helpers (day-of-week is computed in UTC so it's stable regardless of
//    the edge runtime's timezone; a calendar date's weekday is TZ-independent). ──
function dayTypeFor(dateStr: string, p: PricingData): "weekend" | "weekday" {
  const key = String(dateStr || "").slice(0, 10);
  const override = p.rateCalendar[key];
  if (override) return override === "weekend" ? "weekend" : "weekday";
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return "weekday";
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 Sun … 6 Sat
  return (dow === 0 || dow === 5 || dow === 6) ? "weekend" : "weekday"; // Fri/Sat/Sun
}

function addDaysStr(dateStr: string, i: number): string {
  const [y, m, d] = String(dateStr || "").slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + i);
  return dt.toISOString().slice(0, 10);
}

function nightsBetween(cin: string, cout: string): number {
  const a = Date.parse(String(cin).slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(String(cout).slice(0, 10) + "T00:00:00Z");
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** PHT (UTC+8) calendar date, for membership expiry comparison. */
function todayPHT(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function normalizeName(s: unknown): string {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function memberRate(p: PricingData, service: string, membershipType: string): number {
  if (membershipType === "renewal" && p.renewalMemberDiscount[service] != null) {
    return p.renewalMemberDiscount[service];
  }
  return p.memberDiscount[service] || 0;
}

/**
 * Validate a membership server-side using the same rules as the public site
 * (validate_member RPC): must exist, be active, not expired, be usable at this
 * branch (unless Passport tier), and be bound to the booked pet's name.
 */
export async function validateMembership(
  supabase: any, code: unknown, petName: unknown, branchId: string,
): Promise<Membership> {
  const invalid: Membership = { valid: false, membershipType: "standard", code: null };
  const clean = String(code || "").trim().toUpperCase();
  if (clean.length < 4) return invalid;
  try {
    const { data: member } = await supabase.rpc("validate_member", { p_code: clean });
    if (!member || !member.member_code) return invalid;
    if (member.active === false) return invalid;
    if (member.valid_until && String(member.valid_until).slice(0, 10) < todayPHT()) return invalid;
    if (member.tier !== "passport" && member.branch_id && member.branch_id !== branchId) return invalid;

    const pet = normalizeName(petName);
    let petList: string[] = [];
    if (Array.isArray(member.pet_names) && member.pet_names.length) petList = member.pet_names.map(normalizeName);
    else if (member.pet_name) petList = [normalizeName(member.pet_name)];
    if (petList.length === 0 || petList.indexOf(pet) === -1) return invalid;

    return { valid: true, membershipType: member.membership_type || "standard", code: clean };
  } catch {
    return invalid; // fail closed — no discount if validation can't run
  }
}

/**
 * Authoritative price for a booking. Ignores any client-supplied amounts.
 * `convenienceFee` is always the online fee — every hosted checkout is an online
 * booking (walk-ins never reach create-maya-checkout / create-payment).
 */
export function computeBookingPrice(
  body: Record<string, any>, p: PricingData, membership: Membership,
): PricedBooking {
  const svc  = String(body.service || "");
  const size = String(body.petSize || "");
  let subtotal = 0;
  let discountable = 0;
  let priceable = true;

  if (svc === "grooming") {
    const gkey = String(body.groomService || "");
    const base = (p.groom[gkey]?.[size]) || 0;
    if (base > 0) { subtotal += base; discountable += base; }
    const enabled = ADDON_ENABLED[gkey]; // undefined (unknown svc) or null (all) or list
    const addonKeys = body.addons && typeof body.addons === "object" ? Object.keys(body.addons) : [];
    for (const k of addonKeys) {
      const meta = p.addons[k];
      if (!meta) continue;                                   // unknown add-on → ignore
      if (enabled && enabled.indexOf(k) === -1) continue;    // not allowed for this service
      if (gkey === "premium" && k === "face_trim") continue; // premium includes face trim free
      let price = 0;
      if (meta.assessment) price = 0;
      else if (meta.sizeDependent) price = p.faceTrim[size] || 0;
      else price = meta.price || 0;
      subtotal += price;                                     // add-ons are NOT discountable
    }
  } else if (svc === "hotel") {
    const cin = String(body.hotelCheckin || "");
    const cout = String(body.hotelCheckout || "");
    const room = String(body.hotelRoom || "small_cage");
    const rateSize = CAGE_RATE_SIZE[room] || size || "small_dog";
    const nights = nightsBetween(cin, cout);
    let base = 0;
    for (let i = 0; i < nights; i++) {
      const dt = dayTypeFor(addDaysStr(cin, i), p);
      base += ((p.hotel as any)[dt]?.[rateSize]) || 0;
    }
    subtotal += base; discountable += base;
    // Late pickup: after 8 PM → an extra night at the checkout-date rate; else hourly.
    const pickupHour = parseInt(body.hotelPickupHour) || 14;
    let late = 0;
    if (pickupHour > 20) {
      const dt = dayTypeFor(cout, p);
      late = ((p.hotel as any)[dt]?.[rateSize]) || 0;
    } else {
      late = Math.max(0, pickupHour - 14) * p.hotelLateRate;
    }
    subtotal += late;                                        // late fee is NOT discountable
  } else if (svc === "daycare") {
    const base = p.daycare[size] || 0;
    const openTime = body.daycareOpenTime === true || body.daycareOpenTime === "true";
    if (openTime) {
      subtotal += base;
    } else {
      const dropH = parseInt(body.daycareDropoffHour) || 0;
      const pickH = parseInt(body.daycarePickupHour) || 0;
      const hours = Math.max(0, pickH - dropH);
      const extra = Math.max(0, hours - 3);
      subtotal += base + extra * (p.daycareExtra[size] || 0);
    }
    discountable += subtotal;
  } else {
    priceable = false; // studio ("contact to book") and anything else never pay online
  }

  const rate = membership.valid ? memberRate(p, svc, membership.membershipType) : 0;
  const discountAmount = (membership.valid && discountable > 0) ? Math.round(discountable * rate) : 0;
  const convenienceFee = p.convenienceFee || 0;
  const total = subtotal - discountAmount + convenienceFee;

  return {
    priceable: priceable && subtotal > 0,
    subtotal,
    discountAmount,
    convenienceFee,
    total,
    memberValid: membership.valid && discountAmount > 0,
    memberCode: membership.valid ? membership.code : null,
    membershipType: membership.membershipType,
  };
}
