import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'
import { targets, watchAll } from './build.mjs'
import {
  CLI,
  DEV_CONTROL_PORT,
  DEV_DATA_DIR,
  FIXTURE_ROOT,
  TARGET_FILE,
  delay,
  devEnv,
  runCli,
} from './dev-env.mjs'

const noPlugin = process.argv.includes('--no-plugin')
const log = (msg) => console.log(`\x1b[36m[dev]\x1b[0m ${msg}`)
const warn = (msg) => console.log(`\x1b[33m[dev]\x1b[0m ${msg}`)

let shuttingDown = false
let daemon = null
let disposeWatch = null
let vite = null

/** A daemon that finds a live one in its control range writes the registry and
 *  exits 0 instead of serving. Restarting into that is an infinite loop, so an
 *  unexpected exit is only ever retried when the port is genuinely free. */
async function daemonOnPort() {
  try {
    const res = await fetch(`http://127.0.0.1:${DEV_CONTROL_PORT}/control/health`, {
      signal: AbortSignal.timeout(800),
    })
    if (!res.ok) return null
    const body = await res.json()
    return body?.service === 'eztweak' ? body : null
  } catch {
    return null
  }
}

/** A daemon that keeps crashing is almost always the edit under test, and a 4Hz
 *  respawn loop buries the stack trace that says so. Give up after this many
 *  crashes inside the window and wait for the next save to try again. */
const CRASH_GIVE_UP_COUNT = 3
const CRASH_WINDOW_MS = 5000
let crashTimes = []

function startDaemon() {
  daemon = spawn(process.execPath, [CLI, '__daemon'], {
    env: devEnv,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const child = daemon
  child.on('exit', async (code) => {
    if (shuttingDown || child !== daemon) return
    const squatter = await daemonOnPort()
    if (squatter) {
      warn(`daemon exited (${code}) - 127.0.0.1:${DEV_CONTROL_PORT} is held by pid ${squatter.pid}`)
      warn('stop it with `npm run dev:cli stop`, then re-run `npm run dev`')
      await shutdown()
      return
    }
    const now = Date.now()
    crashTimes = [...crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now]
    if (crashTimes.length >= CRASH_GIVE_UP_COUNT) {
      daemon = null
      crashTimes = []
      warn(`daemon exited (${code}) ${CRASH_GIVE_UP_COUNT} times in a row - it does not boot`)
      warn('fix the error above; the next successful build restarts it')
      return
    }
    warn(`daemon exited (${code}); restarting`)
    await delay(250)
    if (!shuttingDown && child === daemon) startDaemon()
  })
}

/** `npm run dev` must be idempotent after a hard kill: the dev control port is
 *  dev mode's alone, so anything still on it is our own orphan to clear. */
async function clearStrayDaemon() {
  const stray = await daemonOnPort()
  if (!stray) return
  warn(`clearing an orphaned dev daemon on ${DEV_CONTROL_PORT} (pid ${stray.pid})`)
  await fetch(`http://127.0.0.1:${DEV_CONTROL_PORT}/control/stop`, { method: 'POST' }).catch(
    () => {},
  )
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!(await daemonOnPort())) return
    await delay(150)
  }
  throw new Error(`could not clear the daemon on ${DEV_CONTROL_PORT} (pid ${stray.pid})`)
}

/** Resolves once the daemon we just spawned is the one answering - matching on
 *  pid, because a restart usually reclaims the same port and a stale registry
 *  from the previous one would otherwise look healthy. */
async function waitForDaemon(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEV_CONTROL_PORT}/control/health`, {
        signal: AbortSignal.timeout(1000),
      })
      const body = res.ok ? await res.json() : null
      if (body?.ok && body.pid === daemon?.pid) return
    } catch {
      /* not up yet */
    }
    await delay(150)
  }
  throw new Error(`dev daemon did not come up on 127.0.0.1:${DEV_CONTROL_PORT}`)
}

/** Resolves once the child is really gone. SIGTERM alone is not enough: a daemon
 *  wedged by the edit under test never runs its handler, and the orphan it leaves
 *  on the control port cannot be cleared on the next run either. */
async function killDaemon(child, graceMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const dead = once(child, 'exit')
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), graceMs)
  try {
    await dead
  } finally {
    clearTimeout(force)
  }
}

/** Never overlaps two daemons: the replacement would find the dying one still
 *  listening in its range and adopt it instead of taking over. */
async function restartDaemon() {
  const dying = daemon
  daemon = null
  await killDaemon(dying)
  startDaemon()
  await waitForDaemon()
  log('daemon restarted - in-flight polls reconnect on their own')
}

let restartChain = Promise.resolve()
let restartPending = false

/** Coalesces the burst of rebuilds one save produces, then serialises what is
 *  left. A plain pre-restart flag only debounces the window before a restart, so
 *  two saves a blink apart would run `restartDaemon` concurrently. */
function onNodeRebuild() {
  if (restartPending) return restartChain
  restartPending = true
  restartChain = restartChain.then(async () => {
    await delay(50)
    restartPending = false
    if (shuttingDown) return
    await restartDaemon().catch((err) => warn(`restart failed: ${err.message}`))
  })
  return restartChain
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('')
  log('shutting down')
  await Promise.allSettled([killDaemon(daemon), disposeWatch?.(), vite?.close()])
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

const builtOnce = new Set()
let firstBuildDone
const firstBuild = new Promise((resolve) => {
  firstBuildDone = resolve
})

disposeWatch = await watchAll((group, outfile, result) => {
  if (result.errors.length) {
    warn(`build failed: ${outfile}`)
    return
  }
  if (!builtOnce.has(outfile)) {
    builtOnce.add(outfile)
    if (builtOnce.size === targets.length) firstBuildDone()
    return
  }
  if (group === 'node') {
    log(`${outfile} changed - restarting daemon`)
    void onNodeRebuild()
  } else {
    log(`${outfile} changed - reload the browser`)
  }
})
await firstBuild
log('watching src/')

vite = await createServer({
  root: FIXTURE_ROOT,
  configFile: join(FIXTURE_ROOT, noPlugin ? 'vite.noplugin.config.ts' : 'vite.config.ts'),
})
await vite.listen()
const targetUrl = vite.resolvedUrls?.local?.[0]
if (!targetUrl) throw new Error('vite did not report a local url')
log(`fixture on ${targetUrl}${noPlugin ? ' (no eztweakSource - anchors have no source)' : ''}`)

mkdirSync(DEV_DATA_DIR, { recursive: true })
writeFileSync(TARGET_FILE, JSON.stringify({ url: targetUrl }, null, 2))

await clearStrayDaemon()
startDaemon()
await waitForDaemon()
await runCli([targetUrl])

log('review shell open. next: `npm run dev:agent` in another terminal')
