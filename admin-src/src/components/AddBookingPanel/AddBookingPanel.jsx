import { useState, useEffect, useCallback, useRef } from 'react'
import { sbGet, sbPost, sbPatch, sbDelete, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../lib/supabase'
import { supabase } from '../../lib/supabase'
import { parsePricing, emptyPricing, calcBase, calcLate, calcTotal, calcNights, calcHotelBreakdown, hotelSizeKey, DEFAULT_ADDONS } from '../../lib/pricing'
import styles from './AddBookingPanel.module.css'

// ── Constants ─────────────────────────────────────────────────────────────
const GROOM_SVCS = [
  { k:'bath_dry', n:'Bath and Dry',  d:'30 min' },
  { k:'basic',    n:'Basic Groom',   d:'1 hr'   },
  { k:'premium',  n:'Premium Groom', d:'2 hrs'  },
  { k:'ala_carte',n:'Ala Carte',     d:'varies' },
]
const ADDON_COMPAT = { bath_dry:null, basic:['face_trim','antitick','whitening','demat','deshed'], premium:['face_trim','antitick','whitening','demat','deshed'], ala_carte:null }
const BK_SIZES     = ['small_dog','medium_dog','large_dog','giant_dog','cat']
const SIZE_LBL     = { small_dog:'Small dog', medium_dog:'Medium dog', large_dog:'Large dog', giant_dog:'Giant dog', cat:'Cat' }
const ROOM_TYPES   = { small_cage:'Small Cage', medium_cage:'Medium Cage', large_cage:'Large Cage', single_cabin:'Cat Cabin', villa:'Cat Villa' }
const GROOM_SLOTS  = ['9:00 AM','10:00 AM','11:00 AM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM']
const STUDIO_SLOTS = ['10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM','7:00 PM','8:00 PM','9:00 PM']
const STEP_NAMES   = ['Service','Schedule','Pet','Owner','Details','Summary']
const PICK_OPTS    = [[14,'On or before 2PM'],[15,'3PM'],[16,'4PM'],[17,'5PM'],[18,'6PM'],[19,'7PM'],[20,'8PM']]
const SVC_COLORS   = { grooming:'#4D96B9', hotel:'#EF9F27', daycare:'#1D9E75', studio:'#D4537E' }

// ── Build booking_charges rows for admin-created / admin-edited bookings ──
// Addons are already tracked in booking_addons; this covers the remaining line items.
// No convenience_fee for admin bookings (no PayMongo).
function buildAdminCharges(bookingId, bk, pricing, base, disc, late) {
  const charges = []
  let i = 0

  // For grooming, calcBase returns package + addons combined.
  // Subtract addons so the base_service charge is the package price only.
  const addonTotal = bk.svc === 'grooming'
    ? Object.keys(bk.addons).reduce((sum, k) => {
        const a = pricing.addons.find(x => x.key === k)
        if (!a || a.assessment) return sum
        if (k === 'face_trim' && bk.gsvc === 'premium') return sum // included in premium
        return sum + (a.sizeDependent ? (pricing.faceTrim[bk.size] ?? 0) : a.price)
      }, 0)
    : 0

  const baseServiceAmt = Math.max(0, base - addonTotal)
  // For hotel: base = nightly rates (calcHotel), late is always separate — no overlap.

  const svcName = bk.svc === 'grooming'
    ? (() => { const g = GROOM_SVCS.find(x => x.k === bk.gsvc); return g ? `Grooming – ${g.n}` : 'Grooming' })()
    : ({ hotel: 'Pet Hotel Stay', daycare: 'Daycare', studio: 'Studio Session' }[bk.svc] ?? 'Service')

  if (baseServiceAmt > 0) charges.push({ booking_id: bookingId, sort_order: i++, type: 'base_service',    label: svcName,          amount: baseServiceAmt })
  if (late > 0)           charges.push({ booking_id: bookingId, sort_order: i++, type: 'late_pickup',     label: 'Late pickup fee', amount: late })
  if (disc > 0)           charges.push({ booking_id: bookingId, sort_order: i++, type: 'member_discount', label: 'Member discount', amount: disc })
  return charges
}

function mkBk(branchId) {
  return {
    svc:'grooming', branch: branchId ?? '',
    // grooming
    size:'small_dog', gsvc:'basic', stylist:'any', stylistId:null,
    gdate:'', gslot:'', addons:{}, gnotes:'',
    // hotel
    hcin:'', hcout:'', hroom:'', hroom_id:null, hroom_type:'',
    hdrop:'10:00', hpickHour:14, hplay:false,
    hfeed:'', hmeds:'', hemerg:'', hemergp:'', hvet:'', hvetc:'', hvetaddr:'',
    // daycare
    dcdate:'', dcdrop:'09:00', dcpick:'17:00', dcopen:false, dcnotes:'',
    // studio
    stdate:'', stslot:'',
    // pet
    pname:'', panimal:'dog', pgender:'male', pbreed:'',
    page:'', pageunit:'years', ptemp:'', pmed:'', vacc:{},
    // owner
    ofirst:'', olast:'', oemail:'', ophone:'', osource:'', owner_id:null,
    // booking
    status:'confirmed', paysts:'unpaid', paymethod:'', payref:'',
    memcode:'', memvalid:false,
    wgen:true, wvacc:true, wmedia:true, anotes:'',
    recby:'Admin', mode:'admin',
  }
}

function fmt(n) { return '₱' + Number(n).toLocaleString() }

// ── Helper components defined OUTSIDE AddBookingPanel ─────────────────────
// If these were defined inside, every parent re-render (e.g. a keystroke)
// would create a new function reference, causing React to unmount/remount
// them and making every input lose focus after one character.

function FG({ label, req, children }) {
  return (
    <div className={styles.fg}>
      {label && <label className={styles.fl}>{label}{req && <span className={styles.req}> *</span>}</label>}
      {children}
    </div>
  )
}
function IBox({ children }) { return <div className={styles.ibox}>{children}</div> }
function SectionHead({ children }) { return <div className={styles.secHead}>{children}</div> }
function Toggle({ label, val, onToggle }) {
  return (
    <div className={styles.toggleRow}>
      <span className={styles.toggleLbl}>{label}</span>
      <div className={`${styles.toggle} ${val ? styles.toggleOn : ''}`} onClick={onToggle} />
    </div>
  )
}
function SRow({ k, v, disc, muted }) {
  return (
    <div className={styles.srow}>
      <span className={styles.srowK}>{k}</span>
      <span className={`${styles.srowV} ${disc ? styles.srowDisc : ''} ${muted ? styles.srowMuted : ''}`}>{v}</span>
    </div>
  )
}
function SzPills({ filter, size, onSize }) {
  const opts = filter ? BK_SIZES.filter(s => filter.includes(s)) : BK_SIZES
  return (
    <div className={styles.pills}>
      {opts.map(s => (
        <button key={s} className={`${styles.pill} ${size === s ? styles.pillOn : ''}`}
          onClick={() => onSize(s)}>{SIZE_LBL[s]}</button>
      ))}
    </div>
  )
}

export default function AddBookingPanel({ branch, rooms, groomers, studios = [], editBooking = null, onClose, onSaved }) {
  const [step,   setStep]   = useState(0)
  const [bk,     setBk]     = useState(() => mkBk(branch?.id))
  const [pricing,setPricing]= useState(emptyPricing())
  const [slots,  setSlots]  = useState(null)       // null=show prompt, []loading, [...]=loaded
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [ownerResults, setOwnerResults] = useState([])
  const [ownerTimer,   setOwnerTimer]   = useState(null)
  const [memMsg, setMemMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState('')
  const isEdit = !!editBooking

  // Load pricing once
  useEffect(() => {
    sbGet('pricing', 'select=category,service_key,size_key,day_type,price')
      .then(rows => setPricing(parsePricing(rows)))
      .catch(() => {})
  }, [])

  // Pre-populate for edit
  useEffect(() => {
    if (!editBooking) { setBk(mkBk(branch?.id)); return }
    const b   = editBooking
    const pet = Array.isArray(b.pets)   ? b.pets[0]   : b.pets   ?? {}
    const own = Array.isArray(b.owners) ? b.owners[0] : b.owners ?? {}
    const gd  = Array.isArray(b.grooming_details) ? b.grooming_details[0] : b.grooming_details
    const hd  = Array.isArray(b.hotel_details)    ? b.hotel_details[0]    : b.hotel_details
    const dd  = Array.isArray(b.daycare_details)  ? b.daycare_details[0]  : b.daycare_details
    const sd  = Array.isArray(b.studio_details)   ? b.studio_details[0]   : b.studio_details
    const addonsArr = Array.isArray(b.booking_addons) ? b.booking_addons : (b.booking_addons ? [b.booking_addons] : [])
    const addonMap = {}
    addonsArr.forEach(a => { addonMap[a.addon_key ?? a.addon_name] = true })
    setBk({
      ...mkBk(branch?.id),
      svc: b.service, status: b.status, paysts: b.payment_status,
      size: pet.size ?? 'small_dog',
      gsvc: gd?.groom_service_key ?? 'basic', stylist: gd?.preferred_stylist ?? 'any',
      stylistId: gd?.groomer_id ?? null,
      gdate: gd?.service_date ?? '', gslot: gd?.timeslot ?? '', gnotes: gd?.special_requests ?? '',
      addons: addonMap,
      hcin: hd?.checkin_date ?? '', hcout: hd?.checkout_date ?? '',
      hroom: hd?.room_type ?? '', hroom_id: hd?.room_id ?? null, hroom_type: hd?.room_type ?? '',
      hdrop: hd?.dropoff_time ?? '10:00', hpickHour: hd?.pickup_hour ?? 14,
      hplay: hd?.playpark_consent ?? false,
      hfeed: hd?.feeding_instructions ?? '', hmeds: hd?.medications ?? '',
      hemerg: hd?.emergency_name ?? '', hemergp: hd?.emergency_phone ?? '',
      hvet: hd?.vet_clinic ?? '', hvetc: hd?.vet_contact ?? '', hvetaddr: hd?.vet_address ?? '',
      dcdate: dd?.service_date ?? '', dcdrop: dd?.dropoff_time ?? '09:00',
      dcpick: dd?.pickup_time ?? '17:00', dcopen: dd?.open_time ?? false,
      dcnotes: dd?.notes ?? '',
      stdate: sd?.service_date ?? '', stslot: sd?.timeslot ?? '',
      pname: pet.name ?? '', panimal: pet.animal_type ?? 'dog',
      pgender: pet.gender ?? 'male', pbreed: pet.breed ?? '',
      page: String(pet.age_value ?? ''), pageunit: pet.age_unit ?? 'years',
      ptemp: pet.temperament ?? '', pmed: pet.medical_notes ?? '',
      ofirst: own.first_name ?? '', olast: own.last_name ?? '',
      oemail: own.email ?? '', ophone: own.mobile ?? '',
      osource: own.referral_source ?? '', owner_id: own.id ?? null,
    })
  }, [editBooking, branch?.id])

  const upd = (key, val) => setBk(prev => ({ ...prev, [key]: val }))
  const updMany = obj => setBk(prev => ({ ...prev, ...obj }))

  // ── Grooming slot loader ──────────────────────────────────────────────────
  const loadSlots = useCallback(async (date, groomerId) => {
    if (!date) { setSlots(null); return }
    setSlotsLoading(true)
    const ALL = ['9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM']
    try {
      // Grooming date now lives in grooming_details.service_date. Query it directly,
      // scoped to this branch + active bookings via an inner embed of the parent.
      const gdRows = await sbGet('grooming_details',
        `select=timeslot,groomer_id,bookings!inner(branch_id,status)` +
        `&service_date=eq.${date}` +
        `&bookings.branch_id=eq.${branch.id}` +
        `&bookings.status=neq.cancelled&bookings.status=neq.rejected`)
      const takenByGroomer = {}
      for (const r of (gdRows ?? [])) {
        const gid = r.groomer_id ?? 'any'
        if (!takenByGroomer[gid]) takenByGroomer[gid] = []
        takenByGroomer[gid].push(r.timeslot)
      }
      const disabled = new Set()
      for (const slot of ALL) {
        if (groomerId && groomerId !== 'any') {
          if ((takenByGroomer[groomerId] ?? []).includes(slot)) disabled.add(slot)
        } else {
          const free = groomers.filter(g => !(takenByGroomer[g.id] ?? []).includes(slot))
          if (!free.length) disabled.add(slot)
        }
      }
      setSlots(ALL.map(s => ({ s, taken: disabled.has(s) })))
    } catch { setSlots(ALL.map(s => ({ s, taken: false }))) }
    setSlotsLoading(false)
  }, [branch?.id, groomers])

  // ── Owner search ──────────────────────────────────────────────────────────
  function ownerSearch(q) {
    clearTimeout(ownerTimer)
    if (!q || q.length < 3) { setOwnerResults([]); return }
    setOwnerTimer(setTimeout(async () => {
      try {
        const enc = encodeURIComponent(q.trim())
        const rows = await sbGet('owners',
          `select=id,first_name,last_name,email,mobile,referral_source&or=(email.ilike.*${enc}*,mobile.ilike.*${enc}*)&limit=5`)
        setOwnerResults(rows ?? [])
      } catch { setOwnerResults([]) }
    }, 350))
  }

  function selectOwner(r) {
    updMany({ ofirst: r.first_name ?? '', olast: r.last_name ?? '', oemail: r.email ?? '',
      ophone: r.mobile ?? '', osource: r.referral_source ?? '', owner_id: r.id })
    setOwnerResults([])
  }

  // ── Member validation ─────────────────────────────────────────────────────
  async function applyMember() {
    if (bk.memvalid) { updMany({ memvalid:false, memcode:'' }); setMemMsg(''); return }
    const code = bk.memcode.trim().toUpperCase()
    if (!code) return
    setMemMsg('Checking…')
    try {
      const rows = await sbGet('members',
        `member_code=eq.${encodeURIComponent(code)}&select=member_code,tier,active,valid_until,branch_id&limit=1`)
      const m = rows?.[0]
      if (!m?.active) { setMemMsg('Member code not found or inactive.'); return }
      if (m.valid_until && new Date(m.valid_until) < new Date()) {
        setMemMsg(`Membership expired (valid until ${m.valid_until}).`); return
      }
      if (m.tier !== 'passport' && m.branch_id && m.branch_id !== branch?.id) {
        setMemMsg('This membership belongs to another branch.'); return
      }
      updMany({ memvalid: true, memcode: code })
      const pct = Math.round((pricing.disc[bk.svc] ?? 0) * 100)
      setMemMsg(pct ? `${pct}% member discount applied ✓` : 'Member verified ✓')
    } catch (e) { setMemMsg('Could not verify: ' + e.message) }
  }

  // ── Validation ────────────────────────────────────────────────────────────
  function validate(s) {
    if (s === 0) return true // Service always valid
    if (s === 1) {
      if (bk.svc === 'grooming') {
        if (!bk.gdate) return alert('Enter a grooming date.'), false
        if (!bk.gslot) return alert('Select a time slot.'), false
        if (bk.gsvc === 'ala_carte' && !Object.keys(bk.addons).length)
          return alert('Select at least one add-on for Ala Carte.'), false
      }
      if (bk.svc === 'hotel') {
        if (!bk.hcin || !bk.hcout) return alert('Enter check-in and check-out dates.'), false
        if (calcNights(bk) < 1) return alert('Check-out must be after check-in.'), false
      }
      if (bk.svc === 'daycare' && !bk.dcdate) return alert('Enter a daycare date.'), false
      if (bk.svc === 'studio'  && (!bk.stdate || !bk.stslot)) return alert('Enter a date and slot.'), false
    }
    if (s === 2 && !bk.pname.trim()) return alert('Enter the pet\'s name.'), false
    if (s === 3) {
      if (!bk.ofirst.trim() || !bk.olast.trim()) return alert('Enter the owner\'s first and last name.'), false
      if (!bk.ophone.trim()) return alert('Enter the owner\'s mobile number.'), false
    }
    return true
  }

  function next() { if (validate(step)) setStep(s => Math.min(s + 1, STEP_NAMES.length - 1)) }
  function back() { setStep(s => Math.max(s - 1, 0)) }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function save() {
    if (!pricing.loaded) return alert('Pricing not loaded yet. Please wait a moment.')
    setSaving(true); setErr('')
    const vaccNames = bk.panimal === 'cat'
      ? ['Anti-rabies','All-in-1 shot','Anti-parasitic']
      : ['Anti-rabies','5/6/8-in-1 shot','Kennel Cough / Bordetella','Tick and flea treatment']
    const { base, disc, late, subtotal, total } = calcTotal(bk, pricing)
    const payMethodDb = bk.paymethod ? bk.paymethod.toLowerCase().replace(/ \/ /g,'_').replace(/ /g,'_') : ''

    try {
      if (isEdit) {
        // ── EDIT: direct PATCH calls ──
        const b = editBooking
        const pet = Array.isArray(b.pets) ? b.pets[0] : b.pets ?? {}
        const own = Array.isArray(b.owners) ? b.owners[0] : b.owners ?? {}
        // booking_date is the creation date — left untouched here. The service
        // date is edited on the service detail table below.
        await sbPatch('bookings', `id=eq.${b.id}`, {
          status: bk.status, payment_status: bk.paysts,
          subtotal: subtotal, discount_amount: disc, total,
        })
        // Refresh booking_charges — preserve convenience_fee (online bookings), replace the rest
        await sbDelete('booking_charges', `booking_id=eq.${b.id}&type=neq.convenience_fee`)
        const updatedCharges = buildAdminCharges(b.id, bk, pricing, base, disc, late)
        if (updatedCharges.length > 0) await sbPost('booking_charges', updatedCharges)

        if (pet.id) await sbPatch('pets', `id=eq.${pet.id}`, {
          name: bk.pname.trim(), animal_type: bk.panimal, gender: bk.pgender,
          breed: bk.pbreed||null, age_value: bk.page ? parseInt(bk.page) : null,
          age_unit: bk.pageunit||'years', size: bk.size||null,
          medical_notes: bk.pmed||null, temperament: bk.ptemp||null,
        })
        if (own.id) await sbPatch('owners', `id=eq.${own.id}`, {
          first_name: bk.ofirst.trim(), last_name: bk.olast.trim(),
          email: bk.oemail.trim()||null, mobile: bk.ophone.trim(),
          referral_source: bk.osource||null,
        })
        if (bk.svc==='grooming') {
          const gsvc = GROOM_SVCS.find(x => x.k === bk.gsvc)
          await sbPatch('grooming_details', `booking_id=eq.${b.id}`, {
            service_date: bk.gdate||null,
            timeslot: bk.gslot, preferred_stylist: bk.stylist||'any',
            groomer_id: bk.stylistId||null, groom_service_key: bk.gsvc||'basic',
            groom_service_name: gsvc?.n || '', special_requests: bk.gnotes||null,
          })
          await sbDelete('booking_addons', `booking_id=eq.${b.id}`)
          const addonRows = Object.keys(bk.addons).map(k => {
            const a = DEFAULT_ADDONS.find(x => x.key === k)
            return { booking_id: b.id, addon_key: k, addon_name: a?.name??k,
              price: a ? (a.sizeDependent ? (pricing.faceTrim[bk.size]??0) : a.price) : 0 }
          })
          if (addonRows.length) await sbPost('booking_addons', addonRows)
        }
        if (bk.svc==='hotel') await sbPatch('hotel_details', `booking_id=eq.${b.id}`, {
          checkin_date: bk.hcin, checkout_date: bk.hcout,
          dropoff_time: bk.hdrop||null, pickup_time: `${bk.hpickHour}:00`,
          pickup_hour: parseInt(bk.hpickHour)||14, room_type: bk.hroom||null,
          room_id: bk.hroom_id||null, playpark_consent: bk.hplay,
          feeding_instructions: bk.hfeed||null, medications: bk.hmeds||null,
          emergency_name: bk.hemerg||null, emergency_phone: bk.hemergp||null,
          vet_clinic: bk.hvet||null, vet_contact: bk.hvetc||null, vet_address: bk.hvetaddr||null,
        })
        if (bk.svc==='daycare') await sbPatch('daycare_details', `booking_id=eq.${b.id}`, {
          service_date: bk.dcdate||null,
          dropoff_time: bk.dcdrop||'', pickup_time: bk.dcopen ? null : (bk.dcpick||null),
          open_time: bk.dcopen, notes: bk.dcnotes||null,
        })
        if (bk.svc==='studio') await sbPatch('studio_details', `booking_id=eq.${b.id}`, { service_date: bk.stdate||null, timeslot: bk.stslot||'' })

        await sbDelete('pet_vaccines', `booking_id=eq.${b.id}`)
        const vaccRows = Object.keys(bk.vacc).map(i => ({
          booking_id: b.id, vaccine_name: vaccNames[parseInt(i)], confirmed: bk.vacc[i]
        })).filter(r => r.vaccine_name)
        if (vaccRows.length) await sbPost('pet_vaccines', vaccRows)

        if (bk.paysts !== 'unpaid' && payMethodDb) {
          await sbPost('payments', { booking_id: b.id, amount: total, type: 'balance',
            method: payMethodDb, reference_number: bk.payref||null, recorded_by: bk.recby })
        }
        await sbPost('booking_edits', {
          booking_id: b.id, edited_by_name: bk.recby,
          field_changes: JSON.stringify({ admin_edit: true }),
        })
        onSaved?.()
        onClose()
        alert('Booking updated.')

      } else {
        // ── CREATE: edge function ──
        const location = (() => {
          const n = (branch?.name ?? '').toLowerCase()
          if (n.includes('eastwood')) return 'eastwood'
          return 'estancia'
        })()
        const addonsPayload = Object.keys(bk.addons).reduce((acc, k) => {
          const a = DEFAULT_ADDONS.find(x => x.key === k)
          if (a && !a.assessment) acc[k] = a.sizeDependent ? (pricing.faceTrim[bk.size]??0) : a.price
          return acc
        }, {})
        const vaccPayload = Object.keys(bk.vacc).reduce((acc, i) => {
          if (vaccNames[parseInt(i)]) acc[vaccNames[parseInt(i)]] = bk.vacc[i]
          return acc
        }, {})
        const payload = {
          location, service: bk.svc,
          petName: bk.pname, petAnimal: bk.panimal, petGender: bk.pgender,
          petBreed: bk.pbreed, petAge: bk.page, petAgeUnit: bk.pageunit,
          petSize: bk.size, petMedical: bk.pmed, petTemperament: bk.ptemp,
          ownerFirst: bk.ofirst, ownerLast: bk.olast,
          ownerEmail: bk.oemail, ownerPhone: bk.ophone, ownerSource: bk.osource,
          groomDate: bk.gdate, groomSlot: bk.gslot, groomService: bk.gsvc,
          preferredStylist: bk.stylist,
          hotelCheckin: bk.hcin, hotelCheckout: bk.hcout,
          hotelRoom: bk.hroom, hotelRoomId: bk.hroom_id,
          hotelDropoff: bk.hdrop, hotelPickup: `${bk.hpickHour}:00`,
          hotelPickupHour: parseInt(bk.hpickHour)||14,
          playparkConsent: bk.hplay ? 'yes' : 'no',
          hotelFeeding: bk.hfeed, hotelMeds: bk.hmeds,
          emergencyName: bk.hemerg, emergencyPhone: bk.hemergp,
          vetClinic: bk.hvet, vetContact: bk.hvetc, vetAddress: bk.hvetaddr,
          daycareDate: bk.dcdate, daycareDropoff: bk.dcdrop, daycarePickup: bk.dcpick,
          daycareOpenTime: bk.dcopen, daycareNotes: bk.dcnotes||null,
          studioDate: bk.stdate, studioSlot: bk.stslot,
          addons: addonsPayload, vaccines: vaccPayload,
          waiverGeneral: bk.wgen, waiverVaccine: bk.wvacc,
          waiverSeniorMedical: false, waiverStudio: false, waiverMedia: bk.wmedia,
          membershipId: bk.memvalid ? bk.memcode : null,
          subtotal: subtotal, discountAmount: disc, total,
          adminCreated: true, booking_source: bk.mode || 'admin',
        }
        const { data: sess } = await supabase.auth.getSession()
        const token = sess?.session?.access_token ?? SUPABASE_ANON_KEY
        const res  = await fetch(`${SUPABASE_URL}/functions/v1/submit-booking`, {
          method: 'POST',
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error)
        if (data.booking_id) {
          await sbPatch('bookings', `id=eq.${data.booking_id}`, {
            status: bk.status, payment_status: bk.paysts, booking_source: bk.mode||'admin' })
          if (bk.paysts !== 'unpaid' && payMethodDb) {
            await sbPost('payments', { booking_id: data.booking_id, amount: total, type: 'downpayment',
              method: payMethodDb, reference_number: bk.payref||null, recorded_by: bk.recby })
          }
          const newCharges = buildAdminCharges(data.booking_id, bk, pricing, base, disc, late)
          if (newCharges.length > 0) await sbPost('booking_charges', newCharges)
        }
        onSaved?.()
        onClose()
        alert(`Booking created: ${data.ref_number || 'done'}`)
      }
    } catch (e) {
      setErr('Failed: ' + e.message)
      setSaving(false)
    }
  }

  // ── Step renderers ────────────────────────────────────────────────────────

  // ── Step renderers (called as functions, not JSX components, so React never
  // compares their references and no input loses focus on re-render) ──────────

  function StepService() {
    const svcs = [
      { k:'grooming', icon:'✂️', label:'Grooming',  color:'#4D96B9' },
      { k:'hotel',    icon:'🏠', label:'Pet Hotel', color:'#EF9F27' },
      { k:'daycare',  icon:'🌞', label:'Daycare',   color:'#1D9E75' },
      { k:'studio',   icon:'📷', label:'Studio',    color:'#D4537E' },
    ].filter(s => s.k !== 'studio' || studios.length > 0)
    return (
      <div className={styles.svcGrid}>
        {svcs.map(s => (
          <div key={s.k} className={`${styles.svcCard} ${bk.svc === s.k ? styles.svcOn : ''}`}
            style={{ borderColor: bk.svc === s.k ? s.color : undefined }}
            onClick={() => updMany({ svc: s.k, addons: {} })}>
            <span className={styles.svcIcon}>{s.icon}</span>
            <span className={styles.svcLbl}>{s.label}</span>
          </div>
        ))}
      </div>
    )
  }

  function StepGrooming() {
    return (
      <>
        <FG label="Pet size" req><SzPills size={bk.size} onSize={s => upd('size', s)} /></FG>

        <FG label="Grooming service" req>
          <div className={styles.gsvcGrid}>
            {GROOM_SVCS.map(sv => {
              const pr = sv.k === 'ala_carte' ? 'Add-ons only' : fmt((pricing.groom[sv.k]?.[bk.size]) ?? 0)
              return (
                <div key={sv.k}
                  className={`${styles.gsvcCard} ${bk.gsvc === sv.k ? styles.gsvcOn : ''}`}
                  onClick={() => updMany({ gsvc: sv.k, addons: {} })}>
                  <div>
                    <div className={styles.gsvcName}>{sv.n}</div>
                    <div className={styles.gsvcDur}>{sv.d}</div>
                  </div>
                  <div className={styles.gsvcPrice}>{pr}</div>
                </div>
              )
            })}
          </div>
        </FG>

        <FG label="Add-ons">
          {bk.gsvc === 'ala_carte' && <IBox>Ala Carte: at least one add-on required.</IBox>}
          <div className={styles.addonGrid}>
            {DEFAULT_ADDONS.map(a => {
              const compat = ADDON_COMPAT[bk.gsvc]
              const enabled = !compat || compat.includes(a.key)
              const isPremFT = a.key === 'face_trim' && bk.gsvc === 'premium'
              const on = !!bk.addons[a.key]
              const pr = isPremFT ? 'included' : a.assessment ? 'Assessment'
                : a.sizeDependent ? fmt(pricing.faceTrim[bk.size] ?? 0) : fmt(a.price)
              return (
                <div key={a.key}
                  className={`${styles.acard} ${on ? styles.acardOn : ''} ${!enabled || isPremFT ? styles.acardDis : ''}`}
                  onClick={() => {
                    if (!enabled || isPremFT) return
                    const next = { ...bk.addons }
                    if (next[a.key]) delete next[a.key]; else next[a.key] = true
                    upd('addons', next)
                  }}>
                  <div className={styles.acardName}>{a.name}</div>
                  <div className={styles.acardPrice}>{pr}</div>
                </div>
              )
            })}
          </div>
        </FG>

        <div className={styles.twoCol}>
          <FG label="Groomer">
            <select className={styles.sel} value={bk.stylistId ?? 'any'}
              onChange={e => {
                const g = groomers.find(x => x.id === e.target.value)
                updMany({ stylistId: g?.id ?? null, stylist: g?.name ?? 'any' })
                if (bk.gdate) loadSlots(bk.gdate, e.target.value)
              }}>
              <option value="any">Any available</option>
              {groomers.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </FG>
          <FG label="Date" req>
            <input type="date" className={styles.inp} value={bk.gdate}
              onChange={e => { upd('gdate', e.target.value); loadSlots(e.target.value, bk.stylistId ?? 'any') }} />
          </FG>
        </div>

        <FG label="Time slot" req>
          {slotsLoading && <p className={styles.hint}>Loading slots…</p>}
          {!slotsLoading && slots === null && <p className={styles.hint}>Select a date to see available slots.</p>}
          {!slotsLoading && slots !== null && (
            <div className={styles.slotGrid}>
              {slots.map(({ s, taken }) => (
                <button key={s}
                  className={`${styles.slot} ${bk.gslot === s ? styles.slotOn : ''} ${taken ? styles.slotTaken : ''}`}
                  disabled={taken} onClick={() => upd('gslot', s)}>{s}</button>
              ))}
            </div>
          )}
        </FG>

        <FG label="Special requests">
          <textarea className={styles.ta} value={bk.gnotes} onChange={e => upd('gnotes', e.target.value)}
            placeholder="Any specific requests…" rows={2} />
        </FG>
      </>
    )
  }

  function StepHotel() {
    const nights = calcNights(bk)
    const hotelEst = nights > 0 ? fmt(calcLate(bk, pricing) > 0 ? (calcLate(bk,pricing)+calcNights(bk)) : 0) : null
    return (
      <>
        <FG label="Pet size" req>
          <SzPills filter={['small_dog','medium_dog','large_dog','cat']} size={bk.size} onSize={s => upd('size', s)} />
        </FG>
        <div className={styles.twoCol}>
          <FG label="Check-in" req>
            <input type="date" className={styles.inp} value={bk.hcin}
              onChange={e => updMany({ hcin: e.target.value })} />
          </FG>
          <FG label="Check-out" req>
            <input type="date" className={styles.inp} value={bk.hcout}
              onChange={e => updMany({ hcout: e.target.value })} />
          </FG>
        </div>
        {nights > 0 && (() => {
          const sk      = hotelSizeKey(bk)
          const wdRate  = pricing.hotel['weekday']?.[sk] ?? 0
          const estBase = wdRate * nights
          const late    = calcLate(bk, pricing)
          const basisLbl = bk.size === 'cat'
            ? (bk.hroom_type === 'villa' ? 'Cat Villa rate' : 'Cat Cabin rate')
            : `${SIZE_LBL[bk.size]} rate`
          return (
            <IBox>
              {nights} night{nights !== 1 ? 's' : ''} — est. {fmt(estBase + late)}
              <span style={{ fontSize: 10, opacity: 0.65, marginLeft: 6 }}>({basisLbl}; weekday)</span>
            </IBox>
          )
        })()}
        <FG label="Room" req>
          <select className={styles.sel} value={bk.hroom_id ?? ''}
            onChange={e => {
              const r = rooms.find(x => x.id === e.target.value)
              updMany({ hroom_id: r?.id ?? null, hroom: r?.name ?? '', hroom_type: r?.room_type ?? '' })
            }}>
            <option value="">Select room…</option>
            {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </FG>
        <div className={styles.twoCol}>
          <FG label="Drop-off time">
            <input type="time" className={styles.inp} value={bk.hdrop}
              onChange={e => upd('hdrop', e.target.value)} />
          </FG>
          <FG label="Pick-up time">
            <select className={styles.sel} value={String(bk.hpickHour)}
              onChange={e => upd('hpickHour', parseInt(e.target.value))}>
              {PICK_OPTS.map(([h, l]) => {
                const fee = (pricing.lateRate ?? 0) * (h - 14)
                const lbl = h === 14 ? l : `${l} (+${fmt(fee)})`
                return <option key={h} value={String(h)}>{lbl}</option>
              })}
            </select>
          </FG>
        </div>
        <Toggle label="Play park consent" val={bk.hplay} onToggle={() => upd('hplay', !bk.hplay)} />
      </>
    )
  }

  function StepDaycare() {
    return (
      <>
        <FG label="Pet size" req>
          <SzPills filter={['small_dog','medium_dog','large_dog','cat']} size={bk.size} onSize={s => upd('size', s)} />
        </FG>
        <FG label="Date" req>
          <input type="date" className={styles.inp} value={bk.dcdate}
            onChange={e => upd('dcdate', e.target.value)} />
        </FG>
        <div className={styles.twoCol}>
          <FG label="Drop-off time">
            <input type="time" className={styles.inp} value={bk.dcdrop}
              onChange={e => upd('dcdrop', e.target.value)} />
          </FG>
          <FG label="Pick-up time">
            <input type="time" className={styles.inp} value={bk.dcpick}
              onChange={e => upd('dcpick', e.target.value)} disabled={bk.dcopen} />
          </FG>
        </div>
        <Toggle label="Until open time (last pet out)" val={bk.dcopen} onToggle={() => upd('dcopen', !bk.dcopen)} />
        <FG label="Notes">
          <textarea className={styles.ta} value={bk.dcnotes}
            onChange={e => upd('dcnotes', e.target.value)} rows={2} />
        </FG>
      </>
    )
  }

  function StepStudio() {
    return (
      <>
        <FG label="Date" req>
          <input type="date" className={styles.inp} value={bk.stdate}
            onChange={e => upd('stdate', e.target.value)} />
        </FG>
        <FG label="Time slot" req>
          <div className={styles.slotGrid}>
            {STUDIO_SLOTS.map(s => (
              <button key={s} className={`${styles.slot} ${bk.stslot === s ? styles.slotOn : ''}`}
                onClick={() => upd('stslot', s)}>{s}</button>
            ))}
          </div>
        </FG>
      </>
    )
  }

  function StepPet() {
    const vaccNames = bk.panimal === 'cat'
      ? ['Anti-rabies','All-in-1 shot','Anti-parasitic']
      : ['Anti-rabies','5/6/8-in-1 shot','Kennel Cough / Bordetella','Tick and flea treatment']
    return (
      <>
        <FG label="Pet name" req>
          <input className={styles.inp} value={bk.pname} onChange={e => upd('pname', e.target.value)} placeholder="Buddy" />
        </FG>
        <div className={styles.twoCol}>
          <FG label="Species">
            <div className={styles.pills}>
              {[['dog','🐶 Dog'],['cat','🐱 Cat']].map(([k,l]) => (
                <button key={k} className={`${styles.pill} ${bk.panimal === k ? styles.pillOn : ''}`}
                  onClick={() => upd('panimal', k)}>{l}</button>
              ))}
            </div>
          </FG>
          <FG label="Sex">
            <div className={styles.pills}>
              {[['male','Male'],['female','Female']].map(([k,l]) => (
                <button key={k} className={`${styles.pill} ${bk.pgender === k ? styles.pillOn : ''}`}
                  onClick={() => upd('pgender', k)}>{l}</button>
              ))}
            </div>
          </FG>
        </div>
        <div className={styles.twoCol}>
          <FG label="Breed">
            <input className={styles.inp} value={bk.pbreed} onChange={e => upd('pbreed', e.target.value)} />
          </FG>
          <FG label="Size">
            <select className={styles.sel} value={bk.size} onChange={e => upd('size', e.target.value)}>
              {BK_SIZES.map(s => <option key={s} value={s}>{SIZE_LBL[s]}</option>)}
            </select>
          </FG>
        </div>
        <div className={styles.twoCol}>
          <FG label="Age">
            <input type="number" className={styles.inp} value={bk.page} min="0"
              onChange={e => upd('page', e.target.value)} />
          </FG>
          <FG label="Unit">
            <select className={styles.sel} value={bk.pageunit} onChange={e => upd('pageunit', e.target.value)}>
              <option value="years">Years</option>
              <option value="months">Months</option>
            </select>
          </FG>
        </div>
        <FG label="Temperament">
          <select className={styles.sel} value={bk.ptemp} onChange={e => upd('ptemp', e.target.value)}>
            <option value="">— select —</option>
            {['friendly_all','friendly_shy','selective','first_time','reactive'].map(t => (
              <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </FG>
        <FG label="Medical notes">
          <textarea className={styles.ta} value={bk.pmed} onChange={e => upd('pmed', e.target.value)}
            placeholder="Allergies, conditions, medications…" rows={2} />
        </FG>
        <FG label="Vaccines on file">
          <div className={styles.vaccList}>
            {vaccNames.map((vn, i) => (
              <div key={i} className={styles.vaccRow}>
                <span className={styles.vaccName}>{vn}</span>
                <div className={styles.vaccBtns}>
                  <button className={`${styles.vaccBtn} ${bk.vacc[i] === true  ? styles.vaccY : ''}`}
                    onClick={() => upd('vacc', { ...bk.vacc, [i]: bk.vacc[i] === true ? undefined : true })}>Yes</button>
                  <button className={`${styles.vaccBtn} ${bk.vacc[i] === false ? styles.vaccN : ''}`}
                    onClick={() => upd('vacc', { ...bk.vacc, [i]: bk.vacc[i] === false ? undefined : false })}>No</button>
                </div>
              </div>
            ))}
          </div>
        </FG>
      </>
    )
  }

  function StepOwner() {
    return (
      <>
        <IBox>Search by email or phone to pre-fill existing owner details.</IBox>
        <FG label="Search">
          <input className={styles.inp} placeholder="+63 917 123 4567 or email@…"
            onChange={e => ownerSearch(e.target.value)} />
        </FG>
        {ownerResults.length > 0 && (
          <div className={styles.ownerResults}>
            {ownerResults.map((r, i) => (
              <div key={i} className={styles.ownerRow} onClick={() => selectOwner(r)}>
                <div className={styles.ownerName}>{r.first_name} {r.last_name}</div>
                <div className={styles.ownerSub}>{r.email ?? '—'} · {r.mobile ?? '—'}</div>
              </div>
            ))}
          </div>
        )}
        <div className={styles.divider} />
        <div className={styles.twoCol}>
          <FG label="First name" req>
            <input className={styles.inp} value={bk.ofirst} onChange={e => upd('ofirst', e.target.value)} />
          </FG>
          <FG label="Last name" req>
            <input className={styles.inp} value={bk.olast} onChange={e => upd('olast', e.target.value)} />
          </FG>
        </div>
        <FG label="Email">
          <input type="email" className={styles.inp} value={bk.oemail} onChange={e => upd('oemail', e.target.value)} />
        </FG>
        <FG label="Mobile" req>
          <input type="tel" className={styles.inp} value={bk.ophone} onChange={e => upd('ophone', e.target.value)} placeholder="+63 917 123 4567" />
        </FG>
        <FG label="Referral source">
          <select className={styles.sel} value={bk.osource} onChange={e => upd('osource', e.target.value)}>
            <option value="">Select…</option>
            {['Instagram','Facebook','TikTok','Google search','Friend or family referral','Walk-in / saw the branch'].map(o => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </FG>
      </>
    )
  }

  function StepDetails() {
    return (
      <>
        {bk.svc === 'hotel' && (
          <>
            <SectionHead>Hotel care</SectionHead>
            <FG label="Feeding instructions">
              <textarea className={styles.ta} value={bk.hfeed}
                onChange={e => upd('hfeed', e.target.value)} rows={2} />
            </FG>
            <FG label="Medications / special care">
              <textarea className={styles.ta} value={bk.hmeds}
                onChange={e => upd('hmeds', e.target.value)} rows={2} />
            </FG>
            <SectionHead>Emergency contact</SectionHead>
            <div className={styles.twoCol}>
              <FG label="Name"><input className={styles.inp} value={bk.hemerg} onChange={e => upd('hemerg', e.target.value)} /></FG>
              <FG label="Phone"><input className={styles.inp} value={bk.hemergp} onChange={e => upd('hemergp', e.target.value)} /></FG>
            </div>
            <FG label="Vet clinic"><input className={styles.inp} value={bk.hvet} onChange={e => upd('hvet', e.target.value)} /></FG>
            <div className={styles.twoCol}>
              <FG label="Vet contact"><input className={styles.inp} value={bk.hvetc} onChange={e => upd('hvetc', e.target.value)} /></FG>
              <FG label="Vet address"><input className={styles.inp} value={bk.hvetaddr} onChange={e => upd('hvetaddr', e.target.value)} /></FG>
            </div>
          </>
        )}
        <SectionHead>Waivers</SectionHead>
        {[['wgen','General terms accepted'],['wvacc','Health declaration'],['wmedia','Media consent (photos/videos)']].map(([k,l]) => (
          <Toggle key={k} label={l} val={bk[k]} onToggle={() => upd(k, !bk[k])} />
        ))}
        <FG label="Internal notes" style={{ marginTop: 12 }}>
          <textarea className={styles.ta} value={bk.anotes}
            onChange={e => upd('anotes', e.target.value)} rows={2}
            placeholder="Admin context for the team…" />
        </FG>
      </>
    )
  }

  function StepSummary() {
    const vaccNames = bk.panimal === 'cat'
      ? ['Anti-rabies','All-in-1 shot','Anti-parasitic']
      : ['Anti-rabies','5/6/8-in-1 shot','Kennel Cough / Bordetella','Tick and flea treatment']
    const { base, disc, late, subtotal, total } = calcTotal(bk, pricing)
    const gsvc = GROOM_SVCS.find(x => x.k === bk.gsvc)
    const hasFaceTrimIncluded = bk.svc==='grooming' && bk.gsvc==='premium' && bk.addons['face_trim']
    const hasAssess = bk.svc==='grooming' && Object.keys(bk.addons).some(k => DEFAULT_ADDONS.find(a => a.key===k && a.assessment))

    return (
      <>
        <SectionHead>Booking</SectionHead>
        <SRow k="Service" v={{ grooming:'Grooming', hotel:'Pet Hotel', daycare:'Daycare', studio:'Studio' }[bk.svc]} />
        {bk.svc === 'grooming' && <>
          <SRow k="Service type" v={gsvc?.n} />
          <SRow k="Size" v={SIZE_LBL[bk.size]} />
          <SRow k="Stylist" v={bk.stylist === 'any' ? 'Any available' : bk.stylist} />
          <SRow k="Date & time" v={bk.gdate && bk.gslot ? `${bk.gdate} at ${bk.gslot}` : '—'} />
          {Object.keys(bk.addons).length > 0 && <SRow k="Add-ons" v={Object.keys(bk.addons).map(k => DEFAULT_ADDONS.find(a=>a.key===k)?.name??k).join(', ')} />}
        </>}
        {bk.svc === 'hotel' && <>
          <SRow k="Room" v={bk.hroom || '—'} />
          <SRow k="Check-in" v={bk.hcin || '—'} />
          <SRow k="Check-out" v={bk.hcout || '—'} />
          <SRow k="Nights" v={calcNights(bk) > 0 ? String(calcNights(bk)) : '—'} />
        </>}
        {bk.svc === 'daycare' && <>
          <SRow k="Date" v={bk.dcdate || '—'} />
          <SRow k="Drop-off" v={bk.dcdrop || '—'} />
          <SRow k="Pick-up" v={bk.dcopen ? 'Open time' : (bk.dcpick || '—')} />
        </>}
        {bk.svc === 'studio' && <>
          <SRow k="Date" v={bk.stdate || '—'} />
          <SRow k="Slot" v={bk.stslot || '—'} />
        </>}

        <SectionHead>Pet & owner</SectionHead>
        <SRow k="Pet" v={`${bk.pname || '—'}${bk.pbreed ? ` — ${bk.pbreed}` : ''}`} />
        <SRow k="Owner" v={(bk.ofirst + ' ' + bk.olast).trim() || '—'} />
        <SRow k="Mobile" v={bk.ophone || '—'} />

        <SectionHead>Bill</SectionHead>
        {bk.svc === 'grooming' && <>
          {bk.gsvc !== 'ala_carte' && <SRow k={gsvc?.n ?? 'Base'} v={fmt((pricing.groom[bk.gsvc]?.[bk.size]) ?? 0)} />}
          {Object.keys(bk.addons).map(k => {
            const a = DEFAULT_ADDONS.find(x => x.key === k)
            if (!a) return null
            return <SRow key={k} k={`Add-on — ${a.name}`} v={a.assessment ? 'For assessment' : a.sizeDependent ? fmt(pricing.faceTrim[bk.size]??0) : fmt(a.price)} />
          })}
        </>}
        {bk.svc === 'hotel' && calcNights(bk) > 0 && (() => {
          const bd = calcHotelBreakdown(bk, pricing)
          if (!bd) return null
          return <>
            {bd.weekday.count > 0 && <SRow k={`Weekday (${bd.weekday.count} night${bd.weekday.count !== 1 ? 's' : ''})`} v={fmt(bd.weekday.total)} />}
            {bd.weekend.count > 0 && <SRow k={`Weekend (${bd.weekend.count} night${bd.weekend.count !== 1 ? 's' : ''})`} v={fmt(bd.weekend.total)} />}
            {late > 0 && <SRow k="Late pickup fee" v={fmt(late)} />}
          </>
        })()}
        {bk.svc === 'daycare' && <SRow k="Daycare" v={fmt(pricing.daycare[bk.size] ?? 0)} />}
        {bk.svc === 'studio' && <SRow k="Studio session" v="Set at check-out" muted />}
        {hasAssess && <p className={styles.assessNote}>* Assessment items priced in-store</p>}

        {/* Member code */}
        <div className={styles.memRow}>
          <input className={styles.inp} placeholder="Member code (BH-M001)"
            value={bk.memcode} onChange={e => upd('memcode', e.target.value.toUpperCase())}
            style={{ textTransform:'uppercase', flex:1 }} />
          <button className={styles.memBtn} onClick={applyMember}>
            {bk.memvalid ? 'Remove' : 'Apply'}
          </button>
        </div>
        {memMsg && <p className={`${styles.memMsg} ${bk.memvalid ? styles.memOk : ''}`}>{memMsg}</p>}

        {disc > 0 && <SRow k="Member discount" v={`-${fmt(disc)}`} disc />}
        <div className={styles.totalRow}>
          <span>Total</span>
          <span>{fmt(total)}{hasAssess ? ' + assessment' : bk.svc === 'studio' ? ' (TBD)' : ''}</span>
        </div>

        <SectionHead>Status &amp; payment</SectionHead>
        {bk.mode === 'walkin' && (
          <div className={styles.walkinBadge}>🚶 Walk-in — payment collected in-store.</div>
        )}
        <FG label="Booking status">
          <div className={styles.pills}>
            {[['pending','Pending'],['confirmed','Confirmed'],['checked_in','Checked in']].map(([k,l]) => (
              <button key={k} className={`${styles.pill} ${bk.status === k ? styles.pillOn : ''}`}
                onClick={() => upd('status', k)}>{l}</button>
            ))}
          </div>
        </FG>
        <FG label="Payment status">
          <select className={styles.sel} value={bk.paysts} onChange={e => upd('paysts', e.target.value)}>
            <option value="unpaid">Unpaid</option>
            <option value="partially_paid">Partially paid</option>
            <option value="paid">Paid</option>
          </select>
        </FG>
        {bk.paysts !== 'unpaid' && (
          <div className={styles.twoCol}>
            <FG label="Payment method">
              <select className={styles.sel} value={bk.paymethod} onChange={e => upd('paymethod', e.target.value)}>
                <option value="">Select…</option>
                {['Cash','GCash / QRPH','Credit / debit card','Bank transfer'].map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </FG>
            <FG label="Reference #">
              <input className={styles.inp} placeholder="Optional"
                value={bk.payref} onChange={e => upd('payref', e.target.value)} />
            </FG>
          </div>
        )}
        <FG label={isEdit ? 'Edited by' : 'Recorded by'}>
          <input className={styles.inp} value={bk.recby} onChange={e => upd('recby', e.target.value)} />
        </FG>

        {err && <p className={styles.errMsg}>{err}</p>}
      </>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  // Call step renderers as plain functions (not JSX elements) so React never
  // treats them as component types — no unmount/remount on parent re-renders.
  const stepComponents = [
    StepService(),
    bk.svc === 'grooming' ? StepGrooming() : bk.svc === 'hotel' ? StepHotel() : bk.svc === 'daycare' ? StepDaycare() : StepStudio(),
    StepPet(),
    StepOwner(),
    StepDetails(),
    StepSummary(),
  ]

  const isLast = step === STEP_NAMES.length - 1

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.panel}>
        {/* Header */}
        <div className={styles.head}>
          <div className={styles.headTop}>
            <span className={styles.title}>{isEdit ? 'Edit booking' : bk.mode === 'walkin' ? 'Walk-in Booking' : 'Add Booking'}</span>
            <button className={styles.closeBtn} onClick={onClose}>×</button>
          </div>
          {/* Step bar */}
          <div className={styles.stepBar}>
            {STEP_NAMES.map((n, i) => (
              <div key={i}
                className={`${styles.stepItem} ${i === step ? styles.stepCur : ''} ${i < step ? styles.stepDone : ''}`}
                onClick={() => i < step && setStep(i)}>
                {n}
              </div>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {stepComponents[step]}
        </div>

        {/* Footer */}
        <div className={styles.foot}>
          <button className={styles.btnBack} onClick={step === 0 ? onClose : back}>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {isLast ? (
            <button className={styles.btnSave} onClick={save} disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create booking'}
            </button>
          ) : (
            <button className={styles.btnNext} onClick={next}>Continue →</button>
          )}
        </div>
      </div>
    </div>
  )
}
