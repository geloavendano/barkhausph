import { useEffect, useState, useRef } from 'react'
import { sbGet, sbUpsert } from '../../lib/supabase'
import { normalizeCsvDate } from '../../lib/csvDate'
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

const MEMBERS_IMPORT_JOB_KEY = 'barkhaus:members-import-job:v1'
let activeMembersImportPromise = null

function loadMembersImportJob() {
  try {
    const raw = localStorage.getItem(MEMBERS_IMPORT_JOB_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveMembersImportJob(job) {
  localStorage.setItem(MEMBERS_IMPORT_JOB_KEY, JSON.stringify(job))
  window.dispatchEvent(new CustomEvent('barkhaus-members-import-job'))
}

function clearMembersImportJob() {
  localStorage.removeItem(MEMBERS_IMPORT_JOB_KEY)
  window.dispatchEvent(new CustomEvent('barkhaus-members-import-job'))
}

function reportFilename() {
  return `barkhaus-members-import-report-${new Date().toISOString().slice(0, 10)}.csv`
}

async function runMembersImportJob(job) {
  if (activeMembersImportPromise) return activeMembersImportPromise

  activeMembersImportPromise = (async () => {
    let current = { ...job, status: 'processing', result: 'Uploading membership rows…' }
    saveMembersImportJob(current)

    for (let i = current.processed; i < current.uploadRows.length; i++) {
      const row = current.uploadRows[i]
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
          active: true,
          updated_at: new Date().toISOString(),
        }], 'member_code')
        current = {
          ...current,
          processed: i + 1,
          updated: current.updated + (existing?.length ? 1 : 0),
          added: current.added + (existing?.length ? 0 : 1),
          reportRows: [...current.reportRows, [...row.cols, 'Success', operation, 'No action needed.']],
        }
      } catch (err) {
        current = {
          ...current,
          processed: i + 1,
          failed: current.failed + 1,
          reportRows: [
            ...current.reportRows,
            [...row.cols, 'Failed', err.message, 'Review this row and upload it again after fixing the issue.'],
          ],
        }
      }

      const pct = current.total ? Math.round((current.processed / current.total) * 100) : 100
      saveMembersImportJob({
        ...current,
        result: `Processing ${current.processed} of ${current.total} rows (${pct}%).`,
      })
    }

    const completed = {
      ...current,
      status: 'completed',
      resultOk: current.failed === 0,
      completedAt: new Date().toISOString(),
      result: `Done: ${current.added} added, ${current.updated} updated, ${current.failed} failed.`,
    }
    saveMembersImportJob(completed)
    return completed
  })().finally(() => {
    activeMembersImportPromise = null
  })

  return activeMembersImportPromise
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
  const [preview, setPreview] = useState(null)
  const [job, setJob] = useState(() => loadMembersImportJob())
  const fileRef = useRef(null)

  useEffect(() => {
    const syncJob = () => setJob(loadMembersImportJob())
    const timer = setInterval(syncJob, 750)
    window.addEventListener('barkhaus-members-import-job', syncJob)
    const existing = loadMembersImportJob()
    if (existing?.status === 'processing') runMembersImportJob(existing)
    return () => {
      clearInterval(timer)
      window.removeEventListener('barkhaus-members-import-job', syncJob)
    }
  }, [])

  useEffect(() => {
    if (!job) return
    setResult(job.result ?? '')
    setResultOk(job.status === 'completed' ? job.resultOk : null)
  }, [job])

  function downloadSampleCsv() {
    const sampleBranch = branches?.[0]?.name ?? 'Estancia'
    const rows = [
      ['Membership ID', 'Pet Name', 'Breed', 'Valid Until Date', 'Branch'],
      ['BH-M001', 'Max', 'Golden Retriever', '2026-12-31', sampleBranch],
      ['BH-P001', 'Luna', 'Persian', '2026-12-31', ''],
    ]
    downloadCsv('barkhaus-members-template.csv', rows)
  }

  async function handleFileSelected(e) {
    const file = e.target.files[0]
    if (!file) return
    if (loadMembersImportJob()?.status !== 'processing') {
      clearMembersImportJob()
      setJob(null)
    }
    setResult('Parsing…')
    setResultOk(null)
    setPreview(null)

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
      let invalidRows = 0

      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i])
        const memberCode = (cols[idIdx] ?? '').trim().toUpperCase()
        const petName = (cols[petIdx] ?? '').trim()
        const branchName = brIdx >= 0 ? (cols[brIdx] ?? '').trim() : ''
        const reportBase = headers.map((_, idx) => cols[idx] ?? '')

        function fail(reason, action) {
          reportRows.push([...reportBase, 'Failed', reason, action])
          invalidRows++
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
        })
      }

      const dataRows = lines.length - 1
      setPreview({
        fileName: file.name,
        dataRows,
        validRows: uploadRows.length,
        invalidRows,
        uploadRows,
        reportRows,
      })
      setResult(`Selected ${file.name}: ${dataRows} rows found.`)
      setResultOk(null)
      e.target.value = ''
    } catch (err) {
      setResult(`Upload failed: ${err.message}`)
      setResultOk(false)
    }
  }

  function cancelPreview() {
    setPreview(null)
    setResult('')
    setResultOk(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  function clearCompletedReport() {
    clearMembersImportJob()
    setJob(null)
    setResult('')
    setResultOk(null)
  }

  async function proceedImport() {
    if (!preview) return
    const nextJob = {
      id: String(Date.now()),
      fileName: preview.fileName,
      status: preview.validRows ? 'processing' : 'completed',
      startedAt: new Date().toISOString(),
      filename: reportFilename(),
      uploadRows: preview.uploadRows,
      reportRows: preview.reportRows,
      total: preview.uploadRows.length,
      processed: 0,
      added: 0,
      updated: 0,
      failed: preview.invalidRows,
      resultOk: preview.invalidRows === 0,
      result: preview.validRows
        ? `Processing 0 of ${preview.validRows} rows (0%).`
        : 'No valid rows to upload. Download the import report for row-level fixes.',
    }
    setPreview(null)
    saveMembersImportJob(nextJob)
    setJob(nextJob)
    if (!preview.validRows) {
      const completed = { ...nextJob, status: 'completed', completedAt: new Date().toISOString() }
      saveMembersImportJob(completed)
      downloadCsv(completed.filename, completed.reportRows)
      return
    }
    const completed = await runMembersImportJob(nextJob)
    downloadCsv(completed.filename, completed.reportRows)
  }

  const progressPct = job?.total ? Math.round((job.processed / job.total) * 100) : (job?.status === 'completed' ? 100 : 0)
  const isProcessing = job?.status === 'processing'
  const reportRows = job?.reportRows
  const reportReady = job?.status === 'completed' && reportRows?.length > 0

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
        Dates may use YYYY-MM-DD or M/D/YYYY format.
      </p>

      <input
        type="file"
        accept=".csv"
        style={{ display: 'none' }}
        ref={fileRef}
        onChange={handleFileSelected}
      />
      <div className={styles.csvActions}>
        <button
          className="btn-primary"
          onClick={() => fileRef.current?.click()}
          disabled={isProcessing}
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

      {preview && (
        <div className={styles.filePreview}>
          <div>
            <p className={styles.previewName}>{preview.fileName}</p>
            <p className={styles.previewMeta}>
              {preview.dataRows} rows found · {preview.validRows} ready · {preview.invalidRows} need fixes
            </p>
          </div>
          <div className={styles.previewActions}>
            <button className={styles.cancelBtn} onClick={cancelPreview}>Cancel</button>
            <button className={styles.proceedBtn} onClick={proceedImport}>Proceed</button>
          </div>
        </div>
      )}

      {job && (
        <div className={styles.importPanel}>
          <div className={styles.importTop}>
            <span>{job.status === 'completed' ? 'Import complete' : 'Import in progress'}</span>
            <span>{progressPct}%</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
          </div>
          <p className={styles.importMeta}>
            {job.fileName} · {job.processed} of {job.total} processed · {job.added} added · {job.updated} updated · {job.failed} failed
          </p>
        </div>
      )}

      {result && (
        <p className={styles.csvResult} style={{ color: resultOk ? 'var(--success)' : resultOk === false ? 'var(--error)' : 'var(--mid)' }}>
          {result}
        </p>
      )}
      {reportReady && (
        <button
          className={styles.reportBtn}
          onClick={() => downloadCsv(job.filename, job.reportRows)}
        >
          Download Import Report
        </button>
      )}
      {reportReady && (
        <button className={styles.clearBtn} onClick={clearCompletedReport}>
          Clear Import Status
        </button>
      )}
    </div>
  )
}
