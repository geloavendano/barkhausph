import { useState, useEffect, useCallback } from 'react'
import { sbGet } from '../../lib/supabase'
import { SVC_LABELS, SVC_COLORS, STATUS_COLORS, PAY_COLORS, first, dayOffsetStr, todayStr, hexBg } from '../../lib/constants'
import BookingDrawer from './BookingDrawer'
import styles from './BookingsPage.module.css'

const BOOKING_SELECT = [
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

const SVC_FILTERS = ['all', 'grooming', 'hotel', 'daycare', 'studio']

export default function BookingsPage({ branches, currentBranchIdx = 0, rooms, groomers }) {
  const [bookings,   setBookings]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  const [svcFilter,  setSvcFilter]  = useState('all')
  const [daysBack,   setDaysBack]   = useState(7)
  const [openId,     setOpenId]     = useState(null)
  const [collapsed,  setCollapsed]  = useState({})

  const branch = branches?.[currentBranchIdx]

  const load = useCallback(async (append = false, days = daysBack, svc = svcFilter) => {
    if (!branch) return
    if (!append) { setLoading(true); setError('') }
    try {
      const fromDate = dayOffsetStr(days)
      const toDate   = append ? dayOffsetStr(days - 7) : todayStr()
      const svcQ     = svc !== 'all' ? `&service=eq.${svc}` : ''
      const rows = await sbGet(
        'bookings',
        `branch_id=eq.${branch.id}&created_at=gte.${fromDate}T00:00:00&created_at=lte.${toDate}T23:59:59&order=created_at.desc&select=${BOOKING_SELECT}${svcQ}`
      )
      if (append) {
        setBookings(prev => {
          const ids = new Set(prev.map(b => b.id))
          return [...prev, ...(rows ?? []).filter(b => !ids.has(b.id))]
        })
      } else {
        setBookings(rows ?? [])
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [branch, daysBack, svcFilter])

  useEffect(() => { load(false, 7, svcFilter) }, [branch, svcFilter])

  function handleFilterChange(svc) {
    setSvcFilter(svc)
    setDaysBack(7)
    setBookings([])
  }

  function handleLoadMore() {
    const next = daysBack + 7
    setDaysBack(next)
    load(true, next, svcFilter)
  }

  function toggleGroup(dt) {
    setCollapsed(c => ({ ...c, [dt]: !c[dt] }))
  }

  // Group by created_at date
  const groups = {}
  bookings.forEach(b => {
    const dt = b.created_at ? b.created_at.split('T')[0] : 'Unknown'
    if (!groups[dt]) groups[dt] = []
    groups[dt].push(b)
  })
  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a))

  const openBooking = bookings.find(b => b.id === openId)

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

      {loading && <p className={styles.msg}>Loading…</p>}
      {error   && <p className={styles.err}>{error}</p>}

      {!loading && !error && sortedDates.length === 0 && (
        <p className={styles.msg}>No bookings in this period.</p>
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

      {!loading && (
        <div className={styles.loadMore}>
          <button className={styles.loadMoreBtn} onClick={handleLoadMore}>
            Load earlier bookings
          </button>
        </div>
      )}

      {openBooking && (
        <BookingDrawer
          booking={openBooking}
          rooms={rooms}
          groomers={groomers}
          onClose={() => setOpenId(null)}
          onUpdated={() => { setOpenId(null); load(false, daysBack, svcFilter) }}
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
