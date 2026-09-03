import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
export const CLI_SRC = join(ROOT, 'src', 'cli.ts')
export const FAKE_AGENT = `node ${join(ROOT, 'test', 'helpers', 'fake-acp-agent.mjs')}`
export const PKG_VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await probe()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await delay(100)
  }
}

/** One isolated daemon world: its own data dir, control range and home, so a
 *  test never meets the developer's real daemon, registry lookups, or skill
 *  installs. Each world picks its range from `controlPort`, which callers keep
 *  distinct across test files. */
export class DaemonWorld {
  readonly dataDir = mkdtempSync(join(tmpdir(), 'eztweak-daemon-'))
  readonly env: NodeJS.ProcessEnv
  readonly children = new Set<ChildProcess>()

  constructor(readonly controlPort: number) {
    this.env = {
      ...process.env,
      EZTWEAK_DATA_DIR: this.dataDir,
      EZTWEAK_CONTROL_PORT: String(controlPort),
      EZTWEAK_NO_UPDATE_CHECK: '1',
      HOME: this.dataDir,
      USERPROFILE: this.dataDir,
    }
  }

  /** Runs the daemon from source, the way the CLI would from `dist`. */
  spawnDaemon(extraArgs: string[] = []): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_SRC, '__daemon', ...extraArgs], {
      env: this.env,
      stdio: 'ignore',
    })
    this.children.add(child)
    child.on('exit', () => this.children.delete(child))
    return child
  }

  registry(): { port: number; pid: number } | null {
    try {
      return JSON.parse(readFileSync(join(this.dataDir, 'daemon.json'), 'utf8'))
    } catch {
      return null
    }
  }

  async health(port: number): Promise<{ ok: boolean; version?: string; pid?: number } | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/control/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (!res.ok) return null
      return (await res.json()) as { ok: boolean; version?: string; pid?: number }
    } catch {
      return null
    }
  }

  /** The daemon that currently owns the registry and answers healthy. */
  async liveDaemon(): Promise<{ port: number; pid: number }> {
    return waitFor(async () => {
      const info = this.registry()
      if (!info) return null
      const h = await this.health(info.port)
      return h?.ok && h.pid === info.pid ? info : null
    }, 'a live daemon')
  }

  async control(port: number, path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-eztweak-version': PKG_VERSION,
        ...(init?.headers ?? {}),
      },
    })
  }

  async openSession(
    controlPort: number,
    body: { url: string; project: string; agent?: string; reopen?: boolean },
  ): Promise<{ port: number; shellUrl: string }> {
    const res = await this.control(controlPort, '/control/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`open session failed: ${res.status} ${await res.text()}`)
    return (await res.json()) as { port: number; shellUrl: string }
  }

  async state(sessionPort: number): Promise<Record<string, unknown>> {
    const res = await fetch(`http://127.0.0.1:${sessionPort}/__eztweak/api/state`)
    return (await res.json()) as Record<string, unknown>
  }

  /** Queue one annotation and send it, which is what puts a user entry - and
   *  whatever the agent replies to it - in the thread. */
  async sendFeedback(sessionPort: number, comment: string): Promise<void> {
    const api = `http://127.0.0.1:${sessionPort}/__eztweak/api`
    const headers = { 'content-type': 'application/json' }
    await fetch(`${api}/annotations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'element', comment, anchor: { selector: 'div' } }),
    })
    await fetch(`${api}/send`, { method: 'POST', headers, body: JSON.stringify({ note: null }) })
  }

  /** Stops the daemon on `port` and waits for its process to be gone, ports
   *  and all - a stopping daemon answers 503 before it has exited. */
  async stopDaemon(port: number): Promise<void> {
    const pid = (await this.health(port))?.pid
    await fetch(`http://127.0.0.1:${port}/control/stop`, { method: 'POST' }).catch(() => {})
    await waitFor(async () => {
      if (pid === undefined) return !(await this.health(port))
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 'daemon to exit')
  }

  async dispose(): Promise<void> {
    const info = this.registry()
    if (info) await this.stopDaemon(info.port).catch(() => {})
    for (const child of this.children) child.kill('SIGKILL')
  }
}
