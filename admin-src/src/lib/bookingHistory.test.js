import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBookingHistory } from './bookingHistory.js'

test('consolidates and sorts booking audit events', () => {
  const events = buildBookingHistory({
    booking: { id: 'b1', created_at: '2026-07-01T00:00:00Z', booking_source: 'online' },
    bookingStatuses: [{
      id: 's1', changed_at: '2026-07-03T00:00:00Z',
      from_status: 'pending', to_status: 'confirmed', changed_by_email: 'admin@example.com',
    }],
    paymentStatuses: [{
      id: 'ps1', changed_at: '2026-07-04T00:00:00Z',
      from_status: 'unpaid', to_status: 'paid', change_source: 'service_role',
    }],
    payments: [{
      id: 'p1', created_at: '2026-07-02T00:00:00Z',
      amount: 870, type: 'balance', method: 'online', reference_number: 'maya-1',
    }],
  })

  assert.deepEqual(events.map(event => event.kind), [
    'payment_status', 'booking_status', 'payment', 'created',
  ])
  assert.equal(events[0].detail, 'Unpaid to Paid')
  assert.equal(events[2].detail, 'PHP 870 via Online, ref maya-1')
})

test('resolves room changes and removes duplicate status edit audits', () => {
  const events = buildBookingHistory({
    bookingEdits: [
      {
        id: 'room', edited_at: '2026-07-01T00:00:00Z', edited_by_name: 'Gelo',
        field_changes: { assignment: 'room', from: 'r1', to: '__internal_other_room__' },
      },
      {
        id: 'duplicate', edited_at: '2026-07-02T00:00:00Z',
        field_changes: { status_from: 'pending', status_to: 'confirmed' },
      },
    ],
    rooms: [{ id: 'r1', name: 'Suite 1' }],
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].detail, 'Room assignment changed from Suite 1 to Own Cage')
  assert.equal(events[0].actor, 'Gelo')
})

