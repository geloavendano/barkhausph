import { useState, useRef } from 'react'
import { sbGet, sbUpsert } from '../../lib/supabase'
import styles from './MembersPage.module.css'

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

function toCsv(rows) {
  return rows.map(row => row.map(csvCell).join(',')).join('\n')
}

function downloadCsv(filename, rows) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function parseCsvLine(line) {
  const cols = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++ }
      else quoted = !quoted
    } else if (ch === ',' && !quoted) {
      cols.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  cols.push(cur.trim())
  return cols.map(c => c.replace(/^"|"$/g, ''))
}

function normalizeCsvDate(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return { ok: true, value: null }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { ok: false, reason: 'Invalid Valid Until Date.', action: 'Use YYYY-MM-DD, for example 2026-03-04.' }
  }
  const date = new Date(raw + 'T00:00:00Z')
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    return { ok: false, reason: 'Invalid Valid Until Date.', action: 'Enter a real calendar date in YYYY-MM-DD format.' }
  }
  return { ok: true, value: raw }
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
        `member_code=eq.${encodeURIComponent(c)}&select=*&limit=1`
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

      setStatus({ ok: true, tierLabel, branchName, validStr, petName: m.pet_name, petBreed: m.pet_breed })
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
              {status.petBreed && <Row label="Breed" value={status.petBreed} />}
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
  const [report, setReport] = useState(null)
  const fileRef = useRef(null)

  function downloadSampleCsv() {
    const sampleBranch = branches?.[0]?.name ?? 'Estancia'
    const rows = [
      ['Membership ID', 'Pet Name', 'Breed', 'Valid Until Date', 'Branch'],
      ['BH-M001', 'Max', 'Golden Retriever', '2026-12-31', sampleBranch],
      ['BH-P001', 'Luna', 'Persian', '2026-12-31', ''],
    ]
    downloadCsv('barkhaus-members-template.csv', rows)
  }

  async function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setResult('Parsing…')
    setResultOk(null)
    setReport(null)

    try {
      const text = await file.text()
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      if (!lines.length) { setResult('Empty file.'); setResultOk(false); return }

      const headers = parseCsvLine(lines[0])
      const idIdx   = headers.findIndex(h => h.toLowerCase() === 'membership id')
      const petIdx  = headers.findIndex(h => h.toLowerCase() === 'pet name')
      const breedIdx = headers.findIndex(h => h.toLowerCase() === 'breed')
      const dateIdx = headers.findIndex(h => h.toLowerCase() === 'valid until date')
      const brIdx   = headers.findIndex(h => h.toLowerCase() === 'branch')

      if (idIdx < 0 || petIdx < 0) {
        setResult('Missing required columns: "Membership ID" and "Pet Name".')
        setResultOk(false); return
      }

      const reportHeaders = [
        ...headers,
        'Import Status',
        'Import Result',
        'Next Action',
      ]
      const reportRows = [reportHeaders]
      const uploadRows = []

      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i])
        const memberCode = (cols[idIdx] ?? '').trim().toUpperCase()
        const petName = (cols[petIdx] ?? '').trim()
        const branchName = brIdx >= 0 ? (cols[brIdx] ?? '').trim() : ''
        const reportBase = headers.map((_, idx) => cols[idx] ?? '')

        function fail(reason, action) {
          reportRows.push([...reportBase, 'Failed', reason, action])
        }

        if (!memberCode) {
          fail('Missing Membership ID.', 'Add a membership code, then upload the corrected row again.')
          continue
        }
        if (!petName) {
          fail('Missing Pet Name.', 'Add the registered pet name, then upload the corrected row again.')
          continue
        }
        const date = normalizeCsvDate(dateIdx >= 0 ? cols[dateIdx] : '')
        if (!date.ok) {
          fail(date.reason, date.action)
          continue
        }
        const brMatch = branchName
          ? branches?.find(b => b.name.toLowerCase() === branchName.toLowerCase())
          : null
        if (branchName && !brMatch) {
          fail('Branch does not match an active branch name.', 'Use the exact branch name, or leave Branch blank for Passport.')
          continue
        }
        uploadRows.push({
          cols: reportBase,
          member_code: memberCode,
          pet_name:    petName,
          pet_breed:   (breedIdx >= 0 ? (cols[breedIdx] ?? '').trim() : '') || null,
          valid_until: date.value,
          branch_id:   brMatch ? brMatch.id : null,
          // Tier is derived from branch: a branch-bound member is Standard,
          // a member with no branch is Passport (valid at all branches).
          tier:        brMatch ? 'standard' : 'passport',
          active:      true,
          updated_at:  new Date().toISOString(),
        })
      }

      if (!uploadRows.length) {
        const filename = `barkhaus-members-import-report-${new Date().toISOString().slice(0, 10)}.csv`
        setReport({ filename, rows: reportRows })
        downloadCsv(filename, reportRows)
        setResult('No rows were uploaded. Download the import report for row-level fixes.')
        setResultOk(false)
        e.target.value = ''
        return
      }
      setResult(`Uploading ${uploadRows.length} valid rows…`)

      let failed = reportRows.length - 1
      let added = 0, updated = 0
      for (const row of uploadRows) {
        try {
          const existing = await sbGet(
            'members',
            `member_code=eq.${encodeURIComponent(row.member_code)}&select=member_code&limit=1`
          )
          const operation = existing?.length ? 'Updated existing member.' : 'Added new member.'
          await sbUpsert('members', [{
            member_code: row.member_code,
            pet_name: row.pet_name,
            pet_breed: row.pet_breed,
            valid_until: row.valid_until,
            branch_id: row.branch_id,
            tier: row.tier,
            active: row.active,
            updated_at: row.updated_at,
          }])
          if (existing?.length) updated++
          else added++
          reportRows.push([...row.cols, 'Success', operation, 'No action needed.'])
        } catch (err) {
          failed++
          reportRows.push([...row.cols, 'Failed', err.message, 'Review this row and upload it again after fixing the issue.'])
        }
      }

      const filename = `barkhaus-members-import-report-${new Date().toISOString().slice(0, 10)}.csv`
      setReport({ filename, rows: reportRows })
      downloadCsv(filename, reportRows)
      setResult(`Done: ${added} added, ${updated} updated, ${failed} failed. Import report downloaded.`)
      setResultOk(failed === 0)
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
        <code>Breed</code>, <code>Valid Until Date</code>, <code>Branch</code>
      </p>
      <p className={styles.csvNote}>
        Use an exact branch name for Standard memberships. Leave Branch blank for Passport memberships valid at all branches.
      </p>

      <input
        type="file"
        accept=".csv"
        style={{ display: 'none' }}
        ref={fileRef}
        onChange={handleFile}
      />
      <div className={styles.csvActions}>
        <button
          className="btn-primary"
          onClick={() => fileRef.current?.click()}
        >
          Choose CSV File
        </button>
        <button
          className={styles.templateBtn}
          onClick={downloadSampleCsv}
        >
          Download Sample CSV
        </button>
      </div>

      {result && (
        <p className={styles.csvResult} style={{ color: resultOk ? 'var(--success)' : resultOk === false ? 'var(--error)' : 'var(--mid)' }}>
          {result}
        </p>
      )}
      {report && (
        <button
          className={styles.reportBtn}
          onClick={() => downloadCsv(report.filename, report.rows)}
        >
          Download Import Report
        </button>
      )}
    </div>
  )
}
