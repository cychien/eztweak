import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.EZTWEAK_DATA_DIR = mkdtempSync(join(tmpdir(), 'eztweak-test-'))

const { SESSION_RESTORE_MAX_AGE_MS, SESSIONS_DIR } = await import('../src/constants.js')
const { SessionStore, listPersistedSessions, listRestorableSessions, originKey } = await import(
  '../src/store.js'
)
const anchor = { selector: 'div', page: '/' }

test('annotations queue: add, update, remove', () => {
  const store = new SessionStore('http://localhost:1111')
  store.addAnnotation({ id: 'a1', kind: 'element', comment: 'x', anchor, createdAt: 1 })
  store.addAnnotation({ id: 'a2', kind: 'text', comment: 'y', anchor, createdAt: 2 })
  assert.equal(store.annotations.length, 2)

  assert.equal(store.updateAnnotation('a1', { comment: 'z' }), true)
  assert.equal(store.annotations[0]!.comment, 'z')
  assert.equal(store.updateAnnotation('missing', { comment: 'w' }), false)

  assert.equal(store.removeAnnotation('a2'), true)
  assert.equal(store.annotations.length, 1)
})

test('sendBatch seals the queue and empty sends are rejected', () => {
  const store = new SessionStore('http://localhost:2222')
  assert.equal(store.sendBatch(null), null)
  assert.equal(store.sendBatch('   '), null)

  store.addAnnotation({ id: 'b1', kind: 'element', comment: 'fix', anchor, createdAt: 1 })
  const batch = store.sendBatch('note')!
  assert.equal(batch.items.length, 1)
  assert.equal(batch.note, 'note')
  assert.equal(store.annotations.length, 0)

  const noteOnly = store.sendBatch('follow-up thought')
  assert.ok(noteOnly)
})

test('delivery is at-least-once: unacked batches redeliver, acked ones do not', () => {
  const store = new SessionStore('http://localhost:3333')
  store.addAnnotation({ id: 'c1', kind: 'element', comment: 'fix', anchor, createdAt: 1 })
  const batch = store.sendBatch(null)!

  assert.equal(store.nextBatch()!.batchId, batch.batchId)
  store.markDelivered(batch.batchId)
  assert.equal(store.nextBatch()!.batchId, batch.batchId, 'delivered but unacked → redeliver')

  store.ack(batch.batchId)
  assert.equal(store.nextBatch(), null)
})

test('state survives a store re-instantiation (daemon restart)', () => {
  const first = new SessionStore('http://localhost:4444')
  first.addAnnotation({ id: 'd1', kind: 'element', comment: 'keep me', anchor, createdAt: 1 })
  first.end('user')

  const second = new SessionStore('http://localhost:4444')
  assert.equal(second.annotations[0]!.comment, 'keep me')
  assert.equal(second.session.state, 'ended')
  assert.equal(second.session.endedBy, 'user')

  second.reopen()
  assert.equal(second.session.state, 'active')
  assert.equal(second.session.endedBy, undefined)
})

// A restarted daemon rebuilds its session map from these, so a session it
// cannot see is a session whose queued feedback it will never deliver.
test('persisted sessions are listable across a daemon restart', () => {
  const active = new SessionStore('http://localhost:4444')
  active.setPort(51000)
  const ended = new SessionStore('http://localhost:5555')
  ended.end('user')

  const listed = listPersistedSessions()
  const byOrigin = new Map(listed.map((s) => [s.targetOrigin, s]))

  assert.equal(byOrigin.get('http://localhost:4444')?.state, 'active')
  assert.equal(byOrigin.get('http://localhost:4444')?.port, 51000)
  assert.equal(byOrigin.get('http://localhost:5555')?.state, 'ended')
})

test('the remembered port survives an end/reopen cycle', () => {
  const store = new SessionStore('http://localhost:6666')
  store.setPort(51001)
  store.end('agent')
  store.reopen()
  assert.equal(store.session.port, 51001)
  assert.equal(store.session.state, 'active')
  assert.equal(store.session.endedBy, undefined)
})

const sessionFile = (origin: string) => join(SESSIONS_DIR, originKey(origin), 'session.json')

function rewriteSession(origin: string, patch: Record<string, unknown>): void {
  const file = sessionFile(origin)
  const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, JSON.stringify({ ...record, ...patch }, null, 2))
}

const restorableOrigins = () => listRestorableSessions().map((s) => s.targetOrigin)

test('restore skips ended sessions and ones with no recent activity', () => {
  new SessionStore('http://localhost:7777')
  new SessionStore('http://localhost:8888').end('user')
  new SessionStore('http://localhost:9999')
  rewriteSession('http://localhost:9999', {
    lastActivityAt: Date.now() - SESSION_RESTORE_MAX_AGE_MS - 60_000,
  })

  assert.ok(restorableOrigins().includes('http://localhost:7777'))
  assert.ok(!restorableOrigins().includes('http://localhost:8888'))
  assert.ok(!restorableOrigins().includes('http://localhost:9999'))
  // Stale, but still on disk: the bound decides what to restore, not what to keep.
  const listed = listPersistedSessions().map((s) => s.targetOrigin)
  assert.ok(listed.includes('http://localhost:9999'))
})

// The whole point of the bound: restoring a session rewrites session.json to
// remember its port, and if that counted as activity nothing would ever expire.
test('restoring a session does not renew its activity clock', () => {
  const origin = 'http://localhost:7070'
  const store = new SessionStore(origin)
  rewriteSession(origin, { lastActivityAt: Date.now() - SESSION_RESTORE_MAX_AGE_MS + 60_000 })
  const before = store.session.lastActivityAt

  store.setPort(51002)
  assert.equal(store.session.lastActivityAt, before)
  assert.equal(store.session.port, 51002)

  rewriteSession(origin, { lastActivityAt: Date.now() - SESSION_RESTORE_MAX_AGE_MS - 60_000 })
  store.setPort(51003)
  assert.ok(!restorableOrigins().includes(origin))

  store.touch()
  assert.ok(restorableOrigins().includes(origin))
})

test('a record with no activity clock falls back to createdAt', () => {
  const recent = 'http://localhost:7171'
  const old = 'http://localhost:7272'
  new SessionStore(recent)
  new SessionStore(old)
  rewriteSession(recent, { lastActivityAt: undefined })
  rewriteSession(old, {
    lastActivityAt: undefined,
    createdAt: Date.now() - SESSION_RESTORE_MAX_AGE_MS - 60_000,
  })

  assert.ok(restorableOrigins().includes(recent))
  assert.ok(!restorableOrigins().includes(old))
})
