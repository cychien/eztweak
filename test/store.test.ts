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
  const explored = store.addAttachment('explored.png', 'image/png', bytes('x'))

  store.addAnnotation({
    id: 'q',
    kind: 'element',
    comment: 'c',
    anchor,
    createdAt: 1,
    attachments: [queued],
  })
  store.sendBatch('note', [sent])
  store.startExplore({
    id: 'r1',
    chatId: 'c1',
    label: 'CTA',
    anchor,
    direction: '照 [file 1] 的風格',
    attachments: [explored],
  })

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
  assert.equal(
    existsSync(store.attachmentPath(explored)),
    true,
    'an explore round still holds its direction files',
  )
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

// Editing a queued annotation goes through here, so the patch has to be able to
// leave a field alone, replace it, and clear it - three different things that a
// single `Object.assign` of the request body cannot tell apart.
test('updateAnnotation leaves absent fields alone and clears empty ones', () => {
  const store = new SessionStore('http://localhost:7777', PROJECT)
  const file = { id: 'f1', name: 'a.png', mime: 'image/png', size: 3, createdAt: 1 }
  const ref = { n: 2, anchor, label: 'div' }
  store.addAnnotation({
    id: 'e1',
    kind: 'element',
    comment: '看 [file 1] 跟 [ref 2]',
    anchor,
    createdAt: 1,
    attachments: [file],
    references: [ref],
  })

  // A comment-only patch is what a text tweak sends: the files and the picked
  // elements must survive it untouched.
  assert.equal(store.updateAnnotation('e1', { comment: '再看 [file 1] 跟 [ref 2]' }), true)
  assert.deepEqual(store.annotations[0]!.attachments, [file])
  assert.deepEqual(store.annotations[0]!.references, [ref])
  assert.equal(store.annotations[0]!.comment, '再看 [file 1] 跟 [ref 2]')

  // An empty list means the user deleted the last chip, so the field goes rather
  // than staying on as `[]` - that is the shape `addAnnotation` writes.
  assert.equal(store.updateAnnotation('e1', { attachments: [], references: [] }), true)
  assert.equal('attachments' in store.annotations[0]!, false)
  assert.equal('references' in store.annotations[0]!, false)
  assert.equal(store.annotations[0]!.comment, '再看 [file 1] 跟 [ref 2]', 'still untouched')
})

// The bytes outlive the edit on purpose: a save that silently deleted files would
// be destructive in a way the user cannot see, and `sweepAttachments` is what
// collects an attachment nothing references any more.
test('a file dropped by an edit is left for the sweep, not deleted', () => {
  const store = new SessionStore('http://localhost:7778', PROJECT)
  const saved = store.addAttachment('shot.png', 'image/png', Buffer.from([1, 2, 3]))
  store.addAnnotation({
    id: 'e2',
    kind: 'element',
    comment: 'x',
    anchor,
    createdAt: 1,
    attachments: [saved],
  })
  store.updateAnnotation('e2', { attachments: [] })
  assert.equal(existsSync(store.attachmentPath(saved)), true)
  assert.equal(saved.id in store.attachmentIndex, true)
})

// ------------------------------------------------------------------- chats

test('a store with no chats grows one, and everything logged belongs to it', () => {
  const store = new SessionStore('http://localhost:7001', PROJECT)
  store.appendConversation({ role: 'user', text: 'first', ts: 1 })
  store.appendConversation({ role: 'agent', text: 'reply', ts: 2 })

  const chats = store.chats
  assert.equal(chats.length, 1)
  assert.equal(store.currentChat.id, chats[0]!.id)
  assert.deepEqual(
    store.visibleConversation.map((e) => e.text),
    ['first', 'reply'],
  )
  // Written down, not recomputed on every read.
  assert.equal(store.session.chats?.length, 1)
})

test('a new chat hides the old thread without deleting a word of it', () => {
  const store = new SessionStore('http://localhost:7002', PROJECT)
  store.appendConversation({ role: 'user', text: 'old', ts: 1 })
  const before = store.currentChat.id

  const fresh = store.startChat()
  assert.notEqual(fresh.id, before)
  assert.deepEqual(
    store.visibleConversation.map((e) => e.text),
    [],
    'the window moved',
  )
  assert.equal(store.conversation.length, 1, 'the log did not')

  store.appendConversation({ role: 'user', text: 'new', ts: 2 })
  assert.deepEqual(
    store.visibleConversation.map((e) => e.text),
    ['new'],
  )
})

// The reason the window is a filter on chat rather than a time range: go back to
// an earlier conversation and its new entries are stamped later than the chat
// that followed it, so any date-based window would leak one into the other.
test('an earlier chat picked back up collects entries stamped after the next one', () => {
  const store = new SessionStore('http://localhost:7003', PROJECT)
  const first = store.currentChat.id
  store.appendConversation({ role: 'user', text: 'in first', ts: 1 })
  const second = store.startChat().id
  store.appendConversation({ role: 'user', text: 'in second', ts: 2 })

  assert.equal(store.switchChat(first)?.id, first)
  store.appendConversation({ role: 'user', text: 'back in first', ts: 3 })
  assert.deepEqual(
    store.visibleConversation.map((e) => e.text),
    ['in first', 'back in first'],
  )

  assert.equal(store.switchChat(second)?.id, second)
  assert.deepEqual(
    store.visibleConversation.map((e) => e.text),
    ['in second'],
  )
  assert.equal(store.switchChat('nonesuch'), null)
})

// A session recorded before chats existed. Its `conversationClear` was the whole
// window, so the chat built from it has to draw exactly what it drew before -
// including hiding what the /new of the day hid.
test('a pre-chats session migrates its conversationClear into the first chat', () => {
  const store = new SessionStore('http://localhost:7004', PROJECT)
  const dir = store.dir

  // Rewind the store to what a pre-chats daemon would have written: a clear
  // point, no chats, and entries with no chat stamped on them.
  const session = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'))
  delete session.chats
  delete session.currentChatId
  session.conversationClear = { at: 200 }
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session))
  writeFileSync(
    join(dir, 'conversation.json'),
    JSON.stringify([
      { role: 'user', text: 'before the clear', ts: 100 },
      { role: 'user', text: 'after the clear', ts: 300 },
    ]),
  )

  const reopened = new SessionStore('http://localhost:7004', PROJECT)
  assert.equal(reopened.chats.length, 1)
  assert.equal(reopened.chats[0]!.startedAt, 200, 'the clear point became the chat')
  assert.deepEqual(
    reopened.visibleConversation.map((e) => e.text),
    ['after the clear'],
    'an unstamped entry before the clear stays hidden',
  )

  // And a second chat must not adopt the unstamped entries.
  reopened.startChat()
  assert.deepEqual(
    reopened.visibleConversation.map((e) => e.text),
    [],
  )
})

test('the chat remembers the agent session backing it', () => {
  const store = new SessionStore('http://localhost:7005', PROJECT)
  assert.equal(store.currentChat.acpSessionId, undefined)
  store.setChatSession('acp-1', 'claude')
  assert.equal(store.currentChat.acpSessionId, 'acp-1')

  // A resume the agent could not honour lands the chat on a different session.
  store.setChatSession('acp-2', 'claude')
  assert.equal(store.currentChat.acpSessionId, 'acp-2')

  // A fresh chat starts with none, and the old one keeps its own.
  const old = store.currentChat.id
  store.startChat()
  assert.equal(store.currentChat.acpSessionId, undefined)
  assert.equal(store.chats.find((c) => c.id === old)?.acpSessionId, 'acp-2')
})

// A session id is only meaningful to the agent that issued it. Handing Codex a
// Claude id gets "no rollout found for thread id ..." - so it is never offered.
test('a session is only offered back to the agent that made it', () => {
  const store = new SessionStore('http://localhost:7008', PROJECT)
  store.setChatSession('claude-session', 'claude')

  assert.equal(store.resumableSessionId('claude'), 'claude-session')
  assert.equal(store.resumableSessionId('codex'), undefined, "another agent's id is not offered")

  // Switching to that agent and back finds the original conversation again.
  store.setChatSession('codex-session', 'codex')
  assert.equal(store.resumableSessionId('codex'), 'codex-session')
  assert.equal(store.resumableSessionId('claude'), undefined)
})

test('a chat that never reached an agent has nothing to resume', () => {
  const store = new SessionStore('http://localhost:7009', PROJECT)
  assert.equal(store.resumableSessionId('claude'), undefined)
})

// The regression this pins: an empty chat used to be dropped from the list, so a
// `/new` followed by a look at an older conversation made that older one the
// newest entry - and the shell, which reads "an earlier conversation is showing"
// off exactly that, stopped saying so in the one state it exists to report.
test('an empty chat still appears in the list, so position keeps its meaning', () => {
  const store = new SessionStore('http://localhost:7006', PROJECT)
  const first = store.currentChat.id
  store.appendConversation({ role: 'user', text: 'said something', ts: 1 })
  const fresh = store.startChat().id

  assert.deepEqual(
    store.chatSummaries().map((c) => [c.id, c.entries, c.current]),
    [
      [first, 1, false],
      [fresh, 0, true],
    ],
  )

  store.switchChat(first)
  const onOld = store.chatSummaries()
  assert.equal(onOld.length, 2, 'the empty chat must not vanish when it stops being current')
  assert.equal(onOld.at(-1)!.current, false, 'so an earlier chat showing is still visible as that')
})

test('asking for a fresh chat while already on an empty one has nothing to do', () => {
  const store = new SessionStore('http://localhost:7007', PROJECT)
  assert.equal(store.onEmptyNewestChat, true, 'a brand new review is already fresh')

  store.appendConversation({ role: 'user', text: 'x', ts: 1 })
  assert.equal(store.onEmptyNewestChat, false)

  const fresh = store.startChat().id
  assert.equal(store.onEmptyNewestChat, true)

  // Showing an earlier chat is not "on a fresh one", even though the newest is
  // still empty - starting over from here has somewhere to go.
  store.switchChat(store.chats[0]!.id)
  assert.equal(store.onEmptyNewestChat, false)
  assert.equal(store.switchChat(fresh)?.id, fresh)
  assert.equal(store.onEmptyNewestChat, true)
})
