import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const world = new DaemonWorld(4460)
after(() => world.dispose())

/** A project with two skills on disk. The daemon checks every name a batch sends
 *  against these before it will build a prompt out of them. */
function projectWithSkills(): string {
  const project = join(world.dataDir, 'project')
  for (const name of ['dataviz', 'review-pass']) {
    const dir = join(project, '.claude', 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\nhi\n`)
  }
  return project
}

const api = (port: number, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/__eztweak/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** What the agent was actually handed. The fake agent answers `REPORT` with every
 *  prompt it has seen, which is the only place the assembled turn is visible. */
async function promptsSeen(port: number): Promise<string[]> {
  await api(port, '/send', { note: 'REPORT' })
  const said = await waitFor(async () => {
    const state = (await world.state(port)) as {
      conversation?: { role: string; text: string }[]
    }
    return state.conversation?.find((e) => e.role === 'agent' && e.text.includes('prompts'))
  }, 'the agent to report')
  const report = JSON.parse(said.text) as { prompts: { text: string }[] }
  return report.prompts.map((p) => p.text)
}

// The one seam the unit tests cannot reach: the turn the daemon actually builds.
// Everything below it - which prefix, which marker - is tested in isolation; this
// is whether they are wired together in the right order.
test('a batch naming skills is delivered with them spent and the first hoisted', async () => {
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const project = projectWithSkills()
  const { port } = await world.openSession(control, {
    url: 'http://localhost:9999',
    project,
    agent: FAKE_AGENT,
  })
  await waitFor(async () => {
    const s = (await world.state(port)) as { acp?: { state?: string } }
    return s.acp?.state === 'idle'
  }, 'the agent to be ready')

  await api(port, '/send', {
    note: '先 [skill 1] 再 [skill 2] 收尾',
    skills: ['dataviz', 'review-pass'],
  })
  const prompts = await promptsSeen(port)
  const turn = prompts.find((t) => t.includes('收尾'))
  assert.ok(turn, `no turn carried the note: ${JSON.stringify(prompts)}`)

  // The first is hoisted to its own leading line, because that is the only one
  // an agent expands. The prefix is `$` here: the fake agent is nobody's profile,
  // so it is handed the user's own text untranslated.
  assert.equal(turn.split('\n')[0], '$dataviz')
  // And every marker in the sentence is spent, including the one that was hoisted
  // - the note is what the user wrote, not a copy with a hole in it.
  assert.match(turn, /先 \$dataviz 再 \$review-pass 收尾/)
  assert.doesNotMatch(turn, /\[skill \d\]/)
})

// The names become instructions in somebody's prompt, so nothing reaches one
// without having been found on disk first.
test('a batch naming a skill that is not installed is refused', async () => {
  const { port: control } = await world.liveDaemon()
  const { port } = await world.openSession(control, {
    url: 'http://localhost:9998',
    project: projectWithSkills(),
    agent: FAKE_AGENT,
  })
  const res = await api(port, '/send', { note: 'x', skills: ['dataviz', 'not-a-skill'] })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /unknown skill/)
})
