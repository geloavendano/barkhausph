export function normalizeCsvDate(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return { ok: true, value: null }
  let normalized = raw
  const slashDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slashDate) {
    const month = Number(slashDate[1])
    const day = Number(slashDate[2])
    const year = Number(slashDate[3])
    normalized = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { ok: false, reason: 'Invalid Valid Until Date.', action: 'Use YYYY-MM-DD or M/D/YYYY, for example 2026-03-04 or 3/4/2026.' }
  }
  const date = new Date(normalized + 'T00:00:00Z')
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    return { ok: false, reason: 'Invalid Valid Until Date.', action: 'Enter a real calendar date in YYYY-MM-DD or M/D/YYYY format.' }
  }
  return { ok: true, value: normalized }
}
