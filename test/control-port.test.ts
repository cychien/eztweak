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

// Falling back to the default would put this daemon back in the real daemon's
// range, which is the isolation the env var exists to provide - so a set but
// unusable value has to be fatal, not quietly ignored.
test('throws on values that cannot make a bindable range', () => {
  for (const raw of ['abc', '80', '0', '-1', '65530', '4410.5', 'Infinity']) {
    assert.throws(() => resolveControlPort(raw), /CONTROL_PORT/, raw)
  }
})
