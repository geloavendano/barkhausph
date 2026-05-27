import { useState, useEffect, useCallback } from 'react'
import { sbGet } from '../../lib/supabase'
import { SVC_LABELS, SVC_COLORS, STATUS_COLORS, first, fmtTime } from '../../lib/constants'
import BookingDrawer from '../Bookings/BookingDrawer'
import styles from './CheckInPage.module.css'

const CI_SELECT = [
  'id,ref_number,service,status,payment_status,booking_date,total,subtotal,discount_amount,created_at,booking_source,notes',
  'waivers(general_terms,health_declaration,media_consent,studio_agreement,senior_medical_waiver,signed_at)',
  'owners(id,first_name,last_name,mobile,email,referral_source)',
  'pets(id,name,animal_type,breed,size,gender,age_value,age_unit,temperament,medical_notes)',
  'grooming_details(timeslot,preferred_stylist,groom_service_name,groom_service_key,special_requests,groomer_id)',
  'hotel_details(checkin_date,checkout_date,dropoff_time,pickup_time,room_type,room_id,playpark_consent,feeding_instructions,medications,emergency_name,emergency_phone,vet_clinic,vet_contact,vet_address)',
  'daycare_details(dropoff_time,pickup_time,hours_total,open_time,notes)',
  'studio_details(timeslot,studio_id)',
  'booking_addons(addon_name,price)',
  'pet_vaccines(vaccine_name,confirmed)',
  'checkin_notes(*)',
].join(',')

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

export default function CheckInPage({ branches, currentBranchIdx = 0, rooms, groomers }) {
  const [bookings,  setBookings]  = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [collapsed, setCollapsed] = useState({})
  const [openId,    setOpenId]    = useState(null)
  const [today,     setToday]     = useState('')

  const branch = branches?.[currentBranchIdx]

  const load = useCallback(async () => {
    if (!branch) return
    setLoading(true)
    setError('')

    const todayISO = new Date().toISOString().slice(0, 10)
    setToday(todayISO)

    try {
      const base = `branch_id=eq.${branch.id}&select=${CI_SELECT}`

      const [nonHotelDue, nonHotelCI, hotelAll] = await Promise.all([
        // Confirmed/Pending non-hotel with booking_date <= today
        sbGet('bookings', `${base}&service=not.eq.hotel&status=in.(confirmed,pending)&booking_date=lte.${todayISO}&order=booking_date`),
        // Checked-in non-hotel with booking_date <= today
        sbGet('bookings', `${base}&service=not.eq.hotel&status=eq.checked_in&booking_date=lte.${todayISO}&order=booking_date`),
        // All hotel confirmed/pending/checked_in — filter client-side on dates
        sbGet('bookings', `${base}&service=eq.hotel&status=in.(confirmed,pending,checked_in)&order=created_at`),
      ])

      const hotelFiltered = (hotelAll ?? []).filter(bk => {
        const hd = first(bk.hotel_details)
        if (!hd) return false
        if (bk.status === 'confirmed' || bk.status === 'pending') return hd.checkin_date <= todayISO
        if (bk.status === 'checked_in') return hd.checkout_date <= todayISO
        return false
      })

      // Merge + deduplicate
      const seen = new Set()
      const all = []
      for (const arr of [nonHotelDue ?? [], nonHotelCI ?? [], hotelFiltered]) {
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

  // Categorise
  const needCheckin  = []
  const inProgress   = []
  const needCheckout = []

  bookings.forEach(b => {
    const hd = first(b.hotel_details)
    const isCheckedIn = b.status === 'checked_in'
    const isHotel     = b.service === 'hotel'
    if (isHotel && hd && hd.checkout_date <= today && isCheckedIn) {
      needCheckout.push(b)
    } else if (isCheckedIn) {
      inProgress.push(b)
    } else {
      needCheckin.push(b)
    }
  })

  sortByTime(needCheckin)
  sortByTime(inProgress)
  sortByTime(needCheckout)

  const overdueCount = needCheckout.filter(b => {
    const hd = first(b.hotel_details)
    return hd && hd.checkout_date < today
  }).length

  const todayLabel = today
    ? (() => { try { return new Date(today + 'T00:00:00').toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) } catch { return today } })()
    : ''

  const toggle = id => setCollapsed(prev => ({ ...prev, [id]: !prev[id] }))
  const openBooking = bookings.find(b => b.id === openId)

  if (!branch) return <p className={styles.msg}>No branch selected.</p>

  return (
    <div className={styles.page}>
      <div className={styles.topRow}>
        <div>
          <h2 className={styles.title}>Check In</h2>
          {todayLabel && <p className={styles.dateLabel}>{todayLabel}</p>}
        </div>
        <button className={styles.refreshBtn} onClick={load} disabled={loading}>
          ↻ Refresh
        </button>
      </div>

      {loading && <p className={styles.msg}>Loading check-ins…</p>}
      {error   && <p className={styles.err}>{error}</p>}

      {!loading && !error && bookings.length === 0 && (
        <div className={styles.empty}>
          <p className={styles.emptyIcon}>🐾</p>
          <p className={styles.emptyText}>No active bookings for today.</p>
        </div>
      )}

      {!loading && bookings.length > 0 && (
        <>
          {needCheckin.length > 0 && (
            <Section
              id="ci_checkin"
              label={`Awaiting Check-In (${needCheckin.length})`}
              color="#EF9F27"
              cards={needCheckin}
              actionLabel="Check In"
              actionColor="#EF9F27"
              today={today}
              collapsed={!!collapsed['ci_checkin']}
              onToggle={() => toggle('ci_checkin')}
              onOpen={setOpenId}
            />
          )}
          {inProgress.length > 0 && (
            <Section
              id="ci_inprogress"
              label={`In Progress (${inProgress.length})`}
              color="#1D9E75"
              cards={inProgress}
              actionLabel="In Progress"
              actionColor="#1D9E75"
              today={today}
              collapsed={!!collapsed['ci_inprogress']}
              onToggle={() => toggle('ci_inprogress')}
              onOpen={setOpenId}
              topMargin={needCheckin.length > 0}
            />
          )}
          {needCheckout.length > 0 && (
            <Section
              id="ci_checkout"
              label={overdueCount
                ? `Due for Checkout (${needCheckout.length} · ${overdueCount} overdue)`
                : `Due for Checkout (${needCheckout.length})`}
              color={overdueCount ? 'var(--error)' : '#4D96B9'}
              cards={needCheckout}
              actionLabel="Checkout"
              actionColor={overdueCount ? '#FF6B6B' : '#4D96B9'}
              today={today}
              collapsed={!!collapsed['ci_checkout']}
              onToggle={() => toggle('ci_checkout')}
              onOpen={setOpenId}
              topMargin={needCheckin.length > 0 || inProgress.length > 0}
            />
          )}
        </>
      )}

      {openBooking && (
        <BookingDrawer
          booking={openBooking}
          rooms={rooms}
          groomers={groomers}
          onClose={() => setOpenId(null)}
          onUpdated={() => { setOpenId(null); load() }}
        />
      )}
    </div>
  )
}

function Section({ id, label, color, cards, actionLabel, actionColor, today, collapsed, onToggle, onOpen, topMargin }) {
  return (
    <div className={styles.section} style={topMargin ? { marginTop: 20 } : undefined}>
      <button className={styles.sectionHeader} onClick={onToggle}>
        <span className={styles.sectionLabel} style={{ color }}>{label}</span>
        <span className={styles.chevron} style={{ color }}>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div>
          {cards.map(b => (
            <BookingCard
              key={b.id}
              booking={b}
              actionLabel={actionLabel}
              actionColor={actionColor}
              today={today}
              onClick={() => onOpen(b.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function BookingCard({ booking: b, actionLabel, actionColor, today, onClick }) {
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
  const isOverdue  = hd?.checkout_date && hd.checkout_date < today

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
            {b.status.replace(/_/g, ' ')}
          </span>
        </div>
      </div>
    </div>
  )
}
