import { useEffect, useMemo, useState } from 'react'
import { sbGet } from '../../lib/supabase'
import { first, fmtDate } from '../../lib/constants'
import { hasDurationAddon } from '../../lib/grooming'
import styles from './ReportsPage.module.css'

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

const REPORT_SELECT = [
  'id,ref_number,status,subtotal,discount_amount,total',
  'pets(name)',
  'booking_addons(addon_key,addon_name,price)',
  'grooming_details!inner(service_date,timeslot,groom_service_name,groom_service_key,groomer_id)',
].join(',')

export default function ReportsPage({ branches, currentBranchIdx = 0, groomers = [] }) {
  const branch = branches?.[currentBranchIdx]
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [groomerId, setGroomerId] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const selectedGroomerId = groomerId || groomers[0]?.id || ''

  useEffect(() => {
    if (!branch?.id || !from || !to || !selectedGroomerId) return
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
  }, [branch?.id, from, to, selectedGroomerId])

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
    return { total, addonTotal, serviceTotal: Math.max(0, total - addonTotal) }
  }, [visibleRows])

  const groomerName = groomers.find(g => g.id === selectedGroomerId)?.name ?? 'Select groomer'

  return (
    <div className={styles.page}>
      <div className={styles.topRow}>
        <h2 className={styles.title}>Reports</h2>
      </div>

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
            {visibleRows.map(b => <ReportRow key={b.id} booking={b} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function ReportRow({ booking: b }) {
  const gd = first(b.grooming_details) ?? {}
  const pet = first(b.pets) ?? {}
  const addons = Array.isArray(b.booking_addons) ? b.booking_addons : []
  const hasExtraTime = hasDurationAddon(addons)

  return (
    <div className={styles.row}>
      <span className={styles.date}>{fmtDate(gd.service_date)}</span>
      <span className={styles.pet}>{pet.name ?? '-'}</span>
      <span className={styles.service}>
        {gd.groom_service_name || gd.groom_service_key || 'Grooming'}
        {hasExtraTime && <span className={styles.addonMark}>Demat / Deshed</span>}
      </span>
      <span className={styles.amount}>PHP {(Number(b.subtotal) || 0).toLocaleString()}</span>
    </div>
  )
}
