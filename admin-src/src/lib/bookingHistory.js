const STATUS_LABELS = {
  checked_in: 'Checked in',
  'pencil-booked': 'Pencil-booked',
  partially_paid: 'Partially paid',
}

const PAYMENT_METHODS = {
  bank_transfer: 'Bank transfer',
  manual_online: 'Manual online',
  online: 'Online',
}

function label(value) {
  if (value == null || value === '') return 'None'
  return STATUS_LABELS[value] ?? String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}

function money(value) {
  return `PHP ${(Number(value) || 0).toLocaleString('en-PH')}`
}

function actor(row, fallback) {
  return row.changed_by_email
    || row.edited_by_name
    || row.edited_by_email
    || row.recorded_by
    || row.recorded_by_email
    || fallback
    || null
}

function parseChanges(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(value) }
  catch { return {} }
}

function assignmentName(kind, id, rooms, groomers) {
  if (!id) return kind === 'room' ? 'Unassigned' : 'Any available'
  if (id === '__internal_other_room__') return 'Own Cage'
  const rows = kind === 'room' ? rooms : groomers
  return rows?.find(row => row.id === id)?.name ?? 'Unknown resource'
}

function editDescription(row, rooms, groomers) {
  const changes = parseChanges(row.field_changes)

  if (changes.assignment === 'room') {
    return `Room assignment changed from ${assignmentName('room', changes.from, rooms, groomers)} to ${assignmentName('room', changes.to, rooms, groomers)}`
  }
  if (changes.assignment === 'groomer') {
    return `Groomer assignment changed from ${assignmentName('groomer', changes.from, rooms, groomers)} to ${assignmentName('groomer', changes.to, rooms, groomers)}`
  }
  if (changes.payment_addon_charge) {
    return `Booking total updated for ${label(changes.addon_key)} add-on (${money(changes.amount)})`
  }
  if (changes.admin_edit) return 'Booking details edited'

  const ignored = new Set([
    'edited_by', 'status_from', 'status_to',
    'payment_status_from', 'payment_status_to',
  ])
  const fields = Object.keys(changes).filter(key => !ignored.has(key))
  return fields.length
    ? `Booking edited: ${fields.map(label).join(', ')}`
    : 'Booking details edited'
}

export function buildBookingHistory({
  booking,
  bookingStatuses = [],
  paymentStatuses = [],
  bookingEdits = [],
  payments = [],
  rooms = [],
  groomers = [],
}) {
  const events = []

  for (const row of bookingStatuses) {
    events.push({
      id: `booking-status-${row.id}`,
      at: row.changed_at,
      kind: 'booking_status',
      title: row.from_status == null ? 'Booking status recorded' : 'Booking status updated',
      detail: row.from_status == null
        ? label(row.to_status)
        : `${label(row.from_status)} to ${label(row.to_status)}`,
      actor: actor(row, row.change_source),
    })
  }

  for (const row of paymentStatuses) {
    events.push({
      id: `payment-status-${row.id}`,
      at: row.changed_at,
      kind: 'payment_status',
      title: row.from_status == null ? 'Payment status recorded' : 'Payment status updated',
      detail: row.from_status == null
        ? label(row.to_status)
        : `${label(row.from_status)} to ${label(row.to_status)}`,
      actor: actor(row, row.change_source),
    })
  }

  for (const row of bookingEdits) {
    const changes = parseChanges(row.field_changes)
    // Status changes are already represented by the database histories.
    if (changes.status_from !== undefined || changes.payment_status_from !== undefined) continue
    events.push({
      id: `booking-edit-${row.id}`,
      at: row.edited_at,
      kind: changes.assignment ? 'assignment' : 'booking_edit',
      title: changes.assignment ? 'Resource assignment updated' : 'Booking updated',
      detail: editDescription(row, rooms, groomers),
      actor: actor(row, 'Admin'),
    })
  }

  for (const row of payments) {
    const method = PAYMENT_METHODS[row.method] ?? label(row.method)
    const reference = row.reference_number ? `, ref ${row.reference_number}` : ''
    events.push({
      id: `payment-${row.id}`,
      at: row.created_at,
      kind: row.type === 'refund' ? 'refund' : 'payment',
      title: row.type === 'refund' ? 'Refund recorded' : 'Payment recorded',
      detail: `${money(row.amount)} via ${method}${reference}`,
      actor: actor(row, null),
    })
  }

  if (booking?.created_at) {
    events.push({
      id: `booking-created-${booking.id}`,
      at: booking.created_at,
      kind: 'created',
      title: 'Booking created',
      detail: booking.booking_source ? `Source: ${label(booking.booking_source)}` : '',
      actor: booking.created_by_admin_name || booking.created_by_admin_email || null,
    })
  }

  return events
    .filter(event => event.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
}

