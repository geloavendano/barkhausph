import { useEffect, useMemo, useState } from 'react'
import { sbFunction, sbGet } from '../../lib/supabase'
import { first, fmtDate } from '../../lib/constants'
import { hasDurationAddon } from '../../lib/grooming'
import BookingDrawer from '../Bookings/BookingDrawer'
import styles from './ReportsPage.module.css'

const COMMISSION_ADDON_KEYS = new Set(['demat', 'deshed'])

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

const REPORT_SELECT = [
  '*',
  'waivers(general_terms,house_rules_accepted,grooming_booking_policy,hotel_cancellation_policy,health_declaration,media_consent,studio_agreement,senior_medical_waiver,signed_at)',
  'owners(id,first_name,last_name,mobile,email,referral_source)',
  'pets(id,name,animal_type,breed,size,gender,age_value,age_unit,temperament,medical_notes)',
  'booking_addons(addon_key,addon_name,price)',
  'pet_vaccines(vaccine_name,confirmed)',
  'checkin_notes(*)',
  'grooming_details!inner(service_date,timeslot,groom_service_name,groom_service_key,groomer_id)',
  'hotel_details(checkin_date,checkout_date,dropoff_time,pickup_time,pickup_hour,room_type,room_id,playpark_consent,feeding_instructions,medications,emergency_name,emergency_phone,vet_clinic,vet_contact,vet_address)',
  'daycare_details(dropoff_time,pickup_time,hours_total,open_time,notes,service_date)',
  'studio_details(timeslot,studio_id,service_date)',
].join(',')

export default function ReportsPage({ branches, currentBranchIdx = 0, rooms = [], groomers = [], currentAdmin }) {
  const branch = branches?.[currentBranchIdx]
  const [activeTab, setActiveTab] = useState('groomers')
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [groomerId, setGroomerId] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [openId, setOpenId] = useState(null)

  const selectedGroomerId = groomerId || groomers[0]?.id || ''

  useEffect(() => {
    if (activeTab !== 'groomers' || !branch?.id || !from || !to || !selectedGroomerId) return
    let cancelled = false
    async function loadReport() {
      setLoading(true); setErr('')
      try {
        const data = await sbGet(
          'bookings',
          `branch_id=eq.${branch.id}` +
          `&service=eq.grooming` +
          `&status=eq.completed` +
          `&grooming_details.service_date=gte.${from}` +
          `&grooming_details.service_date=lte.${to}` +
          `&grooming_details.groomer_id=eq.${selectedGroomerId}` +
          `&order=created_at.desc&select=${REPORT_SELECT}`
        )
        if (!cancelled) setRows(data ?? [])
      } catch (e) {
        if (!cancelled) { setErr(e.message); setRows([]) }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadReport()
    return () => { cancelled = true }
  }, [activeTab, branch?.id, from, to, selectedGroomerId])

  const visibleRows = useMemo(
    () => branch?.id && selectedGroomerId ? rows : [],
    [branch?.id, selectedGroomerId, rows]
  )

  const summary = useMemo(() => {
    const total = visibleRows.reduce((sum, b) => sum + (Number(b.subtotal) || 0), 0)
    const addonTotal = visibleRows.reduce((sum, b) => {
      const addons = Array.isArray(b.booking_addons) ? b.booking_addons : []
      return sum + addons.reduce((s, a) => s + (Number(a.price) || 0), 0)
    }, 0)
    const commissionAddonTotal = visibleRows.reduce((sum, b) => {
      const addons = Array.isArray(b.booking_addons) ? b.booking_addons : []
      return sum + addons.reduce((s, a) => s + (COMMISSION_ADDON_KEYS.has(a.addon_key) ? (Number(a.price) || 0) : 0), 0)
    }, 0)
    return { total, addonTotal, commissionAddonTotal, serviceTotal: Math.max(0, total - addonTotal) }
  }, [visibleRows])

  const groomerName = groomers.find(g => g.id === selectedGroomerId)?.name ?? 'Select groomer'
  const openBooking = visibleRows.find(b => b.id === openId)

  function reloadReport() {
    setRows([])
    if (!branch?.id || !from || !to || !selectedGroomerId) return
    setLoading(true); setErr('')
    sbGet(
      'bookings',
      `branch_id=eq.${branch.id}` +
      `&service=eq.grooming` +
      `&status=eq.completed` +
      `&grooming_details.service_date=gte.${from}` +
      `&grooming_details.service_date=lte.${to}` +
      `&grooming_details.groomer_id=eq.${selectedGroomerId}` +
      `&order=created_at.desc&select=${REPORT_SELECT}`
    )
      .then(data => setRows(data ?? []))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }

  return (
    <div className={styles.page}>
      <div className={styles.topRow}>
        <h2 className={styles.title}>Reports</h2>
      </div>

      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${activeTab === 'groomers' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('groomers')}
        >
          Groomer Reports
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'payments' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('payments')}
        >
          Payment Status Check
        </button>
      </div>

      {activeTab === 'groomers' ? (
        <>
          <div className={styles.controls}>
            <label className={styles.field}>
              <span>From</span>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>To</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>Groomer</span>
              <select value={selectedGroomerId} onChange={e => setGroomerId(e.target.value)}>
                <option value="">Select groomer…</option>
                {groomers.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
          </div>

          <div className={styles.summary}>
            <div>
              <span className={styles.metricLabel}>Subtotal sales</span>
              <strong>PHP {summary.total.toLocaleString()}</strong>
            </div>
            <div>
              <span className={styles.metricLabel}>Grooming services</span>
              <strong>PHP {summary.serviceTotal.toLocaleString()}</strong>
            </div>
            <div>
              <span className={styles.metricLabel}>Add-ons</span>
              <strong>PHP {summary.addonTotal.toLocaleString()}</strong>
            </div>
            <div>
              <span className={styles.metricLabel}>Demat / deshed add-ons</span>
              <strong>PHP {summary.commissionAddonTotal.toLocaleString()}</strong>
            </div>
          </div>

          <div className={styles.listHead}>
            <span>Completed grooming bookings</span>
            <span>{visibleRows.length} result{visibleRows.length === 1 ? '' : 's'} · {groomerName}</span>
          </div>

          {loading && <p className={styles.msg}>Loading report…</p>}
          {err && <p className={styles.err}>{err}</p>}
          {!loading && !err && visibleRows.length === 0 && <p className={styles.msg}>No completed grooming bookings for this range.</p>}

          {visibleRows.length > 0 && (
            <div className={styles.tableWrap}>
              <div className={styles.table}>
                {visibleRows.map(b => <ReportRow key={b.id} booking={b} onClick={() => setOpenId(b.id)} />)}
              </div>
            </div>
          )}

          {openBooking && (
            <BookingDrawer
              booking={openBooking}
              rooms={rooms}
              groomers={groomers}
              currentAdmin={currentAdmin}
              onClose={() => setOpenId(null)}
              onUpdated={() => { setOpenId(null); reloadReport() }}
            />
          )}
        </>
      ) : (
        <PaymentStatusCheck />
      )}
    </div>
  )
}

function PaymentStatusCheck() {
  const [ref, setRef] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function checkPayment() {
    const normalized = ref.trim().toUpperCase()
    if (!/^BH-[A-Z0-9]+$/.test(normalized)) {
      setError('Enter a valid Barkhaus reference such as BH-597A57.')
      setResult(null)
      return
    }
    setLoading(true); setError(''); setResult(null)
    try {
      setResult(await sbFunction('admin-maya-payment-status', { ref: normalized }))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const transactions = result?.transactions ?? []

  return (
    <div className={styles.paymentCard}>
      <p className={styles.cardLabel}>Check Maya Payment Status</p>
      <label className={styles.lookupField}>
        <span>Booking Reference Number</span>
        <input
          value={ref}
          placeholder="e.g. BH-597A57"
          onChange={e => setRef(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && checkPayment()}
        />
      </label>
      <button className={styles.checkButton} onClick={checkPayment} disabled={loading}>
        {loading ? 'Checking Maya…' : 'Check Payment Status'}
      </button>

      {error && <p className={styles.lookupError}>{error}</p>}
      {result && transactions.length === 0 && (
        <div className={styles.emptyResult}>
          No Maya transaction was found for <strong>{result.ref}</strong>.
        </div>
      )}
      {transactions.length > 0 && (
        <div className={styles.paymentResults}>
          <div className={styles.resultHeading}>
            <span>{result.ref}</span>
            <span>{transactions.length} Maya transaction{transactions.length === 1 ? '' : 's'}</span>
          </div>
          {transactions.map((payment, index) => (
            <div className={styles.paymentResult} key={payment.id || `${payment.updated_at}-${index}`}>
              <div className={styles.paymentResultTop}>
                <strong>{payment.status || 'Unknown status'}</strong>
                <span>{formatMoney(payment.amount, payment.currency)}</span>
              </div>
              <ResultRow label="Payment ID" value={payment.id} />
              <ResultRow label="Method" value={payment.payment_method || payment.fund_source || '—'} />
              {payment.fund_source && payment.fund_source !== payment.payment_method && (
                <ResultRow label="Fund source" value={payment.fund_source} />
              )}
              <ResultRow label="Maya updated" value={formatMayaTimestamp(payment.updated_at)} />
              {payment.created_at && <ResultRow label="Maya created" value={formatMayaTimestamp(payment.created_at)} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ResultRow({ label, value }) {
  return (
    <div className={styles.resultRow}>
      <span>{label}</span>
      <strong>{value || '—'}</strong>
    </div>
  )
}

function formatMoney(amount, currency = 'PHP') {
  return `${currency || 'PHP'} ${Number(amount || 0).toLocaleString()}`
}

function formatMayaTimestamp(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Manila',
  })
}

function ReportRow({ booking: b, onClick }) {
  const gd = first(b.grooming_details) ?? {}
  const pet = first(b.pets) ?? {}
  const addons = Array.isArray(b.booking_addons) ? b.booking_addons : []
  const hasExtraTime = hasDurationAddon(addons)

  return (
    <button className={styles.row} onClick={onClick}>
      <span className={styles.date}>{fmtDate(gd.service_date)}</span>
      <span className={styles.pet}>{pet.name ?? '-'}</span>
      <span className={styles.service}>
        {gd.groom_service_name || gd.groom_service_key || 'Grooming'}
        {hasExtraTime && <span className={styles.addonMark}>Demat / Deshed</span>}
      </span>
      <span className={styles.amount}>PHP {(Number(b.subtotal) || 0).toLocaleString()}</span>
    </button>
  )
}
