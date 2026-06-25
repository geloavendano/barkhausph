import test from 'node:test'
import assert from 'node:assert/strict'
import { calcLate, emptyPricing, isHotelAdditionalNight, parsePricing } from './pricing.js'

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
