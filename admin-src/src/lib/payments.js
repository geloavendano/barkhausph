// Payment amounts the admin Add/Edit booking panel records alongside a payment-status change.

/** Net amount already paid on a booking: payments minus refunds. */
export function netPaid(payments) {
  return (payments ?? []).reduce((sum, p) => {
    const amt = Number(p?.amount) || 0
    return p?.type === 'refund' ? sum - amt : sum + amt
  }, 0)
}

/**
 * What the panel should insert into `payments` when staff set a payment status and method.
 * Until 12 Nov 2026 it always inserted the booking's FULL total, so editing an already-paid
 * booking (or marking it partially paid) recorded money that was never received.
 *
 * - unpaid          → nothing
 * - paid            → only what is still outstanding (total − already paid); nothing if fully paid
 * - partially_paid  → the amount staff entered, which must be above 0 and below what is outstanding
 *
 * @returns {{ amount: number, error: string }}
 */
export function paymentToRecord({ paymentStatus, total, alreadyPaid = 0, enteredAmount }) {
  const outstanding = Math.max(0, (Number(total) || 0) - (Number(alreadyPaid) || 0))
  if (paymentStatus === 'paid') return { amount: outstanding, error: '' }
  if (paymentStatus !== 'partially_paid') return { amount: 0, error: '' }
  const entered = Number(enteredAmount) || 0
  if (entered <= 0) return { amount: 0, error: 'Enter the amount received for this partial payment.' }
  if (entered >= outstanding) {
    return { amount: 0, error: `₱${entered.toLocaleString()} covers the full balance (₱${outstanding.toLocaleString()}). Set Payment status to Paid instead.` }
  }
  return { amount: entered, error: '' }
}
