import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, PKG_VERSION, waitFor } from './helpers/daemon.js'

const world = new DaemonWorld(4440)
after(() => world.dispose())

// Nothing listens here; the proxy is never exercised, only the session machinery.
const TARGET = 'http://127.0.0.1:9/'
const PROJECT = world.dataDir

interface State {
  version: string
  agentOnline: boolean
  acp?: { agent: string; state: string }
  conversation: { role: string; text: string }[]
}

async function acpIdle(port: number): Promise<State> {
  return waitFor(async () => {
    const s = (await world.state(port)) as unknown as State
    return s.acp?.state === 'idle' ? s : null
  }, 'the ACP agent to go idle')
}

test('a restarted daemon brings the ACP agent back and says so in the thread', async () => {
  world.spawnDaemon()
  const first = await world.liveDaemon()
  const opened = await world.openSession(first.port, {
    url: TARGET,
    project: PROJECT,
    agent: FAKE_AGENT,
  })
  const before = await acpIdle(opened.port)
  assert.equal(before.version, PKG_VERSION)
  assert.equal(before.acp?.agent, FAKE_AGENT)

  // Something in the thread, so there is context whose loss is worth reporting.
  await world.sendFeedback(opened.port, 'make the hero bigger')

  const sessionDirs = readdirSync(join(world.dataDir, 'sessions'))
  assert.equal(sessionDirs.length, 1)
  const persisted = JSON.parse(
    readFileSync(join(world.dataDir, 'sessions', sessionDirs[0]!, 'session.json'), 'utf8'),
  ) as { agent?: string; port?: number }
  assert.equal(persisted.agent, FAKE_AGENT)

  await world.stopDaemon(first.port)
  world.spawnDaemon()
  const second = await world.liveDaemon()
  assert.notEqual(second.pid, first.pid)

  const found = await world.control(
    second.port,
    `/control/sessions/find?origin=${encodeURIComponent(new URL(TARGET).origin)}`,
  )
  assert.equal(found.status, 200)
  const { port } = (await found.json()) as { port: number }
  assert.equal(port, opened.port)

  const after = await acpIdle(port)
  assert.equal(after.agentOnline, true)
  const notice = after.conversation.find((e) => e.role === 'system' && /開啟新 session/.test(e.text))
  assert.ok(notice, 'the thread tells the user the agent came back without its context')
})

test('ending the session drops the agent, so a restore does not resurrect it', async () => {
  const live = await world.liveDaemon()
  const found = await world.control(
    live.port,
    `/control/sessions/find?origin=${encodeURIComponent(new URL(TARGET).origin)}`,
  )
  const { port } = (await found.json()) as { port: number }
  const res = await fetch(`http://127.0.0.1:${port}/__eztweak/api/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'user' }),
  })
  assert.equal(res.status, 200)

  const sessionDirs = readdirSync(join(world.dataDir, 'sessions'))
  const persisted = JSON.parse(
    readFileSync(join(world.dataDir, 'sessions', sessionDirs[0]!, 'session.json'), 'utf8'),
  ) as { agent?: string; state: string }
  assert.equal(persisted.state, 'ended')
  assert.equal(persisted.agent, undefined)
})

test('a session whose last port is taken comes back on another one, not on none', async () => {
  const live = await world.liveDaemon()
  const origin = 'http://127.0.0.1:10'
  const opened = await world.openSession(live.port, { url: `${origin}/`, project: PROJECT })
  await world.stopDaemon(live.port)

  const squatter = createServer().listen(opened.port, '127.0.0.1')
  await new Promise((r) => squatter.once('listening', r))
  try {
    world.spawnDaemon()
    const next = await world.liveDaemon()
    const found = await world.control(
      next.port,
      `/control/sessions/find?origin=${encodeURIComponent(origin)}`,
    )
    assert.equal(found.status, 200)
    const { port } = (await found.json()) as { port: number }
    assert.notEqual(port, opened.port)
    const state = await world.state(port)
    assert.equal(state.targetOrigin, origin)
  } finally {
    squatter.close()
  }
})

test('the update endpoint takes only the JSON requests the shell makes', async () => {
  const live = await world.liveDaemon()
  const { port } = await world.openSession(live.port, {
    url: 'http://127.0.0.1:11/',
    project: PROJECT,
  })
  const url = `http://127.0.0.1:${port}/__eztweak/api/update`
  const formPost = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '',
  })
  assert.equal(formPost.status, 415)
  const shellPost = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(shellPost.status, 409, 'nothing to update in a test world, but the request got through')
})

test('the restart notice is not repeated, and an empty thread never gets one', async () => {
  const origin = 'http://127.0.0.1:12'
  const live = await world.liveDaemon()
  const opened = await world.openSession(live.port, {
    url: `${origin}/`,
    project: PROJECT,
    agent: FAKE_AGENT,
  })

  const notices = async (port: number) => {
    const s = (await world.state(port)) as unknown as State
    return s.conversation.filter((e) => e.role === 'system' && /開啟新 session/.test(e.text)).length
  }

  // Nothing has been said on this session, so the first restart has no context
  // to report the loss of.
  await world.stopDaemon(live.port)
  world.spawnDaemon()
  let daemon = await world.liveDaemon()
  await acpIdle(opened.port)
  assert.equal(await notices(opened.port), 0)

  // Something in the thread, then two restarts back to back: the loss is real
  // once, and the second restart reports nothing new.
  await world.sendFeedback(opened.port, 'x')

  for (let i = 0; i < 2; i++) {
    await world.stopDaemon(daemon.port)
    world.spawnDaemon()
    daemon = await world.liveDaemon()
    await acpIdle(opened.port)
  }
  assert.equal(await notices(opened.port), 1)
})

// Before the agent was persisted and restored, an ACP child was only ever
// spawned from a CLI running inside the project, so a missing cwd was
// unreachable. On restore it is not: `spawn` reports it asynchronously with no
// `exit` event, and an unhandled 'error' would take the daemon - and every other
// session with it - down at startup.
test('a restored session whose project is gone reports a dead agent, not a dead daemon', async () => {
  const live = await world.liveDaemon()
  const gone = mkdtempSync(join(tmpdir(), 'eztweak-vanishing-'))
  const origin = 'http://127.0.0.1:13'
  const opened = await world.openSession(live.port, {
    url: `${origin}/`,
    project: gone,
    agent: FAKE_AGENT,
  })
  await acpIdle(opened.port)

  await world.stopDaemon(live.port)
  rmSync(gone, { recursive: true, force: true })
  world.spawnDaemon()
  const next = await world.liveDaemon()

  // The other session on this daemon is still served, which is the point.
  const others = await world.control(next.port, '/control/sessions')
  assert.equal(others.status, 200)
  assert.ok(((await others.json()) as unknown[]).length > 1)

  const found = await world.control(
    next.port,
    `/control/sessions/find?origin=${encodeURIComponent(origin)}`,
  )
  assert.equal(found.status, 200)
  const { port } = (await found.json()) as { port: number }
  const state = await waitFor(async () => {
    const s = (await world.state(port)) as unknown as State & { acp?: { error?: string } }
    return s.acp?.state === 'exited' ? s : null
  }, 'the agent to report that it could not start')
  assert.match(state.acp?.error ?? '', /could not start|exited/)
  assert.equal(state.agentOnline, false)
})
