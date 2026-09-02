import assert from 'node:assert/strict'
import { test } from 'node:test'
import { threadOrder } from '../src/client/thread.js'
import type { ThreadEntry } from '../src/client/thread.js'

interface Entry extends ThreadEntry {
  text: string
}

const user = (text: string, batchId: string): Entry => ({ role: 'user', text, batchId })
const agent = (text: string, batchId?: string): Entry => ({
  role: 'agent',
  text,
  ...(batchId ? { batchId } : {}),
})
const system = (text: string, batchId?: string): Entry => ({
  role: 'system',
  text,
  ...(batchId ? { batchId } : {}),
})

const texts = (entries: Entry[]) => threadOrder(entries).map((e) => e.text)

test('a thread that never overlapped is left exactly as it was logged', () => {
  const log = [user('q1', 'a'), agent('r1', 'a'), user('q2', 'b'), agent('r2', 'b')]
  assert.deepEqual(texts(log), ['q1', 'r1', 'q2', 'r2'])
})

// The case the ordering exists for: q2 was sent while r1 was still being written,
// so the log has it in the middle - and a verbatim render puts r1 under q2.
test('an answer is drawn under its own question, not under a later one', () => {
  const log = [user('q1', 'a'), user('q2', 'b'), agent('r1', 'a'), agent('r2', 'b')]
  assert.deepEqual(texts(log), ['q1', 'r1', 'q2', 'r2'])
})

test('a turn keeps its reply and its stop note together, in that order', () => {
  const log = [user('q1', 'a'), user('q2', 'b'), agent('r1', 'a'), system('已中止', 'a')]
  assert.deepEqual(texts(log), ['q1', 'r1', '已中止', 'q2'])
})

// A note about the session, or the divider `/new` leaves, answers nothing. For
// those the timeline *is* the meaning, so they must not be moved.
test('entries belonging to no batch stay where the log put them', () => {
  const log = [
    user('q1', 'a'),
    system('新對話'),
    user('q2', 'b'),
    agent('r2', 'b'),
    system('Session ended by user'),
  ]
  assert.deepEqual(texts(log), ['q1', '新對話', 'q2', 'r2', 'Session ended by user'])
})

// Nothing says it answers q1, so it is not pulled up with the answer that does.
test('an unbatched agent reply keeps its own place in the log', () => {
  const log = [user('q1', 'a'), agent('自己說的話'), agent('r1', 'a')]
  assert.deepEqual(texts(log), ['q1', 'r1', '自己說的話'])
})

test('two questions answered out of order still each get their own answer', () => {
  const log = [user('q1', 'a'), user('q2', 'b'), agent('r2', 'b'), agent('r1', 'a')]
  assert.deepEqual(texts(log), ['q1', 'r1', 'q2', 'r2'])
})

// Poll mode redelivers a batch the agent never acked, so one question can end up
// with two replies. Both belong to it, in the order they arrived.
test('a question with several replies keeps all of them', () => {
  const log = [user('q1', 'a'), agent('r1', 'a'), user('q2', 'b'), agent('r1 again', 'a')]
  assert.deepEqual(texts(log), ['q1', 'r1', 'r1 again', 'q2'])
})

// The log is trimmed, or the reply outlived its question some other way. Losing
// the agent's words would be worse than showing them at the end.
test('an answer whose question is missing is still shown, last', () => {
  const log = [user('q2', 'b'), agent('r1', 'a'), agent('r2', 'b')]
  assert.deepEqual(texts(log), ['q2', 'r2', 'r1'])
})

test('an empty thread stays empty', () => {
  assert.deepEqual(threadOrder([]), [])
})

test('every entry comes out exactly once', () => {
  const log = [
    user('q1', 'a'),
    user('q2', 'b'),
    agent('r1', 'a'),
    system('已中止', 'a'),
    system('新對話'),
    agent('orphan', 'zz'),
    agent('r2', 'b'),
  ]
  const out = threadOrder(log)
  assert.equal(out.length, log.length)
  assert.deepEqual(new Set(out), new Set(log))
})
