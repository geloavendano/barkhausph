import { useState, useEffect } from 'react'
import { supabase, sbGet, sbPatch, sbPost, sbSignedUrl } from '../../lib/supabase'
import {
  STATUS_COLORS, PAY_COLORS, SVC_LABELS, SIZE_LABELS,
  SRC_LABELS, first, fmtDate, fmtTime, hexBg, esc,
} from '../../lib/constants'
import PaymentPanel from './PaymentPanel'
import styles from './BookingDrawer.module.css'

const INTERNAL_OTHER_ROOM_ID = '__internal_other_room__'

export default function BookingDrawer({ booking: b, rooms, groomers, onClose, onUpdated, onEdit }) {
  const [payments,    setPayments]    = useState(null)
  const [charges,     setCharges]     = useState([])
  const [vaccDocs,    setVaccDocs]    = useState([])
  const [payOpen,     setPayOpen]     = useState(false)
  const [saving,      setSaving]      = useState(false)
  const [status,      setStatus]      = useState(b.status ?? 'pending')
  const [payStatus,   setPayStatus]   = useState(b.payment_status ?? 'unpaid')
  const [ciOpen,      setCiOpen]      = useState(false)
  const [invOpen,     setInvOpen]     = useState(false)
  const [invVal,      setInvVal]      = useState('')
  const [savingInv,   setSavingInv]   = useState(false)
  const [err,         setErr]         = useState('')
  const [docUrls,     setDocUrls]     = useState({})
  const [receiptUrls, setReceiptUrls] = useState({})

  const pet    = first(b.pets)    ?? {}
  const owner  = first(b.owners)  ?? {}
  const gd     = first(b.grooming_details)
  const hd     = first(b.hotel_details)
  const dd     = first(b.daycare_details)
  const sd     = first(b.studio_details)
  const cn     = first(b.checkin_notes)
  const addons   = Array.isArray(b.booking_addons) ? b.booking_addons : (b.booking_addons ? [b.booking_addons] : [])
  const vaccines = Array.isArray(b.pet_vaccines)   ? b.pet_vaccines   : (b.pet_vaccines   ? [b.pet_vaccines]   : [])
  const waiver   = first(b.waivers)

  // Pre-select current assignment
  useEffect(() => {
    if (b.service === 'grooming') setInvVal(gd?.groomer_id ?? '')
    else if (b.service === 'hotel') setInvVal(hd?.room_type === 'other' ? INTERNAL_OTHER_ROOM_ID : (hd?.room_id ?? ''))
  }, [b])

  useEffect(() => { loadPayments(); loadCharges(); loadVaccDocs() }, [b.id])

  // Generate 1-hour signed read URLs for vaccine documents whenever they load
  useEffect(() => {
    if (vaccDocs.length === 0) return
    let cancelled = false
    async function loadDocUrls() {
      const urls = {}
      for (const doc of vaccDocs) {
        const signed = await sbSignedUrl('vaccine-docs', doc.file_path, 3600)
        if (signed) urls[doc.file_path] = signed
      }
      if (!cancelled) setDocUrls(urls)
    }
    loadDocUrls()
    return () => { cancelled = true }
  }, [vaccDocs])

  // Sign payment-receipt images (stored in the same private bucket)
  useEffect(() => {
    const paths = (payments ?? []).map(p => p.receipt_path).filter(Boolean)
    if (paths.length === 0) return
    let cancelled = false
    ;(async () => {
      const urls = {}
      for (const path of paths) {
        const signed = await sbSignedUrl('vaccine-docs', path, 3600)
        if (signed) urls[path] = signed
      }
      if (!cancelled) setReceiptUrls(urls)
    })()
    return () => { cancelled = true }
  }, [payments])

  async function loadPayments() {
    try {
      const rows = await sbGet('payments', `select=*&booking_id=eq.${b.id}&order=created_at`)
      setPayments(rows ?? [])
    } catch { setPayments([]) }
  }

  async function loadCharges() {
    try {
      const rows = await sbGet('booking_charges', `select=sort_order,type,label,amount&booking_id=eq.${b.id}&order=sort_order`)
      setCharges(rows ?? [])
    } catch { setCharges([]) }
  }

  async function loadVaccDocs() {
    try {
      const rows = await sbGet('vaccine_documents', `select=id,file_path,file_name&booking_id=eq.${b.id}`)
      setVaccDocs(rows ?? [])
    } catch { setVaccDocs([]) }
  }

  async function saveStatus() {
    if (status === 'checked_in') {
      if (b.service === 'grooming' && (!gd?.groomer_id)) {
        setErr('Assign a specific groomer before checking in.'); return
      }
      if (b.service === 'hotel' && (!hd?.room_id && hd?.room_type !== 'other')) {
        setErr('Assign a room before checking in.'); return
      }
    }
    setSaving(true); setErr('')
    try {
      await sbPatch('bookings', `id=eq.${b.id}`, { status, payment_status: payStatus })
      onUpdated()
      onClose()
    } catch (e) { setErr(e.message); setSaving(false) }
  }

  async function saveInventory() {
    setSavingInv(true); setErr('')
    try {
      const val = invVal || null
      if (b.service === 'grooming') {
        const groomerName = val ? (groomers.find(g => g.id === val)?.name ?? 'any') : 'any'
        await sbPatch('grooming_details', `booking_id=eq.${b.id}`, { groomer_id: val, preferred_stylist: groomerName })
      } else {
        if (val === INTERNAL_OTHER_ROOM_ID) {
          await sbPatch('hotel_details', `booking_id=eq.${b.id}`, { room_id: null, room_type: 'other' })
        } else {
          const room = rooms?.find(r => r.id === val)
          await sbPatch('hotel_details', `booking_id=eq.${b.id}`, { room_id: val, room_type: room?.room_type ?? hd?.room_type ?? null })
        }
      }
      onUpdated()
      onClose()
    } catch (e) { setErr(e.message) }
    finally { setSavingInv(false) }
  }

  // Time string
  let timeStr = ''
  if (gd)      timeStr = (gd.service_date ? gd.service_date + ' · ' : '') + (gd.timeslot ?? '')
  else if (hd) timeStr = (hd.checkin_date ?? '') + ' to ' + (hd.checkout_date ?? '')
  else if (dd) timeStr = (dd.service_date ? dd.service_date + ' · ' : '') + (dd.dropoff_time ?? '') + (dd.open_time ? ' to open' : (' to ' + (dd.pickup_time ?? '')))
  else if (sd) timeStr = (sd.service_date ? sd.service_date + ' · ' : '') + (sd.timeslot ?? '')

  const bookedAt = b.created_at ? (() => {
    const d = new Date(b.created_at)
    return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
           d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true })
  })() : null

  // Inventory assignment display
  const hasInventory = b.service === 'grooming' || b.service === 'hotel'
  const invLabel     = b.service === 'grooming' ? 'Groomer' : 'Room'
  let assignedName   = 'Unassigned', assignedColor = 'var(--mid)', isUnassigned = true
  if (b.service === 'grooming') {
    if (gd?.groomer_id) {
      const gr = groomers?.find(x => x.id === gd.groomer_id)
      assignedName = gr?.name ?? 'Unknown'; assignedColor = gr?.color ?? 'var(--mid)'; isUnassigned = false
    } else assignedName = 'Any available'
  } else if (b.service === 'hotel') {
    if (hd?.room_type === 'other') {
      assignedName = 'Other'; assignedColor = '#888780'; isUnassigned = false
    } else if (hd?.room_id) {
      const rm = rooms?.find(x => x.id === hd.room_id)
      assignedName = rm?.name ?? 'Unknown'; assignedColor = rm?.color ?? 'var(--mid)'; isUnassigned = false
    }
  }

  return (
    <>
      <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()} />
      <div className={styles.drawer}>
        <div className={styles.handle} />

        {/* ── Header ── */}
        <div className={styles.scrollBody}>
          <div className={styles.refRow}>
            <p className={styles.ref}>{b.ref_number ?? ''}</p>
            {onEdit && (
              <button className={styles.editBtn} onClick={() => onEdit(b)}>✏ Edit booking</button>
            )}
          </div>
          {bookedAt && <p className={styles.meta}>Booked {bookedAt}</p>}
          {b.booking_source && <p className={styles.meta}>{SRC_LABELS[b.booking_source] ?? b.booking_source}</p>}

          <p className={styles.petName}>
            {pet.name ?? 'Pet'} {pet.animal_type === 'cat' ? '🐱' : '🐶'}
            {b.discount_amount > 0 && <span className={styles.memberStar}>★</span>}
          </p>
          <p className={styles.breed}>
            {[pet.breed, pet.size ? SIZE_LABELS[pet.size] : null].filter(Boolean).join(' · ')}
          </p>
          {(pet.gender || pet.age_value) && (
            <p className={styles.meta}>
              {[pet.gender ? pet.gender.charAt(0).toUpperCase() + pet.gender.slice(1) : null,
                pet.age_value ? `${pet.age_value} ${pet.age_unit ?? ''}`.trim() : null
              ].filter(Boolean).join(' · ')}
            </p>
          )}

          {/* Status pills */}
          <div className={styles.statusRow}>
            <span className={styles.timeStr}>{timeStr}</span>
            <span className={styles.pill} style={{ background: hexBg(STATUS_COLORS[b.status] ?? '#888'), color: STATUS_COLORS[b.status] ?? '#888' }}>
              {(b.status ?? '').replace('_', ' ')}
            </span>
            <span className={styles.pill} style={{ background: hexBg(PAY_COLORS[b.payment_status ?? 'unpaid']), color: PAY_COLORS[b.payment_status ?? 'unpaid'] }}>
              {(b.payment_status ?? 'unpaid').replace('_', ' ')}
            </span>
          </div>

          {/* Medical */}
          {pet.medical_notes && (
            <div className={styles.medical}>
              <p className={styles.medLabel}>Medical notes</p>
              <p className={styles.medText}>{pet.medical_notes}</p>
            </div>
          )}

          {/* Temperament + vaccines */}
          {(pet.temperament || vaccines.length > 0) && (
            <div className={styles.sec}>
              <div className={styles.tags}>
                {pet.temperament && <span className={styles.tag}>{pet.temperament.replace(/_/g, ' ')}</span>}
              </div>
              {vaccines.length > 0 && (
                <div className={styles.vaccRow}>
                  {vaccines.map((v, i) => (
                    <span key={i} className={styles.vacc} style={{ color: v.confirmed ? 'var(--success)' : 'var(--error)' }}>
                      {v.confirmed ? '✓' : '✕'} {v.vaccine_name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Waivers */}
          {waiver && <WaiverSection waiver={waiver} service={b.service} hd={hd} />}

          {/* Service details */}
          <Section title={SVC_LABELS[b.service] ?? b.service}>
            <ServiceRows b={b} gd={gd} hd={hd} dd={dd} sd={sd} addons={addons} rooms={rooms} />
          </Section>

          {/* Inventory assignment */}
          {hasInventory && (
            <Section title={invLabel} action={<SmallBtn onClick={() => setInvOpen(o => !o)}>Assign</SmallBtn>}>
              <div className={styles.invRow}>
                {!isUnassigned && <span className={styles.invDot} style={{ background: assignedColor }} />}
                <span style={{ color: isUnassigned ? 'var(--mid)' : 'var(--cream)', fontWeight: isUnassigned ? 400 : 600 }}>
                  {assignedName}
                </span>
                {isUnassigned && <span className={styles.unassignedBadge}>Unassigned</span>}
              </div>
              {invOpen && (
                <div className={styles.invForm}>
                  <select className="fi" style={{ marginBottom: 8 }} value={invVal} onChange={e => setInvVal(e.target.value)}>
                    {b.service === 'grooming' ? (
                      <>
                        <option value="">Any available</option>
                        {(groomers ?? []).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </>
                    ) : (
                      <>
                        <option value="">Unassigned</option>
                        {(rooms ?? []).filter(r => r.active !== false).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </>
                    )}
                  </select>
                  <button className="btn-primary" onClick={saveInventory} disabled={savingInv} style={{ width: '100%' }}>
                    {savingInv ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            </Section>
          )}

          {/* Owner */}
          <Section title="Owner">
            <div className={styles.ownerRow}>
              <div>
                <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--cream)' }}>
                  {[owner.first_name, owner.last_name].filter(Boolean).join(' ')}
                </p>
                <p style={{ fontSize: 12, color: 'var(--cream-m)' }}>{owner.mobile ?? ''}</p>
                {owner.email && <p style={{ fontSize: 11, color: 'var(--mid)' }}>{owner.email}</p>}
                {owner.referral_source && <p style={{ fontSize: 10, color: 'var(--mid)' }}>via {owner.referral_source}</p>}
              </div>
              {owner.mobile && (
                <a href={`tel:${owner.mobile}`} className={styles.callBtn}>Call</a>
              )}
            </div>
          </Section>

          {/* Emergency (hotel) */}
          {hd && (hd.emergency_name || hd.vet_clinic) && (
            <Section title="Emergency">
              {hd.emergency_name && <DR label="Contact" value={hd.emergency_name + (hd.emergency_phone ? ' / ' + hd.emergency_phone : '')} />}
              {hd.vet_clinic     && <DR label="Vet"     value={hd.vet_clinic} />}
              {hd.vet_contact    && <DR label="Vet contact" value={hd.vet_contact} />}
              {hd.vet_address    && <DR label="Vet address" value={hd.vet_address} />}
            </Section>
          )}

          {/* Vaccine documents */}
          {vaccDocs.length > 0 && (
            <Section title="Vaccine documents">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {vaccDocs.map((doc, i) => {
                  const url = docUrls[doc.file_path]
                  const name = doc.file_name || `Document ${i + 1}`
                  const ext  = doc.file_path?.split('.').pop()?.toLowerCase() ?? ''
                  const isImg = ['jpg','jpeg','png','webp','heic','heif'].includes(ext)
                  return (
                    <div key={doc.id ?? i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {url && isImg
                        ? <a href={url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
                            <img src={url} alt={name} style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
                            <span style={{ fontSize: 12, color: 'var(--cream-m)' }}>{name}</span>
                          </a>
                        : url
                          ? <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--blue)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                              📄 {name}
                            </a>
                          : <span style={{ fontSize: 12, color: 'var(--mid)' }}>⏳ {name}</span>
                      }
                    </div>
                  )
                })}
              </div>
            </Section>
          )}

          {/* Bill */}
          {b.total > 0 && (
            <Section title="Bill">
              <BillRows b={b} addons={addons} charges={charges} />
            </Section>
          )}

          {/* Payments */}
          <Section title="Payments" action={<SmallBtn onClick={() => setPayOpen(true)}>+ Record</SmallBtn>}>
            {payments === null
              ? <p className={styles.muted}>Loading…</p>
              : payments.length === 0
                ? <p className={styles.muted}>No payments recorded.</p>
                : payments.map(p => <PayRow key={p.id} pay={p} receiptUrl={p.receipt_path ? receiptUrls[p.receipt_path] : null} />)
            }
          </Section>

          {/* Admin notes */}
          {b.notes && (
            <Section title="Admin notes">
              <p style={{ fontSize: 13, color: 'var(--cream)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{b.notes}</p>
            </Section>
          )}

          {/* Check-in notes */}
          <Section title="Check-in notes" action={<SmallBtn onClick={() => setCiOpen(o => !o)}>{cn ? 'Edit' : '+ Add'}</SmallBtn>}>
            {cn && <CheckInSummary cn={cn} />}
            {ciOpen && <CheckInForm booking={b} onSaved={() => { onUpdated(); onClose() }} />}
          </Section>

        </div>

        {/* ── Sticky footer ── */}
        <div className={styles.stickyFooter}>
          <div className={styles.stickySelects}>
            <select className="fi" value={status} onChange={e => setStatus(e.target.value)}>
              {['pending','confirmed','checked_in','completed','cancelled'].map(s =>
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              )}
            </select>
            <select className="fi" value={payStatus} onChange={e => setPayStatus(e.target.value)}>
              {['unpaid','partially_paid','paid','refunded'].map(s =>
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              )}
            </select>
          </div>
          {err && <p className={styles.err}>{err}</p>}
          <div className={styles.stickyBtns}>
            <button className={styles.doneBtn} onClick={onClose}>Done</button>
            <button className={styles.updateBtn} onClick={saveStatus} disabled={saving}>
              {saving ? 'Saving…' : 'Update'}
            </button>
          </div>
        </div>
      </div>

      {payOpen && (
        <PaymentPanel
          booking={b}
          bookingId={b.id}
          onClose={() => setPayOpen(false)}
          onSaved={onUpdated}
        />
      )}
    </>
  )
}

/* ── Sub-components ───────────────────────────────────────────── */

function Section({ title, action, children }) {
  return (
    <div className={styles.sec}>
      <div className={styles.secHeader}>
        <p className={styles.secTitle}>{title}</p>
        {action}
      </div>
      {children}
    </div>
  )
}

function DR({ label, value }) {
  if (!value) return null
  return (
    <div className={styles.dr}>
      <span className={styles.drKey}>{label}</span>
      <span className={styles.drVal}>{value}</span>
    </div>
  )
}

function SmallBtn({ onClick, children }) {
  return (
    <button className={styles.smallBtn} onClick={onClick}>{children}</button>
  )
}

function ServiceRows({ b, gd, hd, dd, sd, addons, rooms }) {
  if (gd) return (
    <>
      {gd.service_date && <DR label="Date" value={gd.service_date} />}
      <DR label="Time"    value={gd.timeslot} />
      <DR label="Service" value={gd.groom_service_name} />
      <DR label="Stylist" value={gd.preferred_stylist} />
      {addons.length > 0 && <DR label="Add-ons" value={addons.map(a => a.addon_name).join(', ')} />}
      {gd.special_requests && <DR label="Notes" value={gd.special_requests} />}
    </>
  )
  if (hd) {
    const rm      = rooms?.find(r => r.id === hd.room_id)
    const cinStr  = fmtDate(hd.checkin_date)  + (hd.dropoff_time ? ' · ' + fmtTime(hd.dropoff_time) : '')
    const coutStr = fmtDate(hd.checkout_date) + (hd.pickup_time  ? ' · ' + fmtTime(hd.pickup_time) : '')
    return (
      <>
        <DR label="Room"       value={hd.room_type === 'other' ? 'Other' : (rm?.name ?? hd.room_type ?? '-')} />
        <DR label="Check-in"  value={cinStr} />
        <DR label="Check-out" value={coutStr} />
        <DR label="Play park" value={hd.playpark_consent ? 'Yes' : 'No'} />
        {hd.feeding_instructions && <DR label="Feeding"    value={hd.feeding_instructions} />}
        {hd.medications           && <DR label="Medications" value={hd.medications} />}
      </>
    )
  }
  if (dd) return (
    <>
      {dd.service_date && <DR label="Date" value={dd.service_date} />}
      <DR label="Drop-off" value={dd.dropoff_time} />
      <DR label="Pick-up"  value={dd.open_time ? 'Open time' : dd.pickup_time} />
      <DR label="Duration" value={dd.hours_total ? dd.hours_total + 'h' : '-'} />
      {dd.notes && <DR label="Notes" value={dd.notes} />}
    </>
  )
  if (sd) return (
    <>
      {sd.service_date && <DR label="Date" value={sd.service_date} />}
      <DR label="Slot" value={sd.timeslot} />
    </>
  )
  return <p className={styles.muted}>Details not recorded.</p>
}

function BillRows({ b, addons, charges }) {
  const totalAmt = b.total ?? b.subtotal ?? 0

  // ── New path: use booking_charges (accurate, structured) ──
  // Formula: subtotal = base_service + addons + late_pickup
  //          discount applies to subtotal
  //          total   = subtotal − discount + convenience_fee
  if (charges && charges.length > 0) {
    const sorted       = [...charges].sort((a, z) => (a.sort_order ?? 0) - (z.sort_order ?? 0))
    // Per-night hotel charges (new format) or single base_service (old format)
    const nightCharges = sorted.filter(c => c.type === 'hotel_weekday' || c.type === 'hotel_weekend')
    const base         = sorted.find(c => c.type === 'base_service')
    const late         = sorted.find(c => c.type === 'late_pickup')
    const disc         = sorted.find(c => c.type === 'member_discount')
    const convCharge   = sorted.find(c => c.type === 'convenience_fee')
    const serviceAmt   = nightCharges.length > 0
      ? nightCharges.reduce((s, c) => s + (c.amount ?? 0), 0)
      : (base?.amount ?? 0)
    const subtotalAmt  = serviceAmt
      + addons.reduce((s, a) => s + (a.price ?? 0), 0)
      + (late?.amount ?? 0)
    const convAmt      = convCharge?.amount ?? Math.max(0, totalAmt - subtotalAmt + (disc?.amount ?? 0))
    const hasDeductions = (disc?.amount > 0) || (convAmt > 0)
    return (
      <>
        {/* Per-night breakdown (new bookings) or lump base service (old backfilled bookings) */}
        {nightCharges.length > 0
          ? nightCharges.map((c, i) => <DR key={i} label={c.label} value={`₱${(c.amount ?? 0).toLocaleString()}`} />)
          : base && base.amount > 0 && <DR label={base.label} value={`₱${base.amount.toLocaleString()}`} />
        }
        {addons.map((a, i) => <DR key={i} label={`Add-on — ${a.addon_name}`} value={`₱${(a.price ?? 0).toLocaleString()}`} />)}
        {late && late.amount > 0 && <DR label="Late pickup fee" value={`₱${late.amount.toLocaleString()}`} />}
        {hasDeductions && (
          <div className={styles.dr} style={{ borderTop: '0.5px solid var(--border)', marginTop: 4, paddingTop: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--mid)' }}>Subtotal</span>
            <span style={{ fontSize: 11, color: 'var(--mid)' }}>₱{subtotalAmt.toLocaleString()}</span>
          </div>
        )}
        {disc && disc.amount > 0 && (
          <div className={styles.dr}>
            <span className={styles.drKey}>Member discount</span>
            <span style={{ color: 'var(--success)' }}>−₱{disc.amount.toLocaleString()}</span>
          </div>
        )}
        {convAmt > 0 && <DR label="Convenience fee" value={`₱${convAmt.toLocaleString()}`} />}
        <div className={styles.dr} style={{ borderTop: '0.5px solid var(--border)', marginTop: 4, paddingTop: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--cream)' }}>Total</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--cream)' }}>₱{totalAmt.toLocaleString()}</span>
        </div>
      </>
    )
  }

  // ── Fallback: older bookings without booking_charges ──
  // For online bookings: subtotal already includes late, so the gap vs total is the convenience fee.
  // For admin bookings:  late was added on top of subtotal (pre-Step-3 fix), so the gap is late fee.
  const isOnline    = b.booking_source === 'online'
  const addonTotal  = addons.reduce((s, a) => s + (a.price ?? 0), 0)
  const discAmt     = b.discount_amount ?? 0
  const gap         = Math.max(0, (b.total ?? 0) + discAmt - (b.subtotal ?? 0))
  const lateAmt     = isOnline ? 0    : gap   // admin: gap is late fee
  const convFee     = isOnline ? gap  : 0     // online: gap is convenience fee
  const subtotalAmt = (b.total ?? 0) + discAmt - convFee   // = base + addons + late
  const baseAmt     = Math.max(0, (b.subtotal ?? 0) - addonTotal)
  const hasDeductions = discAmt > 0 || convFee > 0
  const svcLabel    = { grooming: 'Grooming service', hotel: 'Hotel stay', daycare: 'Daycare', studio: 'Studio session' }[b.service] ?? 'Service'
  return (
    <>
      {baseAmt > 0 && <DR label={svcLabel} value={`₱${baseAmt.toLocaleString()}`} />}
      {addons.map((a, i) => <DR key={i} label={`Add-on — ${a.addon_name}`} value={`₱${(a.price ?? 0).toLocaleString()}`} />)}
      {lateAmt > 0 && <DR label="Late pickup fee" value={`₱${lateAmt.toLocaleString()}`} />}
      {hasDeductions && (
        <div className={styles.dr} style={{ borderTop: '0.5px solid var(--border)', marginTop: 4, paddingTop: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--mid)' }}>Subtotal</span>
          <span style={{ fontSize: 11, color: 'var(--mid)' }}>₱{subtotalAmt.toLocaleString()}</span>
        </div>
      )}
      {discAmt > 0 && (
        <div className={styles.dr}>
          <span className={styles.drKey}>Member discount</span>
          <span style={{ color: 'var(--success)' }}>−₱{discAmt.toLocaleString()}</span>
        </div>
      )}
      {convFee > 0 && <DR label="Convenience fee" value={`₱${convFee.toLocaleString()}`} />}
      <div className={styles.dr} style={{ borderTop: '0.5px solid var(--border)', marginTop: 4, paddingTop: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--cream)' }}>Total</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--cream)' }}>₱{totalAmt.toLocaleString()}</span>
      </div>
    </>
  )
}

const BANK_LABELS = {
  gcash: 'GCash',
  bpi: 'BPI',
  bdo: 'BDO',
  transfer: 'Bank transfer',
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  manual_online: 'Manual online',
}

function PayRow({ pay, receiptUrl }) {
  const isRefund = pay.type === 'refund'
  const methodLabel = BANK_LABELS[pay.method] ?? (pay.method ?? '').replace(/_/g, ' ')
  return (
    <div className={styles.payRow} style={{ alignItems: 'flex-start' }}>
      <div style={{ flex: 1 }}>
        <p className={styles.payAmt}>{isRefund ? '−' : ''}₱{(pay.amount ?? 0).toLocaleString()}</p>
        <p className={styles.payMeta}>
          {pay.type.replace(/_/g, ' ')} · {methodLabel}
          {pay.reference_number ? ` · ${pay.reference_number}` : ''}
        </p>
        {pay.notes && <p className={styles.payMeta}>{pay.notes}</p>}
        {pay.receipt_path && (
          receiptUrl
            ? <a href={receiptUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 6 }}>
                <img src={receiptUrl} alt="Transfer receipt"
                  style={{ maxWidth: 120, maxHeight: 150, borderRadius: 6, border: '0.5px solid var(--border)' }} />
              </a>
            : <span style={{ fontSize: 11, color: 'var(--mid)' }}>⏳ loading receipt…</span>
        )}
      </div>
      <p className={styles.payDate}>{new Date(pay.created_at).toLocaleDateString()}</p>
    </div>
  )
}

function WaiverSection({ waiver: wr, service, hd }) {
  const items = [
    { label: 'General terms',          val: wr.general_terms },
    { label: 'Health declaration',     val: wr.health_declaration },
    { label: 'Media consent (photos)', val: wr.media_consent },
  ]
  if (service === 'studio') items.push({ label: 'Studio usage agreement', val: wr.studio_agreement })
  if (wr.senior_medical_waiver != null) items.push({ label: 'Senior / medical waiver', val: wr.senior_medical_waiver })
  if (service === 'hotel') items.push({ label: 'Play park consent', val: hd?.playpark_consent ?? null })

  const signedAt = wr.signed_at ? (() => {
    try { return new Date(wr.signed_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) }
    catch { return wr.signed_at }
  })() : null

  return (
    <div className={styles.sec}>
      <div className={styles.secHeader}>
        <p className={styles.secTitle}>
          Waivers &amp; consent
          {signedAt && <span className={styles.signedAt}>signed {signedAt}</span>}
        </p>
      </div>
      {items.map((w, i) => {
        const color = w.val === true ? 'var(--success)' : w.val === false ? 'var(--error)' : 'var(--mid)'
        const icon  = w.val === true ? '✓' : w.val === false ? '✕' : '—'
        return (
          <div key={i} className={styles.waiverItem}>
            <span style={{ color, fontWeight: 700, width: 16, textAlign: 'center', flexShrink: 0 }}>{icon}</span>
            <span style={{ color: w.val == null ? 'var(--mid)' : 'var(--cream-m)', fontSize: 12 }}>{w.label}</span>
          </div>
        )
      })}
      {wr.media_consent === false && (
        <p className={styles.waiverWarn}>⚠ No photo/video consent — do not post this pet.</p>
      )}
      {service === 'hotel' && hd?.playpark_consent === false && (
        <p className={styles.waiverWarn}>⚠ No playpark consent — keep in room only.</p>
      )}
    </div>
  )
}

function CheckInSummary({ cn }) {
  const rows = []
  if (cn.general_remarks)          rows.push(['Remarks',    cn.general_remarks])
  if (cn.addon_purchases)          rows.push(['Add-ons',    cn.addon_purchases])
  if (cn.physical_inspection_notes) rows.push(['Inspection', cn.physical_inspection_notes])
  if (cn.personal_items)           rows.push(['Items',      cn.personal_items])
  const checks = [['Vaccination', cn.vacc_complete], ['Skin & coat', cn.skin_coat_good],
                  ['Eyes/ears', cn.ears_nose_eyes_good], ['Nails', cn.nails_good], ['Joints', cn.joints_good]]
  checks.forEach(([label, val]) => { if (val !== null && val !== undefined) rows.push([label, val ? 'Pass' : 'Fail']) })
  return rows.map(([label, val], i) => (
    <div key={i} className={styles.dr}>
      <span className={styles.drKey}>{label}</span>
      <span style={{ color: val === 'Fail' ? 'var(--error)' : 'var(--cream)' }}>{val}</span>
    </div>
  ))
}

function CheckInForm({ booking: b, onSaved }) {
  const cn  = first(b.checkin_notes) ?? {}
  const svc = b.service
  const [vals, setVals] = useState({
    general_remarks: cn.general_remarks ?? '',
    addon_purchases: cn.addon_purchases ?? '',
    physical_inspection_notes: cn.physical_inspection_notes ?? '',
    personal_items:  cn.personal_items ?? '',
    vacc_complete:   cn.vacc_complete  ?? null,
    skin_coat_good:  cn.skin_coat_good ?? null,
    ears_nose_eyes_good: cn.ears_nose_eyes_good ?? null,
    nails_good:      cn.nails_good     ?? null,
    joints_good:     cn.joints_good    ?? null,
  })
  const [saving, setSaving] = useState(false)

  function setYN(key, val) { setVals(v => ({ ...v, [key]: val })) }
  function ta(label, key) {
    return (
      <div className="fg" key={key}>
        <label className="fl">{label}</label>
        <textarea className="fi" style={{ resize: 'vertical', minHeight: 60 }}
          value={vals[key] ?? ''} onChange={e => setVals(v => ({ ...v, [key]: e.target.value }))} />
      </div>
    )
  }

  async function save() {
    setSaving(true)
    try {
      const payload = { booking_id: b.id, service: svc, ...vals }
      if (cn.booking_id) await sbPatch('checkin_notes', `booking_id=eq.${b.id}`, payload)
      else await sbPost('checkin_notes', payload)
      onSaved()
    } catch (err) { alert('Failed: ' + err.message) }
    setSaving(false)
  }

  return (
    <div className={styles.ciForm}>
      {svc === 'hotel'   && [ta('Physical inspection', 'physical_inspection_notes'), ta('Personal items', 'personal_items'), ta('Add-on purchases', 'addon_purchases')]}
      {svc === 'daycare' && [ta('Remarks', 'general_remarks'), ta('Add-on purchases', 'addon_purchases')]}
      {svc === 'grooming' && (
        <>
          {ta('Remarks', 'general_remarks')}
          {[
            ['Vaccination complete', 'vacc_complete'],
            ['Skin & coat OK',       'skin_coat_good'],
            ['Ears/nose/eyes OK',    'ears_nose_eyes_good'],
            ['Nails OK',             'nails_good'],
            ['Joints OK',            'joints_good'],
          ].map(([label, key]) => (
            <div key={key} className={styles.ynRow}>
              <span className={styles.ynLabel}>{label}</span>
              <div className={styles.ynBtns}>
                <button className={`${styles.ynBtn} ${vals[key] === true ? styles.ynY : ''}`}  onClick={() => setYN(key, true)}>Yes</button>
                <button className={`${styles.ynBtn} ${vals[key] === false ? styles.ynN : ''}`} onClick={() => setYN(key, false)}>No</button>
              </div>
            </div>
          ))}
        </>
      )}
      <button className="btn-primary" style={{ width: '100%', marginTop: 8 }} onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save notes'}
      </button>
    </div>
  )
}
