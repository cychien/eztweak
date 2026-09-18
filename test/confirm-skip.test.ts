import assert from 'node:assert/strict'
import { test } from 'node:test'
import { confirmSkipKey, confirmSkipped, rememberConfirm } from '../src/client/confirm-skip.js'
import type { KeyStore } from '../src/client/confirm-skip.js'

function store(initial: Record<string, string> = {}): KeyStore & { seen: Record<string, string> } {
  const seen = { ...initial }
  return {
    seen,
    getItem: (k) => seen[k] ?? null,
    setItem: (k, v) => {
      seen[k] = v
    },
  }
}

const SWITCH = 'switch-agent'

test('a question nobody has answered is asked', () => {
  assert.equal(confirmSkipped(store(), SWITCH), false)
})

test('a yes with the box ticked puts the question away', () => {
  const s = store()
  rememberConfirm(s, SWITCH, { ok: true, skip: true })
  assert.equal(confirmSkipped(s, SWITCH), true)
})

// The rule the whole module exists for. "Stop asking" plus a remembered no is a
// control that silently refuses what it was asked about, for good, with nothing
// on screen to say why.
test('a no with the box ticked is not remembered', () => {
  const s = store()
  rememberConfirm(s, SWITCH, { ok: false, skip: true })
  assert.equal(confirmSkipped(s, SWITCH), false)
  assert.deepEqual(s.seen, {})
})

test('a yes without the box keeps the question coming', () => {
  const s = store()
  rememberConfirm(s, SWITCH, { ok: true, skip: false })
  assert.equal(confirmSkipped(s, SWITCH), false)
})

test('one question being put away does not put another away', () => {
  const s = store()
  rememberConfirm(s, SWITCH, { ok: true, skip: true })
  assert.equal(confirmSkipped(s, 'restore-files'), false)
})

// A private window, or site data blocked: every accessor can throw. Silence is
// not consent, so the question gets asked.
test('a store that will not answer means ask, not assume', () => {
  const broken: KeyStore = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
  }
  assert.equal(confirmSkipped(broken, SWITCH), false)
  assert.doesNotThrow(() => rememberConfirm(broken, SWITCH, { ok: true, skip: true }))
  assert.equal(confirmSkipped(null, SWITCH), false)
})

test('the key names the question, so answers cannot collide', () => {
  assert.notEqual(confirmSkipKey('switch-agent'), confirmSkipKey('restore-files'))
})
