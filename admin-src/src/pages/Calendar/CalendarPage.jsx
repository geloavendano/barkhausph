import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase, sbGet, sbPatch } from '../../lib/supabase'
import { STATUS_COLORS, SVC_LABELS, first, hexBg } from '../../lib/constants'
import { groomDurationMins } from '../../lib/grooming'
import BookingDrawer from '../Bookings/BookingDrawer'
import FAB from '../../components/FAB/FAB'
import AddBookingPanel from '../../components/AddBookingPanel/AddBookingPanel'
import BlockSchedulePanel from '../../components/BlockSchedulePanel/BlockSchedulePanel'
import styles from './CalendarPage.module.css'

// ── Constants ──────────────────────────────────────────────────────────────
const DAY_START  = 9 * 60    // 540 min (9 AM)
const DAY_END    = 22 * 60   // 1320 min (10 PM)
const PX_PER_MIN = 1.5
const HOUR_COUNT = (DAY_END - DAY_START) / 60
const TIMELINE_HEIGHT = (DAY_END - DAY_START) * PX_PER_MIN

const INTERNAL_OTHER_ROOM_ID = '__internal_other_room__'
const ROOM_TYPE_LABELS = { small_cage: 'Small Cage', medium_cage: 'Medium Cage', large_cage: 'Large Cage', single_cabin: 'Cat Cabin', villa: 'Cat Villa', other: 'Other' }
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
  '*',
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
function formatMins(mins) {
  const hour24 = Math.floor(mins / 60)
  const minute = mins % 60
  const period = hour24 >= 12 ? 'PM' : 'AM'
  return `${hour24 % 12 || 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${period}`
}
function getBookingTimes(b, dateStr) {
  const gd = first(b.grooming_details) ?? {}, hd = first(b.hotel_details) ?? {}
  const dd = first(b.daycare_details)  ?? {}, sd = first(b.studio_details)  ?? {}
  let st = null, en = null
  if      (b.service === 'grooming') { st = parseMins(gd.timeslot); en = st != null ? st + groomDurationMins(gd.groom_service_key ?? 'basic', b.booking_addons) : null }
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
  if (b.service === 'hotel' && hd?.room_type === 'other') return '#888780'
  if (b.service === 'hotel' && hd?.room_id)    { const r = rooms.find(x => x.id === hd.room_id);       if (r) return r.color }
  if (b.service === 'hotel' && hd?.room_type)  { const rc = { large_cage:'#EF9F27', medium_cage:'#4D96B9', small_cage:'#1D9E75', single_cabin:'#D4537E', villa:'#9B95E8' }; return rc[hd.room_type] ?? '#6AAEC8' }
  if (b.service === 'grooming' && gd?.groomer_id) { const g = groomers.find(x => x.id === gd.groomer_id); if (g) return g.color }
  if (b.service === 'daycare') return '#1D9E75'
  if (b.service === 'studio')  return '#D4537E'
  return '#6AAEC8'
}

// ── View helpers (day / week / month) ───────────────────────────────────────
const VIEW_OPTS = [{ k: 'day', label: 'Day' }, { k: 'week', label: 'Week' }, { k: 'month', label: 'Month' }, { k: 'list', label: 'List' }]

function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x }
function startOfWeek(d) { return addDays(d, -d.getDay()) }   // Sunday

// Inclusive [from, to] window covering the visible cells for the given view.
function viewRange(view, date) {
  if (view === 'week')  { const f = startOfWeek(date); return { from: f, to: addDays(f, 6) } }
  if (view === 'month') { const first = new Date(date.getFullYear(), date.getMonth(), 1); const f = addDays(first, -first.getDay()); return { from: f, to: addDays(f, 41) } }
  if (view === 'list')  { return { from: new Date(date.getFullYear(), date.getMonth(), 1), to: new Date(date.getFullYear(), date.getMonth() + 1, 0) } }
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  return { from: day, to: day }
}

// Does a booking appear on the given ISO day? (hotel stays span checkin..checkout)
function bookingOnDay(b, ds) {
  if (b.service === 'grooming') return (first(b.grooming_details) ?? {}).service_date === ds
  if (b.service === 'daycare')  return (first(b.daycare_details)  ?? {}).service_date === ds
  if (b.service === 'studio')   return (first(b.studio_details)   ?? {}).service_date === ds
  if (b.service === 'hotel')    { const hd = first(b.hotel_details) ?? {}; return !!hd.checkin_date && !!hd.checkout_date && hd.checkin_date <= ds && hd.checkout_date >= ds }
  return false
}
function petEmoji(b) { return (first(b.pets)?.animal_type === 'cat') ? '🐱' : '🐶' }

function weekLabel(from, to) {
  const nowYr = new Date().getFullYear()
  const yr = (from.getFullYear() !== nowYr || to.getFullYear() !== nowYr) ? ` ${to.getFullYear()}` : ''
  if (from.getMonth() === to.getMonth()) return `${MONTHS[from.getMonth()].slice(0, 3)} ${from.getDate()}–${to.getDate()}${yr}`
  return `${MONTHS[from.getMonth()].slice(0, 3)} ${from.getDate()} – ${MONTHS[to.getMonth()].slice(0, 3)} ${to.getDate()}${yr}`
}

// ── Multi-day spanning bars (Google Calendar style) ─────────────────────────
function isoToDate(iso) { return new Date(iso + 'T00:00:00') }
function daysBetween(aIso, bIso) { return Math.round((isoToDate(bIso) - isoToDate(aIso)) / 86400000) }

// Inclusive [startISO, endISO] of the calendar days a booking occupies.
// Hotel spans check-in → check-out; other services are a single service_date.
function bookingDayRange(b) {
  if (b.service === 'hotel') { const hd = first(b.hotel_details) ?? {}; return (hd.checkin_date && hd.checkout_date) ? [hd.checkin_date, hd.checkout_date] : null }
  const ds = b.service === 'grooming' ? first(b.grooming_details)?.service_date
           : b.service === 'daycare'  ? first(b.daycare_details)?.service_date
           : b.service === 'studio'   ? first(b.studio_details)?.service_date : null
  return ds ? [ds, ds] : null
}

// For one week (weekStart = its Sunday), clip every booking to a column segment
// [startCol..endCol] (0–6). `predicate` optionally restricts which bookings count.
// contL/contR mark stays that continue past this week's edges (for flat corners).
function weekSegments(bookings, weekStart, predicate) {
  const wkStart = dateToISO(weekStart), wkEnd = dateToISO(addDays(weekStart, 6))
  const segs = []
  bookings.forEach(b => {
    if (predicate && !predicate(b)) return
    const r = bookingDayRange(b); if (!r) return
    const [s, e] = r
    if (e < wkStart || s > wkEnd) return
    const startCol = Math.max(0, daysBetween(wkStart, s))
    const endCol   = Math.min(6, daysBetween(wkStart, e))
    if (startCol > endCol) return
    segs.push({ b, startCol, endCol, contL: s < wkStart, contR: e > wkEnd })
  })
  return segs
}

// Pack segments into lanes so no two in a lane overlap columns. Longer/earlier
// segments settle into the top lanes (each segment gets a `.lane` index).
function packLanes(segs) {
  const sorted = [...segs].sort((a, z) => a.startCol - z.startCol || (z.endCol - z.startCol) - (a.endCol - a.startCol))
  const lanes = []
  sorted.forEach(seg => {
    let li = lanes.findIndex(lane => lane.every(s => seg.startCol > s.endCol || seg.endCol < s.startCol))
    if (li === -1) { li = lanes.length; lanes.push([]) }
    lanes[li].push(seg); seg.lane = li
  })
  return lanes
}

// ── Main component ─────────────────────────────────────────────────────────
export default function CalendarPage({ branches, currentBranchIdx = 0, rooms, groomers, currentAdmin }) {
  const [currentDate,      setCurrentDate]      = useState(() => new Date())
  const [bookings,         setBookings]         = useState([])
  const [blockedSchedules, setBlockedSchedules] = useState([])
  const [groomerHours,      setGroomerHours]      = useState([])
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
  const [view,             setView]             = useState(() => { try { return localStorage.getItem('cal_view') || 'day' } catch { return 'day' } })
  const [peekDate,         setPeekDate]         = useState(null)   // month "+N more" day overlay
  const [listScrollKey,    setListScrollKey]    = useState(0)      // bump → List view scrolls to today

  const branch  = branches?.[currentBranchIdx]
  const dateStr = useMemo(() => dateToISO(currentDate), [currentDate])
  const range   = useMemo(() => viewRange(view, currentDate), [view, currentDate])
  // String key so range-change effects fire once per (branch, view, window) without Date-identity churn.
  const rangeKey = `${branch?.id ?? ''}|${view}|${dateToISO(range.from)}|${dateToISO(range.to)}`

  // Keep a ref so realtime/polling closures always reload the active view window
  // without needing to re-subscribe every time the user navigates.
  const rangeRef = useRef(range)
  useEffect(() => { rangeRef.current = range }, [range])

  // ── Loaders ───────────────────────────────────────────────────────────────
  // Loads every booking whose service date (or hotel stay) intersects [from, to].
  // Day view passes from === to; week/month pass the window covering the grid.
  const loadBookings = useCallback(async (fromDate, toDate) => {
    if (!branch?.id) { setBookings([]); setLoading(false); return }
    setLoading(true); setLoadError('')
    const f = dateToISO(fromDate), t = dateToISO(toDate)
    try {
      // Exclude cancelled/rejected; keep pending (unpaid online holds) visible.
      const base = `branch_id=eq.${branch.id}&status=not.in.(cancelled,rejected)`
      // Filter every service server-side. Non-hotel services match on service_date
      // within the window; hotel stays intersect the window when check-in is on/
      // before its end and checkout is on/after its start.
      const [groomRows, dayRows, studioRows, hotelRows] = await Promise.all([
        sbGet('bookings', `${base}&service=eq.grooming&grooming_details.service_date=gte.${f}&grooming_details.service_date=lte.${t}&order=created_at&select=${selectForService('grooming')}`),
        sbGet('bookings', `${base}&service=eq.daycare&daycare_details.service_date=gte.${f}&daycare_details.service_date=lte.${t}&order=created_at&select=${selectForService('daycare')}`),
        sbGet('bookings', `${base}&service=eq.studio&studio_details.service_date=gte.${f}&studio_details.service_date=lte.${t}&order=created_at&select=${selectForService('studio')}`),
        sbGet('bookings', `${base}&service=eq.hotel&hotel_details.checkin_date=lte.${t}&hotel_details.checkout_date=gte.${f}&order=created_at&select=${selectForService('hotel')}`),
      ])
      setBookings([...(groomRows ?? []), ...(dayRows ?? []), ...(studioRows ?? []), ...(hotelRows ?? [])])
    } catch (err) {
      console.error('Calendar load error:', err)
      setLoadError(err.message)
      setBookings([])
    }
    finally { setLoading(false) }
  }, [branch])

  // Reload the window currently in view (used by realtime, polling, after edits).
  const reloadBookings = useCallback(() => loadBookings(rangeRef.current.from, rangeRef.current.to), [loadBookings])

  const loadBlocked = useCallback(async () => {
    if (!branch?.id) return
    try { setBlockedSchedules((await sbGet('blocked_schedules', `branch_id=eq.${branch.id}&active=eq.true&order=created_at.desc&select=*`)) ?? []) }
    catch { setBlockedSchedules([]) }
  }, [branch?.id])

  const loadGroomerHours = useCallback(async date => {
    if (!branch?.id) return
    const ds = dateToISO(date)
    try {
      setGroomerHours((await sbGet('resource_service_hours',
        `branch_id=eq.${branch.id}&resource_type=eq.groomer&service_date=eq.${ds}&active=eq.true` +
        `&select=resource_id,start_time,end_time,last_service_time`)) ?? [])
    } catch { setGroomerHours([]) }
  }, [branch])

  const loadStudios = useCallback(async () => {
    if (!branch?.id) return
    try { setStudios((await sbGet('studios', `branch_id=eq.${branch.id}&active=eq.true&order=sort_order.asc.nullslast,name.asc&select=id,name,color,is_unavailable,unavailable_reason,sort_order`)) ?? []) }
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

  // On branch change: reset to today + default filters, reload branch-scoped data.
  // (Bookings + groomer hours are reloaded by the range effect below.)
  useEffect(() => {
    if (!branch?.id) return
    const d = new Date()
    setCurrentDate(d)
    setCalModalDate(d)
    setCurrentSvc('all')
    setActiveFilter(null)
    loadBlocked()
    loadStudios()
  }, [branch?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load bookings whenever the active window (branch / view / focused date) changes.
  // Groomer-hour markers are a day-view-only concern.
  useEffect(() => {
    if (!branch?.id) return
    loadBookings(range.from, range.to)
    if (view === 'day') loadGroomerHours(currentDate)
    else setGroomerHours([])
  }, [rangeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live updates: Realtime + disconnected fallback + visibility change ────
  useEffect(() => {
    if (!branch?.id) return

    let debounce = null
    let fallbackPoll = null
    const refresh = () => {
      // Debounce rapid-fire events (e.g. bulk inserts) to a single reload
      clearTimeout(debounce)
      debounce = setTimeout(() => reloadBookings(), 1200)
    }
    const stopFallback = () => {
      if (fallbackPoll) clearInterval(fallbackPoll)
      fallbackPoll = null
    }
    const startFallback = () => {
      if (!fallbackPoll) fallbackPoll = setInterval(() => reloadBookings(), 5 * 60_000)
    }

    // Supabase Realtime — instant update on any booking change for this branch
    const channel = supabase
      .channel(`cal-${branch.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, refresh)
      .subscribe(status => {
        if (status === 'SUBSCRIBED') stopFallback()
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') startFallback()
      })

    // Refresh immediately when the user returns to this tab
    const onVisible = () => { if (!document.hidden) reloadBookings() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearTimeout(debounce)
      supabase.removeChannel(channel)
      stopFallback()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [branch?.id, reloadBookings]) // eslint-disable-line react-hooks/exhaustive-deps

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
        if (peekDate)        { setPeekDate(null);         return }
        if (calOpen)         { setCalOpen(false);         return }
        return
      }
      // r / R: refresh when nothing is open and no input is focused
      if (e.key === 'r' || e.key === 'R') {
        const tag = document.activeElement?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return
        if (document.activeElement?.isContentEditable) return
        if (showAddBooking || showBlockPanel || filterOpen || openId || openBlockId || calOpen) return
        reloadBookings()
        loadBlocked()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [showAddBooking, showBlockPanel, filterOpen, openId, openBlockId, peekDate, calOpen, reloadBookings, loadBlocked]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Date navigation ───────────────────────────────────────────────────────
  // Handlers only move the focused date / view; the range effect reloads data.
  const changeView = (v) => { setView(v); try { localStorage.setItem('cal_view', v) } catch { /* ignore */ } }
  const shiftDate = (delta) => {
    setActiveFilter(null)
    setCurrentDate(d => {
      const x = new Date(d)
      if (view === 'week')                          x.setDate(x.getDate() + delta * 7)
      else if (view === 'month' || view === 'list') x.setMonth(x.getMonth() + delta)
      else                                          x.setDate(x.getDate() + delta)
      return x
    })
  }
  const goToday    = () => { setActiveFilter(null); setCurrentDate(new Date()) }
  const jumpToDate = (y, m, day) => { setActiveFilter(null); setCalOpen(false); setCurrentDate(new Date(y, m, day)) }
  // Click a day in week/month → drill into Day view for that date.
  const pickDay    = (d) => { setActiveFilter(null); changeView('day'); setCurrentDate(new Date(d.getFullYear(), d.getMonth(), d.getDate())) }
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
      if (activeFilter.type === 'room')    {
        const hd = first(b.hotel_details) ?? {}
        return activeFilter.id === INTERNAL_OTHER_ROOM_ID ? hd.room_type === 'other' : hd.room_id === activeFilter.id
      }
      if (activeFilter.type === 'groomer') { const gd = first(b.grooming_details) ?? {}; return gd.groomer_id  === activeFilter.id }
      if (activeFilter.type === 'studio')  { const sd = first(b.studio_details)   ?? {}; return b.service === 'studio' && sd.studio_id === activeFilter.id }
    }
    return true
  }), [bookings, currentSvc, activeFilter])

  // Merge bookings + relevant blocked-schedule segments into one column-layout pass
  // so they sit side-by-side instead of overlapping.
  const positioned = useMemo(() => {
    if (view !== 'day') return []   // day view only; week/month group per-day instead
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
  }, [view, filtered, blockedSchedules, dateStr, currentSvc, activeFilter])

  const now     = new Date()
  const isToday = now.getFullYear() === currentDate.getFullYear() && now.getMonth() === currentDate.getMonth() && now.getDate() === currentDate.getDate()
  const yrSfx   = currentDate.getFullYear() !== now.getFullYear() ? ` ${currentDate.getFullYear()}` : ''
  const dateLbl = `${DAYS[currentDate.getDay()]}, ${MONTHS[currentDate.getMonth()]} ${currentDate.getDate()}${yrSfx}`
  // Nav label + "Today" visibility adapt to the active view.
  const navLabel = view === 'day' ? dateLbl
    : view === 'week' ? weekLabel(range.from, range.to)
    : `${MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}`
  // Compact numeric label for mobile (e.g. 6/26, 6/21–27, Jun 2026).
  const navLabelShort = view === 'day'
      ? `${currentDate.getMonth() + 1}/${currentDate.getDate()}${yrSfx}`
    : view === 'week'
      ? (range.from.getMonth() === range.to.getMonth()
          ? `${range.from.getMonth() + 1}/${range.from.getDate()}–${range.to.getDate()}`
          : `${range.from.getMonth() + 1}/${range.from.getDate()}–${range.to.getMonth() + 1}/${range.to.getDate()}`)
      : `${MONTHS[currentDate.getMonth()].slice(0, 3)} ${currentDate.getFullYear()}`
  const todayISO    = dateToISO(now)
  const todayInView = dateToISO(range.from) <= todayISO && todayISO <= dateToISO(range.to)
  const openBooking = bookings.find(b => b.id === openId)
  const openBlock   = blockedSchedules.find(b => b.id === openBlockId)
  const showGroomerMarkers = currentSvc === 'grooming' || activeFilter?.type === 'groomer'
  // Sidebar/filter sections track the active service (All shows everything).
  const sbRooms    = (currentSvc === 'all' || currentSvc === 'hotel')    && rooms.length > 0
  const sbGroomers = (currentSvc === 'all' || currentSvc === 'grooming') && groomers.length > 0
  const sbStudios  = (currentSvc === 'all' || currentSvc === 'studio')   && studios.length > 0
  const visibleGroomerHours = showGroomerMarkers
    ? groomerHours.flatMap(hours => {
        const groomer = groomers.find(item => item.id === hours.resource_id)
        if (!groomer || groomer.is_unavailable) return []
        if (activeFilter?.type === 'groomer' && activeFilter.id !== groomer.id) return []
        const start = parseMins(hours.start_time)
        const end = parseMins(hours.end_time)
        const last = parseMins(hours.last_service_time)
        if (start == null || end == null || last == null) return []
        return [{ ...hours, groomer, start, end, last }]
      })
    : []

  return (
    <div className={styles.page}>
      {/* ── Date nav bar ── */}
      <div className={styles.dateNav}>
        {/* Date cluster: label on top, ‹ › beneath (compact horizontally) */}
        <div className={styles.dateCluster}>
          <button className={styles.dateLabelBtn} onClick={openCalOverlay}>
            <span className={styles.lblFull}>{navLabel}</span>
            <span className={styles.lblShort}>{navLabelShort}</span>
          </button>
          <div className={styles.dateArrows}>
            <button className={styles.navArrow} onClick={() => shiftDate(-1)}>‹</button>
            {(!todayInView || view === 'list') && (
              <button className={styles.todayBtn} onClick={() => { goToday(); if (view === 'list') setListScrollKey(k => k + 1) }}>Today</button>
            )}
            <button className={styles.navArrow} onClick={() => shiftDate(1)}>›</button>
          </div>
        </div>
        {loading && <span className={styles.loadDot} />}

        {/* View switch — segmented on desktop, dropdown on mobile */}
        <div className={styles.viewToggle}>
          {VIEW_OPTS.map(v => (
            <button key={v.k}
              className={`${styles.viewBtn} ${view === v.k ? styles.viewBtnOn : ''}`}
              onClick={() => changeView(v.k)}>
              {v.label}
            </button>
          ))}
        </div>
        <select className={styles.viewSelect} value={view} onChange={e => changeView(e.target.value)} aria-label="Calendar view">
          {VIEW_OPTS.map(v => <option key={v.k} value={v.k}>{v.label}</option>)}
        </select>

        {/* Mobile-only filter button (icon) — sidebar is hidden on small screens */}
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
              title={res ? `Filter: ${res.name}` : 'Filter'}
            >
              <span className={styles.filterIcon}>⊟</span>
              {res && <span className={styles.filterBtnDot} style={{ background: res.color }} />}
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
          {sbRooms && (
            <SbSection label="Rooms">
              {rooms.map(r => (
                <SbItem key={r.id} color={r.color} label={r.name}
                  count={bookings.filter(b => {
                    const hd = first(b.hotel_details) ?? {}
                    return b.service === 'hotel' && (r.id === INTERNAL_OTHER_ROOM_ID ? hd.room_type === 'other' : hd.room_id === r.id)
                  }).length}
                  isOn={activeFilter?.type === 'room' && activeFilter?.id === r.id}
                  onToggle={() => toggleFilter('room', r.id)} />
              ))}
            </SbSection>
          )}
          {sbGroomers && (
            <SbSection label="Groomers" topMargin={sbRooms}>
              {groomers.map(g => (
                <SbItem key={g.id} color={g.color} label={g.name} isRound
                  count={bookings.filter(b => b.service === 'grooming' && (first(b.grooming_details) ?? {}).groomer_id === g.id).length}
                  isOn={activeFilter?.type === 'groomer' && activeFilter?.id === g.id}
                  onToggle={() => toggleFilter('groomer', g.id)} />
              ))}
            </SbSection>
          )}
          {sbStudios && (
            <SbSection label="Studios" topMargin={sbRooms || sbGroomers}>
              {studios.map(s => (
                <SbItem key={s.id} color={s.color} label={s.name} isRound
                  count={bookings.filter(b => b.service === 'studio' && (first(b.studio_details) ?? {}).studio_id === s.id).length}
                  isOn={activeFilter?.type === 'studio' && activeFilter?.id === s.id}
                  onToggle={() => toggleFilter('studio', s.id)} />
              ))}
            </SbSection>
          )}
          {currentSvc === 'daycare' && (
            <p className={styles.sbEmpty}>Daycare has no assignable inventory.</p>
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

          {view === 'day' && (<>
          {showGroomerMarkers && visibleGroomerHours.length > 0 && (
            <div className={styles.groomerHoursStrip}>
              {visibleGroomerHours.map(hours => (
                <div className={styles.groomerHoursChip} key={hours.resource_id}>
                  <span className={styles.groomerHoursDot} style={{ background: hours.groomer.color }} />
                  <strong>{hours.groomer.name}</strong>
                  <span>{formatMins(hours.start)}-{formatMins(hours.end)}</span>
                  <span className={styles.groomerHoursLast}>last {formatMins(hours.last)}</span>
                </div>
              ))}
            </div>
          )}

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
                {Array.from({ length: HOUR_COUNT }, (_, i) => {
                  const h = 9 + i
                  return <div className={styles.tlLbl} key={h}>{h < 12 ? `${h}AM` : h === 12 ? '12PM' : `${h-12}PM`}</div>
                })}
              </div>

              {/* Cards area */}
              <div className={styles.tlCol}>
                <div className={styles.tlInner} style={{ height: TIMELINE_HEIGHT }}>
                  {/* Hour grid lines */}
                  {Array.from({ length: HOUR_COUNT }, (_, i) => <div key={i} className={styles.tlLine} style={{ top: i * 90 }} />)}

                  {/* Grooming-only service-hour boundaries. Never shown in All. */}
                  {visibleGroomerHours.map((hours, index) => {
                    const offset = visibleGroomerHours.length > 1 ? index * 4 : 0
                    const color = hours.groomer.color ?? '#4D96B9'
                    const markers = [
                      { key: 'start', minute: hours.start, kind: 'start' },
                      { key: 'end', minute: hours.end, kind: 'end' },
                    ]
                    return <div key={hours.resource_id}>
                      {markers.map(marker => marker.minute >= DAY_START && marker.minute <= DAY_END && (
                        <div key={marker.key} className={`${styles.scheduleBoundary} ${marker.kind === 'start' ? styles.scheduleStart : styles.scheduleEnd}`}
                          style={{ top: (marker.minute - DAY_START) * PX_PER_MIN + (marker.kind === 'start' ? offset : -offset - 6), color }}>
                        </div>
                      ))}
                      {hours.last >= DAY_START && hours.last <= DAY_END && (
                        <div className={styles.lastServiceLine}
                          style={{ top: (hours.last - DAY_START) * PX_PER_MIN + offset, color, borderTopColor: color }}>
                        </div>
                      )}
                    </div>
                  })}

                  {/* Unified column layout: blocked schedules + bookings side-by-side */}
                  {positioned.map(item => {
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
                      : hd ? (hd.room_type === 'other' ? 'Other' : (rooms.find(r => r.id === hd.room_id)?.name ?? ROOM_TYPE_LABELS[hd.room_type] ?? hd.room_type ?? 'Hotel'))
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
          </>)}

          {view === 'week' && (
            <WeekView
              weekStart={range.from} filtered={filtered}
              rooms={rooms} groomers={groomers} today={now}
              onOpenBooking={setOpenId} onPickDay={pickDay}
            />
          )}

          {view === 'month' && (
            <MonthView
              monthAnchor={currentDate} filtered={filtered}
              rooms={rooms} groomers={groomers} today={now}
              onPickDay={pickDay} onOpenBooking={setOpenId}
              onMore={setPeekDate}
            />
          )}

          {view === 'list' && (
            <ListView
              rangeFrom={range.from} rangeTo={range.to} filtered={filtered}
              rooms={rooms} groomers={groomers} today={now}
              onOpenBooking={setOpenId} scrollKey={listScrollKey}
            />
          )}
        </div>
      </div>

      {/* ── Overlays ── */}
      {peekDate && (
        <DayPeek
          date={peekDate} filtered={filtered} rooms={rooms} groomers={groomers}
          onOpenBooking={id => { setPeekDate(null); setOpenId(id) }}
          onClose={() => setPeekDate(null)}
        />
      )}

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
          currentAdmin={currentAdmin}
          onClose={() => setOpenId(null)}
          onUpdated={() => { setOpenId(null); reloadBookings(); loadBlocked() }}
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
          onSaved={() => { reloadBookings(); loadBlocked() }}
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
          rooms={sbRooms ? rooms : []}
          groomers={sbGroomers ? groomers : []}
          studios={sbStudios ? studios : []}
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

// ── Week view: all-day spanning band (hotel) + timed chips per day ───────────
function WeekView({ weekStart, filtered, rooms, groomers, today, onOpenBooking, onPickDay }) {
  const todayISO = dateToISO(today)
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const lanes = packLanes(weekSegments(filtered, weekStart, b => b.service === 'hotel'))
  return (
    <div className={styles.weekScroll}>
      <div className={styles.weekInner}>
        {/* Day headers */}
        <div className={styles.weekHeadRow}>
          {days.map(d => (
            <button key={dateToISO(d)} className={`${styles.weekHead} ${dateToISO(d) === todayISO ? styles.weekHeadToday : ''}`} onClick={() => onPickDay(d)}>
              <span className={styles.weekDow}>{DAYS[d.getDay()]}</span>
              <span className={styles.weekDate}>{d.getDate()}</span>
            </button>
          ))}
        </div>

        {/* All-day spanning bars (multi-day hotel stays) */}
        {lanes.length > 0 && (
          <div className={styles.weekBand}>
            {lanes.map((lane, li) => (
              <div key={li} className={styles.weekLaneRow}>
                {lane.map(seg => {
                  const color = getCardColor(seg.b, rooms, groomers)
                  return (
                    <div key={seg.b.id} className={styles.spanBar}
                      style={{
                        gridColumn: `${seg.startCol + 1} / ${seg.endCol + 2}`,
                        background: hexBg(color), borderLeftColor: color,
                        borderTopLeftRadius: seg.contL ? 0 : 4, borderBottomLeftRadius: seg.contL ? 0 : 4,
                        borderTopRightRadius: seg.contR ? 0 : 4, borderBottomRightRadius: seg.contR ? 0 : 4,
                      }}
                      onClick={() => onOpenBooking(seg.b.id)}>
                      🏨 {first(seg.b.pets)?.name ?? 'Pet'}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}

        {/* Timed bookings (grooming / daycare / studio) per day */}
        <div className={styles.weekBody}>
          {days.map(d => {
            const ds = dateToISO(d)
            const timed = filtered.filter(b => b.service !== 'hotel' && bookingOnDay(b, ds))
              .map(b => ({ b, st: getBookingTimes(b, ds).st }))
              .sort((a, c) => a.st - c.st)
            return (
              <div key={ds} className={styles.weekColBody}>
                {timed.map(({ b, st }) => {
                  const color = getCardColor(b, rooms, groomers)
                  const cancelled = b.status === 'cancelled' || b.status === 'rejected'
                  return (
                    <div key={b.id} className={`${styles.weekChip} ${cancelled ? styles.weekChipCancelled : ''}`}
                      style={{ background: hexBg(color), borderLeftColor: color }}
                      onClick={() => onOpenBooking(b.id)}>
                      <span className={styles.weekChipTime}>{formatMins(st)}</span>
                      <span className={styles.weekChipName}>
                        <span className={styles.sdot} style={{ background: STATUS_COLORS[b.status] ?? '#888' }} />
                        {petEmoji(b)} {first(b.pets)?.name ?? 'Pet'}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Month view: 6 week-rows with lane-packed spanning bars ──────────────────
function MonthView({ monthAnchor, filtered, rooms, groomers, today, onPickDay, onOpenBooking, onMore }) {
  const y = monthAnchor.getFullYear(), mon = monthAnchor.getMonth()
  const todayISO = dateToISO(today)
  const first0 = new Date(y, mon, 1)
  const gridStart = addDays(first0, -first0.getDay())
  const weeks = Array.from({ length: 6 }, (_, w) => addDays(gridStart, w * 7))
  const MAX_LANES = 3
  return (
    <div className={styles.monthScroll}>
      <div className={styles.monthDows}>
        {DAYS.map(d => <div key={d} className={styles.monthDow}>{d}</div>)}
      </div>
      <div className={styles.monthBody}>
        {weeks.map((wkStart, wi) => {
          const days = Array.from({ length: 7 }, (_, i) => addDays(wkStart, i))
          const lanes = packLanes(weekSegments(filtered, wkStart, null))
          const moreByCol = Array(7).fill(0)
          lanes.slice(MAX_LANES).forEach(lane => lane.forEach(seg => { for (let c = seg.startCol; c <= seg.endCol; c++) moreByCol[c]++ }))
          return (
            <div key={wi} className={styles.monthWeek}>
              {/* Background cells — borders, today/other-month, click-to-drill */}
              <div className={styles.monthWeekBg}>
                {days.map(d => (
                  <div key={dateToISO(d)}
                    className={`${styles.monthBgCell} ${dateToISO(d) === todayISO ? styles.monthBgToday : ''}`}
                    onClick={() => onPickDay(d)} />
                ))}
              </div>
              {/* Foreground — day numbers, spanning bars, +more */}
              <div className={styles.monthWeekFg}>
                <div className={styles.monthNumRow}>
                  {days.map(d => (
                    <div key={dateToISO(d)} className={styles.monthNumCell}>
                      <span className={`${styles.monthNum} ${d.getMonth() === mon ? '' : styles.monthNumOther} ${dateToISO(d) === todayISO ? styles.monthNumToday : ''}`}>{d.getDate()}</span>
                    </div>
                  ))}
                </div>
                {lanes.slice(0, MAX_LANES).map((lane, li) => (
                  <div key={li} className={styles.monthLaneRow}>
                    {lane.map(seg => {
                      const color = getCardColor(seg.b, rooms, groomers)
                      const cancelled = seg.b.status === 'cancelled' || seg.b.status === 'rejected'
                      return (
                        <div key={seg.b.id} className={`${styles.spanBar} ${styles.monthBar} ${cancelled ? styles.weekChipCancelled : ''}`}
                          style={{
                            gridColumn: `${seg.startCol + 1} / ${seg.endCol + 2}`,
                            background: hexBg(color), borderLeftColor: color,
                            borderTopLeftRadius: seg.contL ? 0 : 4, borderBottomLeftRadius: seg.contL ? 0 : 4,
                            borderTopRightRadius: seg.contR ? 0 : 4, borderBottomRightRadius: seg.contR ? 0 : 4,
                          }}
                          onClick={e => { e.stopPropagation(); onOpenBooking(seg.b.id) }}>
                          {seg.b.service === 'hotel' ? '🏨 ' : ''}{first(seg.b.pets)?.name ?? 'Pet'}
                        </div>
                      )
                    })}
                  </div>
                ))}
                {moreByCol.some(n => n > 0) && (
                  <div className={styles.monthMoreRow}>
                    {moreByCol.map((n, ci) => (
                      <div key={ci} className={styles.monthMoreCell} style={{ gridColumn: ci + 1 }}>
                        {n > 0 && <span className={styles.monthMore} onClick={e => { e.stopPropagation(); onMore(days[ci]) }}>+{n} more</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── List/agenda view: bookings grouped by day (empty days skipped) ──────────
const STATUS_LABELS = { pending: 'Pending', confirmed: 'Confirmed', checked_in: 'Checked in', completed: 'Completed', cancelled: 'Cancelled', rejected: 'Rejected' }

function ListRow({ b, label, color, onOpenBooking }) {
  const status    = b.status ?? 'confirmed'
  const cancelled = status === 'cancelled' || status === 'rejected'
  const pending   = status === 'pending'
  return (
    <div
      className={`${styles.listRow} ${cancelled ? styles.listRowCancelled : ''} ${pending ? styles.listRowPending : ''}`}
      style={{ borderLeftColor: color }}
      onClick={() => onOpenBooking(b.id)}>
      <span className={styles.listTime}>{label}</span>
      <span className={styles.listStatusDot} style={{ background: STATUS_COLORS[status] ?? '#888' }} />
      <span className={styles.listName}>{petEmoji(b)} {first(b.pets)?.name ?? 'Pet'}</span>
      {status !== 'confirmed' && status !== 'checked_in' && (
        <span className={styles.listBadge} style={{ color: STATUS_COLORS[status] ?? '#888', borderColor: STATUS_COLORS[status] ?? '#888' }}>{STATUS_LABELS[status] ?? status}</span>
      )}
      <span className={styles.listSvc}>{SVC_LABELS[b.service] ?? b.service}</span>
    </div>
  )
}

function ListView({ rangeFrom, rangeTo, filtered, rooms, groomers, today, onOpenBooking, scrollKey }) {
  const todayISO = dateToISO(today)
  const todayRef = useRef(null)
  const pending  = useRef(true)    // scroll to today on first render
  const firstRun = useRef(true)

  const doScroll = () => requestAnimationFrame(() => {
    if (todayRef.current) {
      todayRef.current.scrollIntoView({ behavior: firstRun.current ? 'auto' : 'smooth', block: 'start' })
      pending.current = false
      firstRun.current = false
    }
  })
  // Trigger on mount + when the Today button bumps scrollKey…
  useEffect(() => { pending.current = true; doScroll() }, [scrollKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // …and once data for a newly-navigated month has rendered the today row.
  useEffect(() => { if (pending.current) doScroll() }, [filtered]) // eslint-disable-line react-hooks/exhaustive-deps

  const days = []
  for (let d = new Date(rangeFrom); d <= rangeTo; d = addDays(d, 1)) days.push(new Date(d))
  const groups = days.map(d => {
    const ds = dateToISO(d)
    const dayBk = filtered.filter(b => bookingOnDay(b, ds))
    const hotels = dayBk.filter(b => b.service === 'hotel')
    const timed  = dayBk.filter(b => b.service !== 'hotel')
      .map(b => ({ b, st: getBookingTimes(b, ds).st }))
      .sort((a, c) => a.st - c.st)
    return { d, ds, hotels, timed, count: dayBk.length }
  }).filter(g => g.count > 0)

  if (groups.length === 0) {
    return <div className={styles.listScroll}><div className={styles.weekEmpty}>No bookings this month</div></div>
  }
  return (
    <div className={styles.listScroll}>
      {groups.map(g => (
        <div key={g.ds} ref={g.ds === todayISO ? todayRef : null} className={styles.listDay}>
          <div className={`${styles.listDayHead} ${g.ds === todayISO ? styles.listDayToday : ''}`}>
            <span className={styles.listDow}>{DAYS[g.d.getDay()]}</span>
            <span className={styles.listDateNum}>{g.d.getDate()}</span>
            <span className={styles.listMon}>{MONTHS[g.d.getMonth()].slice(0, 3)}</span>
            {g.ds === todayISO && <span className={styles.listTodayTag}>Today</span>}
            <span className={styles.listCount}>{g.count} booking{g.count > 1 ? 's' : ''}</span>
          </div>
          <div className={styles.listItems}>
            {g.hotels.map(b => (
              <ListRow key={b.id} b={b} label="🏨" color={getCardColor(b, rooms, groomers)} onOpenBooking={onOpenBooking} />
            ))}
            {g.timed.map(({ b, st }) => (
              <ListRow key={b.id} b={b} label={formatMins(st)} color={getCardColor(b, rooms, groomers)} onOpenBooking={onOpenBooking} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Day peek: full booking list for one day (month "+N more") ───────────────
function DayPeek({ date, filtered, rooms, groomers, onOpenBooking, onClose }) {
  const ds = dateToISO(date)
  const dayBk = filtered.filter(b => bookingOnDay(b, ds))
  const hotels = dayBk.filter(b => b.service === 'hotel')
  const timed  = dayBk.filter(b => b.service !== 'hotel')
    .map(b => ({ b, st: getBookingTimes(b, ds).st }))
    .sort((a, c) => a.st - c.st)
  return (
    <div className={styles.peekOverlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.peekCard}>
        <div className={styles.peekHead}>
          <div className={styles.peekDateBox}>
            <span className={styles.peekDow}>{DAYS[date.getDay()]}</span>
            <span className={styles.peekDate}>{date.getDate()}</span>
          </div>
          <button className={styles.peekClose} onClick={onClose}>✕</button>
        </div>
        <div className={styles.peekBody}>
          {hotels.map(b => {
            const color = getCardColor(b, rooms, groomers)
            const cancelled = b.status === 'cancelled' || b.status === 'rejected'
            return (
              <div key={b.id} className={`${styles.peekBar} ${cancelled ? styles.weekChipCancelled : ''}`}
                style={{ background: hexBg(color), borderLeftColor: color }}
                onClick={() => onOpenBooking(b.id)}>
                🏨 {first(b.pets)?.name ?? 'Pet'}
              </div>
            )
          })}
          {timed.map(({ b, st }) => {
            const cancelled = b.status === 'cancelled' || b.status === 'rejected'
            return (
              <div key={b.id} className={`${styles.peekRow} ${cancelled ? styles.weekChipCancelled : ''}`} onClick={() => onOpenBooking(b.id)}>
                <span className={styles.peekTime}>{formatMins(st)}</span>
                <span className={styles.sdot} style={{ background: STATUS_COLORS[b.status] ?? '#888' }} />
                <span className={styles.peekName}>{petEmoji(b)} {first(b.pets)?.name ?? 'Pet'}</span>
              </div>
            )
          })}
          {dayBk.length === 0 && <div className={styles.weekEmpty}>No bookings</div>}
        </div>
      </div>
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
    if (type === 'room') {
      const hd = first(b.hotel_details) ?? {}
      return b.service === 'hotel' && (id === INTERNAL_OTHER_ROOM_ID ? hd.room_type === 'other' : hd.room_id === id)
    }
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
