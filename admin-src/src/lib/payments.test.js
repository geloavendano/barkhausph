import test from 'node:test'
import assert from 'node:assert/strict'
import { netPaid, paymentToRecord } from './payments.js'

test('netPaid subtracts refunds and tolerates numeric strings', () => {
  assert.equal(netPaid([
    { type: 'downpayment', amount: 500 },
    { type: 'balance', amount: '300' },
    { type: 'refund', amount: 100 },
  ]), 700)
  assert.equal(netPaid(null), 0)
})

test('paid on a new booking records the whole total', () => {
  assert.deepEqual(paymentToRecord({ paymentStatus: 'paid', total: 850 }), { amount: 850, error: '' })
})

test('editing an already fully paid booking records nothing (17 Jun duplicate case)', () => {
  assert.equal(paymentToRecord({ paymentStatus: 'paid', total: 8000, alreadyPaid: 8000 }).amount, 0)
  assert.equal(paymentToRecord({ paymentStatus: 'paid', total: 8000, alreadyPaid: 16000 }).amount, 0)
})

test('marking paid after a downpayment records only the balance', () => {
  assert.equal(paymentToRecord({ paymentStatus: 'paid', total: 1200, alreadyPaid: 500 }).amount, 700)
})

test('unpaid records nothing', () => {
  assert.deepEqual(paymentToRecord({ paymentStatus: 'unpaid', total: 1200 }), { amount: 0, error: '' })
})

test('partially paid records the entered amount, never the full total', () => {
  assert.deepEqual(paymentToRecord({ paymentStatus: 'partially_paid', total: 1200, enteredAmount: '500' }), { amount: 500, error: '' })
  assert.match(paymentToRecord({ paymentStatus: 'partially_paid', total: 1200 }).error, /amount received/)
  assert.match(paymentToRecord({ paymentStatus: 'partially_paid', total: 1200, enteredAmount: 1200 }).error, /Set Payment status to Paid/)
  assert.match(paymentToRecord({ paymentStatus: 'partially_paid', total: 1200, alreadyPaid: 500, enteredAmount: 700 }).error, /Paid/)
})
