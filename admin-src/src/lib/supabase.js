import { createClient } from '@supabase/supabase-js'
import { processLock } from '@supabase/auth-js'

// Anon keys are public by design (browser-facing static site).
// Hardcoded so local and CI builds are always identical — no GitHub Secrets needed.
// Exported so App.jsx can use them without re-referencing import.meta.env.
export const SUPABASE_URL      = 'https://dxttnbtfhpanyiyduevn.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4dHRuYnRmaHBhbnlpeWR1ZXZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MjkyNDcsImV4cCI6MjA5MjEwNTI0N30.jrMk8-_Ga01TydNPUwCzlymf1W44PjaXXIUjCLALb2s'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  // The browser Navigator Lock used by default can remain stuck after a tab is
  // suspended or closed mid-refresh, causing getSession() to hang indefinitely.
  auth:     { lock: processLock },
  realtime: { params: { eventsPerSecond: 10 } },
  global:   { headers: { 'x-client-info': 'barkhaus-admin' } },
})

// ── Token cache ────────────────────────────────────────────────────────────
// authHeaders() used to call supabase.auth.getSession() on every API call.
// If a token refresh was in-flight, that would hang indefinitely — silently
// blocking every sbGet/sbPost/etc before they even reached fetch().
// Instead we cache the access token here and update it from App.jsx whenever
// the auth state changes (sign-in, sign-out, token refresh).
let _accessToken = null

export function setAuthToken(token) {
  _accessToken = token
}

/** Shorthand — fetch rows from a REST table with PostgREST query string */
export async function sbGet(table, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`
  const res = await fetch(url, { headers: await authHeaders() })
  if (!res.ok) throw await restError(`GET ${table}`, res)
  return res.json()
}

/** Upsert rows via POST with merge-duplicates */
export async function sbUpsert(table, body, onConflict = '') {
  const hdrs = await authHeaders()
  hdrs['Prefer'] = 'resolution=merge-duplicates,return=minimal'
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : ''
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${qs}`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await restError(`UPSERT ${table}`, res)
}

/** Insert a single row */
export async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...(await authHeaders()), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await restError(`POST ${table}`, res)
}

/** Insert rows and return selected columns */
export async function sbPostSelect(table, body, select = '*') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`, {
    method: 'POST',
    headers: { ...(await authHeaders()), Prefer: 'return=representation' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await restError(`POST ${table}`, res)
  return res.json()
}

/** Patch rows matching a PostgREST filter string */
export async function sbPatch(table, filter, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { ...(await authHeaders()), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await restError(`PATCH ${table}`, res)
}

/** Delete rows matching a PostgREST filter string */
export async function sbDelete(table, filter) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: { ...(await authHeaders()), Prefer: 'return=minimal' },
  })
  if (!res.ok) throw await restError(`DELETE ${table}`, res)
}

/** Invoke an authenticated Edge Function with the cached Admin access token. */
export async function sbFunction(name, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `${name}: ${res.status}`)
  return data
}

/** Build auth headers using the cached access token (set via setAuthToken) */
function authHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${_accessToken ?? SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  }
}

async function restError(label, res) {
  const body = await res.text()
  if (res.status === 401 && /JWT expired|PGRST303/i.test(body)) {
    window.dispatchEvent(new CustomEvent('barkhaus-admin-session-expired'))
  }
  return new Error(`${label}: ${res.status} ${body}`)
}

/**
 * Create a signed read URL for a private storage object, using the cached
 * authenticated token (the supabase JS client's session is unreliable here,
 * so we hit the Storage REST API directly like every other admin call).
 * Returns a full URL string, or null on failure.
 */
export async function sbSignedUrl(bucket, path, expiresIn = 3600) {
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${path}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ expiresIn }),
    })
    if (!res.ok) { console.error('sbSignedUrl', bucket, path, res.status, await res.text()); return null }
    const data = await res.json()
    const signedPath = data?.signedURL || data?.signedUrl || data?.signed_url
    if (!signedPath) {
      console.error('sbSignedUrl missing signed URL in response:', bucket, path, data)
      return null
    }
    return signedPath.startsWith('http') ? signedPath : `${SUPABASE_URL}/storage/v1${signedPath}`
  } catch (e) {
    console.error('sbSignedUrl error:', e)
    return null
  }
}
