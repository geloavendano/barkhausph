import test from 'node:test'
import assert from 'node:assert/strict'
import {
  availableGroomingSlots,
  availableHotelRooms,
  availableStudioSlots,
  overlaps,
  timeToMinutes,
} from './availability.js'

test('parses supported database and display time formats', () => {
  assert.equal(timeToMinutes('09:30:00'), 570)
  assert.equal(timeToMinutes('09:30'), 570)
  assert.equal(timeToMinutes('12:00 AM'), 0)
  assert.equal(timeToMinutes('5:00 PM'), 1020)
  assert.equal(timeToMinutes('24:00'), -1)
  assert.equal(timeToMinutes('9:60 AM'), -1)
})

test('treats adjacent ranges as non-overlapping', () => {
  assert.equal(overlaps([{ start: 540, end: 600 }], 600, 660), false)
  assert.equal(overlaps([{ start: 540, end: 600 }], 599, 660), true)
})

test('grooming blocks slots for the full service duration', () => {
  const slots = availableGroomingSlots({
    slots: ['9:00 AM', '10:00 AM', '11:00 AM'],
    groomers: [{ id: 'g1' }],
    bookings: [{ booking_id: 'b1', groomer_id: 'g1', timeslot: '10:00 AM', groom_service_key: 'premium' }],
    dayOfWeek: 1,
    selectedGroomerId: 'g1',
    serviceKey: 'basic',
    selectedAddons: {},
  })

  assert.deepEqual(slots, ['9:00 AM'])
})

test('grooming accounts for unassigned bookings and duration add-ons', () => {
  const slots = availableGroomingSlots({
    slots: ['9:00 AM', '10:00 AM'],
    groomers: [{ id: 'g1' }, { id: 'g2' }],
    bookings: [
      { booking_id: 'assigned', groomer_id: 'g1', timeslot: '9:00 AM', groom_service_key: 'basic' },
      { booking_id: 'unassigned', groomer_id: null, timeslot: '9:00 AM', groom_service_key: 'bath_dry' },
    ],
    durationAddonBookingIds: new Set(['unassigned']),
    dayOfWeek: 1,
    selectedGroomerId: null,
    serviceKey: 'basic',
    selectedAddons: {},
  })

  assert.deepEqual(slots, ['10:00 AM'])
})

test('grooming respects recurring and one-off resource blocks', () => {
  const slots = availableGroomingSlots({
    slots: ['9:00 AM', '10:00 AM', '11:00 AM'],
    groomers: [{ id: 'g1' }],
    bookings: [],
    recurringBlocks: [{ groomer_id: 'g1', start_time: '09:00', end_time: '10:00', days_of_week: [1] }],
    oneOffBlocks: [{ resource_id: 'g1', start_time: '10:30', end_time: '12:00' }],
    dayOfWeek: 1,
    selectedGroomerId: 'g1',
    serviceKey: 'basic',
    selectedAddons: {},
  })

  assert.deepEqual(slots, [])
})

test('hotel excludes occupied, locked, and size-incompatible rooms', () => {
  const rooms = availableHotelRooms({
    rooms: [
      { id: 'occupied', allowed_sizes: ['small_dog'] },
      { id: 'locked', allowed_sizes: ['small_dog'], is_locked: true },
      { id: 'wrong-size', allowed_sizes: ['cat'] },
      { id: 'free', allowed_sizes: ['small_dog'] },
      { id: 'other' },
    ],
    stays: [{ booking_id: 'b1', room_id: 'occupied' }],
    size: 'small_dog',
    internalRoomId: 'other',
  })

  assert.deepEqual(rooms.map(room => room.id), ['free', 'other'])
})

test('hotel editing excludes the booking being edited from occupancy', () => {
  const rooms = availableHotelRooms({
    rooms: [{ id: 'room-1', allowed_sizes: ['cat'] }],
    stays: [{ booking_id: 'editing', room_id: 'room-1' }],
    size: 'cat',
    excludeBookingId: 'editing',
  })

  assert.deepEqual(rooms.map(room => room.id), ['room-1'])
})

test('studio uses resource capacity, blocks, and unassigned bookings', () => {
  const slots = availableStudioSlots({
    slots: ['10:00 AM', '10:30 AM', '11:00 AM'],
    studios: [{ id: 's1' }, { id: 's2' }],
    bookings: [
      { booking_id: 'assigned', studio_id: 's1', timeslot: '10:00 AM' },
      { booking_id: 'unassigned', studio_id: null, timeslot: '10:00 AM' },
    ],
    recurringBlocks: [{ studio_id: 's2', start_time: '11:00', end_time: '12:00', days_of_week: [2] }],
    dayOfWeek: 2,
  })

  assert.deepEqual(slots, ['11:00 AM'])
})
