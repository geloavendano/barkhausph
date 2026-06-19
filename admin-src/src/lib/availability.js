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

export function buildGroomingSlots(serviceHours, fallback = []) {
  if (serviceHours == null) return fallback
  const valid = serviceHours
    .map(row => ({ start: timeToMinutes(row.start_time), last: timeToMinutes(row.last_service_time) }))
    .filter(row => row.start >= 0 && row.last >= row.start)
  if (!valid.length) return []
  const first = Math.min(...valid.map(row => row.start))
  const last = Math.max(...valid.map(row => row.last))
  const slots = []
  for (let mins = Math.ceil(first / 30) * 30; mins <= last; mins += 30) {
    const hour24 = Math.floor(mins / 60)
    const minute = mins % 60
    const period = hour24 >= 12 ? 'PM' : 'AM'
    slots.push(`${hour24 % 12 || 12}:${String(minute).padStart(2, '0')} ${period}`)
  }
  return slots
}

function dayApplies(block, dayOfWeek) {
  const days = block.days_of_week ?? []
  return days.length === 0 || days.includes(dayOfWeek)
}

function blockRange(block) {
  return { start: timeToMinutes(block.start_time), end: timeToMinutes(block.end_time) }
}

function serviceWindowFor(serviceHours, groomerId) {
  if (serviceHours == null) return null
  const row = serviceHours.find(hours => hours.resource_id === groomerId && hours.active !== false)
  if (!row) return false
  const start = timeToMinutes(row.start_time)
  const end = timeToMinutes(row.end_time)
  const last = timeToMinutes(row.last_service_time)
  if (start < 0 || end <= start || last < start || last > end) return false
  return { start, end, last }
}

export function availableGroomingSlots({
  slots,
  groomers,
  bookings,
  durationAddonBookingIds = new Set(),
  oneOffBlocks = [],
  serviceHours = null,
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

    const canServe = groomer => {
      const window = serviceWindowFor(serviceHours, groomer.id)
      if (window === false) return false
      if (window && (start < window.start || start > window.last || end > window.end)) return false
      return !overlaps(rangesFor(groomer.id), start, end)
    }

    if (!selectedGroomerId) {
      const free = activeGroomers.filter(canServe).length
      return free > unassigned
    }

    const selected = activeGroomers.find(g => g.id === selectedGroomerId)
    if (!selected || !canServe(selected)) return false
    const otherFree = activeGroomers.filter(g => g.id !== selectedGroomerId && canServe(g)).length
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
