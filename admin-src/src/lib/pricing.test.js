import test from 'node:test'
import assert from 'node:assert/strict'
import { calcLate, calcTotal, emptyPricing, isHotelAdditionalNight, parsePricing } from './pricing.js'

function hotelBooking(overrides = {}) {
  return {
    svc: 'hotel',
    hcout: '2026-06-25',
    hpickHour: 20,
    hroom_type: 'small_cage',
    size: 'small_dog',
    ...overrides,
  }
}

const pricing = parsePricing([
  { category: 'hotel', service_key: 'late_pickup', size_key: null, day_type: null, price: 100 },
  { category: 'hotel', service_key: null, size_key: 'small_dog', day_type: 'weekday', price: 700 },
  { category: 'hotel', service_key: null, size_key: 'small_dog', day_type: 'weekend', price: 800 },
], emptyPricing())

test('hotel pickup through 8 PM remains hourly', () => {
  const booking = hotelBooking({ hpickHour: 20 })
  assert.equal(calcLate(booking, pricing), 600)
  assert.equal(isHotelAdditionalNight(booking), false)
})

test('hotel pickup after 8 PM uses the checkout-date nightly rate', () => {
  const weekday = hotelBooking({ hpickHour: 21, hcout: '2026-06-25' })
  const weekend = hotelBooking({ hpickHour: 21, hcout: '2026-06-26' })
  assert.equal(calcLate(weekday, pricing), 700)
  assert.equal(calcLate(weekend, pricing), 800)
  assert.equal(isHotelAdditionalNight(weekday), true)
})

test('hotel membership discount excludes late pickup', () => {
  const booking = hotelBooking({
    hcin: '2026-06-24',
    hcout: '2026-06-25',
    hpickHour: 20,
    memvalid: true,
  })
  const discountedPricing = { ...pricing, disc: { ...pricing.disc, hotel: 0.1 } }
  assert.deepEqual(calcTotal(booking, discountedPricing), {
    base: 700,
    late: 600,
    subtotal: 1300,
    disc: 70,
    total: 1230,
  })
})

test('grooming membership discount excludes add-ons', () => {
  const groomingPricing = parsePricing([
    { category: 'grooming', service_key: 'basic', size_key: 'small_dog', price: 650 },
    { category: 'addon', service_key: 'premium_shampoo', price: 100 },
    { category: 'member_discount', service_key: 'grooming', price: 10 },
  ], emptyPricing())
  const booking = {
    svc: 'grooming',
    gsvc: 'basic',
    size: 'small_dog',
    addons: { premium_shampoo: 100 },
    memvalid: true,
  }
  assert.deepEqual(calcTotal(booking, groomingPricing), {
    base: 750,
    late: 0,
    subtotal: 750,
    disc: 65,
    total: 685,
  })
})

test('daycare membership discount includes additional hours', () => {
  const daycarePricing = parsePricing([
    { category: 'daycare', size_key: 'small_dog', price: 300 },
    { category: 'daycare', service_key: 'additional_hour', size_key: 'small_dog', price: 100 },
    { category: 'member_discount', service_key: 'daycare', price: 10 },
  ], emptyPricing())
  const booking = {
    svc: 'daycare',
    size: 'small_dog',
    dcdrop: '09:00',
    dcpick: '14:00',
    dcopen: false,
    memvalid: true,
  }
  assert.deepEqual(calcTotal(booking, daycarePricing), {
    base: 500,
    late: 0,
    subtotal: 500,
    disc: 50,
    total: 450,
  })
})

test('renewal members receive the hotel renewal override', () => {
  const renewalPricing = parsePricing([
    { category: 'hotel', size_key: 'small_dog', day_type: 'weekday', price: 1000 },
    { category: 'hotel', size_key: 'small_dog', day_type: 'weekend', price: 1000 },
    { category: 'member_discount', service_key: 'hotel', membership_type: 'standard', price: 10 },
    { category: 'member_discount', service_key: 'hotel', membership_type: 'renewal', price: 20 },
  ], emptyPricing())
  const baseBooking = {
    svc: 'hotel',
    hcin: '2026-07-01',
    hcout: '2026-07-02',
    hpickHour: 14,
    hroom_type: 'small_cage',
    size: 'small_dog',
    memvalid: true,
  }

  assert.equal(calcTotal({ ...baseBooking, memtype: 'standard' }, renewalPricing).disc, 100)
  assert.equal(calcTotal({ ...baseBooking, memtype: 'renewal' }, renewalPricing).disc, 200)
})

test('renewal members fall back to standard rates without a service override', () => {
  const renewalPricing = parsePricing([
    { category: 'daycare', size_key: 'small_dog', price: 300 },
    { category: 'member_discount', service_key: 'daycare', membership_type: 'standard', price: 20 },
  ], emptyPricing())
  const booking = {
    svc: 'daycare',
    size: 'small_dog',
    dcopen: true,
    memvalid: true,
    memtype: 'renewal',
  }

  assert.equal(calcTotal(booking, renewalPricing).disc, 60)
})
