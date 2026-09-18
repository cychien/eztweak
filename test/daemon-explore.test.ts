import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import type { ExploreState } from '../src/protocol.js'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const world = new DaemonWorld(4500)
after(() => world.dispose())

interface State {
  acp?: { state?: string; ask?: unknown }
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

/** What the fake agent saw and did, out of its REPORT turn. */
async function report(port: number): Promise<{ log: string[]; prompts: { text: string }[] }> {
  await api(port, '/send', { note: 'REPORT' })
  const said = await waitFor(async () => {
    const s = await state(port)
    return s.conversation?.find((e) => e.role === 'agent' && e.text.includes('prompts'))
  }, 'the agent to report')
  return JSON.parse(said.text) as { log: string[]; prompts: { text: string }[] }
}

const ANCHOR = {
  source: 'src/App.tsx:42',
  components: ['CtaButton', 'Hero'],
  selector: 'main > button.cta',
  text: '免費試用 14 天',
}
const CAPTURE = {
  html: '<button class="cta">免費試用 14 天</button>',
  styles: {
    'box-sizing': 'border-box',
    'font-size': '16px',
    'background-color': 'rgb(59, 130, 246)',
    nonsense: 'dropped',
  },
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

  // The agent asked permission to call the tool before it sent anything, the
  // way Claude Code does outside Auto mode - and got it from the daemon, once,
  // without a card the user would have had to answer for the round to finish.
  const { log, prompts } = await report(port)
  assert.ok(
    log.includes(`permission:mcp__eztweak-explore-${round.id}__explore_variant:allow-once`),
    log.join('\n'),
  )
  // The agent is told the one reset the variant is given, and its value, so it
  // can write `width: 100%` with padding the way the page does.
  const asked = prompts.map((p) => p.text).find((t) => t.includes('更緊湊'))!
  assert.match(asked, /`box-sizing` is `border-box` on every element inside the root/)
  assert.equal((await state(port)).acp?.ask, undefined)
})

// A round's own turn is what normally ends it, and there is one way out that the
// turn never gets to report: the review leaves the branch. The turn is cancelled
// with the session and its end then arrives on a session the daemon has already
// let go of, which the epoch drops - so left alone the round stays `generating`
// for good, the strip says 還在想 about an agent that is not, and the round's url
// goes on taking variants for a turn nobody is waiting on.
test('leaving a branch ends the round it was running', async () => {
  const port = await ready()
  const res = await api(port, '/explore/start', {
    anchor: ANCHOR,
    capture: CAPTURE,
    direction: 'SLOW',
  })
  const { exploreId } = (await res.json()) as { exploreId: string }

  // Variants in and the turn still parked, which is the state a user actually
  // decides in: something on the page, the agent still going.
  await waitFor(async () => {
    const round = (await state(port)).explores?.find((e) => e.id === exploreId)
    return round?.status === 'generating' && round.variants.length === 2
  }, 'the round to be running with its variants in')
  const branch = (await state(port)).chats?.find((c) => c.current)
  const parent = branch?.parentChatId
  assert.ok(parent, 'the explore should have branched')

  await api(port, '/acp/chat', { id: parent })

  const settled = await waitFor(async () => {
    const round = (await state(port)).explores?.find((e) => e.id === exploreId)
    return round && round.status !== 'generating' ? round : null
  }, 'the round to be settled')
  assert.equal(settled.status, 'cancelled')
  assert.equal(settled.variants.length, 2, 'what had already arrived stays')
})

test('the round settles when its turn ends, and the url answers nobody else', async () => {
  const port = await ready()
  const round = await explore(port)

  // The turn is over, so the round has stopped taking variants. Its status is
  // what refuses one now - the url stays open for as long as the branch does,
  // because the agent was handed it when the session opened and no protocol
  // takes one back. See `endExplore`.
  const s = await state(port)
  const live = s.explores!.find((e) => e.id === round.id)!
  assert.equal(live.status, 'done')
  assert.equal(live.variants.length, 2)

  // And it is the round's own agent's url, nobody else's: the token is what says
  // so, and an unknown round and a wrong token are refused the same way.
  const refused = await fetch(`http://127.0.0.1:${port}/__eztweak/api/mcp/${round.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  assert.equal(refused.status, 404)
})

// The round belongs to the branch, not to the one turn that opened it. Asking for
// more inside that branch used to reach a tool the daemon had stopped answering:
// the agent still had the url - a session is handed its servers once, when it
// opens - so every call after the first turn came back 404, in the one
// conversation where asking for more is the obvious thing to do.
test('asking for more in the branch carries the round on', async () => {
  const port = await ready()
  const round = await explore(port)
  assert.equal(round.variants.length, 2)
  const first = round.variants[0]!.id
  assert.equal(round.selected, first)

  // An ordinary message in the branch, which this agent answers by reaching for
  // the variant tool again.
  await api(port, '/send', { note: 'more of these: explore_variant' })

  const grown = await waitFor(async () => {
    const s = await state(port)
    const live = s.explores?.find((e) => e.id === round.id)
    return s.acp?.state === 'idle' && live && live.variants.length > 2 ? live : null
  }, 'the round to take more variants')

  assert.equal(grown.variants.length, 4, 'the strip grows rather than starting over')
  assert.equal(grown.status, 'done', 'and the round settles again with that turn')
  assert.equal(grown.selected, first, 'carrying on is not starting over')
})

// The two ways a round ends, and they are the same act with and without a pick:
// the page goes back to the real element and the review comes out of the branch.
// One call, because it is one decision - a round dismissed with the review still
// standing in its branch leaves a conversation whose only purpose has just been
// taken away, holding a variant tool the daemon no longer answers.
test('leaving a round with a pick ends it and brings the review back', async () => {
  const port = await ready()
  const round = await explore(port)
  const pick = round.variants[1]!
  const branch = (await state(port)).chats!.find((c) => c.current)!
  assert.ok(branch.parentChatId, 'the explore should have branched')

  assert.equal((await api(port, '/explore/exit', { id: round.id, variantId: pick.id })).status, 200)

  const after = await state(port)
  // Off the strip and off the page. What the user chose is a picture of the
  // thing; the real one is the main line's to build.
  assert.equal(
    after.explores?.find((e) => e.id === round.id),
    undefined,
  )
  assert.equal(after.chats?.find((c) => c.current)?.id, branch.parentChatId)
})

test('leaving a round with no pick ends it just the same', async () => {
  const port = await ready()
  const round = await explore(port)
  const branch = (await state(port)).chats!.find((c) => c.current)!

  assert.equal((await api(port, '/explore/exit', { id: round.id })).status, 200)

  const after = await state(port)
  assert.equal(
    after.explores?.find((e) => e.id === round.id),
    undefined,
  )
  assert.equal(after.chats?.find((c) => c.current)?.id, branch.parentChatId)
})

test('a pick the round never produced is refused, and nothing moves', async () => {
  const port = await ready()
  const round = await explore(port)
  const branch = (await state(port)).chats!.find((c) => c.current)!

  assert.equal((await api(port, '/explore/exit', { id: round.id, variantId: 'nope' })).status, 409)

  const after = await state(port)
  assert.ok(
    after.explores?.find((e) => e.id === round.id),
    'the round is still there',
  )
  assert.equal(after.chats?.find((c) => c.current)?.id, branch.id, 'and so is the review')
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

test('the direction takes its files and references with it', async () => {
  const port = await ready()
  const uploaded = await fetch(`http://127.0.0.1:${port}/__eztweak/api/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-ez-name': 'mood.png' },
    body: Buffer.from('not really a png'),
  })
  const file = (await uploaded.json()) as { id: string; name: string }

  const round = await explore(port, {
    direction: '照 [file 1] 的風格，做得像 [ref 2]',
    attachments: [file.id],
    references: [{ n: 2, label: '主要按鈕', anchor: { selector: 'header > button.primary' } }],
  })

  assert.deepEqual(
    round.attachments?.map((a) => a.name),
    ['mood.png'],
  )
  assert.deepEqual(
    round.references?.map((r) => [r.n, r.label]),
    [[2, '主要按鈕']],
  )

  // The markers name something the agent was actually handed: a path it can open
  // and an anchor it can resolve. A marker with nothing behind it is the bug.
  const { prompts } = await report(port)
  const asked = prompts.map((p) => p.text).find((t) => t.includes('照 [file 1] 的風格'))!
  assert.ok(asked, 'the explore prompt was not among what the agent saw')
  assert.match(asked, /mood\.png/)
  assert.match(asked, /attachments\/[^"]+/)
  assert.match(asked, /header > button\.primary/)
  assert.match(asked, /"n": 2/)
})

test('an explore with attachments that are not there is a bad request', async () => {
  const port = await ready()
  const res = await api(port, '/explore/start', {
    anchor: ANCHOR,
    capture: CAPTURE,
    attachments: ['nope'],
  })
  assert.equal(res.status, 400)
  const bad = await api(port, '/explore/start', {
    anchor: ANCHOR,
    capture: CAPTURE,
    references: [{ label: 'no n' }],
  })
  assert.equal(bad.status, 400)
})
