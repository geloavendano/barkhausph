import { useState, useRef } from 'react'
import { sbGet, sbUpsert } from '../../lib/supabase'
import styles from './MembersPage.module.css'

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

export default function MembersPage({ branches }) {
  return (
    <div className={styles.page}>
      <h2 className={styles.title}>Members</h2>
      <div className={styles.grid}>
        <ValidateCard branches={branches} />
        <CsvUploadCard branches={branches} />
      </div>
    </div>
  )
}

/* ── Validate in-store card ─────────────────────────────────────── */
function ValidateCard({ branches }) {
  const [code, setCode] = useState('')
  const [pet,  setPet]  = useState('')
  const [status, setStatus] = useState(null) // { ok, html } | null
  const [loading, setLoading] = useState(false)

  async function validate() {
    const c = code.trim().toUpperCase()
    const p = pet.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!c) { setStatus({ ok: false, text: 'Please enter a member code.' }); return }

    setLoading(true)
    setStatus(null)
    try {
      const rows = await sbGet(
        'members',
        `member_code=eq.${encodeURIComponent(c)}&select=member_code,tier,pet_name,valid_until,branch_id,active&limit=1`
      )
      if (!rows?.length) {
        setStatus({ ok: false, text: '✗ Member code not found.' }); return
      }
      const m = rows[0]
      if (!m.active) {
        setStatus({ ok: false, text: '✗ Membership is inactive.' }); return
      }
      if (m.valid_until && new Date(m.valid_until) < new Date()) {
        const expFmt = new Date(m.valid_until + 'T00:00:00').toLocaleDateString('en-PH', {
          year: 'numeric', month: 'long', day: 'numeric',
        })
        setStatus({ ok: false, text: `✗ Membership expired on ${expFmt}.` }); return
      }
      const regPet = (m.pet_name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
      if (p && regPet && regPet !== p) {
        setStatus({ ok: false, text: '✗ Pet name does not match records.' }); return
      }

      const isPassport = m.tier === 'passport'
      const branchObj  = m.branch_id ? branches?.find(b => b.id === m.branch_id) : null
      const branchName = isPassport
        ? 'All Branches'
        : (branchObj?.name ?? (m.branch_id ? 'Unknown branch' : '⚠ No branch assigned'))
      // Tier label spells out the branch for Standard memberships
      const tierLabel  = isPassport ? 'Passport' : `Standard · ${branchName}`
      const validStr = m.valid_until
        ? 'Valid until ' + new Date(m.valid_until + 'T00:00:00').toLocaleDateString('en-PH', {
            year: 'numeric', month: 'long', day: 'numeric',
          })
        : 'No expiry set'

      setStatus({ ok: true, tierLabel, branchName, validStr, petName: m.pet_name })
    } catch (err) {
      setStatus({ ok: false, text: `Error: ${err.message}` })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.card}>
      <p className={styles.cardLabel}>Validate In-Store Membership</p>

      <div className="fg">
        <label className="fl">Member Code</label>
        <input
          className="fi"
          placeholder="e.g. BH-M001"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && validate()}
        />
      </div>
      <div className="fg">
        <label className="fl">Pet Name</label>
        <input
          className="fi"
          placeholder="e.g. Max"
          value={pet}
          onChange={e => setPet(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && validate()}
        />
      </div>

      <button className="btn-primary" style={{ width: '100%' }} onClick={validate} disabled={loading}>
        {loading ? 'Validating…' : 'Validate'}
      </button>

      {status && (
        status.ok ? (
          <div className={styles.resultOk}>
            <div className={styles.resultOkHeader}>
              <span>✓ Valid Member</span>
              <span className={styles.tier}>{status.tierLabel}</span>
            </div>
            <div className={styles.resultRows}>
              <Row label="Coverage" value={status.branchName} />
              <Row label="Validity" value={status.validStr} />
              {status.petName && <Row label="Pet" value={status.petName} />}
            </div>
          </div>
        ) : (
          <p className={styles.resultErr}>{status.text}</p>
        )
      )}
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span>{value}</span>
    </div>
  )
}

/* ── CSV upload card ─────────────────────────────────────────────── */
function CsvUploadCard({ branches }) {
  const [result, setResult] = useState('')
  const [resultOk, setResultOk] = useState(null)
  const fileRef = useRef(null)

  async function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setResult('Parsing…')
    setResultOk(null)

    try {
      const text = await file.text()
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
      if (!lines.length) { setResult('Empty file.'); setResultOk(false); return }

      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
      const idIdx   = headers.findIndex(h => h.toLowerCase() === 'membership id')
      const petIdx  = headers.findIndex(h => h.toLowerCase() === 'pet name')
      const dateIdx = headers.findIndex(h => h.toLowerCase() === 'valid until date')
      const brIdx   = headers.findIndex(h => h.toLowerCase() === 'branch')

      if (idIdx < 0 || petIdx < 0) {
        setResult('Missing required columns: "Membership ID" and "Pet Name".')
        setResultOk(false); return
      }

      const rows = []
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''))
        const memberCode = (cols[idIdx] ?? '').trim().toUpperCase()
        if (!memberCode) continue
        const branchName = brIdx >= 0 ? (cols[brIdx] ?? '').trim() : ''
        const brMatch = branchName
          ? branches?.find(b => b.name.toLowerCase() === branchName.toLowerCase())
          : null
        rows.push({
          member_code: memberCode,
          pet_name:    (cols[petIdx] ?? '').trim() || null,
          valid_until: (dateIdx >= 0 && cols[dateIdx]) ? cols[dateIdx] || null : null,
          branch_id:   brMatch ? brMatch.id : null,
          // Tier is derived from branch: a branch-bound member is Standard,
          // a member with no branch is Passport (valid at all branches).
          tier:        brMatch ? 'standard' : 'passport',
          active:      true,
          updated_at:  new Date().toISOString(),
        })
      }

      if (!rows.length) { setResult('No valid rows found.'); setResultOk(false); return }
      setResult(`Uploading ${rows.length} rows…`)

      let added = 0, updated = 0
      for (let j = 0; j < rows.length; j += 50) {
        const batch = rows.slice(j, j + 50)
        const existing = await sbGet(
          'members',
          'member_code=in.(' + batch.map(r => encodeURIComponent(r.member_code)).join(',') + ')&select=member_code'
        )
        const existingCodes = (existing ?? []).map(r => r.member_code)
        batch.forEach(r => { if (existingCodes.includes(r.member_code)) updated++; else added++ })
        await sbUpsert('members', batch)
      }

      setResult(`✓ Done: ${added} added, ${updated} updated.`)
      setResultOk(true)
      e.target.value = ''
    } catch (err) {
      setResult(`Upload failed: ${err.message}`)
      setResultOk(false)
    }
  }

  return (
    <div className={styles.card}>
      <p className={styles.cardLabel}>Upload Membership CSV</p>
      <p className={styles.csvHint}>
        Expected columns:{' '}
        <code>Membership ID</code>, <code>Pet Name</code>,{' '}
        <code>Valid Until Date</code>, <code>Branch</code>
      </p>

      <input
        type="file"
        accept=".csv"
        style={{ display: 'none' }}
        ref={fileRef}
        onChange={handleFile}
      />
      <button
        className="btn-primary"
        style={{ width: '100%', marginBottom: 8 }}
        onClick={() => fileRef.current?.click()}
      >
        Choose CSV File
      </button>

      {result && (
        <p className={styles.csvResult} style={{ color: resultOk ? 'var(--success)' : resultOk === false ? 'var(--error)' : 'var(--mid)' }}>
          {result}
        </p>
      )}
    </div>
  )
}
