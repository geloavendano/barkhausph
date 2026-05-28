import { createClient } from '@supabase/supabase-js'

// Anon keys are public by design (browser-facing static site).
// Hardcoded so local and CI builds are always identical — no GitHub Secrets needed.
// Exported so App.jsx can use them without re-referencing import.meta.env.
export const SUPABASE_URL      = 'https://dxttnbtfhpanyiyduevn.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4dHRuYnRmaHBhbnlpeWR1ZXZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MjkyNDcsImV4cCI6MjA5MjEwNTI0N30.jrMk8-_Ga01TydNPUwCzlymf1W44PjaXXIUjCLALb2s'

// Disable realtime — this admin panel only uses REST/PostgREST.
// The Phoenix WS library bundled with realtime uses patterns that trigger
// eval()-related CSP warnings and can stall on constrained networks.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 0 } },
  global:   { headers: { 'x-client-info': 'barkhaus-admin' } },
})

/** Shorthand — fetch rows from a REST table with PostgREST query string */
export async function sbGet(table, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`
  const res = await fetch(url, { headers: await authHeaders() })
  if (!res.ok) throw new Error(`GET ${table}: ${res.status} ${await res.text()}`)
  return res.json()
}

/** Upsert rows via POST with merge-duplicates */
export async function sbUpsert(table, body) {
  const hdrs = await authHeaders()
  hdrs['Prefer'] = 'resolution=merge-duplicates,return=minimal'
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`UPSERT ${table}: ${res.status} ${await res.text()}`)
}

/** Insert a single row */
export async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...(await authHeaders()), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${table}: ${res.status} ${await res.text()}`)
}

/** Patch rows matching a PostgREST filter string */
export async function sbPatch(table, filter, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { ...(await authHeaders()), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`PATCH ${table}: ${res.status} ${await res.text()}`)
}

/** Delete rows matching a PostgREST filter string */
export async function sbDelete(table, filter) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: { ...(await authHeaders()), Prefer: 'return=minimal' },
  })
  if (!res.ok) throw new Error(`DELETE ${table}: ${res.status} ${await res.text()}`)
}

/** Build auth headers using the current session token */
async function authHeaders() {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token ?? SUPABASE_ANON_KEY
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}
