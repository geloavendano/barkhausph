import { useState, useEffect } from 'react'
import { sbGet, sbPost, sbPatch } from '../../lib/supabase'
import styles from './ResourcesPage.module.css'

const COLORS = ['#4D96B9','#EF9F27','#1D9E75','#D4537E','#9B95E8','#D85A30','#639922','#888780']

const ROOM_TYPE_OPTS = [
  { key:'large_cage',   label:'Large Cage' },
  { key:'medium_cage',  label:'Medium Cage' },
  { key:'small_cage',   label:'Small Cage' },
  { key:'single_cabin', label:'Cat Cabin' },
  { key:'villa',        label:'Cat Villa' },
]

const PET_SIZES = [
  { key:'small_dog',  label:'Small Dog' },
  { key:'medium_dog', label:'Medium Dog' },
  { key:'large_dog',  label:'Large Dog' },
  { key:'giant_dog',  label:'Giant Dog' },
  { key:'cat',        label:'Cat' },
]

const TABS = [
  { key:'rooms',    label:'Rooms',    icon:'🏠', singular:'room' },
  { key:'groomers', label:'Groomers', icon:'✂️',  singular:'groomer' },
  { key:'studios',  label:'Studios',  icon:'📸', singular:'studio' },
]

// ── Main page ───────────────────────────────────────────────────────────────
export default function ResourcesPage({ branches, currentBranchIdx = 0, onChanged }) {
  const [tab,     setTab]    = useState('rooms')
  const [rooms,   setRooms]  = useState([])
  const [groomers,setGrms]   = useState([])
  const [studios, setSdts]   = useState([])
  const [loading, setLoading]= useState(true)
  const [panel,   setPanel]  = useState(null) // { type, item }

  const branch = branches?.[currentBranchIdx]

  useEffect(() => { if (branch?.id) loadAll() }, [branch?.id]) // eslint-disable-line

  async function loadAll() {
    if (!branch?.id) return
    setLoading(true)
    try {
      const [r, g, s] = await Promise.all([
        sbGet('rooms',    `branch_id=eq.${branch.id}&active=eq.true&select=*&order=sort_order`),
        sbGet('groomers', `branch_id=eq.${branch.id}&active=eq.true&select=*&order=sort_order`),
        sbGet('studios',  `branch_id=eq.${branch.id}&active=eq.true&select=*&order=sort_order`),
      ])
      setRooms(r ?? [])
      setGrms(g ?? [])
      setSdts(s ?? [])
    } catch { /* non-fatal */ }
    setLoading(false)
  }

  async function handleSaved() {
    setPanel(null)
    await loadAll()
    onChanged?.()
  }

  const curTab  = TABS.find(t => t.key === tab)
  const curList = tab === 'rooms' ? rooms : tab === 'groomers' ? groomers : studios
  const counts  = { rooms: rooms.length, groomers: groomers.length, studios: studios.length }

  return (
    <div className={styles.page}>
      {/* ── Tab bar ── */}
      <div className={styles.tabs}>
        {TABS.map(t => (
          <button key={t.key}
            className={`${styles.tab} ${tab === t.key ? styles.tabOn : ''}`}
            onClick={() => setTab(t.key)}>
            <span className={styles.tabIcon}>{t.icon}</span>
            <span>{t.label}</span>
            <span className={styles.tabCt}>{counts[t.key]}</span>
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className={styles.body}>
        {loading ? (
          <div className={styles.loading}>Loading…</div>
        ) : curList.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>{curTab.icon}</div>
            <div className={styles.emptyMsg}>No {tab} added yet</div>
            <div className={styles.emptyHint}>Tap the button below to add your first {curTab.singular}.</div>
          </div>
        ) : (
          <div className={styles.list}>
            {curList.map(item => (
              <ResourceCard key={item.id} item={item} type={curTab.singular}
                onEdit={() => setPanel({ type: curTab.singular, item })} />
            ))}
          </div>
        )}

        <button className={styles.addBtn}
          onClick={() => setPanel({ type: curTab.singular, item: null })}>
          + Add {curTab.singular}
        </button>
      </div>

      {/* ── Add / Edit panel ── */}
      {panel && (
        <ResourcePanel
          type={panel.type}
          item={panel.item}
          branch={branch}
          onClose={() => setPanel(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}

// ── Resource card ───────────────────────────────────────────────────────────
function ResourceCard({ item, type, onEdit }) {
  const unavailable = item.is_locked || item.is_unavailable
  const reason      = item.lock_reason || item.unavailable_reason
  const sub = type === 'room'
    ? (ROOM_TYPE_OPTS.find(r => r.key === item.room_type)?.label ?? item.room_type ?? '')
    : (unavailable ? (reason ?? 'Unavailable') : 'Active')

  return (
    <div className={`${styles.card} ${unavailable ? styles.cardOff : ''}`}>
      <span className={styles.cardDot} style={{ background: item.color }} />
      <div className={styles.cardMeta}>
        <div className={styles.cardName}>{item.name}</div>
        {sub && (
          <div className={styles.cardSub}>
            {unavailable && <span className={styles.warnDot}>⚠</span>}
            {sub}
          </div>
        )}
      </div>
      <button className={styles.editBtn} onClick={onEdit} title="Edit">✎</button>
    </div>
  )
}

// ── Add/Edit panel ──────────────────────────────────────────────────────────
function ResourcePanel({ type, item, branch, onClose, onSaved }) {
  const isEdit = !!item
  const table  = type === 'room' ? 'rooms' : type === 'groomer' ? 'groomers' : 'studios'
  const label  = type === 'room' ? 'Room'  : type === 'groomer' ? 'Groomer'  : 'Studio'

  const [name,      setName]     = useState(item?.name ?? '')
  const [color,     setColor]    = useState(item?.color ?? (type === 'studio' ? '#D4537E' : COLORS[0]))
  const [roomType,  setRmType]   = useState(item?.room_type ?? 'large_cage')
  const [petType,   setPetType]  = useState(item?.pet_type  ?? 'dog')
  const [sizes,     setSizes]    = useState(item?.allowed_sizes ?? [])
  const [locked,    setLocked]   = useState(item?.is_locked ?? false)
  const [lockRsn,   setLockRsn]  = useState(item?.lock_reason ?? '')
  const [unavail,   setUnavail]  = useState(item?.is_unavailable ?? false)
  const [unavailRsn,setUnavailRsn] = useState(item?.unavailable_reason ?? '')
  const [notes,     setNotes]    = useState(item?.schedule_restrictions?.notes ?? '')
  const [saving,    setSaving]   = useState(false)
  const [err,       setErr]      = useState('')

  function toggleSize(k) {
    setSizes(s => s.includes(k) ? s.filter(x => x !== k) : [...s, k])
  }

  async function handleSave() {
    if (!name.trim()) { setErr('Name is required.'); return }
    setErr(''); setSaving(true)
    try {
      const sr = notes.trim() ? { notes: notes.trim() } : {}
      const payload = { name: name.trim(), color, branch_id: branch.id, schedule_restrictions: sr }

      if (type === 'room') {
        Object.assign(payload, { room_type: roomType, pet_type: petType, allowed_sizes: sizes })
        if (isEdit) Object.assign(payload, { is_locked: locked, lock_reason: lockRsn.trim() || null })
      } else if (isEdit) {
        Object.assign(payload, { is_unavailable: unavail, unavailable_reason: unavailRsn.trim() || null })
      }

      if (isEdit) await sbPatch(table, `id=eq.${item.id}`, payload)
      else        await sbPost(table, payload)
      await onSaved()
    } catch (e) { setErr(e.message); setSaving(false) }
  }

  async function handleRemove() {
    if (!confirm(`Remove this ${label.toLowerCase()}? It will no longer appear in bookings.`)) return
    setSaving(true)
    try { await sbPatch(table, `id=eq.${item.id}`, { active: false }); await onSaved() }
    catch (e) { setErr(e.message); setSaving(false) }
  }

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.panel}>
        {/* Head */}
        <div className={styles.panelHead}>
          <span className={styles.panelTitle}>{isEdit ? `Edit ${label}` : `Add ${label}`}</span>
          <button className={styles.panelClose} onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div className={styles.panelBody}>

          {/* Name */}
          <div className={styles.fg}>
            <label className={styles.fl}>Name <span className={styles.req}>*</span></label>
            <input className={styles.inp} value={name} onChange={e => setName(e.target.value)}
              placeholder={`e.g. ${label} 1`} autoFocus />
          </div>

          {/* Color */}
          <div className={styles.fg}>
            <label className={styles.fl}>Color</label>
            <div className={styles.colorRow}>
              {COLORS.map(c => (
                <div key={c}
                  className={`${styles.swatch} ${color === c ? styles.swatchOn : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)} />
              ))}
            </div>
          </div>

          {/* ── Room-only fields ── */}
          {type === 'room' && <>
            <div className={styles.fg}>
              <label className={styles.fl}>Room type</label>
              <select className={styles.sel} value={roomType} onChange={e => setRmType(e.target.value)}>
                {ROOM_TYPE_OPTS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </div>

            <div className={styles.fg}>
              <label className={styles.fl}>Pet type</label>
              <select className={styles.sel} value={petType} onChange={e => setPetType(e.target.value)}>
                <option value="dog">Dog</option>
                <option value="cat">Cat</option>
                <option value="both">Both</option>
              </select>
            </div>

            <div className={styles.fg}>
              <label className={styles.fl}>Allowed sizes</label>
              <div className={styles.sizeGrid}>
                {PET_SIZES.map(s => (
                  <button key={s.key} type="button"
                    className={`${styles.szBtn} ${sizes.includes(s.key) ? styles.szOn : ''}`}
                    onClick={() => toggleSize(s.key)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {isEdit && <>
              <div className={styles.toggleRow}>
                <span className={styles.toggleLbl}>Locked / temporarily unavailable</span>
                <div className={`${styles.toggle} ${locked ? styles.toggleOn : ''}`}
                  onClick={() => setLocked(l => !l)} />
              </div>
              {locked && (
                <div className={styles.fg}>
                  <label className={styles.fl}>Lock reason</label>
                  <input className={styles.inp} value={lockRsn} onChange={e => setLockRsn(e.target.value)}
                    placeholder="e.g. Under maintenance" />
                </div>
              )}
            </>}
          </>}

          {/* ── Groomer / Studio availability (edit only) ── */}
          {(type === 'groomer' || type === 'studio') && isEdit && <>
            <div className={styles.toggleRow}>
              <span className={styles.toggleLbl}>Mark as unavailable</span>
              <div className={`${styles.toggle} ${unavail ? styles.toggleOn : ''}`}
                onClick={() => setUnavail(u => !u)} />
            </div>
            {unavail && (
              <div className={styles.fg}>
                <label className={styles.fl}>Reason</label>
                <input className={styles.inp} value={unavailRsn} onChange={e => setUnavailRsn(e.target.value)}
                  placeholder="e.g. On leave" />
              </div>
            )}
          </>}

          {/* Notes */}
          <div className={styles.fg}>
            <label className={styles.fl}>Notes (optional)</label>
            <textarea className={styles.ta} value={notes} onChange={e => setNotes(e.target.value)}
              rows={2} placeholder="Internal notes" />
          </div>

          {err && <div className={styles.errMsg}>{err}</div>}
        </div>

        {/* Footer */}
        <div className={styles.panelFoot}>
          {isEdit && (
            <button className={styles.removeBtn} onClick={handleRemove} disabled={saving}>
              Remove
            </button>
          )}
          <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : `Add ${label}`}
          </button>
        </div>
      </div>
    </div>
  )
}
