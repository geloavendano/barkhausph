import test from 'node:test'
import assert from 'node:assert/strict'
import { unrecordedBalance } from './payments.js'

test('nothing recorded yet: the full total, as before', () => {
  assert.equal(unrecordedBalance(850, []), 850)
  assert.equal(unrecordedBalance(850, null), 850)
})

test('re-saving an already paid booking records nothing (17 Jun duplicate case)', () => {
  assert.equal(unrecordedBalance(8000, [{ type: 'downpayment', amount: 8000 }]), 0)
  assert.equal(unrecordedBalance(8000, [{ type: 'downpayment', amount: 8000 }, { type: 'balance', amount: 8000 }]), 0)
})

test('after a downpayment only the remainder is recorded', () => {
  assert.equal(unrecordedBalance(1200, [{ type: 'downpayment', amount: '500' }]), 700)
})

test('refunds reduce what counts as recorded', () => {
  assert.equal(unrecordedBalance(1000, [{ type: 'balance', amount: 1000 }, { type: 'refund', amount: 200 }]), 200)
})
