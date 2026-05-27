export const SVC_LABELS = {
  grooming: 'Grooming',
  hotel:    'Pet Hotel',
  daycare:  'Daycare',
  studio:   'Studio',
}

export const SVC_COLORS = {
  grooming: '#4D96B9',
  hotel:    '#EF9F27',
  daycare:  '#1D9E75',
  studio:   '#D4537E',
}

export const STATUS_COLORS = {
  pending:    '#FFCE58',
  confirmed:  '#4D96B9',
  checked_in: '#1D9E75',
  completed:  '#6BCB77',
  cancelled:  '#888888',
  rejected:   '#888888',
}

export const PAY_COLORS = {
  unpaid:          '#FF6B6B',
  partially_paid:  '#EF9F27',
  paid:            '#6BCB77',
  refunded:        '#9B95E8',
}

export const SIZE_LABELS = {
  tiny:       'Tiny',
  small_dog:  'Small',
  medium_dog: 'Medium',
  large_dog:  'Large',
  giant_dog:  'Giant',
  cat:        'Cat',
}

export const SRC_LABELS = {
  online: 'Online booking',
  admin:  'Admin booking',
  walkin: 'Walk-in',
}

/** Format YYYY-MM-DD → "May 27, 2026" */
export function fmtDate(d) {
  if (!d) return ''
  try {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-PH', {
      month: 'short', day: 'numeric', year: 'numeric',
    })
  } catch { return d }
}

/** Format "14:00" → "2:00 PM" */
export function fmtTime(t) {
  if (!t) return ''
  try {
    const [h, m] = t.split(':').map(Number)
    const ampm = h >= 12 ? 'PM' : 'AM'
    const hr   = h % 12 || 12
    return `${hr}:${String(m).padStart(2, '0')} ${ampm}`
  } catch { return t }
}

/** Return first element if array, else value itself */
export function first(v) {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

/** Hex color → rgba background for pills */
export function hexBg(hex) {
  if (!hex || hex === 'transparent') return 'transparent'
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},0.15)`
}

/** Safe HTML escape */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** YYYY-MM-DD string for N days ago */
export function dayOffsetStr(daysBack) {
  const d = new Date()
  d.setDate(d.getDate() - daysBack)
  return d.toISOString().slice(0, 10)
}

/** Today as YYYY-MM-DD */
export function todayStr() {
  return new Date().toISOString().slice(0, 10)
}
