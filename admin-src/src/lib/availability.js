import { groomDurationMins } from './grooming.js'

export function timeToMinutes(value) {
  if (!value) return -1
  const match = String(value).trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?(?:\s*(AM|PM))?$/i)
  if (!match) return -1
  let hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  const period = match[3]?.toUpperCase()
  if (minute > 59 || (period ? hour < 1 || hour > 12 : hour > 23)) return -1
  if (period === 'PM' && hour !== 12) hour += 12
  if (period === 'AM' && hour === 12) hour = 0
  return hour * 60 + minute
}

export function overlaps(ranges, start, end) {
  return ranges.some(range => start < range.end && end > range.start)
}

function dayApplies(block, dayOfWeek) {
  const days = block.days_of_week ?? []
  return days.length === 0 || days.includes(dayOfWeek)
}

function blockRange(block) {
  return { start: timeToMinutes(block.start_time), end: timeToMinutes(block.end_time) }
}

export function availableGroomingSlots({
  slots,
  groomers,
  bookings,
  durationAddonBookingIds = new Set(),
  recurringBlocks = [],
  oneOffBlocks = [],
  dayOfWeek,
  selectedGroomerId,
  serviceKey,
  selectedAddons,
  excludeBookingId,
}) {
  const activeGroomers = groomers.filter(g => !g.is_unavailable)
  const rows = bookings.filter(row => row.booking_id !== excludeBookingId)
  const durationFor = row => groomDurationMins(
    row.groom_service_key || 'basic',
    durationAddonBookingIds.has(row.booking_id) ? { demat: true } : null,
  )

  function rangesFor(groomerId) {
    const ranges = rows
      .filter(row => row.groomer_id === groomerId && row.timeslot)
      .map(row => {
        const start = timeToMinutes(row.timeslot)
        return { start, end: start + durationFor(row) }
      })
      .filter(range => range.start >= 0)

    recurringBlocks
      .filter(block => block.groomer_id === groomerId && dayApplies(block, dayOfWeek))
      .map(blockRange)
      .filter(range => range.start >= 0 && range.end > range.start)
      .forEach(range => ranges.push(range))

    oneOffBlocks
      .filter(block => block.resource_id === groomerId)
      .map(blockRange)
      .filter(range => range.start >= 0 && range.end > range.start)
      .forEach(range => ranges.push(range))

    return ranges
  }

  return slots.filter(slot => {
    const start = timeToMinutes(slot)
    const end = start + groomDurationMins(serviceKey, selectedAddons)
    const unassigned = rows.filter(row => {
      if (row.groomer_id != null || !row.timeslot) return false
      const bookedStart = timeToMinutes(row.timeslot)
      return bookedStart >= 0 && start < bookedStart + durationFor(row) && end > bookedStart
    }).length

    if (!selectedGroomerId) {
      const free = activeGroomers.filter(g => !overlaps(rangesFor(g.id), start, end)).length
      return free > unassigned
    }

    if (overlaps(rangesFor(selectedGroomerId), start, end)) return false
    const otherFree = activeGroomers.filter(g =>
      g.id !== selectedGroomerId && !overlaps(rangesFor(g.id), start, end)
    ).length
    return unassigned <= otherFree
  })
}

export function availableHotelRooms({ rooms, stays, size, excludeBookingId, internalRoomId }) {
  const occupied = new Set(
    stays
      .filter(stay => stay.booking_id !== excludeBookingId && stay.room_id)
      .map(stay => stay.room_id),
  )

  return rooms.filter(room => {
    if (room.id === internalRoomId) return true
    if (room.is_locked) return false
    if (!Array.isArray(room.allowed_sizes) || !room.allowed_sizes.includes(size)) return false
    return !occupied.has(room.id)
  })
}

export function availableStudioSlots({
  slots,
  studios,
  bookings,
  recurringBlocks = [],
  oneOffBlocks = [],
  dayOfWeek,
  excludeBookingId,
  duration = 60,
}) {
  const activeStudios = studios.filter(studio => !studio.is_unavailable)
  const rows = bookings.filter(row => row.booking_id !== excludeBookingId)

  function rangesFor(studioId) {
    const ranges = rows
      .filter(row => row.studio_id === studioId && row.timeslot)
      .map(row => {
        const start = timeToMinutes(row.timeslot)
        return { start, end: start + duration }
      })
      .filter(range => range.start >= 0)

    recurringBlocks
      .filter(block => block.studio_id === studioId && dayApplies(block, dayOfWeek))
      .map(blockRange)
      .filter(range => range.start >= 0 && range.end > range.start)
      .forEach(range => ranges.push(range))

    oneOffBlocks
      .filter(block => block.resource_id === studioId)
      .map(blockRange)
      .filter(range => range.start >= 0 && range.end > range.start)
      .forEach(range => ranges.push(range))

    return ranges
  }

  return slots.filter(slot => {
    const start = timeToMinutes(slot)
    const end = start + duration
    const unassigned = rows.filter(row => {
      if (row.studio_id != null || !row.timeslot) return false
      const bookedStart = timeToMinutes(row.timeslot)
      return bookedStart >= 0 && start < bookedStart + duration && end > bookedStart
    }).length
    const free = activeStudios.filter(studio => !overlaps(rangesFor(studio.id), start, end)).length
    return free > unassigned
  })
}
