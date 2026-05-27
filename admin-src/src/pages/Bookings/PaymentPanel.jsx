import { useState } from 'react'
import { sbPost } from '../../lib/supabase'
import styles from './PaymentPanel.module.css'

export default function PaymentPanel({ bookingId, onClose, onSaved }) {
  const [amt,      setAmt]      = useState('')
  const [type,     setType]     = useState('balance')
  const [method,   setMethod]   = useState('cash')
  const [ref,      setRef]      = useState('')
  const [notes,    setNotes]    = useState('')
  const [recorder, setRecorder] = useState('')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')

  async function save() {
    const amount = parseInt(amt)
    if (!amount || isNaN(amount)) { setError('Please enter an amount.'); return }
    setSaving(true); setError('')
    try {
      await sbPost('payments', {
        booking_id:       bookingId,
        amount,
        type,
        method,
        reference_number: ref  || null,
        notes:            notes || null,
        recorded_by:      recorder || 'admin',
      })
      onSaved()
      onClose()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.panel}>
        <div className={styles.header}>
          <p className={styles.title}>Record Payment</p>
          <button className={styles.close} onClick={onClose}>✕</button>
        </div>

        <div className={styles.body}>
          <div className="fg">
            <label className="fl">Amount (PHP)</label>
            <input className="fi" type="number" placeholder="e.g. 500"
              value={amt} onChange={e => setAmt(e.target.value)} />
          </div>
          <div className="fg">
            <label className="fl">Type</label>
            <select className="fi" value={type} onChange={e => setType(e.target.value)}>
              <option value="downpayment">Downpayment</option>
              <option value="balance">Balance</option>
              <option value="addon">Add-on charge</option>
              <option value="refund">Refund</option>
            </select>
          </div>
          <div className="fg">
            <label className="fl">Method</label>
            <select className="fi" value={method} onChange={e => setMethod(e.target.value)}>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="online">Online</option>
            </select>
          </div>
          <div className="fg">
            <label className="fl">Reference number</label>
            <input className="fi" placeholder="Optional"
              value={ref} onChange={e => setRef(e.target.value)} />
          </div>
          <div className="fg">
            <label className="fl">Notes</label>
            <textarea className="fi" style={{ resize: 'vertical', minHeight: 60 }}
              placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          <div className="fg">
            <label className="fl">Recorded by</label>
            <input className="fi" placeholder="Your name"
              value={recorder} onChange={e => setRecorder(e.target.value)} />
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <button className="btn-primary" style={{ width: '100%' }} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save payment'}
          </button>
        </div>
      </div>
    </div>
  )
}
