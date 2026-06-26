import { useState, useEffect, useCallback } from 'react'
import { sbGet } from '../../lib/supabase'
import { SVC_LABELS, SVC_COLORS, STATUS_COLORS, STATUS_LABELS, first, fmtTime } from '../../lib/constants'
import { searchBookings } from '../../lib/search'
import BookingDrawer from '../Bookings/BookingDrawer'
import styles from './CheckInPage.module.css'

const CI_COMMON = [
  '*',
  'waivers(general_terms,house_rules_accepted,grooming_booking_policy,hotel_cancellation_policy,health_declaration,media_consent,studio_agreement,senior_medical_waiver,signed_at)',
  'owners(id,first_name,last_name,mobile,email,referral_source)',
  'pets(id,name,animal_type,breed,size,gender,age_value,age_unit,temperament,medical_notes)',
  'booking_addons(addon_key,addon_name,price)',
  'pet_vaccines(vaccine_name,confirmed)',
  'checkin_notes(*)',
].join(',')

// Service date lives in each detail table's service_date column (mirrors hotel).
const CI_DETAIL = {
  grooming: 'grooming_details(timeslot,preferred_stylist,groom_service_name,groom_service_key,special_requests,groomer_id,service_date)',
  hotel:    'hotel_details(checkin_date,checkout_date,dropoff_time,pickup_time,room_type,room_id,playpark_consent,feeding_instructions,medications,emergency_name,emergency_phone,vet_clinic,vet_contact,vet_address)',
  daycare:  'daycare_details(dropoff_time,pickup_time,hours_total,open_time,notes,service_date)',
  studio:   'studio_details(timeslot,studio_id,service_date)',
}

// Full select for one service, with that service's detail as !inner so we can
// filter parent bookings by the child's service_date.
function ciSelectFor(innerSvc) {
  const details = Object.keys(CI_DETAIL).map(svc =>
    svc === innerSvc ? CI_DETAIL[svc].replace('(', '!inner(') : CI_DETAIL[svc]
  )
  return [CI_COMMON, ...details].join(',')
}

// Search select: all detail embeds as left joins (any service can match).
const CI_SEARCH_SELECT = [CI_COMMON, ...Object.values(CI_DETAIL)].join(',')

function localDateISO(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function getBookingTime(b) {
  const gd = first(b.grooming_details)
  const hd = first(b.hotel_details)
  const dd = first(b.daycare_details)
  const sd = first(b.studio_details)
  return (gd?.timeslot) || (hd?.dropoff_time) || (dd?.dropoff_time) || (sd?.timeslot) || '99:99'
}

function sortByTime(arr) {
  return [...arr].sort((a, b) => getBookingTime(a).localeCompare(getBookingTime(b)))
}

function daysBetweenISO(fromISO, toISO) {
  if (!fromISO || !toISO) return 99999
  const from = new Date(fromISO + 'T00:00:00')
  const to = new Date(toISO + 'T00:00:00')
  return Math.round((to - from) / 86_400_000)
}

function sortByDaysUntil(arr, today) {
  return [...arr].sort((a, b) => {
    const da = daysBetweenISO(today, scheduledDate(a))
    const db = daysBetweenISO(today, scheduledDate(b))
    if (da !== db) return da - db
    return getBookingTime(a).localeCompare(getBookingTime(b))
  })
}

function daysUntilLabel(b, today) {
  const days = daysBetweenISO(today, scheduledDate(b))
  if (days === 99999) return 'No schedule date'
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return `${days} days until schedule`
}

// Parse a booking time into minutes-of-day. Handles display ("2:00 PM"),
// 24h ("14:00") and bare-hour ("14") forms used across services.
function parseTimeToMins(s) {
  if (s == null) return null
  const str = String(s).trim()
  const disp = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (disp) {
    let h = +disp[1]; const m = +disp[2]; const ap = disp[3].toUpperCase()
    if (ap === 'PM' && h !== 12) h += 12
    if (ap === 'AM' && h === 12) h = 0
    return h * 60 + m
  }
  const hm = str.match(/^(\d{1,2}):(\d{2})/); if (hm) return (+hm[1]) * 60 + (+hm[2])
  const bare = str.match(/^(\d{1,2})$/);     if (bare) return (+bare[1]) * 60
  return null
}

// The day a booking is scheduled to start (check-in for hotel, service date otherwise).
function scheduledDate(b) {
  if (b.service === 'hotel')    return first(b.hotel_details)?.checkin_date
  if (b.service === 'grooming') return first(b.grooming_details)?.service_date
  if (b.service === 'daycare')  return first(b.daycare_details)?.service_date
  if (b.service === 'studio')   return first(b.studio_details)?.service_date
  return null
}

// Overdue for check-in: still "confirmed" (not checked in) and its scheduled
// arrival has already passed — either an earlier day, or today before now.
function isCheckinOverdue(b, today, nowMins) {
  if (b.status !== 'confirmed') return false
  const date = scheduledDate(b)
  if (!date) return false
  if (date < today) return true
  if (date > today) return false
  const startMins = parseTimeToMins(getBookingTime(b))
  return startMins != null && nowMins > startMins
}

export default function CheckInPage({ branches, currentBranchIdx = 0, rooms, groomers, currentAdmin }) {
  const [bookings,  setBookings]  = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [collapsed, setCollapsed] = useState({})
  const [openId,    setOpenId]    = useState(null)
  const [today,     setToday]     = useState('')
  const [searchQ,       setSearchQ]       = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching,     setSearching]     = useState(false)

  const branch = branches?.[currentBranchIdx]
  const searchActive = searchQ.trim().length >= 2

  const load = useCallback(async () => {
    if (!branch) return
    setLoading(true)
    setError('')

    const todayISO = localDateISO()
    setToday(todayISO)

    try {
      const base   = `branch_id=eq.${branch.id}`
      const status = 'status=in.(confirmed,pending,checked_in)'
      const pencil = 'status=eq.pencil-booked'

      // Non-hotel: due when the service date (in each detail table) is today or
      // earlier. Filtered server-side via !inner on service_date.
      const [groomRows, dayRows, studioRows, hotelAll, pencilGroomRows, pencilDayRows, pencilStudioRows, pencilHotelRows] = await Promise.all([
        sbGet('bookings', `${base}&service=eq.grooming&${status}&grooming_details.service_date=lte.${todayISO}&order=created_at&select=${ciSelectFor('grooming')}`),
        sbGet('bookings', `${base}&service=eq.daycare&${status}&daycare_details.service_date=lte.${todayISO}&order=created_at&select=${ciSelectFor('daycare')}`),
        sbGet('bookings', `${base}&service=eq.studio&${status}&studio_details.service_date=lte.${todayISO}&order=created_at&select=${ciSelectFor('studio')}`),
        // Hotel: fetch all active and filter client-side on checkin/checkout.
        sbGet('bookings', `${base}&service=eq.hotel&${status}&order=created_at&select=${ciSelectFor('hotel')}`),
        sbGet('bookings', `${base}&service=eq.grooming&${pencil}&order=created_at&select=${ciSelectFor('grooming')}`),
        sbGet('bookings', `${base}&service=eq.daycare&${pencil}&order=created_at&select=${ciSelectFor('daycare')}`),
        sbGet('bookings', `${base}&service=eq.studio&${pencil}&order=created_at&select=${ciSelectFor('studio')}`),
        sbGet('bookings', `${base}&service=eq.hotel&${pencil}&order=created_at&select=${ciSelectFor('hotel')}`),
      ])

      const hotelFiltered = (hotelAll ?? []).filter(bk => {
        const hd = first(bk.hotel_details)
        if (!hd) return false
        if (bk.status === 'confirmed' || bk.status === 'pending') return hd.checkin_date <= todayISO
        if (bk.status === 'checked_in') return hd.checkin_date <= todayISO
        return false
      })

      // Merge + deduplicate
      const seen = new Set()
      const all = []
      for (const arr of [groomRows ?? [], dayRows ?? [], studioRows ?? [], hotelFiltered, pencilGroomRows ?? [], pencilDayRows ?? [], pencilStudioRows ?? [], pencilHotelRows ?? []]) {
        for (const bk of arr) {
          if (!seen.has(bk.id)) { seen.add(bk.id); all.push(bk) }
        }
      }

      setBookings(all)
    } catch (err) {
      console.error(err)
      setError('Failed to load. Try refreshing.')
    } finally {
      setLoading(false)
    }
  }, [branch])

  useEffect(() => { load() }, [load])

  // ── Search (ref #, owner name/email, pet name) — debounced ────────────────
  useEffect(() => {
    if (!searchActive || !branch?.id) { setSearchResults([]); setSearching(false); return }
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const rows = await searchBookings(branch.id, searchQ, CI_SEARCH_SELECT)
        setSearchResults(rows)
      } catch { setSearchResults([]) }
      finally { setSearching(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [searchQ, searchActive, branch?.id])

  // Categorise
  const pendingConfirmation = []
  const dueCheckin          = []   // overdue: confirmed but should already be checked in
  const awaitingCheckin     = []   // upcoming / pending
  const inProgress          = []
  const needCheckout        = []

  const nowMins = (() => { const n = new Date(); return n.getHours() * 60 + n.getMinutes() })()

  bookings.forEach(b => {
    const hd = first(b.hotel_details)
    const isCheckedIn = b.status === 'checked_in'
    const isHotel     = b.service === 'hotel'
    if (b.status === 'pencil-booked') {
      pendingConfirmation.push(b)
    } else if (isHotel && hd && hd.checkout_date <= today && isCheckedIn) {
      needCheckout.push(b)
    } else if (isCheckedIn) {
      inProgress.push(b)
    } else if (isCheckinOverdue(b, today, nowMins)) {
      dueCheckin.push(b)
    } else {
      awaitingCheckin.push(b)
    }
  })

  const sortedPendingConfirmation = sortByDaysUntil(pendingConfirmation, today)
  const sortedDueCheckin = sortByTime(dueCheckin)
  const sortedAwaitingCheckin = sortByTime(awaitingCheckin)
  const sortedInProgress = sortByTime(inProgress)
  const sortedNeedCheckout = sortByTime(needCheckout)

  const overdueCount = needCheckout.filter(b => {
    const hd = first(b.hotel_details)
    return hd && hd.checkout_date < today
  }).length

  const todayLabel = today
    ? (() => { try { return new Date(today + 'T00:00:00').toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) } catch { return today } })()
    : ''

  const toggle = id => setCollapsed(prev => ({ ...prev, [id]: !prev[id] }))
  const openBooking = (searchActive ? searchResults : bookings).find(b => b.id === openId)

  if (!branch) return <p className={styles.msg}>No branch selected.</p>

  return (
    <div className={styles.page}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.title}>Pending</h2>
          {todayLabel && <p className={styles.dateLabel}>{todayLabel}</p>}
        </div>
        <button className={styles.refreshBtn} onClick={load} disabled={loading}>
          ↻ Refresh
        </button>
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

      {/* ── Search results ── */}
      {searchActive ? (
        <>
          <p className={styles.searchMeta}>
            {searching ? 'Searching…' : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''} for "${searchQ.trim()}"`}
          </p>
          {!searching && searchResults.length === 0 && (
            <div className={styles.empty}>
              <p className={styles.emptyIcon}>🔍</p>
              <p className={styles.emptyText}>No matching bookings.</p>
            </div>
          )}
          <div className={styles.section}>
            {searchResults.map(b => (
              <BookingCard
                key={b.id}
                booking={b}
                actionLabel={STATUS_LABELS[b.status] ?? (b.status ?? '').replace(/_/g, ' ')}
                actionColor={STATUS_COLORS[b.status] ?? '#888'}
                today={today}
                onClick={() => setOpenId(b.id)}
              />
            ))}
          </div>
        </>
      ) : (
      <>
      {loading && <p className={styles.msg}>Loading pending bookings…</p>}
      {error   && <p className={styles.err}>{error}</p>}

      {!loading && !error && (
        <>
          <Section
            id="ci_pencil"
            label={`Pending Confirmation (${sortedPendingConfirmation.length})`}
            color="#9B95E8"
            cards={sortedPendingConfirmation}
            actionLabel="Pencil-booked"
            actionColor="#9B95E8"
            today={today}
            metaFor={b => daysUntilLabel(b, today)}
            emptyText="No pencil-booked bookings."
            collapsed={!!collapsed['ci_pencil']}
            onToggle={() => toggle('ci_pencil')}
            onOpen={setOpenId}
          />
          <Section
            id="ci_due_checkin"
            label={`Due for Check-in (${sortedDueCheckin.length}${sortedDueCheckin.length ? ' overdue' : ''})`}
            color="var(--error)"
            cards={sortedDueCheckin}
            actionLabel="Check In"
            actionColor="#FF6B6B"
            overdue
            today={today}
            emptyText="No overdue check-ins."
            collapsed={!!collapsed['ci_due_checkin']}
            onToggle={() => toggle('ci_due_checkin')}
            onOpen={setOpenId}
            topMargin
          />
          <Section
            id="ci_checkin"
            label={`Awaiting Check-In (${sortedAwaitingCheckin.length})`}
            color="#EF9F27"
            cards={sortedAwaitingCheckin}
            actionLabel="Check In"
            actionColor="#EF9F27"
            today={today}
            emptyText="No bookings awaiting check-in."
            collapsed={!!collapsed['ci_checkin']}
            onToggle={() => toggle('ci_checkin')}
            onOpen={setOpenId}
            topMargin
          />
          <Section
            id="ci_inprogress"
            label={`In Progress (${sortedInProgress.length})`}
            color="#1D9E75"
            cards={sortedInProgress}
            actionLabel="In Progress"
            actionColor="#1D9E75"
            today={today}
            emptyText="No bookings in progress."
            collapsed={!!collapsed['ci_inprogress']}
            onToggle={() => toggle('ci_inprogress')}
            onOpen={setOpenId}
            topMargin
          />
          <Section
            id="ci_checkout"
            label={overdueCount
              ? `Due for Checkout (${sortedNeedCheckout.length} · ${overdueCount} overdue)`
              : `Due for Checkout (${sortedNeedCheckout.length})`}
            color={overdueCount ? 'var(--error)' : '#4D96B9'}
            cards={sortedNeedCheckout}
            actionLabel="Checkout"
            actionColor={overdueCount ? '#FF6B6B' : '#4D96B9'}
            today={today}
            emptyText="No bookings due for checkout."
            collapsed={!!collapsed['ci_checkout']}
            onToggle={() => toggle('ci_checkout')}
            onOpen={setOpenId}
            topMargin
          />
        </>
      )}
      </>
      )}

      {openBooking && (
        <BookingDrawer
          booking={openBooking}
          rooms={rooms}
          groomers={groomers}
          currentAdmin={currentAdmin}
          onClose={() => setOpenId(null)}
          onUpdated={() => { setOpenId(null); load() }}
        />
      )}
    </div>
  )
}

function Section({ id, label, color, cards, actionLabel, actionColor, today, overdue, collapsed, onToggle, onOpen, topMargin, emptyText, metaFor }) {
  return (
    <div className={styles.section} style={topMargin ? { marginTop: 20 } : undefined}>
      <button className={styles.sectionHeader} onClick={onToggle}>
        <span className={styles.sectionLabel} style={{ color }}>{label}</span>
        <span className={styles.chevron} style={{ color }}>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div>
          {cards.length === 0 && <div className={styles.sectionEmpty}>{emptyText ?? 'No bookings.'}</div>}
          {cards.map(b => (
            <BookingCard
              key={b.id}
              booking={b}
              actionLabel={actionLabel}
              actionColor={actionColor}
              today={today}
              extraMeta={metaFor ? metaFor(b) : ''}
              overdue={overdue}
              onClick={() => onOpen(b.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function BookingCard({ booking: b, actionLabel, actionColor, today, overdue, extraMeta, onClick }) {
  const gd  = first(b.grooming_details)
  const hd  = first(b.hotel_details)
  const dd  = first(b.daycare_details)
  const sd  = first(b.studio_details)
  const pet = first(b.pets) ?? {}
  const own = first(b.owners) ?? {}

  const rawTime    = getBookingTime(b)
  const time       = rawTime !== '99:99' ? fmtTime(rawTime) : ''
  const svcColor   = SVC_COLORS[b.service] ?? '#888'
  const statusColor = STATUS_COLORS[b.status] ?? '#888'
  const isOverdue  = overdue || (hd?.checkout_date && hd.checkout_date < today)

  return (
    <div
      className={styles.card}
      style={{ borderLeft: `3px solid ${actionColor}` }}
      onClick={onClick}
    >
      {/* Top row: service badge + ref + action pill */}
      <div className={styles.cardTop}>
        <div className={styles.cardLeft}>
          <span
            className={styles.svcBadge}
            style={{ background: `${svcColor}22`, color: svcColor }}
          >
            {SVC_LABELS[b.service] ?? b.service}
          </span>
          <span className={styles.ref}>{b.ref_number ?? '-'}</span>
        </div>
        <span
          className={styles.actionPill}
          style={{ background: `${actionColor}22`, color: actionColor }}
        >
          {isOverdue ? '⚠ Overdue' : actionLabel}
        </span>
      </div>

      {/* Bottom row: pet/owner + time/checkout */}
      <div className={styles.cardBottom}>
        <div>
          <p className={styles.petName}>{pet.name ?? '-'}</p>
          <p className={styles.ownerName}>
            {[own.first_name, own.last_name].filter(Boolean).join(' ') || '—'}
          </p>
          {own.mobile && <p className={styles.ownerMobile}>{own.mobile}</p>}
        </div>
        <div className={styles.cardRight}>
          {time && <p className={styles.time}>{time}</p>}
          {hd?.checkout_date && (
            <p
              className={styles.checkoutDate}
              style={isOverdue ? { color: 'var(--error)' } : undefined}
            >
              out: {hd.checkout_date}
            </p>
          )}
          <span className={styles.statusPill} style={{ color: statusColor }}>
            {STATUS_LABELS[b.status] ?? b.status.replace(/_/g, ' ')}
          </span>
          {extraMeta && <p className={styles.scheduleMeta}>{extraMeta}</p>}
        </div>
      </div>
    </div>
  )
}
