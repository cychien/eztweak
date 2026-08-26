import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

process.env.EZTWEAK_DATA_DIR = mkdtempSync(join(tmpdir(), 'eztweak-test-'))

const { SessionStore, listPersistedSessions, listRestorableSessions } = await import(
  '../src/store.js'
)
const { ATTACHMENT_GRACE_MS } = await import('../src/constants.js')
const anchor = { selector: 'div', page: '/' }
const PROJECT = '/tmp/project-a'

test('annotations queue: add, update, remove', () => {
  const store = new SessionStore('http://localhost:1111', PROJECT)
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
  const store = new SessionStore('http://localhost:2222', PROJECT)
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
  const store = new SessionStore('http://localhost:3333', PROJECT)
  store.addAnnotation({ id: 'c1', kind: 'element', comment: 'fix', anchor, createdAt: 1 })
  const batch = store.sendBatch(null)!

  assert.equal(store.nextBatch()!.batchId, batch.batchId)
  store.markDelivered(batch.batchId)
  assert.equal(store.nextBatch()!.batchId, batch.batchId, 'delivered but unacked → redeliver')

  store.ack(batch.batchId)
  assert.equal(store.nextBatch(), null)
})

test('state survives a store re-instantiation (daemon restart)', () => {
  const first = new SessionStore('http://localhost:4444', PROJECT)
  first.addAnnotation({ id: 'd1', kind: 'element', comment: 'keep me', anchor, createdAt: 1 })
  first.end('user')

  const second = new SessionStore('http://localhost:4444', PROJECT)
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
  const active = new SessionStore('http://localhost:4444', PROJECT)
  active.setPort(51000)
  const ended = new SessionStore('http://localhost:5555', PROJECT)
  ended.end('user')

  const listed = listPersistedSessions()
  const byOrigin = new Map(listed.map((s) => [s.targetOrigin, s]))

  assert.equal(byOrigin.get('http://localhost:4444')?.state, 'active')
  assert.equal(byOrigin.get('http://localhost:4444')?.port, 51000)
  assert.equal(byOrigin.get('http://localhost:5555')?.state, 'ended')
})

test('the remembered port survives an end/reopen cycle', () => {
  const store = new SessionStore('http://localhost:6666', PROJECT)
  store.setPort(51001)
  store.end('agent')
  store.reopen()
  assert.equal(store.session.port, 51001)
  assert.equal(store.session.state, 'active')
  assert.equal(store.session.endedBy, undefined)
})

test('restore rebuilds every active session and skips ended ones', () => {
  new SessionStore('http://localhost:7777', PROJECT)
  new SessionStore('http://localhost:8888', PROJECT).end('user')

  const restorable = listRestorableSessions().map((s) => s.targetOrigin)
  assert.ok(restorable.includes('http://localhost:7777'))
  assert.ok(!restorable.includes('http://localhost:8888'))
  // Ended, but still on disk: restore decides what to rebuild, not what to keep.
  assert.ok(listPersistedSessions().some((s) => s.targetOrigin === 'http://localhost:8888'))
})

// Dev servers default to the same port, so two projects reviewed on
// localhost:5173 are the case that made this identity change necessary.
test('two projects on one origin get separate stores', () => {
  const origin = 'http://localhost:5173'
  const a = new SessionStore(origin, '/tmp/project-a')
  const b = new SessionStore(origin, '/tmp/project-b')
  assert.notEqual(a.dir, b.dir)

  a.addAnnotation({ id: 'a1', kind: 'element', comment: 'A only', anchor, createdAt: 1 })
  a.sendBatch('A note')

  assert.equal(b.nextBatch(), null)
  assert.deepEqual(b.conversation, [])
  assert.deepEqual(b.annotations, [])
  assert.equal(a.nextBatch()?.note, 'A note')
})

test('the same project on one origin keeps its store', () => {
  const origin = 'http://localhost:5174'
  new SessionStore(origin, '/tmp/project-a').addAnnotation({
    id: 'keep',
    kind: 'element',
    comment: 'still mine',
    anchor,
    createdAt: 1,
  })
  const reopened = new SessionStore(origin, '/tmp/project-a')
  assert.equal(reopened.annotations[0]?.comment, 'still mine')
})

// Only one project can hold a port at a time, so restoring both would rebuild a
// proxy for a dev server that is certainly gone.
test('restore keeps only the newest session per origin', () => {
  const origin = 'http://localhost:5175'
  const older = new SessionStore(origin, '/tmp/old-project')
  // Both stores are built in the same millisecond here; date the first one back
  // so the assertion tests the rule rather than readdir order.
  const record = join(older.dir, 'session.json')
  writeFileSync(record, JSON.stringify({ ...older.session, createdAt: 1 }))
  const newer = new SessionStore(origin, '/tmp/new-project')
  newer.setPort(50001)

  const restorable = listRestorableSessions().filter((s) => s.targetOrigin === origin)
  assert.equal(restorable.length, 1)
  assert.equal(restorable[0]?.project, '/tmp/new-project')
})

// ---------------------------------------------------------------- attachments

const bytes = (s: string) => Buffer.from(s)

test('an attachment is written to disk and indexed', () => {
  const store = new SessionStore('http://localhost:9001', PROJECT)
  const a = store.addAttachment('shot.png', 'image/png', bytes('png-bytes'))

  assert.equal(a.name, 'shot.png')
  assert.equal(a.mime, 'image/png')
  assert.equal(a.size, 9)
  assert.equal(readFileSync(store.attachmentPath(a), 'utf8'), 'png-bytes')
  assert.equal(store.attachmentIndex[a.id]?.name, 'shot.png')
  assert.equal(store.attachmentPath(a), join(store.dir, 'attachments', `${a.id}-shot.png`))
})

// Every clipboard screenshot arrives under the same name, so without this the
// chips in one composer would be indistinguishable.
test('names are deduplicated within a session', () => {
  const store = new SessionStore('http://localhost:9002', PROJECT)
  const names = [1, 2, 3].map(() => store.addAttachment('image.png', 'image/png', bytes('x')).name)
  assert.deepEqual(names, ['image.png', 'image-2.png', 'image-3.png'])
})

test('a nameless paste is named from its type', () => {
  const store = new SessionStore('http://localhost:9003', PROJECT)
  assert.equal(store.addAttachment('', 'image/jpeg', bytes('x')).name, 'file.jpg')
  assert.equal(store.addAttachment('', 'application/octet-stream', bytes('x')).name, 'file')
})

// The name reaches a real path, so a traversal attempt must not resolve above
// the attachments directory.
test('hostile names cannot escape the attachments directory', () => {
  const store = new SessionStore('http://localhost:9004', PROJECT)
  for (const raw of ['../../evil.png', '/etc/passwd', '..', '.hidden']) {
    const a = store.addAttachment(raw, 'image/png', bytes('x'))
    assert.equal(dirname(store.attachmentPath(a)), store.attachmentsDir)
    assert.ok(!a.name.includes('/'))
    assert.ok(!a.name.startsWith('.'))
  }
})

test('unknown ids resolve to null rather than a partial list', () => {
  const store = new SessionStore('http://localhost:9005', PROJECT)
  const a = store.addAttachment('a.png', 'image/png', bytes('x'))
  assert.equal(store.getAttachments([a.id])?.length, 1)
  assert.equal(store.getAttachments([a.id, 'nope']), null)
  assert.deepEqual(store.getAttachments([]), [])
})

test('removing an attachment deletes the file, unless something references it', () => {
  const store = new SessionStore('http://localhost:9006', PROJECT)
  const loose = store.addAttachment('loose.png', 'image/png', bytes('x'))
  const held = store.addAttachment('held.png', 'image/png', bytes('x'))
  store.addAnnotation({
    id: 'ann',
    kind: 'element',
    comment: 'see this',
    anchor,
    createdAt: 1,
    attachments: [held],
  })

  assert.equal(store.removeAttachment(loose.id), 'ok')
  assert.equal(existsSync(store.attachmentPath(loose)), false)
  assert.equal(store.removeAttachment(loose.id), 'unknown')

  assert.equal(store.removeAttachment(held.id), 'referenced')
  assert.equal(existsSync(store.attachmentPath(held)), true)
})

test('deleting an annotation takes its files with it', () => {
  const store = new SessionStore('http://localhost:9007', PROJECT)
  const file = store.addAttachment('gone.png', 'image/png', bytes('x'))
  store.addAnnotation({
    id: 'ann',
    kind: 'element',
    comment: 'c',
    anchor,
    createdAt: 1,
    attachments: [file],
  })

  assert.equal(store.removeAnnotation('ann'), true)
  assert.equal(existsSync(store.attachmentPath(file)), false)
  assert.equal(store.attachmentIndex[file.id], undefined)
})

// A pasted screenshot can be the whole message.
test('a file with no text is still a batch worth sending', () => {
  const store = new SessionStore('http://localhost:9008', PROJECT)
  const file = store.addAttachment('only.png', 'image/png', bytes('x'))

  assert.equal(store.sendBatch(null), null)
  const batch = store.sendBatch(null, [file])!
  assert.equal(batch.attachments?.[0]?.name, 'only.png')
  assert.equal(existsSync(store.attachmentPath(file)), true, 'sending must not delete the bytes')
})

test('the attachment index survives a daemon restart', () => {
  const origin = 'http://localhost:9009'
  const file = new SessionStore(origin, PROJECT).addAttachment('keep.png', 'image/png', bytes('x'))
  const restarted = new SessionStore(origin, PROJECT)

  assert.equal(restarted.attachmentIndex[file.id]?.name, 'keep.png')
  assert.equal(restarted.getAttachments([file.id])?.[0]?.name, 'keep.png')
})

// The sweep is what collects files from a composer that was never sent, so it
// has to be able to tell those from the ones still in play.
test('the sweep drops only stale, unreferenced attachments', () => {
  const store = new SessionStore('http://localhost:9010', PROJECT)
  const fresh = store.addAttachment('fresh.png', 'image/png', bytes('x'))
  const stale = store.addAttachment('stale.png', 'image/png', bytes('x'))
  const queued = store.addAttachment('queued.png', 'image/png', bytes('x'))
  const sent = store.addAttachment('sent.png', 'image/png', bytes('x'))

  store.addAnnotation({
    id: 'q',
    kind: 'element',
    comment: 'c',
    anchor,
    createdAt: 1,
    attachments: [queued],
  })
  store.sendBatch('note', [sent])

  // Date the orphan back past the grace window, so the sweep runs against the
  // real clock and the rule under test is age, not a doctored `now`.
  const index = store.attachmentIndex
  index[stale.id]!.createdAt = Date.now() - ATTACHMENT_GRACE_MS - 1
  writeFileSync(join(store.dir, 'attachments.json'), JSON.stringify(index))

  store.sweepAttachments()

  assert.equal(existsSync(store.attachmentPath(stale)), false, 'stale orphan is collected')
  assert.equal(store.attachmentIndex[stale.id], undefined)
  assert.equal(existsSync(store.attachmentPath(fresh)), true, 'young orphan is still in grace')
  assert.equal(existsSync(store.attachmentPath(queued)), true, 'queued annotation still holds it')
  assert.equal(existsSync(store.attachmentPath(sent)), true, 'sent batch still holds it')
})

// A crash between the two writes leaves bytes nothing will ever name.
test('the sweep collects files the index never learned about', () => {
  const store = new SessionStore('http://localhost:9011', PROJECT)
  store.addAttachment('real.png', 'image/png', bytes('x'))
  const stray = join(store.attachmentsDir, 'ffffffffffff-stray.png')
  writeFileSync(stray, 'x')
  utimesSync(stray, new Date(0), new Date(0))

  store.sweepAttachments()
  assert.equal(existsSync(stray), false)
})

// A note that points at an element but says nothing else is still a send: the
// element is the message.
test('a batch carries the elements the note pointed at', () => {
  const store = new SessionStore('http://localhost:1131', PROJECT)
  const references = [{ n: 1, anchor: { source: 'src/b.tsx:88' }, label: '立即報名' }]
  assert.equal(store.sendBatch(null), null)
  const batch = store.sendBatch(null, [], references)!
  assert.deepEqual(batch.references, references)
  assert.deepEqual(store.outbox[0]!.references, references, 'and survives the round trip to disk')
})

test('references on a queued annotation reach the batch that seals it', () => {
  const store = new SessionStore('http://localhost:1132', PROJECT)
  store.addAnnotation({
    id: 'a1',
    kind: 'element',
    comment: '跟 [ref 1] 一樣',
    anchor,
    createdAt: 1,
    references: [{ n: 1, anchor: { source: 'src/b.tsx:88' }, label: 'Row' }],
  })
  const batch = store.sendBatch(null)!
  assert.equal(batch.items[0]!.references?.[0]!.label, 'Row')
})

test('a batch with no references does not invent the field', () => {
  const store = new SessionStore('http://localhost:1133', PROJECT)
  assert.equal(store.sendBatch('just a note')!.references, undefined)
})
