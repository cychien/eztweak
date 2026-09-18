/** Agent processes, killed whole and killed even when this daemon is not around
 *  to do it.
 *
 *  Two problems, and they compound. An ACP agent is started through a shell, so
 *  what this daemon holds is `sh -c "npx ..."` and the agent itself is somewhere
 *  below it - signalling the child alone leaves that tail running. And a daemon
 *  killed outright, by `kill -9` or the OOM killer, runs no exit handler at all,
 *  so nothing signals anything.
 *
 *  So: every agent is spawned into its own process group and killed by group,
 *  which takes the whole tree; and the groups are written down, so the next
 *  daemon to start can finish what a killed one could not. That second part
 *  matters most exactly when it is hardest to notice - an agent orphaned by the
 *  OOM killer goes on holding the memory that caused it, and goes on holding a
 *  login that costs the user money. */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './constants.js'

const FILE = join(DATA_DIR, 'agent-children.json')

interface Record_ {
  /** The daemon that owns these. A live one still owns them; anything else has
   *  left them behind. */
  daemonPid: number
  children: { pid: number; command: string }[]
}

/** Live groups, by leader pid, with the command each was started with. */
const live = new Map<number, string>()

function read(): Record_ | null {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Record_
  } catch {
    return null
  }
}

function write(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const record: Record_ = {
      daemonPid: process.pid,
      children: [...live].map(([pid, command]) => ({ pid, command })),
    }
    writeFileSync(FILE, JSON.stringify(record, null, 2))
  } catch {
    /* best effort - losing the note costs a reap, not a daemon */
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether `pid` is still the process that was written down.
 *
 *  The whole of the care in this module. Pids are reused, and the note can be
 *  days old, so killing one on the strength of its number alone eventually kills
 *  something else - and this kills process *groups*, which makes that worse than
 *  usual. The command line is what settles it: a recycled pid running something
 *  else does not match, and is left alone. */
function isStillTheAgent(pid: number, command: string): boolean {
  try {
    const actual = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return actual.length > 0 && actual.includes(command)
  } catch {
    // No such process, or `ps` is not answering. Either way this is not a
    // confirmed target, and an unconfirmed one is never killed.
    return false
  }
}

/** Kill one group, whole. Falls back to the leader alone: a child that was not
 *  spawned into its own group has no group to take, and killing what we can beat
 *  killing nothing. */
export function killGroup(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* already gone */
    }
  }
}

export function trackAgent(pid: number, command: string): void {
  live.set(pid, command)
  write()
}

export function untrackAgent(pid: number): void {
  if (live.delete(pid)) write()
}

/** Kill every group this daemon still holds. For its own exit. */
export function killTrackedAgents(): void {
  for (const pid of live.keys()) killGroup(pid)
}

/**
 * Kill agents a previous daemon left behind, and take ownership of the note.
 *
 * Skipped entirely while the daemon named in the note is still alive: it owns
 * those agents and is presumably using them. Only a note whose owner is gone
 * describes orphans.
 */
export function reapOrphanedAgents(): number {
  const record = read()
  if (!record) {
    write()
    return 0
  }
  if (record.daemonPid !== process.pid && running(record.daemonPid)) return 0
  let killed = 0
  for (const { pid, command } of record.children ?? []) {
    if (pid === process.pid || !isStillTheAgent(pid, command)) continue
    killGroup(pid)
    killed++
  }
  write()
  return killed
}

/** For a daemon shutting down cleanly: the note describes nothing any more. */
export function clearAgentRecord(): void {
  live.clear()
  try {
    rmSync(FILE, { force: true })
  } catch {
    /* best effort */
  }
}
