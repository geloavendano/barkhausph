import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, sbGet } from '../../lib/supabase'
import { SVC_LABELS, SVC_COLORS, STATUS_COLORS, PAY_COLORS, first, hexBg } from '../../lib/constants'
import BookingDrawer from './BookingDrawer'
import FAB from '../../components/FAB/FAB'
import AddBookingPanel from '../../components/AddBookingPanel/AddBookingPanel'
import BlockSchedulePanel from '../../components/BlockSchedulePanel/BlockSchedulePanel'
import { searchBookings } from '../../lib/search'
import styles from './BookingsPage.module.css'

const BOOKING_SELECT = [
  '*',
  'waivers(general_terms,house_rules_accepted,grooming_booking_policy,hotel_cancellation_policy,health_declaration,media_consent,studio_agreement,senior_medical_waiver,signed_at)',
  'owners(id,first_name,last_name,mobile,email,referral_source)',
  'pets(id,name,animal_type,breed,size,gender,age_value,age_unit,temperament,medical_notes)',
  'grooming_details(timeslot,preferred_stylist,groom_service_name,groom_service_key,special_requests,groomer_id,service_date)',
  'hotel_details(checkin_date,checkout_date,dropoff_time,pickup_time,pickup_hour,room_type,room_id,playpark_consent,feeding_instructions,medications,emergency_name,emergency_phone,vet_clinic,vet_contact,vet_address)',
  'daycare_details(dropoff_time,pickup_time,hours_total,open_time,notes,service_date)',
  'studio_details(timeslot,studio_id,service_date)',
  'booking_addons(addon_key,addon_name,price)',
  'pet_vaccines(vaccine_name,confirmed)',
  'checkin_notes(*)',
].join(',')

const SVC_FILTERS = ['all', 'grooming', 'hotel', 'daycare', 'studio']
const PAGE_SIZE   = 50   // rows per fetch (top-level bookings; embeds are nested)

export default function BookingsPage({ branches, currentBranchIdx = 0, rooms, groomers, studios = [], currentAdmin }) {
  const [bookings,        setBookings]        = useState([])
  const [loading,         setLoading]         = useState(true)
  const [loadingMore,     setLoadingMore]     = useState(false)
  const [reachedEnd,      setReachedEnd]      = useState(false)
  const [error,           setError]           = useState('')
  const [svcFilter,       setSvcFilter]       = useState('all')
  const [openId,          setOpenId]          = useState(null)
  const [collapsed,       setCollapsed]       = useState({})
  const [showAddBooking,  setShowAddBooking]  = useState(false)
  const [showBlockPanel,  setShowBlockPanel]  = useState(false)
  const [editBooking,     setEditBooking]     = useState(null)
  const [searchQ,         setSearchQ]         = useState('')
  const [searchResults,   setSearchResults]   = useState([])
  const [searching,       setSearching]       = useState(false)

  const branch = branches?.[currentBranchIdx]
  const searchActive = searchQ.trim().length >= 2

  // How many rows are currently loaded — drives the offset for "load more"
  // and the page size for refreshes (so realtime/poll preserve the expanded view).
  const loadedCountRef = useRef(0)

  const fetchRows = useCallback(async (offset, limit, svc) => {
    const svcQ = svc !== 'all' ? `&service=eq.${svc}` : ''
    return await sbGet(
      'bookings',
      `branch_id=eq.${branch.id}${svcQ}&order=created_at.desc&select=${BOOKING_SELECT}&limit=${limit}&offset=${offset}`
    )
  }, [branch])

  // mode 'reset'  → reload from the top (offset 0), keeping at least the rows
  //                 already shown so refreshes don't collapse the list
  // mode 'more'   → append the next PAGE_SIZE rows after what's loaded
  const load = useCallback(async (mode = 'reset', svc = svcFilter) => {
    if (!branch) return
    if (mode === 'more') setLoadingMore(true)
    else                 { setLoading(true); setError('') }
    try {
      if (mode === 'more') {
        const rows = (await fetchRows(loadedCountRef.current, PAGE_SIZE, svc)) ?? []
        setBookings(prev => {
          const ids = new Set(prev.map(b => b.id))
          const fresh = rows.filter(b => !ids.has(b.id))
          loadedCountRef.current = prev.length + fresh.length
          return [...prev, ...fresh]
        })
        if (rows.length < PAGE_SIZE) setReachedEnd(true)
      } else {
        const want = Math.max(PAGE_SIZE, loadedCountRef.current)
        const rows = (await fetchRows(0, want, svc)) ?? []
        setBookings(rows)
        loadedCountRef.current = rows.length
        setReachedEnd(rows.length < want)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [branch, svcFilter, fetchRows])

  // Reload from scratch whenever the branch or service filter changes
  useEffect(() => {
    loadedCountRef.current = 0
    setReachedEnd(false)
    load('reset', svcFilter)
  }, [branch?.id, svcFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Search (ref #, owner name/email, pet name) — debounced ────────────────
  useEffect(() => {
    if (!searchActive || !branch?.id) { setSearchResults([]); setSearching(false); return }
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const rows = await searchBookings(branch.id, searchQ, BOOKING_SELECT)
        setSearchResults(rows)
      } catch { setSearchResults([]) }
      finally { setSearching(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [searchQ, searchActive, branch?.id])

  // ── Live updates: Realtime + disconnected fallback + visibility change ────
  useEffect(() => {
    if (!branch?.id) return

    let debounce = null
    let fallbackPoll = null
    const refresh = () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => load('reset'), 1200)
    }
    const stopFallback = () => {
      if (fallbackPoll) clearInterval(fallbackPoll)
      fallbackPoll = null
    }
    const startFallback = () => {
      if (!fallbackPoll) fallbackPoll = setInterval(() => load('reset'), 5 * 60_000)
    }

    const channel = supabase
      .channel(`bk-${branch.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, refresh)
      .subscribe(status => {
        if (status === 'SUBSCRIBED') stopFallback()
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') startFallback()
      })

    const onVisible = () => { if (!document.hidden) load('reset') }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearTimeout(debounce)
      supabase.removeChannel(channel)
      stopFallback()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [branch?.id, load]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') {
        if (showAddBooking) { setShowAddBooking(false); setEditBooking(null); return }
        if (showBlockPanel) { setShowBlockPanel(false); return }
        if (openId)         { setOpenId(null);           return }
        return
      }
      if (e.key === 'r' || e.key === 'R') {
        const tag = document.activeElement?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return
        if (document.activeElement?.isContentEditable) return
        if (showAddBooking || showBlockPanel || openId) return
        load('reset')
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [showAddBooking, showBlockPanel, openId, load])

  function handleFilterChange(svc) {
    setSvcFilter(svc)   // the [svcFilter] effect resets the list + pagination
  }

  function handleLoadMore() {
    load('more')
  }

  function toggleGroup(dt) {
    setCollapsed(c => ({ ...c, [dt]: !c[dt] }))
  }

  // When searching, show the search results in place of the paginated list
  const displayed = searchActive ? searchResults : bookings

  // Group by created_at date in LOCAL timezone (created_at is UTC; splitting on 'T'
  // gives the wrong date for bookings made past midnight UTC but still today locally)
  const groups = {}
  displayed.forEach(b => {
    let dt = 'Unknown'
    if (b.created_at) {
      const d = new Date(b.created_at)
      dt = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    }
    if (!groups[dt]) groups[dt] = []
    groups[dt].push(b)
  })
  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a))

  const openBooking = displayed.find(b => b.id === openId)

  return (
    <div className={styles.page}>
      <div className={styles.topRow}>
        <h2 className={styles.title}>Bookings</h2>
        {/* Service filter */}
        <div className={styles.filters}>
          {SVC_FILTERS.map(svc => (
            <button
              key={svc}
              className={`${styles.filterBtn} ${svcFilter === svc ? styles.filterOn : ''}`}
              onClick={() => handleFilterChange(svc)}
            >
              {svc === 'all' ? 'All' : SVC_LABELS[svc]}
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className={styles.searchRow}>
        <span className={styles.searchIcon}>🔍</span>
        <input
          className={styles.searchInput}
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
          placeholder="Search ref #, owner name, email, or pet name…"
        />
        {searchQ && (
          <button className={styles.searchClear} onClick={() => setSearchQ('')} title="Clear">✕</button>
        )}
      </div>

      {searchActive && (
        <p className={styles.searchMeta}>
          {searching ? 'Searching…' : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''} for "${searchQ.trim()}"`}
        </p>
      )}

      {!searchActive && loading && <p className={styles.msg}>Loading…</p>}
      {error   && <p className={styles.err}>{error}</p>}

      {!loading && !error && !searching && sortedDates.length === 0 && (
        <p className={styles.msg}>{searchActive ? 'No matching bookings.' : 'No bookings found.'}</p>
      )}

      {sortedDates.map(dt => {
        const dateLabel = dt === 'Unknown' ? 'No date' : (() => {
          try { return new Date(dt + 'T00:00:00').toLocaleDateString('en-PH', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) }
          catch { return dt }
        })()
        const isOpen = !collapsed[dt]
        return (
          <div key={dt} className={styles.group}>
            <div className={styles.groupHeader} onClick={() => toggleGroup(dt)}>
              <span className={styles.groupLabel}>{dateLabel} <span className={styles.groupCount}>({groups[dt].length})</span></span>
              <span className={styles.chevron}>{isOpen ? '▾' : '▸'}</span>
            </div>
            {isOpen && (
              <div className={styles.tableWrap}>
                <div className={styles.table}>
                  {groups[dt].map((b, i) => (
                    <BookingRow
                      key={b.id}
                      booking={b}
                      isLast={i === groups[dt].length - 1}
                      onClick={() => setOpenId(b.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })}

      {!searchActive && !loading && bookings.length > 0 && (
        <div className={styles.loadMore}>
          {reachedEnd ? (
            <p className={styles.loadMoreEnd}>You've reached the end — no more bookings.</p>
          ) : (
            <button
              className={styles.loadMoreBtn}
              onClick={handleLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load earlier bookings'}
            </button>
          )}
        </div>
      )}

      {openBooking && (
        <BookingDrawer
          booking={openBooking}
          rooms={rooms}
          groomers={groomers}
          currentAdmin={currentAdmin}
          onClose={() => setOpenId(null)}
          onUpdated={() => { setOpenId(null); load('reset') }}
          onEdit={b => { setOpenId(null); setEditBooking(b); setShowAddBooking(true) }}
        />
      )}

      {/* ── FAB ── */}
      <FAB
        onAddBooking={() => { setEditBooking(null); setShowAddBooking(true) }}
        onBlockSchedule={() => setShowBlockPanel(true)}
      />

      {showAddBooking && (
        <AddBookingPanel
          branch={branch}
          rooms={rooms}
          groomers={groomers}
          studios={studios}
          currentAdmin={currentAdmin}
          editBooking={editBooking}
          onClose={() => { setShowAddBooking(false); setEditBooking(null) }}
          onSaved={() => load('reset')}
        />
      )}

      {showBlockPanel && (
        <BlockSchedulePanel
          branch={branch}
          rooms={rooms}
          groomers={groomers}
          studios={studios}
          onClose={() => setShowBlockPanel(false)}
          onSaved={() => {}}
        />
      )}
    </div>
  )
}

function BookingRow({ booking: b, isLast, onClick }) {
  const pet   = first(b.pets)   ?? {}
  const owner = first(b.owners) ?? {}
  const gd    = first(b.grooming_details)
  const hd    = first(b.hotel_details)
  const dd    = first(b.daycare_details)
  const sd    = first(b.studio_details)

  let sched = ''
  if (gd?.timeslot) sched = gd.timeslot
  else if (hd)      sched = `${hd.checkin_date ?? '-'} → ${hd.checkout_date ?? '-'}`
  else if (dd)      sched = `${dd.dropoff_time ?? ''} – ${dd.pickup_time ?? 'open'}`
  else if (sd?.timeslot) sched = sd.timeslot

  const isCancelled = b.status === 'cancelled' || b.status === 'rejected'
  const svcColor    = SVC_COLORS[b.service] ?? '#888'
  const statusColor = STATUS_COLORS[b.status] ?? '#888'
  const ownerName   = [owner.first_name, owner.last_name].filter(Boolean).join(' ')

  return (
    <div
      className={`${styles.row} ${isCancelled ? styles.cancelled : ''}`}
      style={{ borderBottom: isLast ? 'none' : '0.5px solid var(--border)' }}
      onClick={onClick}
    >
      <span className={styles.dot} style={{ background: statusColor }} />
      <span className={styles.svcBadge} style={{ background: svcColor + '22', color: svcColor }}>
        {SVC_LABELS[b.service] ?? b.service}
      </span>
      <span className={`${styles.ref} ${isCancelled ? styles.lineThrough : ''}`}>
        {b.ref_number ?? '-'}
      </span>
      <span className={styles.petOwner}>
        {pet.name ?? '-'}
        {b.discount_amount > 0 && <span className={styles.star}>★</span>}
        {' '}
        <span className={styles.ownerName}>· {ownerName || '—'}</span>
      </span>
      <span className={styles.sched}>{sched}</span>
      <span className={styles.total}>{b.total ? `₱${b.total.toLocaleString()}` : '-'}</span>
    </div>
  )
}
