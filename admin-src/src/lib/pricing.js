// ── Shared pricing tables — populated at runtime from the pricing table ──
// Mirrors the structure in /pricing.js (root) but as an ES module.

export const DEFAULT_ADDONS = [
  { key:'nail_trim',       name:'Nail Trim and Filing',    price:0, assessment:false, sizeDependent:false },
  { key:'ear_clean',       name:'Ear Cleaning',             price:0, assessment:false, sizeDependent:false },
  { key:'teeth',           name:'Teeth Brushing',           price:0, assessment:false, sizeDependent:false },
  { key:'sanitary',        name:'Sanitary Clean',           price:0, assessment:false, sizeDependent:false },
  { key:'antitick',        name:'Anti-tick & Flea Bath',    price:0, assessment:false, sizeDependent:false },
  { key:'whitening',       name:'Whitening Bath',           price:0, assessment:false, sizeDependent:false },
  { key:'paw_pads',        name:'Paw Pads Trim',            price:0, assessment:false, sizeDependent:false },
  { key:'anal_gland',      name:'Anal Gland Expression',    price:0, assessment:false, sizeDependent:false },
  { key:'face_trim',       name:'Face Trim',                price:0, assessment:false, sizeDependent:true  },
  { key:'deshed',          name:'Deshedding',               price:0, assessment:true,  sizeDependent:false },
  { key:'demat',           name:'Dematting',                price:0, assessment:true,  sizeDependent:false },
  { key:'premium_shampoo', name:'Premium Shampoo',          price:0, assessment:false, sizeDependent:false },
]

export function emptyPricing() {
  return {
    groom:   { bath_dry:{}, basic:{}, premium:{}, ala_carte:{} },
    faceTrim: {},
    addons:  DEFAULT_ADDONS.map(a => ({ ...a })),
    hotel:   { weekday:{}, weekend:{} },
    daycare: {},
    extra:   {},
    lateRate: 0,
    disc:    { grooming:0, hotel:0, daycare:0 },
    fee:     0,
    loaded:  false,
  }
}

export function parsePricing(rows, base = null) {
  const p = base ?? emptyPricing()
  for (const r of (rows ?? [])) {
    const { category: cat, service_key: svc, size_key: sz, day_type: day, price } = r
    if (cat === 'grooming' && svc && sz) {
      if (!p.groom[svc]) p.groom[svc] = {}
      p.groom[svc][sz] = price
    } else if (cat === 'face_trim' && sz) {
      p.faceTrim[sz] = price
    } else if (cat === 'addon' && svc) {
      const a = p.addons.find(x => x.key === svc)
      if (a && !a.assessment && !a.sizeDependent) a.price = price
    } else if (cat === 'hotel' && svc === 'late_pickup') {
      p.lateRate = price
    } else if (cat === 'hotel' && sz && day) {
      if (!p.hotel[day]) p.hotel[day] = {}
      p.hotel[day][sz] = price
    } else if (cat === 'daycare' && sz) {
      if (svc === 'additional_hour') p.extra[sz] = price
      else p.daycare[sz] = price
    } else if (cat === 'member_discount' && svc) {
      p.disc[svc] = price / 100
    } else if (cat === 'convenience') {
      p.fee = price
    }
  }
  p.loaded = rows?.length > 0
  return p
}

// ── Cost helpers ──

export function calcNights(bk) {
  if (!bk.hcin || !bk.hcout) return 0
  return Math.max(0, Math.round((new Date(bk.hcout) - new Date(bk.hcin)) / 86400000))
}

// Hotel pricing key is determined by ROOM TYPE, mirroring the public booking flow.
// Pricing table keys: small_dog, medium_dog, large_dog, cat_single_cabin, cat_villa
const ROOM_TYPE_TO_RATE_KEY = {
  small_cage:   'small_dog',
  medium_cage:  'medium_dog',
  large_cage:   'large_dog',
  single_cabin: 'cat_single_cabin',
  villa:        'cat_villa',
}
export function hotelSizeKey(bk) {
  // Use the selected room's type to look up the rate key, exactly like the public booking page.
  // Fall back to pet size only when no room has been chosen yet.
  return ROOM_TYPE_TO_RATE_KEY[bk.hroom_type] ?? bk.size ?? 'small_dog'
}

/** Returns { weekday: { count, rate, total }, weekend: { count, rate, total } } */
export function calcHotelBreakdown(bk, p) {
  const n = calcNights(bk)
  if (!n) return null
  const sk = hotelSizeKey(bk)
  const wdRate = p.hotel['weekday']?.[sk] ?? 0
  const weRate = p.hotel['weekend']?.[sk] ?? 0
  let wdCount = 0, weCount = 0
  const d0 = new Date(bk.hcin)
  for (let i = 0; i < n; i++) {
    const d = new Date(d0); d.setDate(d.getDate() + i)
    const dw = d.getDay()
    if (dw === 0 || dw === 5 || dw === 6) weCount++
    else wdCount++
  }
  return {
    weekday: { count: wdCount, rate: wdRate, total: wdCount * wdRate },
    weekend: { count: weCount, rate: weRate, total: weCount * weRate },
  }
}

export function calcHotel(bk, p) {
  const n = calcNights(bk)
  if (!n) return 0
  const sk = hotelSizeKey(bk)
  let tot = 0
  const d0 = new Date(bk.hcin)
  for (let i = 0; i < n; i++) {
    const d = new Date(d0); d.setDate(d.getDate() + i)
    const dw = d.getDay()
    tot += (p.hotel[dw === 0 || dw === 5 || dw === 6 ? 'weekend' : 'weekday']?.[sk]) ?? 0
  }
  return tot
}

export function calcLate(bk, p) {
  if (bk.svc !== 'hotel') return 0
  const pickupHour = parseInt(bk.hpickHour) || 14
  if (pickupHour > 20) {
    const checkout = bk.hcout ? new Date(`${bk.hcout}T00:00:00`) : null
    const day = checkout && !Number.isNaN(checkout.getTime()) ? checkout.getDay() : 1
    const dayType = day === 0 || day === 5 || day === 6 ? 'weekend' : 'weekday'
    return p.hotel[dayType]?.[hotelSizeKey(bk)] ?? 0
  }
  return Math.max(0, pickupHour - 14) * (p.lateRate ?? 0)
}

export function isHotelAdditionalNight(bk) {
  return bk.svc === 'hotel' && (parseInt(bk.hpickHour) || 14) > 20
}

export function calcBase(bk, p) {
  if (bk.svc === 'grooming') {
    const base = bk.gsvc !== 'ala_carte' ? ((p.groom[bk.gsvc]?.[bk.size]) ?? 0) : 0
    const addonTotal = Object.keys(bk.addons).reduce((sum, k) => {
      const a = p.addons.find(x => x.key === k)
      if (!a || a.assessment) return sum
      if (k === 'face_trim' && bk.gsvc === 'premium') return sum // included
      return sum + (a.sizeDependent ? (p.faceTrim[bk.size] ?? 0) : a.price)
    }, 0)
    return base + addonTotal
  }
  if (bk.svc === 'hotel')   return calcHotel(bk, p)
  if (bk.svc === 'daycare') return calcDaycare(bk, p)
  return 0
}

/** Daycare: base rate + extra hourly rate for each hour beyond the first 3 */
export function calcDaycare(bk, p) {
  const base = p.daycare[bk.size] ?? 0
  if (bk.dcopen || !bk.dcdrop || !bk.dcpick) return base
  const dropH = parseInt(bk.dcdrop)   // "09:00" → 9
  const pickH = parseInt(bk.dcpick)   // "17:00" → 17
  if (isNaN(dropH) || isNaN(pickH) || pickH <= dropH) return base
  const hours = pickH - dropH
  const extra = Math.max(0, hours - 3)
  return base + extra * (p.extra[bk.size] ?? 0)
}

export function calcTotal(bk, p) {
  const base     = calcBase(bk, p)
  const late     = calcLate(bk, p)
  const subtotal = base + late
  // Grooming add-ons and hotel late pickup are billed at full price.
  // Daycare's base already represents its full selected duration.
  let discountable = base
  if (bk.svc === 'grooming') {
    discountable = bk.gsvc !== 'ala_carte' ? (p.groom[bk.gsvc]?.[bk.size] ?? 0) : 0
  }
  const disc = bk.memvalid ? Math.round(discountable * (p.disc[bk.svc] ?? 0)) : 0
  return { base, disc, late, subtotal, total: subtotal - disc }
}
