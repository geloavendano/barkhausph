import { useState } from 'react'
import { sbPost } from '../../lib/supabase'
import styles from './FAB.module.css'

export default function FAB({ onAddBooking, onBlockSchedule }) {
  const [open, setOpen] = useState(false)

  function toggle() { setOpen(o => !o) }
  function close()  { setOpen(false) }

  async function handleWalkin() {
    close()
    // The walk-in booking page is gated by a one-time token in walkin_tokens.
    // Create the token here (authenticated admin), then open the page with it.
    // Open the tab synchronously first so the browser doesn't block the popup,
    // then redirect it once the token row is created.
    const win = window.open('', '_blank')
    try {
      const token = crypto.randomUUID()
      await sbPost('walkin_tokens', { id: token })
      const url = `/booking.html?walkin=1&token=${encodeURIComponent(token)}`
      if (win) win.location = url
      else window.open(url, '_blank')
    } catch (e) {
      if (win) win.close()
      alert('Could not start walk-in booking: ' + (e?.message ?? e))
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
