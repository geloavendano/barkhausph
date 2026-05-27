import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL     = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

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
