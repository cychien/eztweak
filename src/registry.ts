import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DAEMON_LOG, DATA_DIR, REGISTRY_FILE } from './constants.js'

export interface DaemonInfo {
  port: number
  pid: number
  startedAt: number
}

export interface RunningDaemon extends DaemonInfo {
  version: string
}

export function readRegistry(): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as DaemonInfo
  } catch {
    return null
  }
}

export function writeRegistry(info: DaemonInfo): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(REGISTRY_FILE, JSON.stringify(info, null, 2))
}

/** With `pid`, only a registry naming that daemon is cleared: a retiring daemon
 *  must not take its successor's entry down with it. */
export function clearRegistry(pid?: number): void {
  if (pid !== undefined && readRegistry()?.pid !== pid) return
  rmSync(REGISTRY_FILE, { force: true })
}

/** Confirms the port is serving *our* daemon, not just something that answers.
 *  A registry left behind by a killed daemon can otherwise point at whatever
 *  later took the port — including an older daemon from a previous build. */
export async function probeDaemon(port: number, pid: number): Promise<{ version: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/control/health`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { ok?: boolean; pid?: number; version?: string }
    if (body.ok !== true || body.pid !== pid) return null
    return { version: body.version ?? 'unknown' }
  } catch {
    return null
  }
}

export async function findRunningDaemon(): Promise<RunningDaemon | null> {
  const info = readRegistry()
  if (!info) return null
  const probed = await probeDaemon(info.port, info.pid)
  if (probed) return { ...info, version: probed.version }
  clearRegistry()
  return null
}

/** `/control/stop` clears the registry before it responds, and a stopping
 *  daemon's health check turns 503 so a starting one never adopts it. Waits for
 *  the process itself to go: it holds the session ports until it exits, and a
 *  replacement started before then lands its sessions elsewhere, changing every
 *  shell URL the user has open. */
async function stopDaemon(daemon: { port: number; pid: number }): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${daemon.port}/control/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try {
      process.kill(daemon.pid, 0)
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Start a daemon from `cliEntry` and let go of it: detached, logging to the
 *  shared daemon log, outliving whoever launched it. */
export function launchDaemon(cliEntry: string, args: string[] = []): ChildProcess {
  mkdirSync(DATA_DIR, { recursive: true })
  const log = openSync(DAEMON_LOG, 'a')
  const child = spawn(process.execPath, [cliEntry, '__daemon', ...args], {
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  return child
}

async function spawnDaemon(cliEntry: string): Promise<RunningDaemon> {
  launchDaemon(cliEntry)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    const info = await findRunningDaemon()
    if (info) return info
  }
  throw new Error(`daemon failed to start within 8s (see ${DAEMON_LOG})`)
}

/** Resolve to a daemon running exactly `version`. All shell and session logic
 *  lives in the daemon, so a leftover one from a previous version keeps serving
 *  stale behavior forever — replace it instead of adopting it. Sessions survive:
 *  the new daemon restores them from disk onto the ports they last held.
 *  The retry covers a spawned daemon adopting a live older one inside its
 *  control range, which `daemonMain` does without looking at versions. */
export async function ensureDaemon(cliEntry: string, version: string): Promise<RunningDaemon> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const running = (await findRunningDaemon()) ?? (await spawnDaemon(cliEntry))
    if (running.version === version) return running
    await stopDaemon(running)
  }
  throw new Error(`a daemon running another version keeps taking over (see ${DAEMON_LOG})`)
}
