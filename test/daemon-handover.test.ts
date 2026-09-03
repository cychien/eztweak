import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const world = new DaemonWorld(4450)
after(() => world.dispose())

const TARGET = 'http://127.0.0.1:9/'
const ORIGIN = new URL(TARGET).origin

interface State {
  agentOnline: boolean
  acp?: { state: string }
  conversation: { role: string; text: string }[]
}

test('a successor registers first, waits for the predecessor, then takes its sessions and ports', async () => {
  world.spawnDaemon()
  const old = await world.liveDaemon()
  const opened = await world.openSession(old.port, {
    url: TARGET,
    project: world.dataDir,
    agent: FAKE_AGENT,
  })
  await waitFor(async () => {
    const s = (await world.state(opened.port)) as unknown as State
    return s.acp?.state === 'idle' ? s : null
  }, 'the first agent to go idle')
  // The restart notice is only owed when there was context to lose, so the
  // thread has to hold something before the handover.
  await world.sendFeedback(opened.port, 'tighten the hero spacing')

  world.spawnDaemon(['--succeed', String(old.pid)])
  const successor = await waitFor(async () => {
    const info = world.registry()
    if (!info || info.pid === old.pid) return null
    const h = await world.health(info.port)
    return h?.ok && h.pid === info.pid ? info : null
  }, 'the successor to register')
  assert.notEqual(successor.port, old.port, 'the old daemon still holds its control port')
  assert.ok((await world.health(old.port))?.ok, 'the predecessor keeps serving meanwhile')

  // Sessions are not there to be found yet - and the lookup waits rather than
  // saying so, because the predecessor is still holding the ports.
  await assert.rejects(
    world.control(successor.port, `/control/sessions/find?origin=${encodeURIComponent(ORIGIN)}`, {
      signal: AbortSignal.timeout(700),
    }),
    /abort|timeout/i,
  )

  // The predecessor lets go. Its stop must not take the successor's registry
  // entry down with it.
  await world.stopDaemon(old.port)
  assert.equal(world.registry()?.pid, successor.pid)

  const found = await world.control(
    successor.port,
    `/control/sessions/find?origin=${encodeURIComponent(ORIGIN)}`,
  )
  assert.equal(found.status, 200)
  const { port } = (await found.json()) as { port: number }
  assert.equal(port, opened.port, 'the session came back on the port the shell already has')

  const state = await waitFor(async () => {
    const s = (await world.state(port)) as unknown as State
    return s.acp?.state === 'idle' ? s : null
  }, 'the restored agent to go idle')
  assert.equal(state.agentOnline, true)
  assert.ok(state.conversation.some((e) => e.role === 'system' && /開啟新 session/.test(e.text)))
})
