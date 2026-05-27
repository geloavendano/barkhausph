import { useState } from 'react'
import styles from './FAB.module.css'

export default function FAB({ onAddBooking, onBlockSchedule }) {
  const [open, setOpen] = useState(false)

  function toggle() { setOpen(o => !o) }
  function close()  { setOpen(false) }

  function handleWalkin() {
    close()
    window.open('/booking.html?walkin=1', '_blank')
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
