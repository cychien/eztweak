import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chatTitles, claudeTitle, worthListing } from '../src/chat-titles.js'
import type { ChatSummary } from '../src/store.js'

const SESSION = '58355ceb-9969-4631-b89b-9584d17fc3e9'

/** A Claude home with one transcript in it, written as Claude writes them: one
 *  JSON object per line, in a project folder named after a flattened path. */
function claudeHome(lines: unknown[], id = SESSION): string {
  const home = mkdtempSync(join(tmpdir(), 'eztweak-home-'))
  const dir = join(home, '.claude', 'projects', '-Users-someone-a-project')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
  return home
}

const title = (t: string) => ({ type: 'ai-title', aiTitle: t, sessionId: SESSION })
const chatter = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ type: 'assistant', message: { content: 'x'.repeat(200) }, i }))

test('the transcript is found without rebuilding the folder name', () => {
  assert.equal(claudeTitle(SESSION, claudeHome([title('週報頁面改版')])), '週報頁面改版')
})

// Claude re-emits the title as the conversation grows, and the last one is the
// one it currently goes by.
test('the newest title wins', () => {
  const home = claudeHome([title('第一個猜測'), ...chatter(3), title('最後定下來的題目')])
  assert.equal(claudeTitle(SESSION, home), '最後定下來的題目')
})

// A transcript runs to tens of megabytes, so the title is read off the tail. A
// title that only appears near the start still has to be found - which is the
// case this covers, because the tail read will miss it.
test('a title only near the start of a long transcript is still found', () => {
  const home = claudeHome([title('很早就定下來的題目'), ...chatter(4000)])
  assert.equal(claudeTitle(SESSION, home), '很早就定下來的題目')
})

test('a transcript Claude never titled has no title', () => {
  assert.equal(claudeTitle(SESSION, claudeHome(chatter(3))), undefined)
})

// Claude prunes old transcripts - one had already taken two of this project's
// conversations while this was being written - so a missing file is the ordinary
// case, not a broken one.
test('a pruned transcript is simply no title', () => {
  const home = claudeHome([title('沒被留下來的對話')], 'aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(claudeTitle(SESSION, home), undefined)
})

// The id goes straight into a path. It comes from a session file this daemon
// wrote, but a lookup that would read any file on disk given the right string is
// not something to leave standing on that.
test('only something shaped like a session id is looked up', () => {
  const home = claudeHome([title('x')])
  assert.equal(claudeTitle('../../../etc/passwd', home), undefined)
  assert.equal(claudeTitle('', home), undefined)
})

const chat = (over: Partial<ChatSummary> = {}): ChatSummary => ({
  id: 'c1',
  startedAt: 1,
  entries: 2,
  current: false,
  ...over,
})

// An agent nobody here has a profile for is asked nothing, so what the review
// recorded is all there is - which is also the path every fallback takes.
test('what the review recorded names a conversation no agent will', async () => {
  const titles = await chatTitles([chat({ said: '結帳流程的間距不對' })], 'node my-acp.mjs', '/tmp')
  assert.equal(titles.get('c1'), '結帳流程的間距不對')
})

test('a conversation with nothing said in it gets no title at all', async () => {
  const titles = await chatTitles([chat()], 'node my-acp.mjs', '/tmp')
  assert.equal(titles.has('c1'), false)
})

// A note is a paragraph and a comment carries the newlines it was typed with. A
// title is a line.
test('a title is one line, however it was typed', async () => {
  const titles = await chatTitles(
    [chat({ said: '這裡跑版了\n\n  兩個地方都要改   ' })],
    'node my-acp.mjs',
    '/tmp',
  )
  assert.equal(titles.get('c1'), '這裡跑版了 兩個地方都要改')
})

const listed = (rows: { title?: string; current: boolean }[]) =>
  rows.filter(worthListing).map((r) => r.title ?? (r.current ? 'current' : 'newest'))

// Oldest first, as the store keeps them.
test('conversations nobody said anything in are left out', () => {
  assert.deepEqual(
    listed([
      { title: '結帳流程', current: false },
      { current: false },
      { current: false },
      { title: '週報頁面', current: true },
    ]),
    ['結帳流程', '週報頁面'],
  )
})

// The one being viewed stays whatever it holds: a picker that cannot show where
// you are is worse than a long one.
test('the conversation being viewed is listed even when it is empty', () => {
  assert.deepEqual(listed([{ title: '結帳流程', current: false }, { current: true }]), [
    '結帳流程',
    'current',
  ])
})

// The bug this rule was written for. Step onto an older conversation while the
// newest is still empty and, without this, the way forward vanishes from the only
// control that could take you there.
test('the newest conversation is always the way back', () => {
  assert.deepEqual(listed([{ title: '結帳流程', current: true }, { current: false }]), [
    '結帳流程',
    'newest',
  ])
})
