import { useState, useEffect } from 'react'
import { supabase, sbGet, setAuthToken, SUPABASE_URL, SUPABASE_ANON_KEY } from './lib/supabase'
import Gate        from './components/Gate/Gate'
import Shell       from './components/Shell/Shell'
import MembersPage   from './pages/Members/MembersPage'
import BookingsPage  from './pages/Bookings/BookingsPage'
import CheckInPage   from './pages/CheckIn/CheckInPage'
import CalendarPage  from './pages/Calendar/CalendarPage'
import ResourcesPage from './pages/Resources/ResourcesPage'
import ReportsPage   from './pages/Reports/ReportsPage'

const INTERNAL_OTHER_ROOM = {
  id: '__internal_other_room__',
  name: 'Other',
  color: '#888780',
  active: true,
  room_type: 'other',
  internal_only: true,
}

const SESSION_RESTORE_TIMEOUT_MS = 10000

function withTimeout(promise, timeoutMs) {
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('SESSION_RESTORE_TIMEOUT')), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

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
  const [currentAdmin, setCurrentAdmin] = useState(null)
  const [accessError,  setAccessError]  = useState('')
  const [coverageRefreshKey, setCoverageRefreshKey] = useState(0)
  const [inventoryTab, setInventoryTab] = useState('rooms')
  const [resourcesBranchId, setResourcesBranchId] = useState(null)

  /* ── Auth ── */
  useEffect(() => {
    let active = true

    withTimeout(supabase.auth.getSession(), SESSION_RESTORE_TIMEOUT_MS)
      .then(async ({ data }) => {
        if (!active) return
        const sess = data?.session ?? null
        setAuthToken(sess?.access_token ?? null)
        setSession(sess)
        // Function declarations are hoisted; this callback runs after render.
        // eslint-disable-next-line react-hooks/immutability
        if (sess) await onSessionReady(sess)
      })
      .catch(err => {
        if (!active) return
        console.error('getSession failed:', err)
        setAuthToken(null)
        setSession(null)
        setAccessError(err?.message === 'SESSION_RESTORE_TIMEOUT'
          ? 'Your saved admin session could not be restored. Please sign in again.'
          : 'We could not check your admin session. Please sign in again.')
      })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, sess) => {
      setAuthToken(sess?.access_token ?? null)
      setSession(sess)
      if (sess) {
        try { await onSessionReady(sess) }
        catch (err) {
          console.error('onSessionReady failed:', err)
          setAllowed(false)
          setAccessError('We could not verify your admin access. Please check your connection and try again.')
        }
      } else {
        setAllowed(false)
        setGreeting('')
        setCurrentAdmin(null)
        setResourcesBranchId(null)
      }
    })

    const handleSessionExpired = async () => {
      setAccessError('Your admin session expired. Please sign in again to continue.')
      setAllowed(false)
      setGreeting('')
      setCurrentAdmin(null)
      setAuthToken(null)
      await supabase.auth.signOut()
    }
    window.addEventListener('barkhaus-admin-session-expired', handleSessionExpired)

    return () => {
      active = false
      subscription.unsubscribe()
      window.removeEventListener('barkhaus-admin-session-expired', handleSessionExpired)
    }
  }, [])

  async function onSessionReady(sess) {
    const adminRow = await verifyAdmin(sess)
    setAllowed(!!adminRow)
    if (adminRow) {
      setAccessError('')
      const meta = sess.user.user_metadata ?? {}
      const name = meta.full_name ?? meta.name ?? sess.user.email ?? ''
      setCurrentAdmin({
        adminUserId: adminRow.id ?? null,
        authUserId:  sess.user.id ?? null,
        email:       sess.user.email ?? adminRow.email ?? null,
        name,
      })
      setGreeting('Hi, ' + (name.split(' ')[0] || 'Admin'))
      // branch_ids restricts which branches this admin sees; null/empty = all.
      // (undefined when the column doesn't exist yet → treated as all.)
      await loadBranches(adminRow.branch_ids)
    } else {
      const email = sess.user.email ?? 'this Google account'
      setGreeting('')
      setCurrentAdmin(null)
      setAccessError(`${email} is not authorized for the Barkhaus admin dashboard. Please contact an admin to request access.`)
      await supabase.auth.signOut()
    }
  }

  async function verifyAdmin(sess) {
    // select=* so this keeps working before the branch_ids column is added
    // (a named select on a missing column would 400 and lock everyone out).
    const url = `${SUPABASE_URL}/rest/v1/admin_users?select=*&email=eq.${encodeURIComponent(sess.user.email)}&limit=1`
    const res = await fetch(url, {
      headers: {
        apikey:         SUPABASE_ANON_KEY,
        Authorization: `Bearer ${sess.access_token}`,
      },
    })
    if (!res.ok) throw new Error(`Admin verification failed (${res.status})`)
    const rows = await res.json()
    return (Array.isArray(rows) && rows.length > 0) ? rows[0] : null
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
    setResourcesBranchId(null)
    // Load rooms + groomers together; studios separately so a missing table can't block the others
    try {
      const [r, g] = await Promise.all([
        sbGet('rooms',    `branch_id=eq.${branchId}&active=eq.true&select=id,name,color,active,room_type,allowed_sizes,is_locked,sort_order&order=sort_order.asc.nullslast,name.asc`),
        sbGet('groomers', `branch_id=eq.${branchId}&active=eq.true&select=id,name,color,active,is_unavailable,sort_order&order=sort_order.asc.nullslast,name.asc`),
      ])
      setRooms([...(r ?? []), { ...INTERNAL_OTHER_ROOM, branch_id: branchId }])
      setGroomers(g ?? [])
    } catch { /* non-fatal */ }
    try {
      const s = await sbGet('studios', `branch_id=eq.${branchId}&active=eq.true&select=id,name,color,is_unavailable,sort_order&order=sort_order.asc.nullslast,name.asc`)
      setStudios(s ?? [])
    } catch { setStudios([]) }
    setResourcesBranchId(branchId)
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

  if (!session || !allowed) return <Gate accessError={accessError} onClearAccessError={() => setAccessError('')} />

  const pageProps = { branches, currentBranchIdx: branchIdx, rooms, groomers, studios, currentAdmin }

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
      coverageBranch={branches[branchIdx]}
      groomers={groomers}
      coverageRefreshKey={coverageRefreshKey}
      coverageReady={resourcesBranchId === branches[branchIdx]?.id}
      onOpenGroomerInventory={() => { setInventoryTab('groomers'); setPage('resources') }}
    >
      {page === 'calendar'  && <CalendarPage  {...pageProps} />}
      {page === 'bookings'  && <BookingsPage  {...pageProps} />}
      {page === 'checkin'   && <CheckInPage   {...pageProps} />}
      {page === 'members'   && <MembersPage   {...pageProps} />}
      {page === 'reports'   && <ReportsPage   {...pageProps} />}
      {page === 'resources' && (
        <ResourcesPage
          key={`${branches[branchIdx]?.id ?? 'branch'}:${inventoryTab}`}
          branches={branches}
          currentBranchIdx={branchIdx}
          requestedTab={inventoryTab}
          onChanged={() => {
            if (branches[branchIdx]?.id) loadResources(branches[branchIdx].id)
            setCoverageRefreshKey(key => key + 1)
          }}
        />
      )}
    </Shell>
  )
}
