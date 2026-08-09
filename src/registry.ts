import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DAEMON_LOG, DATA_DIR, REGISTRY_FILE } from './constants.js'

export interface DaemonInfo {
  port: number
  pid: number
  startedAt: number
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

export function clearRegistry(): void {
  rmSync(REGISTRY_FILE, { force: true })
}

/** Confirms the port is serving *our* daemon, not just something that answers.
 *  A registry left behind by a killed daemon can otherwise point at whatever
 *  later took the port — including an older daemon from a previous build. */
async function isHealthy(port: number, pid: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/control/health`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { ok?: boolean; pid?: number }
    return body.ok === true && body.pid === pid
  } catch {
    return false
  }
}

export async function findRunningDaemon(): Promise<DaemonInfo | null> {
  const info = readRegistry()
  if (!info) return null
  if (await isHealthy(info.port, info.pid)) return info
  clearRegistry()
  return null
}

/** Start the daemon (detached) if it is not already running; resolve to its info. */
export async function ensureDaemon(cliEntry: string): Promise<DaemonInfo> {
  const running = await findRunningDaemon()
  if (running) return running

  mkdirSync(DATA_DIR, { recursive: true })
  const log = openSync(DAEMON_LOG, 'a')
  const child = spawn(process.execPath, [cliEntry, '__daemon'], {
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()

  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    const info = await findRunningDaemon()
    if (info) return info
  }
  throw new Error(`daemon failed to start within 8s (see ${DAEMON_LOG})`)
}
