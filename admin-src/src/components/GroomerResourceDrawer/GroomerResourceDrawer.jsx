import { useEffect, useMemo, useState } from 'react'
import { sbGet, sbPatch, sbPost, sbUpsert } from '../../lib/supabase'
import { RESOURCE_COLORS } from '../../lib/constants'
import styles from './GroomerResourceDrawer.module.css'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function dateStr(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function monthBounds({ y, m }) {
  const first = `${y}-${String(m + 1).padStart(2, '0')}-01`
  const lastDay = new Date(y, m + 1, 0).getDate()
  return { first, last: `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` }
}

function shiftMonthValue(month, direction) {
  const next = new Date(month.y, month.m + direction, 1)
  return { y: next.getFullYear(), m: next.getMonth() }
}

function timeInput(value, fallback) {
  return value ? String(value).slice(0, 5) : fallback
}

function parsedDates(value) {
  if (Array.isArray(value)) return value
  return value ? String(value).replace(/[{}"]/g, '').split(',').filter(Boolean) : []
}

function formatDate(value) {
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-PH', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  })
}

function MonthCalendar({ month, onMonth, markedDates = [], selectedDate, onSelectDate, toggledDates = [], onToggleDate }) {
  const firstDay = new Date(month.y, month.m, 1).getDay()
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate()
  const cells = Array(firstDay).fill(null)
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(`${month.y}-${String(month.m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }
  const today = dateStr()
  return (
    <div className={styles.calendar}>
      <div className={styles.calNav}>
        <button type="button" onClick={() => onMonth(shiftMonthValue(month, -1))}>&lt;</button>
        <strong>{MONTHS[month.m]} {month.y}</strong>
        <button type="button" onClick={() => onMonth(shiftMonthValue(month, 1))}>&gt;</button>
      </div>
      <div className={styles.calGrid}>
        {['S','M','T','W','T','F','S'].map((day, index) => <span className={styles.dow} key={`${day}-${index}`}>{day}</span>)}
        {cells.map((value, index) => value ? (
          <button key={value} type="button"
            className={`${styles.day} ${markedDates.includes(value) ? styles.availableDay : ''} ${selectedDate === value ? styles.selectedDay : ''} ${toggledDates.includes(value) ? styles.toggledDay : ''} ${today === value ? styles.today : ''}`}
            onClick={() => onToggleDate ? onToggleDate(value) : onSelectDate?.(value)}>
            {Number(value.slice(-2))}
          </button>
        ) : <span key={`blank-${index}`} />)}
      </div>
    </div>
  )
}

function HoursFields({ start, setStart, end, setEnd, last, setLast }) {
  return (
    <div className={styles.hoursGrid}>
      <label>Starts<input type="time" value={start} onChange={event => setStart(event.target.value)} /></label>
      <label>Ends<input type="time" value={end} onChange={event => setEnd(event.target.value)} /></label>
      <label>Last service<input type="time" value={last} onChange={event => setLast(event.target.value)} /></label>
    </div>
  )
}

function BulkHoursPanel({ branch, groomer, onClose, onSaved }) {
  const now = new Date()
  const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() })
  const [dates, setDates] = useState([])
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('19:00')
  const [last, setLast] = useState('17:00')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function toggleDate(value) {
    setDates(current => current.includes(value) ? current.filter(date => date !== value) : [...current, value].sort())
  }

  async function save() {
    if (!dates.length) return setError('Select at least one date.')
    if (!start || !end || !last || start >= end || last < start || last > end) {
      return setError('Set valid service hours and a last-service time inside that window.')
    }
    setSaving(true); setError('')
    try {
      await sbUpsert('resource_service_hours', dates.map(serviceDate => ({
        branch_id: branch.id,
        resource_type: 'groomer',
        resource_id: groomer.id,
        service_date: serviceDate,
        start_time: start,
        end_time: end,
        last_service_time: last,
        active: true,
        updated_at: new Date().toISOString(),
      })), 'resource_type,resource_id,service_date')
      await onSaved()
      onClose()
    } catch (err) { setError(err.message); setSaving(false) }
  }

  return (
    <div className={styles.nestedOverlay} onClick={event => event.target === event.currentTarget && onClose()}>
      <div className={styles.nestedPanel}>
        <header><strong>Add service hours in bulk</strong><button onClick={onClose}>x</button></header>
        <div className={styles.nestedBody}>
          <p className={styles.help}>Selected dates will be overwritten with these hours.</p>
          <MonthCalendar month={month} onMonth={setMonth} toggledDates={dates} onToggleDate={toggleDate} />
          <p className={styles.count}>{dates.length} date{dates.length === 1 ? '' : 's'} selected</p>
          <HoursFields start={start} setStart={setStart} end={end} setEnd={setEnd} last={last} setLast={setLast} />
          {error && <p className={styles.error}>{error}</p>}
        </div>
        <footer><button className={styles.secondary} onClick={onClose}>Cancel</button><button className={styles.primary} onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save hours'}</button></footer>
      </div>
    </div>
  )
}

function BlockEditor({ branch, groomer, block, onClose, onSaved }) {
  const initialDates = parsedDates(block?.dates)
  const initialDate = initialDates[0] ? new Date(`${initialDates[0]}T00:00:00`) : new Date()
  const [month, setMonth] = useState({ y: initialDate.getFullYear(), m: initialDate.getMonth() })
  const [dates, setDates] = useState(initialDates)
  const [start, setStart] = useState(timeInput(block?.start_time, '12:00'))
  const [end, setEnd] = useState(timeInput(block?.end_time, '13:00'))
  const [reason, setReason] = useState(block?.reason ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function toggleDate(value) {
    setDates(current => current.includes(value) ? current.filter(date => date !== value) : [...current, value].sort())
  }

  async function save() {
    if (!dates.length) return setError('Select at least one date.')
    if (!start || !end || start >= end) return setError('Set a valid start and end time.')
    setSaving(true); setError('')
    const payload = {
      branch_id: branch.id, resource_type: 'groomer', resource_id: groomer.id,
      dates, start_time: start, end_time: end, reason: reason.trim() || null, active: true,
    }
    try {
      if (block) await sbPatch('blocked_schedules', `id=eq.${block.id}`, payload)
      else await sbPost('blocked_schedules', payload)
      await onSaved(); onClose()
    } catch (err) { setError(err.message); setSaving(false) }
  }

  async function remove() {
    if (!confirm('Remove this blocked schedule?')) return
    setSaving(true)
    try { await sbPatch('blocked_schedules', `id=eq.${block.id}`, { active: false }); await onSaved(); onClose() }
    catch (err) { setError(err.message); setSaving(false) }
  }

  return (
    <div className={styles.nestedOverlay} onClick={event => event.target === event.currentTarget && onClose()}>
      <div className={styles.nestedPanel}>
        <header><strong>{block ? 'Edit blocked schedule' : 'Add blocked schedule'}</strong><button onClick={onClose}>x</button></header>
        <div className={styles.nestedBody}>
          <MonthCalendar month={month} onMonth={setMonth} toggledDates={dates} onToggleDate={toggleDate} />
          <p className={styles.count}>{dates.length} date{dates.length === 1 ? '' : 's'} selected</p>
          <div className={styles.hoursGrid}>
            <label>Starts<input type="time" value={start} onChange={event => setStart(event.target.value)} /></label>
            <label>Ends<input type="time" value={end} onChange={event => setEnd(event.target.value)} /></label>
          </div>
          <label className={styles.field}>Reason<input value={reason} onChange={event => setReason(event.target.value)} placeholder="Lunch, leave, appointment" /></label>
          {error && <p className={styles.error}>{error}</p>}
        </div>
        <footer>{block && <button className={styles.danger} onClick={remove} disabled={saving}>Remove</button>}<span /><button className={styles.secondary} onClick={onClose}>Cancel</button><button className={styles.primary} onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save block'}</button></footer>
      </div>
    </div>
  )
}

export default function GroomerResourceDrawer({ branch, groomer, onClose, onSaved }) {
  const now = new Date()
  const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() })
  const [selectedDate, setSelectedDate] = useState(dateStr(now))
  const [hours, setHours] = useState([])
  const [blocks, setBlocks] = useState([])
  const [loading, setLoading] = useState(true)
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('19:00')
  const [last, setLast] = useState('17:00')
  const [name, setName] = useState(groomer.name)
  const [color, setColor] = useState(groomer.color ?? RESOURCE_COLORS[0].value)
  const [unavailable, setUnavailable] = useState(!!groomer.is_unavailable)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)
  const [blockEditor, setBlockEditor] = useState(undefined)

  const currentHours = useMemo(() => hours.find(row => row.service_date === selectedDate && row.active !== false), [hours, selectedDate])

  async function load() {
    const { first, last: monthLast } = monthBounds(month)
    setLoading(true); setError('')
    try {
      const [hoursRows, blockRows] = await Promise.all([
        sbGet('resource_service_hours', `resource_type=eq.groomer&resource_id=eq.${groomer.id}&service_date=gte.${first}&service_date=lte.${monthLast}&select=*&order=service_date`),
        sbGet('blocked_schedules', `resource_type=eq.groomer&resource_id=eq.${groomer.id}&active=eq.true&select=*&order=created_at.desc`),
      ])
      setHours(hoursRows ?? []); setBlocks(blockRows ?? [])
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { load() }, [groomer.id, month.y, month.m]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setStart(timeInput(currentHours?.start_time, '09:00'))
    setEnd(timeInput(currentHours?.end_time, '19:00'))
    setLast(timeInput(currentHours?.last_service_time, '17:00'))
  }, [currentHours])
  /* eslint-enable react-hooks/set-state-in-effect */

  async function saveDate() {
    if (!start || !end || !last || start >= end || last < start || last > end) {
      return setError('Set valid service hours and a last-service time inside that window.')
    }
    setSaving(true); setError('')
    try {
      await sbUpsert('resource_service_hours', {
        branch_id: branch.id, resource_type: 'groomer', resource_id: groomer.id,
        service_date: selectedDate, start_time: start, end_time: end,
        last_service_time: last, active: true, updated_at: new Date().toISOString(),
      }, 'resource_type,resource_id,service_date')
      await load(); onSaved?.()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  async function removeDate() {
    if (!currentHours || !confirm(`Remove availability for ${formatDate(selectedDate)}?`)) return
    setSaving(true)
    try { await sbPatch('resource_service_hours', `id=eq.${currentHours.id}`, { active: false, updated_at: new Date().toISOString() }); await load(); onSaved?.() }
    catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  async function saveDetails() {
    if (!name.trim()) return setError('Name is required.')
    setSaving(true); setError('')
    try {
      await sbPatch('groomers', `id=eq.${groomer.id}`, { name: name.trim(), color, is_unavailable: unavailable })
      onSaved?.()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  async function nestedSaved() { await load(); onSaved?.() }

  return (
    <div className={styles.overlay} onClick={event => event.target === event.currentTarget && onClose()}>
      <aside className={styles.drawer}>
        <header className={styles.header}>
          <div><span className={styles.dot} style={{ background: color }} /><strong>{name}</strong><small>Groomer schedule</small></div>
          <button onClick={onClose}>x</button>
        </header>
        <div className={styles.body}>
          <section>
            <div className={styles.sectionHead}><div><h3>Available service hours</h3><p>Today is selected by default. Marked days have saved hours.</p></div><button className={styles.primary} onClick={() => setBulkOpen(true)}>Add in bulk</button></div>
            <MonthCalendar month={month} onMonth={setMonth} markedDates={hours.filter(row => row.active !== false).map(row => row.service_date)} selectedDate={selectedDate} onSelectDate={setSelectedDate} />
            <div className={styles.selectedHours}>
              <strong>{formatDate(selectedDate)}</strong>
              <span className={currentHours ? styles.availableLabel : styles.unavailableLabel}>{currentHours ? 'Available' : 'No availability'}</span>
              <HoursFields start={start} setStart={setStart} end={end} setEnd={setEnd} last={last} setLast={setLast} />
              <div className={styles.actions}>{currentHours && <button className={styles.danger} onClick={removeDate} disabled={saving}>Remove day</button>}<button className={styles.primary} onClick={saveDate} disabled={saving}>{saving ? 'Saving...' : currentHours ? 'Update day' : 'Add day'}</button></div>
            </div>
          </section>
          <section>
            <h3>Resource details</h3>
            <label className={styles.field}>Name<input value={name} onChange={event => setName(event.target.value)} /></label>
            <div className={styles.swatches}>{RESOURCE_COLORS.map(option => <button key={option.value} type="button" title={option.label} aria-label={option.label} className={color === option.value ? styles.swatchOn : ''} style={{ background: option.value }} onClick={() => setColor(option.value)} />)}</div>
            <label className={styles.check}><input type="checkbox" checked={unavailable} onChange={event => setUnavailable(event.target.checked)} /> Mark resource unavailable</label>
            <button className={styles.secondary} onClick={saveDetails} disabled={saving}>Save resource details</button>
          </section>
          <section>
            <div className={styles.sectionHead}><div><h3>Blocked schedules</h3><p>Blocks subtract time from otherwise available days.</p></div><button className={styles.primary} onClick={() => setBlockEditor(null)}>Add block</button></div>
            {blocks.length ? <div className={styles.blockList}>{blocks.map(block => <button key={block.id} onClick={() => setBlockEditor(block)}><strong>{timeInput(block.start_time)}-{timeInput(block.end_time)}</strong><span>{block.reason || 'Blocked'}</span><small>{parsedDates(block.dates).length} date{parsedDates(block.dates).length === 1 ? '' : 's'}</small></button>)}</div> : <p className={styles.empty}>No blocked schedules.</p>}
          </section>
          {loading && <p className={styles.help}>Loading schedule...</p>}
          {error && <p className={styles.error}>{error}</p>}
        </div>
      </aside>
      {bulkOpen && <BulkHoursPanel branch={branch} groomer={groomer} onClose={() => setBulkOpen(false)} onSaved={nestedSaved} />}
      {blockEditor !== undefined && <BlockEditor branch={branch} groomer={groomer} block={blockEditor} onClose={() => setBlockEditor(undefined)} onSaved={nestedSaved} />}
    </div>
  )
}
