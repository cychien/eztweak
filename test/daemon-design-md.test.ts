import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ExploreState } from '../src/protocol.js'
import type { PersistedSession } from '../src/store.js'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const world = new DaemonWorld(4510)
after(() => world.dispose())

interface State {
  acp?: { state?: string }
  conversation?: { role: string; text: string }[]
  explores?: ExploreState[]
}

let nextPort = 9900

const QUESTION = '這個專案還沒有 DESIGN.md'
const RULE = "`DESIGN.md` at the project root is the design system's source of truth"
const SAMPLE = '---\nname: Fixture\ncolors:\n  primary: "#1A1C1E"\n---\n\n## Overview\n\nPlain.\n'

/** A project of its own, with or without the file, under the world so it goes
 *  with it. */
function project(withDesignMd: boolean): string {
  const dir = mkdtempSync(join(world.dataDir, 'project-'))
  if (withDesignMd) writeFileSync(join(dir, 'DESIGN.md'), SAMPLE)
  return dir
}

async function ready(projectDir: string): Promise<number> {
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const { port } = await world.openSession(control, {
    url: `http://localhost:${nextPort++}`,
    project: projectDir,
    agent: FAKE_AGENT,
  })
  await waitFor(async () => {
    const s = (await world.state(port)) as State
    return s.acp?.state === 'idle'
  }, 'the agent to be ready')
  return port
}

const api = (port: number, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}/__eztweak/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

const state = (port: number) => world.state(port) as Promise<State>

/** One batch, and the turn it starts run to its end. The fake agent echoes the
 *  prompt back, so its reply carrying the note is the turn having happened. */
async function say(port: number, note: string): Promise<void> {
  await api(port, '/send', { note })
  await waitFor(async () => {
    const s = await state(port)
    return (
      s.acp?.state === 'idle' &&
      s.conversation?.some((e) => e.role === 'agent' && e.text.includes(note))
    )
  }, `the turn for "${note}"`)
}

/** Every batch prompt the fake agent has been sent, in order, out of its REPORT
 *  turn - which it does not count among them. */
async function prompts(port: number): Promise<string[]> {
  await api(port, '/send', { note: 'REPORT' })
  const said = await waitFor(async () => {
    const s = await state(port)
    return s.conversation?.find((e) => e.role === 'agent' && e.text.includes('"prompts"'))
  }, 'the agent to report')
  return (JSON.parse(said.text) as { prompts: { text: string }[] }).prompts.map((p) => p.text)
}

/** The session on disk for a project, as the daemon last wrote it. */
function persisted(projectDir: string): PersistedSession {
  const sessions = join(world.dataDir, 'sessions')
  for (const key of readdirSync(sessions)) {
    const session = JSON.parse(
      readFileSync(join(sessions, key, 'session.json'), 'utf8'),
    ) as PersistedSession
    if (session.project === projectDir) return session
  }
  throw new Error(`no session on disk for ${projectDir}`)
}

test('a project without DESIGN.md is offered one on its first batch, and then left alone', async () => {
  const dir = project(false)
  const port = await ready(dir)

  await say(port, '把按鈕改藍')
  await say(port, '再大一點')
  const [first, second] = await prompts(port)

  assert.ok(first!.includes(QUESTION), 'the first batch carries the offer')
  assert.ok(
    first!.indexOf(QUESTION) < first!.indexOf('把按鈕改藍'),
    'and the offer comes before the batch',
  )
  assert.ok(!first!.includes(RULE))
  assert.ok(!second!.includes(QUESTION), 'the second batch does not ask again')

  // The chat remembers on disk, so a daemon that comes back on it does not ask again.
  const chat = persisted(dir).chats!.find((c) => c.id === persisted(dir).currentChatId)!
  assert.equal(typeof chat.designMdOfferedAt, 'number')
})

test('a new conversation is offered once more', async () => {
  const dir = project(false)
  const port = await ready(dir)
  await say(port, 'first')

  await api(port, '/acp/new')
  await waitFor(async () => (await state(port)).acp?.state === 'idle', 'the new chat to open')
  await say(port, 'second')

  const all = await prompts(port)
  const asked = all.filter((p) => p.includes(QUESTION))
  assert.equal(asked.length, 2)
  assert.ok(asked[1]!.includes('second'))
})

test('the file appearing between batches turns the offer into the rule', async () => {
  const dir = project(false)
  const port = await ready(dir)

  await say(port, 'before')
  writeFileSync(join(dir, 'DESIGN.md'), SAMPLE)
  await say(port, 'after')

  const [before, after] = await prompts(port)
  assert.ok(before!.includes(QUESTION))
  assert.ok(!after!.includes(QUESTION))
  assert.ok(after!.includes(RULE))
})

test('a project with DESIGN.md is never asked, and always told', async () => {
  const dir = project(true)
  const port = await ready(dir)

  await say(port, 'one')
  await say(port, 'two')

  const all = await prompts(port)
  assert.equal(all.length, 2)
  for (const p of all) {
    assert.ok(p.includes(RULE), 'every batch names the file')
    assert.ok(!p.includes(QUESTION))
  }
  assert.equal(persisted(dir).chats![0]!.designMdOfferedAt, undefined)
})

const ANCHOR = { source: 'src/App.tsx:42', selector: 'main > button.cta', text: '免費試用' }
const CAPTURE = { html: '<button class="cta">免費試用</button>', parentWidth: 640 }

async function explore(port: number): Promise<void> {
  const res = await api(port, '/explore/start', { anchor: ANCHOR, capture: CAPTURE })
  const started = (await res.json()) as { exploreId?: string; error?: string }
  assert.equal(res.status, 200, started.error)
  await waitFor(async () => {
    const s = await state(port)
    const round = s.explores?.find((e) => e.id === started.exploreId)
    return s.acp?.state === 'idle' && round?.status === 'done'
  }, 'the explore turn to finish')
}

test('an explore is never offered the file, and is bound by it when there is one', async () => {
  const bare = await ready(project(false))
  await explore(bare)
  const [bareExplore] = (await prompts(bare)).filter((p) => p.includes('exploring UI variants'))
  assert.ok(bareExplore)
  assert.ok(!bareExplore.includes(QUESTION))
  assert.ok(!bareExplore.includes('DESIGN.md'))

  const kept = await ready(project(true))
  await explore(kept)
  const [keptExplore] = (await prompts(kept)).filter((p) => p.includes('exploring UI variants'))
  assert.ok(keptExplore)
  assert.ok(!keptExplore.includes(QUESTION))
  assert.ok(keptExplore.includes('Keep every variant within its tokens and rules'))
})
