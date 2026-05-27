import { useState } from 'react'
import { sbPost, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../lib/supabase'
import { supabase } from '../../lib/supabase'
import styles from './FAB.module.css'

export default function FAB({ onAddBooking, onBlockSchedule }) {
  const [open, setOpen] = useState(false)

  function toggle() { setOpen(o => !o) }
  function close()  { setOpen(false) }

  async function handleWalkin() {
    close()
    try {
      const token = crypto.randomUUID?.() ??
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
        })
      const { data: sess } = await supabase.auth.getSession()
      const accessToken = sess?.session?.access_token ?? SUPABASE_ANON_KEY
      const res = await fetch(`${SUPABASE_URL}/rest/v1/walkin_tokens`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ id: token }),
      })
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
      window.open(`/booking.html?walkin=1&token=${encodeURIComponent(token)}`, '_blank')
    } catch (e) {
      alert('Could not open walk-in booking: ' + e.message)
    }
  }

  return (
    <div className={styles.group}>
      {open && (
        <>
          <div className={styles.backdrop} onClick={close} />
          <div className={styles.actions}>
            <button className={styles.action} onClick={() => { close(); onAddBooking?.() }}>
              📋 Add Booking
            </button>
            <button className={styles.action} onClick={handleWalkin}>
              🚶 Walk-in
            </button>
            <button className={styles.action} onClick={() => { close(); onBlockSchedule?.() }}>
              🚫 Block Schedule
            </button>
          </div>
        </>
      )}
      <button className={`${styles.main} ${open ? styles.mainOpen : ''}`} onClick={toggle}>
        +
      </button>
    </div>
  )
}
