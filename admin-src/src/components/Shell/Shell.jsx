import logo from '../../assets/barkhaus-logo.png'
import styles from './Shell.module.css'

const NAV_ITEMS = [
  { key: 'calendar',  icon: '📅', label: 'Calendar'  },
  { key: 'bookings',  icon: '📋', label: 'Bookings'  },
  { key: 'checkin',   icon: '🐾', label: 'Check In'  },
  { key: 'members',   icon: '👤', label: 'Members'   },
  { key: 'resources', icon: '📦', label: 'Inventory' },
]

export default function Shell({ page, onPageChange, greeting, branches = [], branchIdx = 0, onBranchChange, onSignOut, contentFill, children }) {
  return (
    <div className={styles.app}>
      {/* ── Top bar ── */}
      <header className={styles.topbar}>
        <img src={logo} alt="Barkhaus" className={styles.logo} />
        {branches.length > 1 && (
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
        </nav>

        {/* Page content */}
        <main className={`${styles.content} ${contentFill ? styles.contentFill : ''}`}>
          {children}
        </main>
      </div>

      {/* ── Mobile bottom nav ── */}
      <nav className={styles.mobileNav}>
        {NAV_ITEMS.map(item => (
          <button
            key={item.key}
            className={`${styles.mobileBtn} ${page === item.key ? styles.active : ''}`}
            onClick={() => onPageChange(item.key)}
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
