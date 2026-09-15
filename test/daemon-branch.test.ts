import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const world = new DaemonWorld(4490)
after(() => world.dispose())

interface ChatWire {
  id: string
  entries: number
  current: boolean
  parentChatId?: string
}

interface State {
  acp?: { state?: string }
  chats?: ChatWire[]
  conversation?: { role: string; text: string; chatId?: string }[]
}

async function ready(env?: Record<string, string>): Promise<number> {
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const { port } = await world.openSession(control, {
    url: `http://localhost:${9980 + Math.floor(Math.random() * 10)}`,
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

/** Send a batch and wait for the turn it starts to finish. */
async function send(port: number, note: string): Promise<void> {
  const before = ((await world.state(port)) as State).conversation?.length ?? 0
  await api(port, '/send', { note })
  await waitFor(async () => {
    const s = (await world.state(port)) as State
    return (s.conversation?.length ?? 0) > before + 1 && s.acp?.state === 'idle'
  }, `the turn for ${note}`)
}

/** What the thread is showing, which is one chat's worth of the log. */
async function visible(port: number): Promise<string[]> {
  const s = (await world.state(port)) as State
  return (s.conversation ?? []).map((e) => `${e.role}:${e.text}`)
}

const chats = async (port: number): Promise<ChatWire[]> =>
  ((await world.state(port)) as State).chats ?? []

test('a branch is its own conversation, and the review comes back to the one it left', async () => {
  const port = await ready()
  await send(port, 'on the main line')
  const before = await visible(port)
  assert.ok(before.some((e) => e.includes('on the main line')))

  const branched = await api(port, '/acp/branch')
  assert.equal(branched.status, 200)
  const { chatId, parentChatId } = (await branched.json()) as {
    chatId: string
    parentChatId: string
  }
  assert.notEqual(chatId, parentChatId)

  // The thread empties: a branch is a conversation of its own, and what was said
  // on the main line is not in it - the *agent* has the history, the shell does
  // not pretend the user does.
  assert.deepEqual(await visible(port), [])
  const onBranch = await chats(port)
  assert.equal(onBranch.find((c) => c.current)?.id, chatId)
  assert.equal(onBranch.find((c) => c.id === chatId)?.parentChatId, parentChatId)

  await send(port, 'only on the branch')
  assert.ok((await visible(port)).some((e) => e.includes('only on the branch')))

  // 回主線: an ordinary switch to the parent, and the branch is not in it.
  await api(port, '/acp/chat', { id: parentChatId })
  const back = await visible(port)
  assert.ok(back.some((e) => e.includes('on the main line')))
  assert.ok(!back.some((e) => e.includes('only on the branch')))

  // And the branch is still there to go back to.
  await api(port, '/acp/chat', { id: chatId })
  assert.ok((await visible(port)).some((e) => e.includes('only on the branch')))
})

test('an agent that cannot branch is refused, and the review does not move', async () => {
  const port = await ready({ EZ_FAKE_NO_FORK: '1' })
  await send(port, 'on the main line')
  const was = (await chats(port)).find((c) => c.current)?.id

  const refused = await api(port, '/acp/branch')
  assert.equal(refused.status, 409)
  assert.match(((await refused.json()) as { error: string }).error, /cannot branch/)

  assert.equal((await chats(port)).find((c) => c.current)?.id, was)
  assert.ok((await visible(port)).some((e) => e.includes('on the main line')))
})

test('a fork the agent takes and then fails leaves no half-made branch behind', async () => {
  const port = await ready({ EZ_FAKE_REFUSE_FORK: '1' })
  await send(port, 'on the main line')
  const before = await chats(port)

  assert.equal((await api(port, '/acp/branch')).status, 409)

  // The danger this guards: a refused fork that still started a chat would leave
  // the review on an empty conversation that looks like a branch and has none of
  // the history a branch is for.
  assert.deepEqual(
    (await chats(port)).map((c) => c.id),
    before.map((c) => c.id),
  )
  assert.ok((await visible(port)).some((e) => e.includes('on the main line')))
})
