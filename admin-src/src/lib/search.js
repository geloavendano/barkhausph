import { sbGet } from './supabase'

// Search bookings by reference number, owner name, owner email, or pet name.
// Runs three parallel queries (one per searchable area) and merges unique rows,
// because PostgREST can't OR across columns of different embedded tables in a
// single request. Each query is scoped to the branch and capped to 50 rows.
//
//   branchId  — restrict results to this branch
//   rawQuery  — the user's search text
//   select    — the full PostgREST select string (must contain `owners(` and
//               `pets(` so they can be promoted to !inner for the embed filters)
export async function searchBookings(branchId, rawQuery, select) {
  const q = (rawQuery ?? '').trim()
  if (!branchId || q.length < 2) return []

  // encodeURIComponent escapes commas/parens/spaces so they can't break the
  // PostgREST or=() grouping or the ilike pattern.
  const like  = `*${encodeURIComponent(q)}*`
  const base  = `branch_id=eq.${branchId}`
  const order = 'order=created_at.desc&limit=50'

  // Reference number — plain top-level column
  const refQ = `${base}&ref_number=ilike.${like}&select=${select}&${order}`

  // Owner name / email — promote owners to !inner so the embed filter
  // constrains the parent rows (otherwise it only nulls the embed).
  const ownerSelect = select.replace('owners(', 'owners!inner(')
  const ownerQ = `${base}&owners.or=(first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like})&select=${ownerSelect}&${order}`

  // Pet name
  const petSelect = select.replace('pets(', 'pets!inner(')
  const petQ = `${base}&pets.name=ilike.${like}&select=${petSelect}&${order}`

  const results = await Promise.allSettled([
    sbGet('bookings', refQ),
    sbGet('bookings', ownerQ),
    sbGet('bookings', petQ),
  ])

  const seen = new Set()
  const merged = []
  for (const r of results) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue
    for (const b of r.value) {
      if (!seen.has(b.id)) { seen.add(b.id); merged.push(b) }
    }
  }
  merged.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  return merged
}
