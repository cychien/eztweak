import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const world = new DaemonWorld(4560)
after(() => world.dispose())

interface State {
  acp?: { state?: string }
  conversation?: { role: string; text: string }[]
}

let nextPort = 9820

const HISTORY = 'earlier conversations that this session did not see'

function project(): string {
  const dir = mkdtempSync(join(world.dataDir, 'project-'))
  writeFileSync(join(dir, 'PRODUCT.md'), '# Product\n\n## Users\n\nPeople.\n')
  writeFileSync(join(dir, 'DESIGN.md'), '---\nname: Fixture\ncolors:\n  primary: "#1A1C1E"\n---\n')
  return dir
}

async function ready(harness = true): Promise<number> {
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const { port } = await world.openSession(control, {
    url: `http://localhost:${nextPort++}`,
    project: project(),
    agent: FAKE_AGENT,
  })
  await waitFor(async () => {
    const s = (await world.state(port)) as State
    return s.acp?.state === 'idle'
  }, 'the agent to be ready')
  if (harness) {
    const res = await api(port, '/harness', { on: true })
    assert.equal(res.status, 200, await res.text())
  }
  return port
}

const api = (port: number, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}/__eztweak/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

const state = (port: number) => world.state(port) as Promise<State>

async function annotate(port: number, comment: string, selector: string): Promise<void> {
  const res = await api(port, '/annotations', {
    kind: 'element',
    comment,
    anchor: { source: 'src/App.tsx:42', selector, text: comment },
  })
  assert.equal(res.status, 200, await res.text())
}

/** The fake agent echoes the prompt, so a reply carrying the note means the turn ran. */
async function send(port: number, note: string): Promise<void> {
  const res = await api(port, '/send', { note })
  assert.equal(res.status, 200, await res.text())
  await waitFor(async () => {
    const s = await state(port)
    return (
      s.acp?.state === 'idle' &&
      s.conversation?.some((e) => e.role === 'agent' && e.text.includes(note))
    )
  }, `the turn for "${note}"`)
}

async function newChat(port: number): Promise<void> {
  const res = await api(port, '/acp/new')
  assert.equal(res.status, 200, await res.text())
  await waitFor(async () => (await state(port)).acp?.state === 'idle', 'the new chat to open')
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

test('a conversation with nothing before it, and its own later batches, get no history', async () => {
  const port = await ready()
  await annotate(port, '太鬆了', 'main > .hero .cta')
  await send(port, '第一批')
  await send(port, '第二批')
  const all = await prompts(port)
  assert.equal(all.length, 2)
  for (const p of all) assert.ok(!p.includes(HISTORY), 'nothing to hand over')
})

test('after /new the first batch carries the earlier conversation, once, as history', async () => {
  const port = await ready()
  await annotate(port, '太鬆了', 'main > .hero .cta')
  await send(port, '整體再緊一點')
  await annotate(port, '這個也太鬆', 'main > .pricing .card')
  await send(port, '第二批')

  await newChat(port)
  await send(port, '新對話第一批')
  await send(port, '新對話第二批')

  const all = await prompts(port)
  const before = all.filter((p) => !p.includes('新對話'))
  const fresh = all.filter((p) => p.includes('新對話'))
  assert.equal(fresh.length, 2)
  for (const p of before)
    assert.ok(!p.includes(HISTORY), 'the first conversation had nothing before it')
  const [first, second] = fresh
  assert.ok(first!.includes(HISTORY))
  assert.ok(first!.includes('none of it is being asked again'))
  const block = first!.slice(first!.indexOf(HISTORY), first!.indexOf('The user reviewed'))
  assert.ok(block.includes('太鬆了') && block.includes('整體再緊一點'), 'the first conversation')
  assert.ok(block.includes('這個也太鬆') && block.includes('第二批'), 'and its later batch')
  assert.ok(block.indexOf('這個也太鬆') < block.indexOf('太鬆了'), 'newest first')
  assert.ok(
    first!.indexOf(HISTORY) < first!.indexOf('新對話第一批'),
    'history comes before the batch it rides in front of',
  )
  assert.ok(!second!.includes(HISTORY), 'given once per conversation')
  assert.ok(!second!.includes('太鬆了'))
})

test('with the harness off, a fresh conversation is handed no history', async () => {
  const port = await ready(false)
  await annotate(port, '太鬆了', 'main > .hero .cta')
  await send(port, '整體再緊一點')
  await newChat(port)
  await send(port, '新對話第一批')
  const fresh = (await prompts(port)).filter((p) => p.includes('新對話'))
  assert.equal(fresh.length, 1)
  assert.ok(!fresh[0]!.includes(HISTORY))
  assert.ok(!fresh[0]!.includes('太鬆了'))
})
