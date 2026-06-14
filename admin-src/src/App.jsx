import { useState, useEffect } from 'react'
import { supabase, sbGet, setAuthToken, SUPABASE_URL, SUPABASE_ANON_KEY } from './lib/supabase'
import Gate        from './components/Gate/Gate'
import Shell       from './components/Shell/Shell'
import MembersPage   from './pages/Members/MembersPage'
import BookingsPage  from './pages/Bookings/BookingsPage'
import CheckInPage   from './pages/CheckIn/CheckInPage'
import CalendarPage  from './pages/Calendar/CalendarPage'
import ResourcesPage from './pages/Resources/ResourcesPage'

export default function App() {
  const [session,      setSession]      = useState(undefined)
  const [allowed,      setAllowed]      = useState(false)
  const [greeting,     setGreeting]     = useState('')
  const [page,         setPage]         = useState('calendar')
  const [branches,     setBranches]     = useState([])
  const [branchIdx,    setBranchIdx]    = useState(0)
  const [rooms,        setRooms]        = useState([])
  const [groomers,     setGroomers]     = useState([])
  const [studios,      setStudios]      = useState([])

  /* ── Auth ── */
  useEffect(() => {
    // Safety net: if getSession() hangs (e.g. stuck token-refresh request),
    // fall through to the Gate login page after 6 s instead of spinning forever.
    const giveUp = setTimeout(() => {
      console.warn('getSession timed out — falling back to login')
      setSession(s => s === undefined ? null : s)
    }, 6000)

    supabase.auth.getSession()
      .then(async ({ data }) => {
        clearTimeout(giveUp)
        const sess = data?.session ?? null
        setAuthToken(sess?.access_token ?? null)
        setSession(sess)
        if (sess) await onSessionReady(sess)
      })
      .catch(err => {
        clearTimeout(giveUp)
        console.error('getSession failed:', err)
        setAuthToken(null)
        setSession(null)
      })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, sess) => {
      setAuthToken(sess?.access_token ?? null)
      setSession(sess)
      if (sess) {
        try { await onSessionReady(sess) }
        catch (err) { console.error('onSessionReady failed:', err) }
      } else {
        setAllowed(false)
        setGreeting('')
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function onSessionReady(sess) {
    const adminRow = await verifyAdmin(sess)
    setAllowed(!!adminRow)
    if (adminRow) {
      const meta = sess.user.user_metadata ?? {}
      const name = meta.full_name ?? meta.name ?? sess.user.email ?? ''
      setGreeting('Hi, ' + (name.split(' ')[0] || 'Admin'))
      // branch_ids restricts which branches this admin sees; null/empty = all.
      // (undefined when the column doesn't exist yet → treated as all.)
      await loadBranches(adminRow.branch_ids)
    }
  }

  async function verifyAdmin(sess) {
    try {
      // select=* so this keeps working before the branch_ids column is added
      // (a named select on a missing column would 400 and lock everyone out).
      const url = `${SUPABASE_URL}/rest/v1/admin_users?select=*&email=eq.${encodeURIComponent(sess.user.email)}&limit=1`
      const res = await fetch(url, {
        headers: {
          apikey:         SUPABASE_ANON_KEY,
          Authorization: `Bearer ${sess.access_token}`,
        },
      })
      const rows = await res.json()
      return (Array.isArray(rows) && rows.length > 0) ? rows[0] : null
    } catch { return null }
  }

  async function loadBranches(allowedIds) {
    try {
      const rows = await sbGet('branches', 'select=id,name&order=created_at')
      let list = rows ?? []
      // Restrict to the admin's allowed branches. NULL / empty / missing = all branches.
      if (Array.isArray(allowedIds) && allowedIds.length > 0) {
        list = list.filter(b => allowedIds.includes(b.id))
      }
      setBranches(list)
    } catch { /* non-fatal */ }
  }

  async function loadResources(branchId) {
    // Load rooms + groomers together; studios separately so a missing table can't block the others
    try {
      const [r, g] = await Promise.all([
        sbGet('rooms',    `branch_id=eq.${branchId}&active=eq.true&select=id,name,color,active,room_type&order=name`),
        sbGet('groomers', `branch_id=eq.${branchId}&active=eq.true&select=id,name,color,active&order=name`),
      ])
      setRooms(r ?? [])
      setGroomers(g ?? [])
    } catch { /* non-fatal */ }
    try {
      const s = await sbGet('studios', `branch_id=eq.${branchId}&active=eq.true&select=id,name,color&order=sort_order`)
      setStudios(s ?? [])
    } catch { setStudios([]) }
  }

  // Load resources when branch changes
  useEffect(() => {
    if (branches[branchIdx]?.id) loadResources(branches[branchIdx].id)
  }, [branches, branchIdx])

  /* ── Render ── */
  if (session === undefined) return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: 'var(--bg)',
    }}>
      <div style={{
        width: 28, height: 28, border: '3px solid var(--border)',
        borderTopColor: 'var(--yellow)', borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )

  if (!session || !allowed) return <Gate />

  const pageProps = { branches, currentBranchIdx: branchIdx, rooms, groomers, studios }

  function handleSignOut() {
    supabase.auth.signOut()
  }

  return (
    <Shell
      page={page}
      onPageChange={setPage}
      greeting={greeting}
      branches={branches}
      branchIdx={branchIdx}
      onBranchChange={setBranchIdx}
      onSignOut={handleSignOut}
      contentFill={page === 'calendar'}
    >
      {page === 'calendar'  && <CalendarPage  {...pageProps} />}
      {page === 'bookings'  && <BookingsPage  {...pageProps} />}
      {page === 'checkin'   && <CheckInPage   {...pageProps} />}
      {page === 'members'   && <MembersPage   {...pageProps} />}
      {page === 'resources' && (
        <ResourcesPage
          branches={branches}
          currentBranchIdx={branchIdx}
          onChanged={() => { if (branches[branchIdx]?.id) loadResources(branches[branchIdx].id) }}
        />
      )}
    </Shell>
  )
}
