import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const world = new DaemonWorld(4470)
after(() => world.dispose())

/** Every entry the thread holds, in order. */
async function thread(port: number): Promise<{ role: string; text: string }[]> {
  const state = (await world.state(port)) as { conversation?: { role: string; text: string }[] }
  return state.conversation ?? []
}

// A turn that ran to its own end without a word wrote nothing at all: the user's
// message sat there with no reply and no explanation, which is indistinguishable
// from a turn still running. There is no other way to tell waiting from finished,
// so the thread has to say which it is.
test('a turn that ends without saying anything still says so', async () => {
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const { port } = await world.openSession(control, {
    url: 'http://localhost:9997',
    project: world.dataDir,
    agent: FAKE_AGENT,
  })
  await waitFor(async () => {
    const s = (await world.state(port)) as { acp?: { state?: string } }
    return s.acp?.state === 'idle'
  }, 'the agent to be ready')

  await fetch(`http://127.0.0.1:${port}/__eztweak/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'SILENT' }),
  })

  const note = await waitFor(
    async () => (await thread(port)).find((e) => e.role === 'system' && e.text.includes('沒有回覆')),
    'the thread to account for the silent turn',
  )
  assert.match(note.text, /這一輪結束了/)

  // And the turn is over as far as everything else is concerned - a note that
  // arrived while the agent was still held busy would be worse than none.
  const idle = (await world.state(port)) as { acp?: { state?: string } }
  assert.equal(idle.acp?.state, 'idle')
})
