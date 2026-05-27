import { useState, useEffect } from 'react'
import { sbPost } from '../../lib/supabase'
import styles from './BlockSchedulePanel.module.css'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function todayStr() { return new Date().toISOString().slice(0, 10) }

export default function BlockSchedulePanel({ branch, rooms, groomers, studios = [], onClose, onSaved }) {
  const [type,      setType]      = useState('room')
  const [resourceId,setResourceId]= useState('')
  const [dates,     setDates]     = useState([])
  const [month,     setMonth]     = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() } })
  const [startTime, setStartTime] = useState('09:00')
  const [endTime,   setEndTime]   = useState('17:00')
  const [reason,    setReason]    = useState('')
  const [saving,    setSaving]    = useState(false)
  const [err,       setErr]       = useState('')

  // Reset resource when type changes
  useEffect(() => { setResourceId('') }, [type])

  const resources = type === 'room' ? rooms : type === 'groomer' ? groomers : studios

  function toggleDate(ds) {
    setDates(prev =>
      prev.includes(ds) ? prev.filter(d => d !== ds) : [...prev, ds].sort()
    )
  }

  function shiftMonth(dir) {
    setMonth(prev => {
      let m = prev.m + dir, y = prev.y
      if (m > 11) { m = 0; y++ }
      if (m < 0)  { m = 11; y-- }
      return { y, m }
    })
  }

  async function save() {
    setErr('')
    if (!resourceId)        return setErr('Select a resource.')
    if (!dates.length)      return setErr('Select at least one date.')
    if (!startTime || !endTime || startTime >= endTime)
      return setErr('Set a valid start and end time.')

    setSaving(true)
    try {
      await sbPost('blocked_schedules', {
        branch_id:     branch.id,
        resource_type: type,
        resource_id:   resourceId,
        dates,
        start_time:    startTime,
        end_time:      endTime,
        reason:        reason.trim() || null,
        active:        true,
      })
      onSaved?.()
      onClose()
    } catch (e) {
      setErr('Failed to save: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Date picker ──
  const today = todayStr()
  const { y, m } = month
  const firstDay = new Date(y, m, 1).getDay()
  const daysInMonth = new Date(y, m + 1, 0).getDate()

  const calDays = []
  for (let i = 0; i < firstDay; i++) calDays.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    calDays.push(ds)
  }

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.panel}>
        <div className={styles.head}>
          <span className={styles.title}>Block Schedule</span>
          <button className={styles.close} onClick={onClose}>×</button>
        </div>
        <div className={styles.body}>
          {/* Branch */}
          <div className={styles.fg}>
            <label className={styles.fl}>Branch</label>
            <p className={styles.branchLbl}>{branch?.name ?? '—'}</p>
          </div>

          {/* Resource type */}
          <div className={styles.fg}>
            <label className={styles.fl}>Resource type</label>
            <div className={styles.pills}>
              {[['room','Hotel Room'],['groomer','Groomer'],['studio','Studio']].map(([k, l]) => (
                <button key={k} className={`${styles.pill} ${type === k ? styles.pillOn : ''}`}
                  onClick={() => setType(k)}>{l}</button>
              ))}
            </div>
          </div>

          {/* Resource */}
          <div className={styles.fg}>
            <label className={styles.fl}>Which one? <span className={styles.req}>*</span></label>
            <select className={styles.sel} value={resourceId} onChange={e => setResourceId(e.target.value)}>
              <option value="">Select…</option>
              {resources.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>

          {/* Date picker */}
          <div className={styles.fg}>
            <label className={styles.fl}>Date(s) — click to toggle</label>
            <div className={styles.calWrap}>
              <div className={styles.calNav}>
                <button className={styles.calArrow} onClick={() => shiftMonth(-1)}>‹</button>
                <span className={styles.calMonthLbl}>{MONTHS[m]} {y}</span>
                <button className={styles.calArrow} onClick={() => shiftMonth(1)}>›</button>
              </div>
              <div className={styles.calDows}>
                {['S','M','T','W','T','F','S'].map((d, i) => <div key={i} className={styles.calDow}>{d}</div>)}
              </div>
              <div className={styles.calGrid}>
                {calDays.map((ds, i) => {
                  if (!ds) return <div key={i} />
                  const sel  = dates.includes(ds)
                  const isT  = ds === today
                  return (
                    <div key={ds}
                      className={`${styles.calCell} ${sel ? styles.calSel : ''} ${isT && !sel ? styles.calToday : ''}`}
                      onClick={() => toggleDate(ds)}>
                      {parseInt(ds.slice(-2))}
                    </div>
                  )
                })}
              </div>
              <p className={styles.dateCount}>{dates.length} date{dates.length !== 1 ? 's' : ''} selected</p>
            </div>
          </div>

          {/* Time range */}
          <div className={styles.twoCol}>
            <div className={styles.fg}>
              <label className={styles.fl}>Start time <span className={styles.req}>*</span></label>
              <input type="time" className={styles.inp} value={startTime} onChange={e => setStartTime(e.target.value)} />
            </div>
            <div className={styles.fg}>
              <label className={styles.fl}>End time <span className={styles.req}>*</span></label>
              <input type="time" className={styles.inp} value={endTime} onChange={e => setEndTime(e.target.value)} />
            </div>
          </div>

          {/* Reason */}
          <div className={styles.fg}>
            <label className={styles.fl}>Reason <span className={styles.opt}>(optional)</span></label>
            <input className={styles.inp} placeholder="e.g. Lunch break, Leave"
              value={reason} onChange={e => setReason(e.target.value)} />
          </div>

          {err && <p className={styles.err}>{err}</p>}
        </div>
        <div className={styles.foot}>
          <button className={styles.btnCancel} onClick={onClose}>Cancel</button>
          <button className={styles.btnSave} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save Block'}
          </button>
        </div>
      </div>
    </div>
  )
}
