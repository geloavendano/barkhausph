// ── SHARED PRICING TABLES ──
// Single source of truth for all rate data.
// Loaded by both booking.html and admin.html; values are zeroed here and
// populated at runtime by calling loadPricingData(rows) after the Supabase fetch.

var GROOM_PRICES = {
  bath_dry:  { small_dog:0, medium_dog:0, large_dog:0, giant_dog:0, cat:0 },
  basic:     { small_dog:0, medium_dog:0, large_dog:0, giant_dog:0, cat:0 },
  premium:   { small_dog:0, medium_dog:0, large_dog:0, giant_dog:0, cat:0 },
  ala_carte: { small_dog:0, medium_dog:0, large_dog:0, giant_dog:0, cat:0 }
};

var FACE_TRIM_PRICES = { small_dog:0, medium_dog:0, large_dog:0, giant_dog:0, cat:0 };

var ADDONS = [
  { key:'nail_trim',       name:'Nail Trim and Filing',   price:0, assessment:false, sizeDependent:false },
  { key:'ear_clean',       name:'Ear Cleaning',            price:0, assessment:false, sizeDependent:false },
  { key:'teeth',           name:'Teeth Brushing',          price:0, assessment:false, sizeDependent:false },
  { key:'sanitary',        name:'Sanitary Clean',          price:0, assessment:false, sizeDependent:false },
  { key:'antitick',        name:'Anti-tick and Flea Bath', price:0, assessment:false, sizeDependent:false },
  { key:'whitening',       name:'Whitening Bath',          price:0, assessment:false, sizeDependent:false },
  { key:'paw_pads',        name:'Paw Pads Trim',           price:0, assessment:false, sizeDependent:false },
  { key:'anal_gland',      name:'Anal Gland Expression',   price:0, assessment:false, sizeDependent:false },
  { key:'face_trim',       name:'Face Trim',               price:0, assessment:false, sizeDependent:true  },
  { key:'deshed',          name:'Deshedding',              price:0, assessment:true,  sizeDependent:false },
  { key:'demat',           name:'Dematting',               price:0, assessment:true,  sizeDependent:false },
  { key:'premium_shampoo', name:'Premium Shampoo',         price:0, assessment:false, sizeDependent:false }
];

var HOTEL_RATES = {
  weekday: { small_dog:0, medium_dog:0, large_dog:0, cat_single_cabin:0, cat_villa:0 },
  weekend: { small_dog:0, medium_dog:0, large_dog:0, cat_single_cabin:0, cat_villa:0 }
};

var DAYCARE_RATES       = { small_dog:0, medium_dog:0, large_dog:0, cat:0 };
var DAYCARE_EXTRA_RATES = { small_dog:0, medium_dog:0, large_dog:0, cat:0 };
var HOTEL_LATE_RATE     = 0;
var MEMBER_DISCOUNT     = { grooming:0, hotel:0, daycare:0 };
var RENEWAL_MEMBER_DISCOUNT = {};
var CONVENIENCE_FEE     = 0;

/**
 * True once loadPricingData() has successfully processed at least one row.
 * Both booking.html and admin.html read this to detect a failed pricing fetch
 * and block ₱0 submissions.
 */
var _pricingLoaded = false;

/**
 * Populate all pricing tables from a Supabase `pricing` rows array.
 * Called by both booking.html (after sbFetchPublic) and admin.html (after sb()).
 * @param {Array} rows  - rows from the pricing table
 */
function loadPricingData(rows) {
  if (!rows || !rows.length) return;
  rows.forEach(function(r) {
    var cat = r.category, svc = r.service_key, sz = r.size_key, day = r.day_type, p = r.price;
    if (cat === 'grooming' && svc && sz) {
      if (!GROOM_PRICES[svc]) GROOM_PRICES[svc] = {};
      GROOM_PRICES[svc][sz] = p;
    } else if (cat === 'face_trim' && sz) {
      FACE_TRIM_PRICES[sz] = p;
    } else if (cat === 'addon' && svc) {
      var addon = ADDONS.find(function(a){ return a.key === svc; });
      if (addon && !addon.assessment && !addon.sizeDependent) addon.price = p;
    } else if (cat === 'hotel' && svc === 'late_pickup') {
      HOTEL_LATE_RATE = p;
    } else if (cat === 'hotel' && sz && day) {
      if (!HOTEL_RATES[day]) HOTEL_RATES[day] = {};
      HOTEL_RATES[day][sz] = p;
    } else if (cat === 'daycare' && sz) {
      if (svc === 'additional_hour') {
        DAYCARE_EXTRA_RATES[sz] = p;
      } else {
        DAYCARE_RATES[sz] = p;
      }
    } else if (cat === 'member_discount' && svc) {
      if (r.membership_type === 'renewal') RENEWAL_MEMBER_DISCOUNT[svc] = p / 100;
      else MEMBER_DISCOUNT[svc] = p / 100;
    } else if (cat === 'convenience') {
      CONVENIENCE_FEE = p;
    }
  });
  _pricingLoaded = true;
}

function memberDiscountRate(service, membershipType) {
  if (membershipType === 'renewal' && RENEWAL_MEMBER_DISCOUNT[service] != null) {
    return RENEWAL_MEMBER_DISCOUNT[service];
  }
  return MEMBER_DISCOUNT[service] || 0;
}

function calculateMemberDiscount(service, discountableAmount, memberValid, membershipType) {
  if (!memberValid || discountableAmount <= 0) return 0;
  return Math.round(discountableAmount * memberDiscountRate(service, membershipType));
}
