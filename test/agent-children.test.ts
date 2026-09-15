import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.EZTWEAK_DATA_DIR = mkdtempSync(join(tmpdir(), 'eztweak-agents-'))

const { clearAgentRecord, killGroup, reapOrphanedAgents, trackAgent, untrackAgent } = await import(
  '../src/agent-children.js'
)
const { DATA_DIR } = await import('../src/constants.js')
const FILE = join(DATA_DIR, 'agent-children.json')

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const settle = () => new Promise((r) => setTimeout(r, 400))

/** A shell that spawns a child of its own and then waits, which is the shape an
 *  agent has: what the daemon holds is the shell, and the agent is below it. */
function spawnAgentLike(): { pid: number; command: string; descendants: () => number[] } {
  const script = join(DATA_DIR, 'fake-agent.js')
  writeFileSync(
    script,
    `require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1e9)'],{stdio:'ignore'})\nsetTimeout(()=>{},1e9)\n`,
  )
  const command = `node ${script}`
  const child = spawn(command, { shell: true, detached: true, stdio: 'ignore' })
  // Detached *and* unreferenced, or the test process waits on a child it only
  // spawned to kill.
  child.unref()
  const pid = child.pid!
  const descendants = (): number[] => {
    const out: number[] = []
    const walk = (p: number): void => {
      let kids: number[] = []
      try {
        kids = execFileSync('pgrep', ['-P', String(p)], { encoding: 'utf8' })
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(Number)
      } catch {
        /* none */
      }
      for (const k of kids) {
        out.push(k)
        walk(k)
      }
    }
    walk(pid)
    return out
  }
  return { pid, command, descendants }
}

// The whole point of the process group: what the daemon holds is a shell, and
// the agent is below it. Signalling the shell alone leaves the agent running -
// which is how an orphan survived a clean shutdown, not only a kill -9.
test('killing an agent takes the processes below it too', async () => {
  const agent = spawnAgentLike()
  await settle()
  const below = agent.descendants()
  assert.ok(below.length > 0, 'the fake agent should have spawned something below it')

  killGroup(agent.pid)
  await settle()
  assert.equal(alive(agent.pid), false)
  assert.deepEqual(
    below.filter(alive),
    [],
    'a process below the shell must not survive the shell',
  )
})

test('a tracked agent is written down and forgotten again', () => {
  clearAgentRecord()
  trackAgent(4242, 'npx -y some-agent')
  const written = JSON.parse(readFileSync(FILE, 'utf8')) as {
    daemonPid: number
    children: { pid: number; command: string }[]
  }
  assert.equal(written.daemonPid, process.pid)
  assert.deepEqual(written.children, [{ pid: 4242, command: 'npx -y some-agent' }])

  untrackAgent(4242)
  assert.deepEqual(
    (JSON.parse(readFileSync(FILE, 'utf8')) as { children: unknown[] }).children,
    [],
  )
})

test('a clean shutdown leaves no note behind', () => {
  trackAgent(4243, 'npx -y some-agent')
  assert.equal(existsSync(FILE), true)
  clearAgentRecord()
  assert.equal(existsSync(FILE), false)
})

// The one that matters. A pid is reused, so a note days old can name something
// else entirely - and this kills process *groups*, which makes a wrong guess
// worse than usual. Only a pid still running the command it was written down
// with is a confirmed target.
test('a pid now running something else is left alone', async () => {
  const bystander = spawnAgentLike()
  await settle()
  clearAgentRecord()
  writeFileSync(
    FILE,
    JSON.stringify({
      daemonPid: 999999,
      children: [{ pid: bystander.pid, command: 'npx -y a-completely-different-agent' }],
    }),
  )

  assert.equal(reapOrphanedAgents(), 0, 'nothing was confirmed, so nothing was killed')
  await settle()
  assert.equal(alive(bystander.pid), true, 'the bystander must survive')
  killGroup(bystander.pid)
})

test('an agent left by a dead daemon is reaped, whole', async () => {
  const orphan = spawnAgentLike()
  await settle()
  const below = orphan.descendants()
  clearAgentRecord()
  writeFileSync(
    FILE,
    // A daemon pid that cannot be running: the note has no owner left.
    JSON.stringify({ daemonPid: 999999, children: [{ pid: orphan.pid, command: orphan.command }] }),
  )

  assert.equal(reapOrphanedAgents(), 1)
  await settle()
  assert.equal(alive(orphan.pid), false)
  assert.deepEqual(below.filter(alive), [], 'the tail below it goes too')
})

// A note whose daemon is still alive describes agents in use, not orphans.
test('agents belonging to a live daemon are not touched', async () => {
  const inUse = spawnAgentLike()
  await settle()
  clearAgentRecord()
  writeFileSync(
    FILE,
    // This test process stands in for a daemon that is very much running - but
    // not this one, so ownership is what spares it rather than identity.
    JSON.stringify({
      daemonPid: inUse.pid,
      children: [{ pid: inUse.pid, command: inUse.command }],
    }),
  )

  assert.equal(reapOrphanedAgents(), 0)
  await settle()
  assert.equal(alive(inUse.pid), true)
  killGroup(inUse.pid)
})

test('a missing note is not an error', () => {
  clearAgentRecord()
  assert.equal(reapOrphanedAgents(), 0)
})
