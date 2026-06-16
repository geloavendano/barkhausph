import { useState } from 'react'
import logo from '../../assets/barkhaus-logo.png'
import styles from './Shell.module.css'

const NAV_ITEMS = [
  { key: 'calendar',  icon: '📅', label: 'Calendar'  },
  { key: 'bookings',  icon: '📋', label: 'Bookings'  },
  { key: 'checkin',   icon: '🐾', label: 'Check In'  },
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

export default function Shell({ page, onPageChange, greeting, branches = [], branchIdx = 0, onBranchChange, onSignOut, contentFill, children }) {
  const [moreOpen, setMoreOpen] = useState(false)

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
