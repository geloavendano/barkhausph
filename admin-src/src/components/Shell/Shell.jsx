import { useEffect, useState } from 'react'
import logo from '../../assets/barkhaus-logo.png'
import { sbGet, supabase } from '../../lib/supabase'
import styles from './Shell.module.css'

const NAV_ITEMS = [
  { key: 'calendar',  icon: '📅', label: 'Calendar'  },
  { key: 'bookings',  icon: '📋', label: 'Bookings'  },
  { key: 'checkin',   icon: '🐾', label: 'Pending'   },
  { key: 'members',   icon: '👤', label: 'Members'   },
  { key: 'resources', icon: '📦', label: 'Inventory' },
  { key: 'reports',   icon: '📊', label: 'Reports'   },
]

const GUIDE_LINK = { icon: '📖', label: 'Admin Guide', href: '/docs/admin-guide.html' }
const MOBILE_PRIMARY = ['calendar', 'bookings', 'checkin']
const MORE_ITEMS = [
  { key: 'members',   icon: '👤', label: 'Members'   },
  { key: 'resources', icon: '📦', label: 'Inventory' },
  { key: 'reports',   icon: '📊', label: 'Reports'   },
  GUIDE_LINK,
]

function localDateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function GroomingCoverageBanner({ branch, groomers, refreshKey, ready, onOpenInventory }) {
  const [missingDates, setMissingDates] = useState([])

  useEffect(() => {
    if (!branch?.id || !ready) return
    let cancelled = false
    async function loadCoverage() {
      const dates = Array.from({ length: 14 }, (_, index) => {
        const date = new Date(); date.setDate(date.getDate() + index); return localDateString(date)
      })
      const activeIds = groomers.filter(groomer => !groomer.is_unavailable).map(groomer => groomer.id)
      try {
        const rows = activeIds.length ? await sbGet('resource_service_hours',
          `branch_id=eq.${branch.id}&resource_type=eq.groomer&active=eq.true` +
          `&service_date=gte.${dates[0]}&service_date=lte.${dates[dates.length - 1]}` +
          `&resource_id=in.(${activeIds.join(',')})&select=service_date,resource_id`) : []
        const covered = new Set((rows ?? []).map(row => row.service_date))
        if (!cancelled) setMissingDates(dates.filter(date => !covered.has(date)))
      } catch (error) {
        // Hide until the resource_service_hours migration is applied.
        if (!/PGRST205|42P01|404/.test(error.message)) console.error('Grooming coverage check failed:', error)
        if (!cancelled) setMissingDates([])
      }
    }
    loadCoverage()
    return () => { cancelled = true }
  }, [branch?.id, groomers, refreshKey, ready])

  if (!missingDates.length) return null
  const labels = missingDates.map(date => new Date(`${date}T00:00:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }))
  return (
    <div className={styles.coverageBanner} role="alert">
      <div><strong>Grooming availability needs attention</strong><span>No groomer service hours are assigned for: {labels.join(', ')}.</span></div>
      <button onClick={onOpenInventory}>Fix in Inventory</button>
    </div>
  )
}

// Alerts when grooming bookings for today / tomorrow still have no groomer
// assigned (grooming_details.groomer_id IS NULL), so staff can assign one.
function UnassignedGroomingBanner({ branch, refreshKey, ready, onAssign }) {
  const [info, setInfo] = useState({ count: 0, today: 0, tomorrow: 0 })

  useEffect(() => {
    if (!branch?.id || !ready) { setInfo({ count: 0, today: 0, tomorrow: 0 }); return }
    let cancelled = false
    const today = localDateString(new Date())
    const tmw = new Date(); tmw.setDate(tmw.getDate() + 1)
    const tomorrow = localDateString(tmw)
    async function load() {
      try {
        const rows = await sbGet('grooming_details',
          `select=service_date,bookings!inner(branch_id,status)` +
          `&groomer_id=is.null` +
          `&service_date=in.(${today},${tomorrow})` +
          `&bookings.branch_id=eq.${branch.id}` +
          `&bookings.status=not.in.(cancelled,rejected)`)
        if (cancelled) return
        const list = rows ?? []
        setInfo({
          count: list.length,
          today: list.filter(r => r.service_date === today).length,
          tomorrow: list.filter(r => r.service_date === tomorrow).length,
        })
      } catch (error) {
        if (!/PGRST205|42P01|404/.test(error.message)) console.error('Unassigned grooming check failed:', error)
        if (!cancelled) setInfo({ count: 0, today: 0, tomorrow: 0 })
      }
    }
    load()
    // Live refresh: groomer assignments + new/cancelled grooming bookings happen
    // in the Calendar, not Inventory, so listen for those changes directly.
    let debounce
    const refresh = () => { clearTimeout(debounce); debounce = setTimeout(load, 800) }
    const channel = supabase.channel(`unassigned-groom-${branch.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'grooming_details' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, refresh)
      .subscribe()
    return () => { cancelled = true; clearTimeout(debounce); supabase.removeChannel(channel) }
  }, [branch?.id, refreshKey, ready])

  if (!info.count) return null
  const parts = []
  if (info.today)    parts.push(`${info.today} today`)
  if (info.tomorrow) parts.push(`${info.tomorrow} tomorrow`)
  return (
    <div className={styles.coverageBanner} role="alert">
      <div>
        <strong>Grooming bookings need a groomer</strong>
        <span>{info.count} grooming booking{info.count > 1 ? 's' : ''} ({parts.join(', ')}) {info.count > 1 ? 'have' : 'has'} no groomer assigned.</span>
      </div>
      <button onClick={onAssign}>Assign in Calendar</button>
    </div>
  )
}

export default function Shell({ page, onPageChange, greeting, branches = [], branchIdx = 0, onBranchChange, onSignOut, contentFill, coverageBranch, groomers = [], coverageRefreshKey = 0, coverageReady = false, onOpenGroomerInventory, children }) {
  const [moreOpen, setMoreOpen] = useState(false)

  // Signal the open "More" sheet to fixed-position siblings (e.g. the FAB),
  // which lift above the sheet so they don't cover its items on mobile.
  useEffect(() => {
    document.body.classList.toggle('bh-more-open', moreOpen)
    return () => document.body.classList.remove('bh-more-open')
  }, [moreOpen])

  const inMore = MORE_ITEMS.some(i => i.key === page)

  function navigate(key) {
    onPageChange(key)
    setMoreOpen(false)
  }

  return (
    <div className={styles.app}>
      {/* ── Top bar ── */}
      <header className={styles.topbar}>
        <img src={logo} alt="Barkhaus" className={styles.logo} />
        {branches.length > 0 && (
          <div className={styles.branchTabs}>
            {branches.map((br, i) => (
              <button
                key={br.id}
                className={`${styles.branchTab} ${i === branchIdx ? styles.branchOn : ''}`}
                onClick={() => onBranchChange?.(i)}
              >
                {br.name}
              </button>
            ))}
          </div>
        )}
        <div className={styles.topRight}>
          {greeting && <span className={styles.greeting}>{greeting}</span>}
          <button className={styles.signOutBtn} onClick={onSignOut} title="Sign out">
            ↪
          </button>
        </div>
      </header>

      <GroomingCoverageBanner
        key={coverageBranch?.id ?? 'no-branch'}
        branch={coverageBranch}
        groomers={groomers}
        refreshKey={coverageRefreshKey}
        ready={coverageReady}
        onOpenInventory={() => onOpenGroomerInventory?.()}
      />

      <UnassignedGroomingBanner
        key={`unassigned-${coverageBranch?.id ?? 'no-branch'}`}
        branch={coverageBranch}
        refreshKey={coverageRefreshKey}
        ready={coverageReady}
        onAssign={() => onPageChange('calendar')}
      />

      {/* ── Body ── */}
      <div className={styles.body}>
        {/* Sidebar nav (desktop) */}
        <nav className={styles.sidebar}>
          {NAV_ITEMS.map(item => (
            <button
              key={item.key}
              className={`${styles.navBtn} ${page === item.key ? styles.active : ''}`}
              onClick={() => onPageChange(item.key)}
            >
              <span className={styles.navIcon}>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
          <a className={`${styles.navBtn} ${styles.guideBtn}`} href={GUIDE_LINK.href}>
            <span className={styles.navIcon}>{GUIDE_LINK.icon}</span>
            <span>{GUIDE_LINK.label}</span>
          </a>
        </nav>

        {/* Page content */}
        <main className={`${styles.content} ${contentFill ? styles.contentFill : ''}`}>
          {children}
        </main>
      </div>

      {/* ── Mobile bottom nav ── */}
      <nav className={styles.mobileNav}>
        {MOBILE_PRIMARY.map(key => {
          const item = NAV_ITEMS.find(n => n.key === key)
          return (
            <button
              key={key}
              className={`${styles.mobileBtn} ${page === key ? styles.active : ''}`}
              onClick={() => navigate(key)}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          )
        })}
        {/* More button */}
        <button
          className={`${styles.mobileBtn} ${inMore || moreOpen ? styles.active : ''}`}
          onClick={() => setMoreOpen(o => !o)}
        >
          <span>⋯</span>
          <span>More</span>
        </button>
      </nav>

      {/* ── More sheet ── */}
      {moreOpen && (
        <>
          <div className={styles.moreBackdrop} onClick={() => setMoreOpen(false)} />
          <div className={styles.moreSheet}>
            {MORE_ITEMS.map(item => (
              item.href ? (
                <a
                  key={item.href}
                  className={styles.moreSheetBtn}
                  href={item.href}
                >
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </a>
              ) : (
                <button
                  key={item.key}
                  className={`${styles.moreSheetBtn} ${page === item.key ? styles.active : ''}`}
                  onClick={() => navigate(item.key)}
                >
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              )
            ))}
          </div>
        </>
      )}
    </div>
  )
}
