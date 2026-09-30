import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ExploreState } from '../src/protocol.js'
import type { PersistedSession } from '../src/store.js'
import { clearInspireToken, credentialsFile, writeInspireToken } from '../src/credentials.js'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const world = new DaemonWorld(4510)
after(() => world.dispose())

interface State {
  acp?: { state?: string }
  conversation?: { role: string; text: string; batchId?: string }[]
  explores?: ExploreState[]
  designHarness?: boolean
  designEffort?: string
}

let nextPort = 9900

const BOTH_RULE = 'Read `PRODUCT.md` and `DESIGN.md` at the project root before any visual change.'
const BUILDING = '增強設計 (the design harness) is on for this turn.'
const OFF = '增強設計 (the design harness) is off for this turn.'
const SETUP = 'switched on the design harness - 增強設計'
const MAKE = 'reference/make.md'
const PRODUCT = '# Product\n\n## Users\n\nPeople.\n'
const SAMPLE = '---\nname: Fixture\ncolors:\n  primary: "#1A1C1E"\n---\n\n## Overview\n\nPlain.\n'

function project(files: ('product' | 'design')[] = []): string {
  const dir = mkdtempSync(join(world.dataDir, 'project-'))
  if (files.includes('product')) writeFileSync(join(dir, 'PRODUCT.md'), PRODUCT)
  if (files.includes('design')) writeFileSync(join(dir, 'DESIGN.md'), SAMPLE)
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

const idle = (port: number, what: string) =>
  waitFor(async () => (await state(port)).acp?.state === 'idle', what)

/** The fake agent echoes the prompt, so a reply carrying the note means the turn ran. */
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

/** Every prompt the fake agent has received, across sessions. */
async function prompts(port: number): Promise<string[]> {
  await api(port, '/send', { note: 'REPORT' })
  const said = await waitFor(async () => {
    const s = await state(port)
    return s.conversation?.find((e) => e.role === 'agent' && e.text.includes('"prompts"'))
  }, 'the agent to report')
  return (JSON.parse(said.text) as { prompts: { text: string }[] }).prompts.map((p) => p.text)
}

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

test('the harness is off by default: no rule, no making step, no question', async () => {
  const port = await ready(project(['product', 'design']))
  assert.equal((await state(port)).designHarness, false)
  await say(port, '把按鈕改藍')
  const [prompt] = await prompts(port)
  assert.ok(!prompt!.includes(BOTH_RULE))
  assert.ok(!prompt!.includes(MAKE))
  assert.ok(!prompt!.includes('這個專案'), 'nobody is asked anything by the agent')
  assert.ok(
    !prompt!.includes(OFF),
    'a conversation that never had the harness is not told it is off',
  )
  assert.ok(prompt!.includes('sent this feedback batch'))
})

test('switched on with both files: every batch is told the rule and pointed at make', async () => {
  const dir = project(['product', 'design'])
  const port = await ready(dir)
  const res = await api(port, '/harness', { on: true })
  assert.equal(res.status, 200, await res.text())
  assert.equal((await state(port)).designHarness, true)
  assert.equal(persisted(dir).designHarness, true)

  await say(port, 'one')
  await api(port, '/acp/new')
  await idle(port, 'the new chat to open')
  await say(port, 'two')
  await api(port, '/harness', { on: false })
  await say(port, 'three')

  const all = (await prompts(port)).filter((p) => p.includes('sent this feedback batch'))
  const on = all.filter((p) => p.includes('"one"') || p.includes('"two"'))
  assert.equal(on.length, 2)
  for (const p of on) {
    assert.ok(p.includes(BOTH_RULE), 'the rule rides with every batch')
    assert.ok(p.includes(MAKE), 'and the making step')
    assert.ok(p.includes('Change only what the items ask for'), 'the batch is the scope')
    assert.ok(p.includes('Design effort for this turn: medium.'), 'medium until the user picks')
  }
  const off = all.find((p) => p.includes('"three"'))!
  assert.ok(!off.includes(BOTH_RULE) && !off.includes(MAKE), 'switched off, no harness')
  assert.ok(off.includes(OFF), 'and told so, since this conversation had it')
})

// What an agent read while the harness was on stays in its context; the off line retracts it, and a
// fresh session, which read nothing, needs no retraction.
test('switched off after it was on: every later turn is told it is off, until a new chat', async () => {
  const port = await ready(project(['product', 'design']))
  await api(port, '/harness', { on: true })
  await say(port, 'with')
  await api(port, '/harness', { on: false })
  await say(port, 'after one')
  await say(port, 'after two')
  await api(port, '/acp/new')
  await idle(port, 'the new chat to open')
  await say(port, 'fresh')

  const all = (await prompts(port)).filter((p) => p.includes('sent this feedback batch'))
  const at = (note: string) => all.find((p) => p.includes(`"${note}"`))!
  assert.ok(at('with').includes(BUILDING.slice(0, 20)) || at('with').includes(BOTH_RULE))
  assert.ok(at('after one').includes(OFF) && at('after two').includes(OFF))
  assert.ok(!at('fresh').includes(OFF), 'a new session never saw the harness')
})

test('switched on without the files: refused with what is missing, and left off', async () => {
  const dir = project(['design'])
  const port = await ready(dir)
  const res = await api(port, '/harness', { on: true })
  assert.equal(res.status, 409)
  assert.deepEqual(((await res.json()) as { missing: string[] }).missing, ['product'])
  assert.equal((await state(port)).designHarness, false)
  assert.notEqual(persisted(dir).designHarness, true)

  await say(port, 'plain')
  const [prompt] = await prompts(port)
  assert.ok(!prompt!.includes(BUILDING) && !prompt!.includes(SETUP), 'no setup was queued')
})

test('switched on with a yes: the setup turn runs, and a later batch builds before it makes', async () => {
  const dir = project()
  const port = await ready(dir)
  const res = await api(port, '/harness', { on: true, create: true })
  assert.equal(res.status, 200, await res.text())
  await waitFor(async () => {
    const s = await state(port)
    return s.acp?.state === 'idle' && s.conversation?.some((e) => e.role === 'agent')
  }, 'the setup turn')
  const s = await state(port)
  assert.equal(s.designHarness, true)
  const asked = s.conversation?.find((e) => e.role === 'user')
  assert.equal(asked?.text, '啟用增強設計，建立 PRODUCT.md 與 DESIGN.md')

  await say(port, '按鈕改藍')
  const [setup, batch] = await prompts(port)
  assert.ok(setup!.includes(SETUP))
  assert.ok(setup!.includes('reference/product.md') && setup!.includes('reference/stack.md'))
  assert.ok(setup!.includes('reference/design.md') && setup!.includes('reference/components.md'))
  assert.ok(
    setup!.includes('The page is running at http://'),
    'the setup is told which page to read',
  )
  assert.ok(!setup!.includes('sent this feedback batch'), 'a setup turn carries no batch')
  assert.ok(setup!.includes('Do not stash, checkout, reset or commit'), "the tree is the user's")

  assert.ok(batch!.includes(BUILDING), 'the files are still missing, so they are built first')
  assert.ok(batch!.indexOf(BUILDING) < batch!.indexOf('按鈕改藍'))
  assert.ok(batch!.includes(MAKE))
  assert.ok(batch!.includes('reference/baseline.md'), 'with the files missing, the standard too')
  assert.ok(!batch!.includes('這個專案'), 'and nobody is asked again')
})

test('while a turn runs, neither the switch nor the effort moves, and nothing is queued', async () => {
  const port = await ready(project(['product', 'design']))
  await api(port, '/send', { note: 'SLOW' })
  await waitFor(async () => (await state(port)).acp?.state === 'working', 'the slow turn')

  assert.equal((await api(port, '/harness', { on: true, create: true })).status, 409)
  assert.equal((await api(port, '/harness/effort', { effort: 'high' })).status, 409)
  const s = await state(port)
  assert.equal(s.designHarness, false)
  assert.equal(s.designEffort, 'medium')
  assert.ok(!s.conversation?.some((e) => e.text.startsWith('啟用增強設計')), 'no setup was queued')

  await api(port, '/acp/cancel')
  await idle(port, 'the slow turn to stop')
  assert.equal((await api(port, '/harness', { on: true })).status, 200)
  assert.equal((await api(port, '/harness/effort', { effort: 'high' })).status, 200)
  assert.equal((await state(port)).designEffort, 'high')
})

test('the effort is the project s, one of three, and the next batch is told it', async () => {
  const dir = project(['product', 'design'])
  const port = await ready(dir)
  assert.equal((await state(port)).designEffort, 'medium', 'medium until the user picks another')
  await api(port, '/harness', { on: true })
  assert.equal((await api(port, '/harness/effort', { effort: 'max' })).status, 400)
  assert.equal((await api(port, '/harness/effort', { effort: 'low' })).status, 200)
  assert.equal((await state(port)).designEffort, 'low')
  await say(port, 'quickly')
  const low = (await prompts(port)).find((p) => p.includes('"quickly"'))!
  assert.ok(low.includes("Design effort for this turn: low. make.md's Effort section"))
  assert.ok(low.includes('reference/make.md` and `'), 'make.md and the baseline, named together')
  assert.ok(low.includes('reference/baseline.md'))
  assert.ok(!low.includes('reference/principles.md'), 'low reads no principles')
  const moved = await ready(dir)
  assert.equal((await state(moved)).designEffort, 'low', 'a new port starts where it was left')
})

test('the switch takes a boolean', async () => {
  const port = await ready(project())
  const res = await api(port, '/harness', { on: 'yes' })
  assert.equal(res.status, 400)
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

test('an explore is bound by the harness only when it is on and ready', async () => {
  const off = await ready(project(['product', 'design']))
  await explore(off)
  const [offExplore] = (await prompts(off)).filter((p) => p.includes('exploring UI variants'))
  assert.ok(offExplore)
  assert.ok(!offExplore.includes('DESIGN.md') && !offExplore.includes('PRODUCT.md'))
  assert.ok(
    offExplore.includes("in Traditional Chinese (繁體中文), the review shell's language"),
    "the reply language, always: the shell's own before the user has written",
  )

  const on = await ready(project(['product', 'design']))
  await api(on, '/harness', { on: true })
  await explore(on)
  const [onExplore] = (await prompts(on)).filter((p) => p.includes('exploring UI variants'))
  assert.ok(onExplore)
  assert.ok(onExplore.includes('`PRODUCT.md` and `DESIGN.md`'))
  assert.ok(onExplore.includes('Keep every variant to `PRODUCT.md`'))
  assert.ok(onExplore.includes(MAKE), 'a variant is made by the making step')
  assert.ok(
    onExplore.includes('reference/baseline.md') && onExplore.includes('reference/principles.md'),
    'and the standard is read with it, not left to a step the round may never reach',
  )
  assert.ok(!onExplore.includes('reference/critique.md'), 'no review: an explore is to be quick')
  assert.ok(onExplore.includes('An explore has no review, your'))
})

// A dev server that moved to another port is a new session; the switch is the project's.
test('the switch is remembered for the project, whatever port its dev server is on', async () => {
  const dir = project(['product', 'design'])
  const first = await ready(dir)
  assert.equal((await api(first, '/harness', { on: true })).status, 200)
  const moved = await ready(dir)
  assert.equal((await state(moved)).designHarness, true, 'a new port starts where it was left')
  await api(moved, '/harness', { on: false })
  const again = await ready(dir)
  assert.equal((await state(again)).designHarness, false)
})

// Remembered on without its files would build them on the next batch without asking.
test('a remembered on whose files are gone starts off, so turning it on asks again', async () => {
  const dir = project(['product', 'design'])
  await api(await ready(dir), '/harness', { on: true })
  rmSync(join(dir, 'PRODUCT.md'))
  const later = await ready(dir)
  assert.equal((await state(later)).designHarness, false)
  const res = await api(later, '/harness', { on: true })
  assert.equal(res.status, 409)
  assert.deepEqual(((await res.json()) as { missing: string[] }).missing, ['product'])
})

const LANGUAGE = 'Write to the user - replies, progress lines and questions - in'

// Every prompt carries the reply language, whatever the switch says; the harness-on ones also hand
// over the daemon's own CLI, since the published package may not have the command yet.
test('every prompt sets the reply language, and a harness-on one names the daemon CLI', async () => {
  const port = await ready(project(['product', 'design']))
  await say(port, 'plain')
  await api(port, '/harness', { on: true })
  await say(port, 'unlogged')
  writeInspireToken('tok-test', credentialsFile(world.dataDir))
  try {
    await say(port, 'with')
  } finally {
    clearInspireToken(credentialsFile(world.dataDir))
  }
  const all = (await prompts(port)).filter((p) => p.includes('sent this feedback batch'))
  const at = (note: string) => all.find((p) => p.includes(`"${note}"`))!
  assert.ok(at('plain').includes(LANGUAGE) && at('with').includes(LANGUAGE))
  assert.ok(!at('plain').includes('inspiration'), 'off: nothing about the database')
  assert.ok(at('unlogged').includes('cannot be searched on this machine'), 'no login: skip it')
  for (const name of ['make', 'baseline', 'principles']) {
    assert.ok(
      at('unlogged').includes(`reference/${name}.md`),
      `${name}.md is named where the turn starts`,
    )
  }
  assert.ok(!at('unlogged').includes(' inspire ...'))
  assert.ok(at('with').includes('src/cli.ts inspire ...'), "the daemon's own CLI, run as it runs")
  assert.ok(at('with').includes('never another copy of eztweak'))
  assert.ok(at('with').includes('reference/inspiration.md'), 'how to search, named where it starts')
  assert.ok(!at('unlogged').includes('reference/inspiration.md'), 'and not when there is none')
})

test("the reply language is named from the user's own words, newest first", async () => {
  const port = await ready(project(['product', 'design']))
  await say(port, '按鈕改藍一點')
  await say(port, 'make the button bigger')
  await say(port, 'CTA')
  const all = (await prompts(port)).filter((p) => p.includes('sent this feedback batch'))
  const at = (note: string) => all.find((p) => p.includes(`"${note}"`))!
  assert.ok(
    at('按鈕改藍一點').includes('in Traditional Chinese (繁體中文), the language of their own'),
  )
  assert.ok(at('make the button bigger').includes('in English, the language of their own words'))
  assert.ok(
    at('CTA').includes('in English'),
    'a word that names no language leaves it to what they wrote before',
  )
})
