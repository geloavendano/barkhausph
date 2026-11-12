/**
 * Amount an admin edit may still record as a payment: the booking total minus what is already
 * recorded (payments minus refunds), never below 0.
 *
 * The Edit booking save used to insert a payment for the FULL total every time it was saved with a
 * payment status and method, so re-saving an already paid booking recorded the money twice
 * (17 Jun 2026: 3 duplicate rows). On a booking with nothing recorded this is the full total, exactly
 * as before.
 */
export function unrecordedBalance(total, payments) {
  const recorded = (payments ?? []).reduce((sum, p) => {
    const amt = Number(p?.amount) || 0
    return p?.type === 'refund' ? sum - amt : sum + amt
  }, 0)
  return Math.max(0, (Number(total) || 0) - recorded)
}
