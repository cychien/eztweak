import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONTROL_PORT, resolveControlPort } from '../src/constants.js'

test('falls back to the default when unset', () => {
  assert.equal(resolveControlPort(undefined), DEFAULT_CONTROL_PORT)
  assert.equal(resolveControlPort(''), DEFAULT_CONTROL_PORT)
})

test('accepts a usable port', () => {
  assert.equal(resolveControlPort('4410'), 4410)
})

// A NaN or out-of-range start would produce a range the daemon can never bind,
// which reads as "daemon failed to start" instead of "your env var is wrong".
test('rejects values that cannot make a bindable range', () => {
  for (const raw of ['abc', '80', '0', '-1', '65530', '4410.5', 'Infinity']) {
    assert.equal(resolveControlPort(raw), DEFAULT_CONTROL_PORT, raw)
  }
})
