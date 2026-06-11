import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase, sbGet, sbPatch } from '../../lib/supabase'
import { STATUS_COLORS, first, hexBg } from '../../lib/constants'
import BookingDrawer from '../Bookings/BookingDrawer'
import FAB from '../../components/FAB/FAB'
import AddBookingPanel from '../../components/AddBookingPanel/AddBookingPanel'
import BlockSchedulePanel from '../../components/BlockSchedulePanel/BlockSchedulePanel'
import styles from './CalendarPage.module.css'

// ── Constants ──────────────────────────────────────────────────────────────
const DAY_START  = 9 * 60    // 540 min (9 AM)
const DAY_END    = 20 * 60   // 1200 min (8 PM)
const PX_PER_MIN = 1.5       // px per minute → 990px total height

const GROOM_DURATIONS  = { bath_dry: 30, basic: 60, premium: 120, ala_carte: 60 }
const ROOM_TYPE_LABELS = { small_cage: 'Small Cage', medium_cage: 'Medium Cage', large_cage: 'Large Cage', single_cabin: 'Cat Cabin', villa: 'Cat Villa' }
const SVCS = [
  { key: 'hotel',    label: 'Hotel',    color: '#EF9F27' },
  { key: 'grooming', label: 'Grooming', color: '#4D96B9' },
  { key: 'daycare',  label: 'Daycare',  color: '#1D9E75' },
  { key: 'studio',   label: 'Studio',   color: '#D4537E' },
]
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

// Common (non-service-detail) columns + embeds shared by every service query.
const COMMON_SELECT = [
  'id,ref_number,service,status,payment_status,booking_date,total,subtotal,discount_amount,member_code_used,created_at,booking_source,notes',
  'waivers(general_terms,health_declaration,media_consent,studio_agreement,senior_medical_waiver,signed_at)',
  'owners(id,first_name,last_name,mobile,email,referral_source)',
  'pets(id,name,animal_type,breed,size,gender,age_value,age_unit,temperament,medical_notes)',
  'booking_addons(addon_key,addon_name,price)',
  'pet_vaccines(vaccine_name,confirmed)',
  'checkin_notes(*)',
].join(',')

// Per-service detail embeds. The service date now lives in each detail table's
// service_date column (grooming/daycare/studio), mirroring hotel's checkin/checkout.
const DETAIL_EMBED = {
  grooming: 'grooming_details(timeslot,preferred_stylist,groom_service_name,groom_service_key,special_requests,groomer_id,service_date)',
  hotel:    'hotel_details(checkin_date,checkout_date,dropoff_time,pickup_time,pickup_hour,room_type,room_id,playpark_consent,feeding_instructions,medications,emergency_name,emergency_phone,vet_clinic,vet_contact,vet_address)',
  daycare:  'daycare_details(dropoff_time,pickup_time,hours_total,open_time,notes,service_date)',
  studio:   'studio_details(timeslot,studio_id,service_date)',
}

// Build a full select for one service, marking that service's detail embed as
// !inner so we can filter parent bookings by the child's service_date. The other
// detail embeds stay as left joins (harmlessly empty for the wrong service).
function selectForService(innerSvc) {
  const details = Object.keys(DETAIL_EMBED).map(svc =>
    svc === innerSvc ? DETAIL_EMBED[svc].replace('(', '!inner(') : DETAIL_EMBED[svc]
  )
  return [COMMON_SELECT, ...details].join(',')
}

// ── Utilities ──────────────────────────────────────────────────────────────
function dateToISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function parseMins(s) {
  if (!s) return null
  const m = s.match(/(\d+):(\d+)\s*(AM|PM)?/i)
  if (!m) return null
  let h = parseInt(m[1]), min = parseInt(m[2])
  const ap = m[3]?.toUpperCase() ?? null
  if (ap === 'PM' && h !== 12) h += 12
  if (ap === 'AM' && h === 12) h = 0
  return h * 60 + min
}
function getBookingTimes(b, dateStr) {
  const gd = first(b.grooming_details) ?? {}, hd = first(b.hotel_details) ?? {}
  const dd = first(b.daycare_details)  ?? {}, sd = first(b.studio_details)  ?? {}
  let st = null, en = null
  if      (b.service === 'grooming') { st = parseMins(gd.timeslot); en = st != null ? st + (GROOM_DURATIONS[gd.groom_service_key ?? 'basic'] ?? 60) : null }
  else if (b.service === 'hotel')    { const cin = hd.checkin_date, cout = hd.checkout_date; if (cin === dateStr) { st = parseMins(hd.dropoff_time) ?? DAY_START; en = DAY_END } else if (cout === dateStr) { st = DAY_START; en = parseMins(hd.pickup_time) ?? DAY_END } else { st = DAY_START; en = DAY_END } }
  else if (b.service === 'daycare')  { st = parseMins(dd.dropoff_time) ?? DAY_START; en = dd.open_time ? DAY_END : (parseMins(dd.pickup_time) ?? DAY_END) }
  else if (b.service === 'studio')   { st = parseMins(sd.timeslot); en = st != null ? st + 60 : null }
  const stF = st ?? DAY_START
  return { st: stF, en: en ?? Math.min(stF + 60, DAY_END) }
}
// Generic column layout — works for any items with { st, en }
function layoutAll(items) {
  const sorted = [...items].sort((a, c) => a.st - c.st)
  const cols = []
  sorted.forEach(item => {
    let placed = false
    for (let c = 0; c < cols.length; c++) { if (cols[c][cols[c].length-1].en <= item.st) { cols[c].push(item); item.col = c; placed = true; break } }
    if (!placed) { item.col = cols.length; cols.push([item]) }
  })
  sorted.forEach(item => { let conc = 1; cols.forEach(col => col.forEach(o => { if (o.st < item.en && o.en > item.st) conc = Math.max(conc, o.col+1) })); item.total = conc })
  return sorted
}
function getCardColor(b, rooms, groomers) {
  const hd = first(b.hotel_details), gd = first(b.grooming_details)
  if (b.service === 'hotel' && hd?.room_id)    { const r = rooms.find(x => x.id === hd.room_id);       if (r) return r.color }
  if (b.service === 'hotel' && hd?.room_type)  { const rc = { large_cage:'#EF9F27', medium_cage:'#4D96B9', small_cage:'#1D9E75', single_cabin:'#D4537E', villa:'#9B95E8' }; return rc[hd.room_type] ?? '#6AAEC8' }
  if (b.service === 'grooming' && gd?.groomer_id) { const g = groomers.find(x => x.id === gd.groomer_id); if (g) return g.color }
  if (b.service === 'daycare') return '#1D9E75'
  if (b.service === 'studio')  return '#D4537E'
  return '#6AAEC8'
}

// ── Main component ─────────────────────────────────────────────────────────
export default function CalendarPage({ branches, currentBranchIdx = 0, rooms, groomers }) {
  const [currentDate,      setCurrentDate]      = useState(() => new Date())
  const [bookings,         setBookings]         = useState([])
  const [blockedSchedules, setBlockedSchedules] = useState([])
  const [studios,          setStudios]          = useState([])
  const [loading,          setLoading]          = useState(true)
  const [loadError,        setLoadError]        = useState('')
  const [currentSvc,       setCurrentSvc]       = useState('all')
  const [activeFilter,     setActiveFilter]     = useState(null)
  const [monthDots,        setMonthDots]        = useState({})
  const [calOpen,          setCalOpen]          = useState(false)
  const [calModalDate,     setCalModalDate]     = useState(() => new Date())
  const [openId,           setOpenId]           = useState(null)
  const [openBlockId,      setOpenBlockId]      = useState(null)
  const [showAddBooking,   setShowAddBooking]   = useState(false)
  const [showBlockPanel,   setShowBlockPanel]   = useState(false)
  const [editBooking,      setEditBooking]      = useState(null)
  const [filterOpen,       setFilterOpen]       = useState(false)

  const branch  = branches?.[currentBranchIdx]
  const dateStr = useMemo(() => dateToISO(currentDate), [currentDate])

  // Keep a ref so realtime/polling closures always see the latest currentDate
  // without needing to re-subscribe every time the user navigates a day.
  const currentDateRef = useRef(currentDate)
  useEffect(() => { currentDateRef.current = currentDate }, [currentDate])

  // ── Loaders ───────────────────────────────────────────────────────────────
  const loadBookings = useCallback(async (date) => {
    if (!branch?.id) { setBookings([]); setLoading(false); return }
    setLoading(true); setLoadError('')
    const ds = dateToISO(date)
    try {
      // Exclude cancelled/rejected; keep pending (unpaid online holds) visible.
      const base = `branch_id=eq.${branch.id}&status=not.in.(cancelled,rejected)`
      // Each non-hotel service is filtered server-side by its detail table's
      // service_date (via !inner). Hotel is fetched whole and filtered client-side
      // against its checkin/checkout range (a stay spans multiple days).
      const [groomRows, dayRows, studioRows, hotelAll] = await Promise.all([
        sbGet('bookings', `${base}&service=eq.grooming&grooming_details.service_date=eq.${ds}&order=created_at&select=${selectForService('grooming')}`),
        sbGet('bookings', `${base}&service=eq.daycare&daycare_details.service_date=eq.${ds}&order=created_at&select=${selectForService('daycare')}`),
        sbGet('bookings', `${base}&service=eq.studio&studio_details.service_date=eq.${ds}&order=created_at&select=${selectForService('studio')}`),
        sbGet('bookings', `${base}&service=eq.hotel&order=created_at&select=${selectForService('hotel')}`),
      ])
      const d = new Date(ds + 'T00:00:00')
      const hf = (hotelAll ?? []).filter(b => {
        const hd = first(b.hotel_details); if (!hd) return false
        return new Date(hd.checkin_date + 'T00:00:00') <= d && d <= new Date(hd.checkout_date + 'T00:00:00')
      })
      setBookings([...(groomRows ?? []), ...(dayRows ?? []), ...(studioRows ?? []), ...hf])
    } catch (err) {
      console.error('Calendar load error:', err)
      setLoadError(err.message)
      setBookings([])
    }
    finally { setLoading(false) }
  }, [branch?.id])

  const loadBlocked = useCallback(async () => {
    if (!branch?.id) return
    try { setBlockedSchedules((await sbGet('blocked_schedules', `branch_id=eq.${branch.id}&active=eq.true&order=created_at.desc&select=*`)) ?? []) }
    catch { setBlockedSchedules([]) }
  }, [branch?.id])

  const loadStudios = useCallback(async () => {
    if (!branch?.id) return
    try { setStudios((await sbGet('studios', `branch_id=eq.${branch.id}&active=eq.true&order=sort_order&select=id,name,color,is_unavailable,unavailable_reason`)) ?? []) }
    catch { setStudios([]) }
  }, [branch?.id])

  const loadMonthDots = useCallback(async (year, month) => {
    if (!branch?.id) return
    const f = `${year}-${String(month+1).padStart(2,'0')}-01`
    const l = `${year}-${String(month+1).padStart(2,'0')}-${new Date(year,month+1,0).getDate()}`
    try {
      // Dots reflect SERVICE dates, which now live in the detail tables. Query each
      // non-hotel detail table for service_date in range, scoped to this branch and
      // excluding cancelled/rejected via an inner embed of the parent booking.
      const sel  = 'service_date,bookings!inner(branch_id,status)'
      const filt = `service_date=gte.${f}&service_date=lte.${l}&bookings.branch_id=eq.${branch.id}&bookings.status=not.in.(cancelled,rejected)`
      const [g, dc, st] = await Promise.all([
        sbGet('grooming_details', `select=${sel}&${filt}`),
        sbGet('daycare_details',  `select=${sel}&${filt}`),
        sbGet('studio_details',   `select=${sel}&${filt}`),
      ])
      const dots = {}
      ;[g, dc, st].forEach(rows => (rows ?? []).forEach(r => { if (r.service_date) dots[r.service_date] = true }))
      setMonthDots(dots)
    } catch { setMonthDots({}) }
  }, [branch?.id])

  useEffect(() => {
    if (!branch?.id) return
    const d = new Date()
    setCurrentDate(d)
    setCalModalDate(d)
    setCurrentSvc('all')
    setActiveFilter(null)
    Promise.all([loadBookings(d), loadBlocked(), loadStudios(), loadMonthDots(d.getFullYear(), d.getMonth())])
  }, [branch?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live updates: Realtime + 60-second poll + visibility change ───────────
  useEffect(() => {
    if (!branch?.id) return

    let debounce = null
    const refresh = () => {
      // Debounce rapid-fire events (e.g. bulk inserts) to a single reload
      clearTimeout(debounce)
      debounce = setTimeout(() => loadBookings(currentDateRef.current), 1200)
    }

    // Supabase Realtime — instant update on any booking change for this branch
    const channel = supabase
      .channel(`cal-${branch.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, refresh)
      .subscribe()

    // 60-second polling fallback in case the WebSocket drops
    const poll = setInterval(() => loadBookings(currentDateRef.current), 60_000)

    // Refresh immediately when the user returns to this tab
    const onVisible = () => { if (!document.hidden) loadBookings(currentDateRef.current) }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearTimeout(debounce)
      supabase.removeChannel(channel)
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [branch?.id, loadBookings]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    function handleKey(e) {
      // Esc: close overlays in priority order (innermost first)
      if (e.key === 'Escape') {
        if (showAddBooking)  { setShowAddBooking(false); setEditBooking(null); return }
        if (showBlockPanel)  { setShowBlockPanel(false); return }
        if (filterOpen)      { setFilterOpen(false);     return }
        if (openId)          { setOpenId(null);           return }
        if (openBlockId)     { setOpenBlockId(null);      return }
        if (calOpen)         { setCalOpen(false);         return }
        return
      }
      // r / R: refresh when nothing is open and no input is focused
      if (e.key === 'r' || e.key === 'R') {
        const tag = document.activeElement?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return
        if (document.activeElement?.isContentEditable) return
        if (showAddBooking || showBlockPanel || filterOpen || openId || openBlockId || calOpen) return
        loadBookings(currentDateRef.current)
        loadBlocked()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [showAddBooking, showBlockPanel, filterOpen, openId, openBlockId, calOpen, loadBookings, loadBlocked]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Date navigation ───────────────────────────────────────────────────────
  const shiftDate = (delta) => {
    const d = new Date(currentDate); d.setDate(d.getDate() + delta)
    const prevM = currentDate.getMonth()
    setCurrentDate(d); setActiveFilter(null)
    loadBookings(d)
    if (d.getMonth() !== prevM) loadMonthDots(d.getFullYear(), d.getMonth())
  }
  const goToday = () => {
    const d = new Date(); const prevM = currentDate.getMonth()
    setCurrentDate(d); setActiveFilter(null)
    loadBookings(d)
    if (d.getMonth() !== prevM) loadMonthDots(d.getFullYear(), d.getMonth())
  }
  const jumpToDate = (y, m, day) => {
    const d = new Date(y, m, day); const prevM = calModalDate.getMonth()
    setCurrentDate(d); setCalOpen(false); setActiveFilter(null)
    loadBookings(d)
    if (d.getMonth() !== prevM) loadMonthDots(y, m)
  }
  const openCalOverlay = () => {
    setCalModalDate(new Date(currentDate))
    loadMonthDots(currentDate.getFullYear(), currentDate.getMonth())
    setCalOpen(true)
  }

  // ── Filter toggle ─────────────────────────────────────────────────────────
  const toggleFilter = (type, id) => {
    if (activeFilter?.type === type && activeFilter?.id === id) { setActiveFilter(null) }
    else {
      setActiveFilter({ type, id })
      if (type === 'room')    setCurrentSvc('hotel')
      if (type === 'groomer') setCurrentSvc('grooming')
      if (type === 'studio')  setCurrentSvc('studio')
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const filtered = useMemo(() => bookings.filter(b => {
    if (currentSvc !== 'all' && b.service !== currentSvc) return false
    if (activeFilter) {
      if (activeFilter.type === 'room')    { const hd = first(b.hotel_details)    ?? {}; return hd.room_id    === activeFilter.id }
      if (activeFilter.type === 'groomer') { const gd = first(b.grooming_details) ?? {}; return gd.groomer_id  === activeFilter.id }
      if (activeFilter.type === 'studio')  { const sd = first(b.studio_details)   ?? {}; return b.service === 'studio' && sd.studio_id === activeFilter.id }
    }
    return true
  }), [bookings, currentSvc, activeFilter])

  // Merge bookings + relevant blocked-schedule segments into one column-layout pass
  // so they sit side-by-side instead of overlapping.
  const positioned = useMemo(() => {
    const bookingItems = filtered.map(b => {
      const t = getBookingTimes(b, dateStr)
      return { kind: 'booking', b, st: t.st, en: t.en, col: 0, total: 1 }
    })
    const blockItems = blockedSchedules.flatMap(bl => {
      const blDates = Array.isArray(bl.dates) ? bl.dates : (bl.dates ? String(bl.dates).replace(/[{}"]/g,'').split(',') : [])
      if (!blDates.includes(dateStr)) return []
      if (currentSvc === 'grooming' && bl.resource_type !== 'groomer') return []
      if (currentSvc === 'hotel'    && bl.resource_type !== 'room')    return []
      if (currentSvc === 'studio'   && bl.resource_type !== 'studio')  return []
      if (currentSvc === 'daycare') return []
      if (activeFilter?.id && bl.resource_id !== activeFilter.id) return []
      const stMin = parseMins(bl.start_time), enMin = parseMins(bl.end_time)
      if (stMin == null || enMin == null || stMin >= enMin) return []
      const visStart = Math.max(stMin, DAY_START), visEnd = Math.min(enMin, DAY_END)
      if (visStart >= visEnd) return []
      return [{ kind: 'block', bl, st: visStart, en: visEnd, col: 0, total: 1 }]
    })
    return layoutAll([...bookingItems, ...blockItems])
  }, [filtered, blockedSchedules, dateStr, currentSvc, activeFilter])

  const now     = new Date()
  const isToday = now.getFullYear() === currentDate.getFullYear() && now.getMonth() === currentDate.getMonth() && now.getDate() === currentDate.getDate()
  const yrSfx   = currentDate.getFullYear() !== now.getFullYear() ? ` ${currentDate.getFullYear()}` : ''
  const dateLbl = `${DAYS[currentDate.getDay()]}, ${MONTHS[currentDate.getMonth()]} ${currentDate.getDate()}${yrSfx}`
  const openBooking = bookings.find(b => b.id === openId)
  const openBlock   = blockedSchedules.find(b => b.id === openBlockId)

  return (
    <div className={styles.page}>
      {/* ── Date nav bar ── */}
      <div className={styles.dateNav}>
        <button className={styles.navArrow} onClick={() => shiftDate(-1)}>‹</button>
        <button className={styles.dateLabelBtn} onClick={openCalOverlay}>{dateLbl}</button>
        <button className={styles.navArrow} onClick={() => shiftDate(1)}>›</button>
        {!isToday && <button className={styles.todayBtn} onClick={goToday}>Today</button>}
        {loading && <span className={styles.loadDot} />}
        {/* Mobile-only filter button — sidebar is hidden on small screens */}
        {(rooms.length > 0 || groomers.length > 0 || studios.length > 0) && (() => {
          const res = activeFilter
            ? (activeFilter.type === 'room'    ? rooms.find(r => r.id === activeFilter.id)
             : activeFilter.type === 'groomer' ? groomers.find(g => g.id === activeFilter.id)
             : studios.find(s => s.id === activeFilter.id))
            : null
          return (
            <button
              className={`${styles.filterBtn} ${activeFilter ? styles.filterBtnOn : ''}`}
              onClick={() => setFilterOpen(true)}
            >
              {res && <span className={styles.filterBtnDot} style={{ background: res.color }} />}
              {res ? res.name : '⊟ Filter'}
            </button>
          )
        })()}
      </div>

      {/* ── Error banner ── */}
      {loadError && (
        <div className={styles.errBanner}>
          ⚠️ {loadError}
        </div>
      )}

      {/* ── Body: sidebar + main ── */}
      <div className={styles.body}>
        {/* Calendar sidebar (rooms / groomers / studios) */}
        <aside className={styles.sidebar}>
          {rooms.length > 0 && (
            <SbSection label="Rooms">
              {rooms.map(r => (
                <SbItem key={r.id} color={r.color} label={r.name}
                  count={bookings.filter(b => b.service === 'hotel' && (first(b.hotel_details) ?? {}).room_id === r.id).length}
                  isOn={activeFilter?.type === 'room' && activeFilter?.id === r.id}
                  onToggle={() => toggleFilter('room', r.id)} />
              ))}
            </SbSection>
          )}
          {groomers.length > 0 && (
            <SbSection label="Groomers" topMargin={rooms.length > 0}>
              {groomers.map(g => (
                <SbItem key={g.id} color={g.color} label={g.name} isRound
                  count={bookings.filter(b => b.service === 'grooming' && (first(b.grooming_details) ?? {}).groomer_id === g.id).length}
                  isOn={activeFilter?.type === 'groomer' && activeFilter?.id === g.id}
                  onToggle={() => toggleFilter('groomer', g.id)} />
              ))}
            </SbSection>
          )}
          {studios.length > 0 && (
            <SbSection label="Studios" topMargin>
              {studios.map(s => (
                <SbItem key={s.id} color={s.color} label={s.name} isRound
                  count={bookings.filter(b => b.service === 'studio' && (first(b.studio_details) ?? {}).studio_id === s.id).length}
                  isOn={activeFilter?.type === 'studio' && activeFilter?.id === s.id}
                  onToggle={() => toggleFilter('studio', s.id)} />
              ))}
            </SbSection>
          )}
        </aside>

        {/* ── Timeline column ── */}
        <div className={styles.main}>
          {/* Service filter tabs */}
          <div className={styles.svcTabs}>
            <div className={`${styles.svcTab} ${currentSvc === 'all' ? styles.svcTabOn : ''}`}
              style={{ color: currentSvc === 'all' ? 'var(--cream-m)' : 'var(--mid)' }}
              onClick={() => { setCurrentSvc('all'); setActiveFilter(null) }}>
              <div className={styles.svcCount}>{bookings.length}</div>
              <div className={styles.svcLabel}>All</div>
            </div>
            {(studios.length > 0 ? SVCS : SVCS.filter(s => s.key !== 'studio')).map(s => (
              <div key={s.key}
                className={`${styles.svcTab} ${currentSvc === s.key ? styles.svcTabOn : ''}`}
                style={{ color: s.color }}
                onClick={() => { setCurrentSvc(s.key); setActiveFilter(null) }}>
                <div className={styles.svcCount}>{bookings.filter(b => b.service === s.key).length}</div>
                <div className={styles.svcLabel}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Empty state */}
          {!loading && !loadError && filtered.length === 0 && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>📅</div>
              <div className={styles.emptyMsg}>No bookings for {dateLbl}</div>
              <div className={styles.emptyHint}>Navigate to a different date or add a booking with the + button</div>
            </div>
          )}

          {/* Scrollable area */}
          <div className={styles.tlScroll}>
            {/* Timeline body */}
            <div className={styles.tlBody}>
              {/* Hour labels */}
              <div className={styles.tlTimes}>
                {Array.from({ length: 12 }, (_, i) => {
                  const h = 9 + i
                  return <div className={styles.tlLbl} key={h}>{h < 12 ? `${h}AM` : h === 12 ? '12PM' : `${h-12}PM`}</div>
                })}
              </div>

              {/* Cards area */}
              <div className={styles.tlCol}>
                <div className={styles.tlInner}>
                  {/* Hour grid lines */}
                  {Array.from({ length: 12 }, (_, i) => <div key={i} className={styles.tlLine} style={{ top: i * 90 }} />)}

                  {/* Unified column layout: blocked schedules + bookings side-by-side */}
                  {positioned.map((item, idx) => {
                    const top = (item.st - DAY_START) * PX_PER_MIN
                    const ht  = item.kind === 'block'
                      ? Math.max(22, (item.en - item.st) * PX_PER_MIN)
                      : Math.max(38, (item.en - item.st) * PX_PER_MIN)
                    const w = `${100/item.total - 0.8}%`
                    const l = `${item.col/item.total*100 + 0.4}%`

                    if (item.kind === 'block') {
                      const bl   = item.bl
                      const pool = bl.resource_type === 'groomer' ? groomers : bl.resource_type === 'studio' ? studios : rooms
                      const res  = pool.find(r => r.id === bl.resource_id)
                      const bc   = res?.color ?? '#9B95E8'
                      const [rr, gg, bb] = [parseInt(bc.slice(1,3),16), parseInt(bc.slice(3,5),16), parseInt(bc.slice(5,7),16)]
                      return (
                        <div key={`bl-${bl.id}`} className={styles.blockCard}
                          style={{ top, height: ht, left: l, width: w,
                            background: `repeating-linear-gradient(135deg,rgba(${rr},${gg},${bb},0.55) 0px,rgba(${rr},${gg},${bb},0.55) 6px,rgba(${rr},${gg},${bb},0.3) 6px,rgba(${rr},${gg},${bb},0.3) 12px)`,
                            border: `1.5px solid ${bc}`, borderLeft: `4px solid ${bc}` }}
                          onClick={() => setOpenBlockId(bl.id)}>
                          <div className={styles.blockLbl}>🚫 {res?.name ? `${res.name} — ` : ''}{bl.reason ?? 'Blocked'}</div>
                          {ht >= 44 && <div className={styles.blockSub}>Blocked</div>}
                        </div>
                      )
                    }

                    const b   = item.b, pet = first(b.pets) ?? {}, gd = first(b.grooming_details), hd = first(b.hotel_details)
                    const color = getCardColor(b, rooms, groomers)
                    const isCancelled = b.status === 'cancelled' || b.status === 'rejected'
                    const detail = gd
                      ? (gd.groom_service_name ?? 'Groom') + (gd.preferred_stylist && gd.preferred_stylist !== 'any' ? ` | ${gd.preferred_stylist}` : '')
                      : hd ? (rooms.find(r => r.id === hd.room_id)?.name ?? ROOM_TYPE_LABELS[hd.room_type] ?? hd.room_type ?? 'Hotel')
                      : first(b.daycare_details) ? 'Daycare' : first(b.studio_details) ? 'Studio' : ''
                    return (
                      <div key={b.id}
                        className={`${styles.bk} ${isCancelled ? styles.bkCancelled : ''} ${b.status === 'pending' ? styles.bkPending : ''}`}
                        style={{ top, height: ht, left: l, width: w, background: hexBg(color), borderLeftColor: color }}
                        onClick={() => setOpenId(b.id)}>
                        {item.total >= 4 ? (
                          <div className={styles.bkNameRotated}>{pet.name ?? 'Pet'}</div>
                        ) : (
                          <>
                            <div className={styles.bkPet}>
                              <span className={styles.sdot} style={{ background: STATUS_COLORS[b.status] ?? '#888' }} />
                              <span style={{ fontSize: 12 }}>{pet.animal_type === 'cat' ? '🐱' : '🐶'}</span>
                              {pet.name ?? 'Pet'}
                            </div>
                            {ht > 52 && detail     && <div className={styles.bkSub}>{detail}</div>}
                            {ht > 72 && (first(b.owners)?.first_name ?? '') && <div className={styles.bkSub}>{first(b.owners).first_name}</div>}
                            {(b.discount_amount ?? 0) > 0 && <span className={styles.bkStar}>★</span>}
                          </>
                        )}
                      </div>
                    )
                  })}

                  {/* Current time line */}
                  {isToday && (() => {
                    const mins = now.getHours()*60 + now.getMinutes()
                    if (mins < DAY_START || mins > DAY_END) return null
                    return (
                      <div className={styles.timeNow} style={{ top: (mins - DAY_START) * PX_PER_MIN }}>
                        <div className={styles.timeNowDot} />
                      </div>
                    )
                  })()}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Overlays ── */}
      {calOpen && (
        <MonthOverlay
          modalDate={calModalDate}
          selectedDate={currentDate}
          monthDots={monthDots}
          onClose={() => setCalOpen(false)}
          onShift={delta => {
            const d = new Date(calModalDate); d.setMonth(d.getMonth() + delta)
            setCalModalDate(d); loadMonthDots(d.getFullYear(), d.getMonth())
          }}
          onJump={jumpToDate}
        />
      )}

      {openBlock && (
        <BlockDrawer
          block={openBlock} rooms={rooms} groomers={groomers} studios={studios}
          onClose={() => setOpenBlockId(null)}
          onDelete={async id => {
            await sbPatch('blocked_schedules', `id=eq.${id}`, { active: false })
            setOpenBlockId(null); loadBlocked()
          }}
        />
      )}

      {openBooking && (
        <BookingDrawer
          booking={openBooking} rooms={rooms} groomers={groomers}
          onClose={() => setOpenId(null)}
          onUpdated={() => { setOpenId(null); loadBookings(currentDate); loadBlocked() }}
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
          editBooking={editBooking}
          onClose={() => { setShowAddBooking(false); setEditBooking(null) }}
          onSaved={() => { loadBookings(currentDate); loadBlocked() }}
        />
      )}

      {showBlockPanel && (
        <BlockSchedulePanel
          branch={branch}
          rooms={rooms}
          groomers={groomers}
          studios={studios}
          onClose={() => setShowBlockPanel(false)}
          onSaved={() => loadBlocked()}
        />
      )}

      {filterOpen && (
        <FilterDrawer
          rooms={rooms}
          groomers={groomers}
          studios={studios}
          bookings={bookings}
          activeFilter={activeFilter}
          onSelect={(type, id) => { toggleFilter(type, id); setFilterOpen(false) }}
          onClear={() => { setActiveFilter(null); setFilterOpen(false) }}
          onClose={() => setFilterOpen(false)}
        />
      )}
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────
function SbSection({ label, children, topMargin }) {
  return (
    <div className={`${styles.sbSec} ${topMargin ? styles.sbSecMargin : ''}`}>
      <p className={styles.sbSecLbl}>{label}</p>
      {children}
    </div>
  )
}
function SbItem({ color, label, count, isOn, isRound, onToggle }) {
  return (
    <div className={`${styles.sbItem} ${isOn ? styles.sbItemOn : ''}`} onClick={onToggle}>
      <span className={`${styles.sbDot} ${isRound ? styles.sbDotRound : ''}`} style={{ background: color }} />
      <span className={styles.sbLbl}>{label}</span>
      <span className={styles.sbCt}>{count}</span>
    </div>
  )
}

function MonthOverlay({ modalDate, selectedDate, monthDots, onClose, onShift, onJump }) {
  const y = modalDate.getFullYear(), mon = modalDate.getMonth()
  const today = new Date()
  const firstDay = new Date(y, mon, 1).getDay()
  const daysCount = new Date(y, mon+1, 0).getDate()
  const prevLast  = new Date(y, mon, 0).getDate()
  const DOWS = ['S','M','T','W','T','F','S']
  const cells = []
  for (let i = 0; i < firstDay; i++) cells.push({ other: true, day: prevLast - firstDay + i + 1, key: `p${i}` })
  for (let d = 1; d <= daysCount; d++) {
    const ds = `${y}-${String(mon+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    cells.push({ day: d, ds, key: `d${d}`,
      isToday: d === today.getDate()        && mon === today.getMonth()        && y === today.getFullYear(),
      isSel:   d === selectedDate.getDate() && mon === selectedDate.getMonth() && y === selectedDate.getFullYear(),
      hasDot: !!monthDots[ds] })
  }
  return (
    <div className={styles.calOverlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.calModal}>
        <div className={styles.calHeader}>
          <button className={styles.calArrow} onClick={() => onShift(-1)}>‹</button>
          <span className={styles.calMonthLbl}>{MONTHS[mon]} {y}</span>
          <button className={styles.calArrow} onClick={() => onShift(1)}>›</button>
          <button className={styles.calClose} onClick={onClose}>✕</button>
        </div>
        <div className={styles.calDows}>
          {DOWS.map((d, i) => <div key={i} className={styles.calDow}>{d}</div>)}
        </div>
        <div className={styles.calGrid}>
          {cells.map(cell => (
            cell.other
              ? <div key={cell.key} className={`${styles.calCell} ${styles.calCellOther}`}><span className={styles.calNum}>{cell.day}</span></div>
              : <div key={cell.key}
                  className={`${styles.calCell} ${cell.isToday ? styles.calCellToday : ''} ${cell.isSel && !cell.isToday ? styles.calCellSel : ''}`}
                  onClick={() => onJump(y, mon, cell.day)}>
                  <span className={styles.calNum}>{cell.day}</span>
                  {cell.hasDot && <div className={styles.calDot} />}
                </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function FilterDrawer({ rooms, groomers, studios, bookings, activeFilter, onSelect, onClear, onClose }) {
  const countFor = (type, id) => bookings.filter(b => {
    if (type === 'room')    return b.service === 'hotel'    && (first(b.hotel_details)    ?? {}).room_id    === id
    if (type === 'groomer') return b.service === 'grooming' && (first(b.grooming_details) ?? {}).groomer_id === id
    if (type === 'studio')  return b.service === 'studio'   && (first(b.studio_details)   ?? {}).studio_id  === id
    return false
  }).length

  return (
    <div className={styles.fdOverlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.fdPanel}>
        <div className={styles.fdHandle} />
        <div className={styles.fdBody}>
          <div className={styles.fdHeader}>
            <span className={styles.fdTitle}>Filter by</span>
            {activeFilter && (
              <button className={styles.fdClearBtn} onClick={onClear}>Clear</button>
            )}
          </div>

          {rooms.length > 0 && (
            <div className={styles.fdSec}>
              <p className={styles.fdSecLbl}>Rooms</p>
              {rooms.map(r => (
                <div
                  key={r.id}
                  className={`${styles.fdItem} ${activeFilter?.type === 'room' && activeFilter?.id === r.id ? styles.fdItemOn : ''}`}
                  onClick={() => onSelect('room', r.id)}
                >
                  <span className={styles.fdDot} style={{ background: r.color }} />
                  <span className={styles.fdLbl}>{r.name}</span>
                  <span className={styles.fdCt}>{countFor('room', r.id)}</span>
                </div>
              ))}
            </div>
          )}

          {groomers.length > 0 && (
            <div className={styles.fdSec}>
              <p className={styles.fdSecLbl}>Groomers</p>
              {groomers.map(g => (
                <div
                  key={g.id}
                  className={`${styles.fdItem} ${activeFilter?.type === 'groomer' && activeFilter?.id === g.id ? styles.fdItemOn : ''}`}
                  onClick={() => onSelect('groomer', g.id)}
                >
                  <span className={`${styles.fdDot} ${styles.fdDotRound}`} style={{ background: g.color }} />
                  <span className={styles.fdLbl}>{g.name}</span>
                  <span className={styles.fdCt}>{countFor('groomer', g.id)}</span>
                </div>
              ))}
            </div>
          )}

          {studios.length > 0 && (
            <div className={styles.fdSec}>
              <p className={styles.fdSecLbl}>Studios</p>
              {studios.map(s => (
                <div
                  key={s.id}
                  className={`${styles.fdItem} ${activeFilter?.type === 'studio' && activeFilter?.id === s.id ? styles.fdItemOn : ''}`}
                  onClick={() => onSelect('studio', s.id)}
                >
                  <span className={`${styles.fdDot} ${styles.fdDotRound}`} style={{ background: s.color }} />
                  <span className={styles.fdLbl}>{s.name}</span>
                  <span className={styles.fdCt}>{countFor('studio', s.id)}</span>
                </div>
              ))}
            </div>
          )}

          <button className={styles.fdDoneBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

function BlockDrawer({ block: bl, rooms, groomers, studios, onClose, onDelete }) {
  const [deleting, setDeleting] = useState(false)
  const pool = bl.resource_type === 'groomer' ? groomers : bl.resource_type === 'studio' ? studios : rooms
  const res  = pool.find(r => r.id === bl.resource_id)
  const resName  = res?.name ?? (bl.resource_type === 'groomer' ? 'Groomer' : bl.resource_type === 'studio' ? 'Studio' : 'Room')
  const resColor = res?.color ?? '#9B95E8'
  const resType  = bl.resource_type === 'groomer' ? 'Groomer' : bl.resource_type === 'studio' ? 'Studio Unit' : 'Hotel Room'
  const dates    = Array.isArray(bl.dates) ? bl.dates : (bl.dates ? String(bl.dates).replace(/[{}"]/g,'').split(',') : [])
  const fmtD     = d => { try { return new Date(d+'T00:00:00').toLocaleDateString('en-PH',{weekday:'short',month:'short',day:'numeric',year:'numeric'}) } catch { return d } }
  const handleDelete = async () => {
    if (!confirm('Delete this blocked schedule?')) return
    setDeleting(true); try { await onDelete(bl.id) } catch { setDeleting(false) }
  }
  return (
    <div className={styles.bdOverlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.bdPanel}>
        <div className={styles.bdHandle} />
        <div className={styles.bdBody}>
          <p className={styles.bdRef}>Blocked Schedule</p>
          <div className={styles.bdTitleRow}>
            <span className={styles.bdDot} style={{ background: resColor }} />
            <span className={styles.bdTitle}>{resName}</span>
          </div>
          <p className={styles.bdSubtype}>{resType}</p>
          <div className={styles.bdSec}>
            <p className={styles.bdSecTitle}>Block Details</p>
            <div className={styles.bdRow}><span className={styles.bdKey}>Time</span><span className={styles.bdVal}>{(bl.start_time ?? '').slice(0,5)} – {(bl.end_time ?? '').slice(0,5)}</span></div>
            {bl.reason && <div className={styles.bdRow}><span className={styles.bdKey}>Reason</span><span className={styles.bdVal}>{bl.reason}</span></div>}
          </div>
          <div className={styles.bdSec}>
            <p className={styles.bdSecTitle}>Blocked Dates ({dates.length})</p>
            <div className={styles.bdDates}>{dates.map((d,i) => <span key={i} className={styles.bdDatePill}>{fmtD(d)}</span>)}</div>
          </div>
          <div className={styles.bdFooter}>
            <button className={styles.bdDeleteBtn} onClick={handleDelete} disabled={deleting}>🗑 Delete Block</button>
            <button className={styles.bdDoneBtn} onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  )
}
