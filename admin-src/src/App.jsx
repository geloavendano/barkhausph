import { useState, useEffect } from 'react'
import { supabase, sbGet } from './lib/supabase'
import Gate        from './components/Gate/Gate'
import Shell       from './components/Shell/Shell'
import MembersPage  from './pages/Members/MembersPage'
import BookingsPage from './pages/Bookings/BookingsPage'
import CheckInPage  from './pages/CheckIn/CheckInPage'
import CalendarPage from './pages/Calendar/CalendarPage'

export default function App() {
  const [session,  setSession]  = useState(undefined) // undefined = loading
  const [allowed,  setAllowed]  = useState(false)
  const [greeting, setGreeting] = useState('')
  const [page,     setPage]     = useState('calendar')
  const [branches, setBranches] = useState([])

  /* ── Auth ── */
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const sess = data?.session ?? null
      setSession(sess)
      if (sess) await onSessionReady(sess)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, sess) => {
      setSession(sess)
      if (sess) await onSessionReady(sess)
      else { setAllowed(false); setGreeting('') }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function onSessionReady(sess) {
    const ok = await verifyAdmin(sess)
    setAllowed(ok)
    if (ok) {
      const meta = sess.user.user_metadata ?? {}
      const name = meta.full_name ?? meta.name ?? sess.user.email ?? ''
      setGreeting('Hi, ' + (name.split(' ')[0] || 'Admin'))
      loadBranches()
    }
  }

  async function verifyAdmin(sess) {
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/admin_users?select=email&email=eq.${encodeURIComponent(sess.user.email)}&limit=1`
      const res = await fetch(url, {
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${sess.access_token}`,
        },
      })
      const rows = await res.json()
      return Array.isArray(rows) && rows.length > 0
    } catch { return false }
  }

  async function loadBranches() {
    try {
      const rows = await sbGet('branches', 'select=id,name&order=created_at')
      setBranches(rows ?? [])
    } catch { /* non-fatal */ }
  }

  /* ── Render ── */
  if (session === undefined) return null // initial load

  if (!session || !allowed) return <Gate />

  const pageProps = { branches }

  return (
    <Shell page={page} onPageChange={setPage} greeting={greeting}>
      {page === 'calendar' && <CalendarPage {...pageProps} />}
      {page === 'bookings' && <BookingsPage {...pageProps} />}
      {page === 'checkin'  && <CheckInPage  {...pageProps} />}
      {page === 'members'  && <MembersPage  {...pageProps} />}
    </Shell>
  )
}
