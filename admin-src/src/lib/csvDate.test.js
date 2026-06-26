import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCsvDate } from './csvDate.js'

test('accepts ISO membership dates unchanged', () => {
  assert.deepEqual(normalizeCsvDate('2026-12-31'), { ok: true, value: '2026-12-31' })
})

test('normalizes US slash membership dates', () => {
  assert.deepEqual(normalizeCsvDate('12/31/2026'), { ok: true, value: '2026-12-31' })
  assert.deepEqual(normalizeCsvDate('6/25/2026'), { ok: true, value: '2026-06-25' })
})

test('rejects impossible membership dates', () => {
  assert.equal(normalizeCsvDate('2/29/2025').ok, false)
  assert.equal(normalizeCsvDate('2026-13-01').ok, false)
})
