import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import type { ExploreState } from '../src/protocol.js'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const world = new DaemonWorld(4500)
after(() => world.dispose())

interface State {
  acp?: { state?: string }
  chats?: { id: string; current: boolean; parentChatId?: string }[]
  conversation?: { role: string; text: string }[]
  explores?: ExploreState[]
}

let nextPort = 9940

async function ready(env?: Record<string, string>): Promise<number> {
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const { port } = await world.openSession(control, {
    url: `http://localhost:${nextPort++}`,
    project: world.dataDir,
    agent: env
      ? `${Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')} ${FAKE_AGENT}`
      : FAKE_AGENT,
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

const ANCHOR = {
  source: 'src/App.tsx:42',
  components: ['CtaButton', 'Hero'],
  selector: 'main > button.cta',
  text: '免費試用 14 天',
}
const CAPTURE = {
  html: '<button class="cta">免費試用 14 天</button>',
  styles: { 'font-size': '16px', 'background-color': 'rgb(59, 130, 246)', nonsense: 'dropped' },
  parentWidth: 640.4,
}

/** Start a round and wait for the branch turn to finish. */
async function explore(port: number, body: unknown = {}): Promise<ExploreState> {
  const res = await api(port, '/explore/start', {
    anchor: ANCHOR,
    capture: CAPTURE,
    ...(body as object),
  })
  const started = (await res.json()) as { exploreId?: string; error?: string }
  assert.equal(res.status, 200, started.error)
  const exploreId = started.exploreId!
  return await waitFor(async () => {
    const s = await state(port)
    const round = s.explores?.find((e) => e.id === exploreId)
    return s.acp?.state === 'idle' && round?.status === 'done' ? round : null
  }, 'the explore turn to finish')
}

test('an explore runs on a branch and its variants come back through the tool', async () => {
  const port = await ready()
  const before = (await state(port)).chats ?? []

  const round = await explore(port, { direction: '更緊湊' })

  // It ran somewhere else: a new conversation, branched off the one the review
  // was on, and the round belongs to it.
  const chats = (await state(port)).chats ?? []
  assert.equal(chats.length, before.length + 1)
  const branch = chats.find((c) => c.current)!
  assert.equal(branch.id, round.chatId)
  assert.ok(branch.parentChatId)

  assert.equal(round.direction, '更緊湊')
  assert.equal(round.label.length > 0, true)
  assert.deepEqual(
    round.variants.map((v) => [v.name, v.html, v.note]),
    [
      ['緊湊版', '<button class="cta">免費試用</button>', 'tighter'],
      ['Outline', '<button class="cta outline">免費試用 14 天</button>', undefined],
    ],
  )
  // The first one goes on the page by itself: the user asked to see variants.
  assert.equal(round.selected, round.variants[0]!.id)

  // The thread on the branch says what was asked, in the user's own words.
  const said = (await state(port)).conversation ?? []
  assert.ok(said.some((e) => e.role === 'user' && e.text.includes('更緊湊')))
})

test('the round is over when the turn is, and a late variant is refused', async () => {
  const port = await ready()
  const round = await explore(port)

  // The agent's url for the round is closed with the turn. Asking it again is
  // what a confused agent does after its turn ended.
  const s = await state(port)
  const live = s.explores!.find((e) => e.id === round.id)!
  assert.equal(live.status, 'done')
  assert.equal(live.variants.length, 2)

  // Straight at the url, the way the agent would: the round no longer takes it.
  const refused = await fetch(`http://127.0.0.1:${port}/__eztweak/api/mcp/${round.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  assert.equal(refused.status, 404)
})

test('a variant can be put on the page and taken off again, and a dismissed round leaves nothing', async () => {
  const port = await ready()
  const round = await explore(port)
  const [first, second] = round.variants

  assert.equal(
    (await api(port, '/explore/select', { id: round.id, variantId: second!.id })).status,
    200,
  )
  assert.equal((await state(port)).explores![0]!.selected, second!.id)

  // The original, which is what `null` means.
  assert.equal((await api(port, '/explore/select', { id: round.id, variantId: null })).status, 200)
  assert.equal((await state(port)).explores![0]!.selected, null)

  // A variant the round does not have is refused rather than shown.
  assert.equal(
    (await api(port, '/explore/select', { id: round.id, variantId: 'nope' })).status,
    409,
  )
  assert.equal((await state(port)).explores![0]!.selected, null)
  assert.ok(first)

  // Dismissed rounds leave the snapshot: nothing of them is on the page.
  assert.equal((await api(port, '/explore/dismiss', { id: round.id })).status, 200)
  assert.equal((await state(port)).explores, undefined)
})

test('two rounds on different elements both stand; a second on the same element takes the slot', async () => {
  const port = await ready()
  const first = await explore(port)
  assert.equal((await state(port)).explores!.length, 1)

  // A different element: both rounds keep their selection, because they are
  // standing in different places on the page.
  const other = await explore(port, {
    anchor: { ...ANCHOR, source: 'src/App.tsx:99', selector: 'main > h1', text: '週報不用開會寫' },
  })
  let live = (await state(port)).explores!
  assert.equal(live.length, 2)
  assert.ok(live.find((e) => e.id === first.id)!.selected)
  assert.ok(live.find((e) => e.id === other.id)!.selected)

  // The same element again: the older round gives the slot up, because two
  // variants cannot both stand in one place.
  const again = await explore(port)
  live = (await state(port)).explores!
  assert.equal(live.find((e) => e.id === first.id)!.selected, null)
  assert.ok(live.find((e) => e.id === other.id)!.selected)
  assert.ok(live.find((e) => e.id === again.id)!.selected)
})

test('a variant the page must not be shown is refused, and the agent is told why', async () => {
  const port = await ready()
  const round = await explore(port, { direction: 'BADVARIANTS' })

  assert.deepEqual(
    round.variants.map((v) => v.name),
    ['fine'],
  )
  // The refusals came back to the agent as the tool's answer, naming the rule.
  const reply = (await state(port)).conversation!.filter((e) => e.role === 'agent').at(-1)!.text
  assert.match(reply, /2 top-level elements/)
  assert.match(reply, /<script>/)
})

test('an agent that cannot branch cannot explore, and nothing is started', async () => {
  const port = await ready({ EZ_FAKE_NO_FORK: '1' })
  const res = await api(port, '/explore/start', { anchor: ANCHOR, capture: CAPTURE })
  assert.equal(res.status, 409)
  assert.equal((await state(port)).explores, undefined)
  assert.equal((await state(port)).chats!.length, 1)
})

test('an explore without markup to vary is a bad request', async () => {
  const port = await ready()
  assert.equal((await api(port, '/explore/start', { anchor: ANCHOR })).status, 400)
  assert.equal((await api(port, '/explore/start', { capture: CAPTURE })).status, 400)
  assert.equal(
    (await api(port, '/explore/start', { anchor: ANCHOR, capture: { html: '' } })).status,
    400,
  )
})
