import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import open, { apps } from 'open'
import {
  DEFAULT_CONTROL_PORT,
  PKG_NAME,
  POLL_RETRIES,
  URL_PREFIX,
  assertControlPortEnv,
} from './constants.js'
import { daemonMain } from './daemon.js'
import { ensureDaemon, findRunningDaemon } from './registry.js'
import { VERSION_HEADER } from './version.js'
import type { PollResult } from './protocol.js'

const cliEntry = fileURLToPath(import.meta.url)
const pkg = JSON.parse(readFileSync(join(dirname(cliEntry), '../package.json'), 'utf8')) as {
  version: string
}

const HELP = `${PKG_NAME} - annotate your live dev app, feedback flows to your local agent

Usage:
  ${PKG_NAME} <url> [--reopen]
      open (or resume) a review session for a dev server
  ${PKG_NAME} poll <url> [--agent-reply <msg>]
      block until the user sends feedback; prints JSON, then exits
  ${PKG_NAME} end <url>
      end the session as the agent
  ${PKG_NAME} status | stop
      show session status / stop the background daemon
  ${PKG_NAME} --version | --help

Environment:
  ${PKG_NAME.toUpperCase()}_DATA_DIR       session state, daemon registry and log (default: ~/.${PKG_NAME})
  ${PKG_NAME.toUpperCase()}_CONTROL_PORT   first port of the daemon's ten-port control range (default: ${DEFAULT_CONTROL_PORT})
      Set both to run an isolated second instance: a starting daemon adopts any
      live daemon inside its own control range, so a separate data dir alone
      still lands you on the shared one.

A restarted daemon picks its sessions back up from disk and re-binds each to the
port it last held, so an open review shell only needs a reload and queued
feedback is still there.

A session is scoped to the project you run this from (nearest .git or
package.json), not to the url alone, so two projects sharing a dev-server port
never see each other's review.

Examples:
  ${PKG_NAME} http://localhost:5173/
  ${PKG_NAME} poll http://localhost:5173/ --agent-reply "改好了 hero 區塊，請再看一次"
`

/** Which project this review belongs to. Anchored at the repo (or package) root
 *  rather than the raw cwd, so opening a session from a subdirectory resolves to
 *  the same session as opening it from the top. */
function projectRoot(): string {
  let dir = resolve(process.cwd())
  const { root } = parse(dir)
  for (;;) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) return dir
    if (dir === root) return resolve(process.cwd())
    dir = dirname(dir)
  }
}

function fail(message: string, hint?: string): never {
  console.error(`error: ${message}`)
  if (hint) console.error(`hint: ${hint}`)
  process.exit(1)
}

function parseTarget(raw: string | undefined): URL {
  if (!raw) fail('missing <url>', `e.g. ${PKG_NAME} http://localhost:5173/`)
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
    return url
  } catch {
    fail(`invalid url: ${raw}`)
  }
}

const versionedHeaders = { 'content-type': 'application/json', [VERSION_HEADER]: pkg.version }

async function controlFetch(
  daemonPort: number,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${daemonPort}${path}`, {
    headers: versionedHeaders,
    ...init,
  })
}

/** A 409 is the daemon refusing a version skew — retrying cannot fix it, so it
 *  is fatal even on paths that otherwise ride out failures. */
async function failOnVersionSkew(res: Response): Promise<void> {
  if (res.status !== 409) return
  const body = (await res.json()) as { error?: string; hint?: string }
  fail(body.error ?? 'version mismatch with the daemon', body.hint)
}

/** `quiet` keeps a mid-poll reconnect from exiting while retries remain. */
async function findSessionPort(target: URL, opts?: { quiet?: boolean }): Promise<number> {
  const bail = (message: string): number => {
    if (opts?.quiet) return 0
    fail(message, `run \`${PKG_NAME} ${target.href}\` first to open a session`)
  }
  const daemon = await findRunningDaemon()
  if (!daemon) return bail('daemon is not running')
  const res = await controlFetch(
    daemon.port,
    `/control/sessions/find?origin=${encodeURIComponent(target.origin)}`,
  )
  await failOnVersionSkew(res)
  if (!res.ok) return bail(`no session for ${target.origin}`)
  const { port } = (await res.json()) as { port: number }
  return port
}

const sessionApi = (port: number, path: string) =>
  `http://127.0.0.1:${port}${URL_PREFIX}/api${path}`

/** Always give the shell its own browser window: a fresh window starts with a
 *  single history entry, which is the only condition under which the shell is
 *  allowed to close itself when the user ends the review. Falls back to a plain
 *  open when the default browser takes no `--new-window` (e.g. Safari). */
async function openShell(shellUrl: string): Promise<void> {
  try {
    await open(shellUrl, {
      newInstance: true,
      app: { name: apps.browser, arguments: ['--new-window'] },
    })
  } catch {
    await open(shellUrl)
  }
}

async function cmdOpen(rawUrl: string | undefined, flags: Set<string>): Promise<void> {
  const target = parseTarget(rawUrl)
  try {
    await fetch(target.origin, { signal: AbortSignal.timeout(3000) })
  } catch {
    fail(
      `nothing is listening at ${target.origin}`,
      'start your dev server first, then re-run this command',
    )
  }
  const daemon = await ensureDaemon(cliEntry, pkg.version)
  const res = await controlFetch(daemon.port, '/control/sessions', {
    method: 'POST',
    body: JSON.stringify({
      url: target.href,
      reopen: flags.has('--reopen'),
      project: projectRoot(),
    }),
  })
  const body = (await res.json()) as { shellUrl?: string; error?: string; hint?: string }
  if (!res.ok) fail(body.error ?? `daemon returned ${res.status}`, body.hint)
  await openShell(body.shellUrl!)
  console.log(`session: ${target.origin}`)
  console.log(`shell:   ${body.shellUrl}`)
  console.log(`next:    run \`${PKG_NAME} poll ${target.origin}/\` and wait for feedback`)
}

async function cmdPoll(rawUrl: string | undefined, reply: string | undefined): Promise<void> {
  const target = parseTarget(rawUrl)
  let port = await findSessionPort(target)
  if (reply?.trim()) {
    const res = await fetch(sessionApi(port, '/agent/reply'), {
      method: 'POST',
      headers: versionedHeaders,
      body: JSON.stringify({ message: reply.trim() }),
    })
    await failOnVersionSkew(res)
    if (!res.ok) fail(`failed to deliver --agent-reply (${res.status})`)
  }
  let attempt = 0
  for (;;) {
    let result: PollResult | { type: 'timeout' }
    try {
      const res = await fetch(sessionApi(port, '/agent/poll'), { headers: versionedHeaders })
      // Reached when a poll reconnects straight to a session port that a
      // restarted, different-version daemon re-bound — `find` never ran.
      await failOnVersionSkew(res)
      result = (await res.json()) as PollResult | { type: 'timeout' }
      attempt = 0
    } catch {
      if (++attempt > POLL_RETRIES) {
        fail(
          'lost connection to the daemon',
          `re-run \`${PKG_NAME} poll ${target.origin}/\` — queued feedback is never lost`,
        )
      }
      await new Promise((r) => setTimeout(r, Math.min(4000, 400 * 2 ** (attempt - 1))))
      // A restarted daemon only prefers the port this session last held, so the
      // port may have moved - re-resolve instead of retrying a dead URL.
      port = await findSessionPort(target, { quiet: attempt <= POLL_RETRIES })
      continue
    }
    if (result.type === 'timeout') continue
    if (result.type === 'feedback') {
      await fetch(sessionApi(port, '/agent/ack'), {
        method: 'POST',
        headers: versionedHeaders,
        body: JSON.stringify({ batchId: result.batchId }),
      }).catch(() => {})
    }
    console.log(JSON.stringify(result, null, 2))
    return
  }
}

async function cmdEnd(rawUrl: string | undefined): Promise<void> {
  const target = parseTarget(rawUrl)
  const port = await findSessionPort(target)
  await fetch(sessionApi(port, '/end'), {
    method: 'POST',
    headers: versionedHeaders,
    body: JSON.stringify({ by: 'agent' }),
  })
  console.log(`session for ${target.origin} ended`)
}

async function cmdStatus(): Promise<void> {
  const daemon = await findRunningDaemon()
  if (!daemon) {
    console.log('daemon: not running')
    return
  }
  console.log(`daemon: running (v${daemon.version}, pid ${daemon.pid}, control port ${daemon.port})`)
  const res = await controlFetch(daemon.port, '/control/sessions')
  await failOnVersionSkew(res)
  const sessions = (await res.json()) as {
    targetOrigin: string
    project: string
    port: number
    state: string
  }[]
  if (sessions.length === 0) console.log('sessions: none')
  for (const s of sessions) {
    console.log(`session: ${s.targetOrigin} → 127.0.0.1:${s.port} (${s.state})`)
    console.log(`         project: ${s.project}`)
  }
}

async function cmdStop(): Promise<void> {
  const daemon = await findRunningDaemon()
  if (!daemon) {
    console.log('daemon: not running')
    return
  }
  await controlFetch(daemon.port, '/control/stop', { method: 'POST' })
  console.log('daemon stopped')
}

async function main(): Promise<void> {
  assertControlPortEnv()
  const argv = process.argv.slice(2)
  const [first, ...rest] = argv
  const flags = new Set(argv.filter((a) => a.startsWith('--')))

  if (!first || first === '--help' || first === '-h' || first === 'help') {
    console.log(HELP)
    return
  }
  if (first === '--version' || first === '-v') {
    console.log(pkg.version)
    return
  }

  switch (first) {
    case '__daemon':
      return daemonMain(pkg.version)
    case 'poll': {
      const replyIdx = rest.indexOf('--agent-reply')
      const reply = replyIdx >= 0 ? rest[replyIdx + 1] : undefined
      return cmdPoll(rest[0], reply)
    }
    case 'end':
      return cmdEnd(rest[0])
    case 'status':
      return cmdStatus()
    case 'stop':
      return cmdStop()
    default:
      return cmdOpen(first, flags)
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
