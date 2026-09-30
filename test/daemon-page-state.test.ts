import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { PageStorage, StorageState } from '../src/page-state.js'
import { findChrome } from '../skills/eztweak/scripts/page.mjs'
import { DaemonWorld, FAKE_AGENT, waitFor } from './helpers/daemon.js'

const world = new DaemonWorld(4640)
const run = promisify(execFile)
const PAGE_SCRIPT = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  'skills/eztweak/scripts/page.mjs',
)

/** An app behind a sign-in: an HttpOnly cookie the server checks, and a token, a tab flag and a
 *  profile record the client checks - one of each place a real app keeps its session. */
const APP = `<!doctype html><title>app</title><script>
  (async () => {
    const profile = await new Promise((ok) => {
      const r = indexedDB.open('auth')
      r.onupgradeneeded = () => r.transaction.abort()
      r.onerror = () => ok(null)
      r.onsuccess = () => {
        const db = r.result
        if (!db.objectStoreNames.contains('users')) return ok(null)
        const get = db.transaction('users').objectStore('users').get('me')
        get.onsuccess = () => ok(get.result ?? null)
        get.onerror = () => ok(null)
      }
    })
    const ok = localStorage.getItem('token') === 't1' && sessionStorage.getItem('tab') === 'a'
    if (!ok || profile?.name !== 'Ada') location.replace('/login')
  })()
</script>`

let target: Server
after(async () => {
  await world.dispose()
  target?.close()
})

async function app(): Promise<string> {
  target = createServer((req, res) => {
    if (req.url?.startsWith('/app') && !/(^|; )sid=s1(;|$)/.test(req.headers.cookie ?? '')) {
      res.writeHead(302, { location: '/login' }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(req.url?.startsWith('/app') ? APP : '<!doctype html><title>sign in</title>')
  })
  await new Promise<void>((ok) => target.listen(0, '127.0.0.1', ok))
  return `http://localhost:${(target.address() as AddressInfo).port}`
}

const STORAGE: PageStorage = {
  localStorage: [{ name: 'token', value: 't1' }],
  sessionStorage: [{ name: 'tab', value: 'a' }],
  indexedDB: [
    {
      name: 'auth',
      version: 1,
      stores: [
        {
          name: 'users',
          autoIncrement: false,
          records: [{ key: 'me', value: { name: 'Ada' } }],
          indexes: [{ name: 'by-name', keyPath: 'name', multiEntry: false, unique: false }],
        },
      ],
    },
  ],
}

async function chromeAvailable(): Promise<boolean> {
  try {
    findChrome()
    return true
  } catch {
    return false
  }
}

test("the agent's browser opens the page signed in the way the user's is", async (t) => {
  const origin = await app()
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const { port } = await world.openSession(control, {
    url: origin,
    project: mkdtempSync(join(world.dataDir, 'project-')),
    agent: FAKE_AGENT,
  })
  const api = `http://127.0.0.1:${port}/__eztweak/api`
  await waitFor(
    async () => ((await world.state(port)) as { acp?: { state?: string } }).acp?.state === 'idle',
    'the agent to be ready',
  )

  // The user's browser, signed in, loading the page through the review and reporting its storage.
  await fetch(`http://127.0.0.1:${port}/app`, {
    headers: { cookie: 'sid=s1; theme=dark', accept: 'text/html' },
  })
  const bad = await fetch(`${api}/page-state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ localStorage: 'nope' }),
  })
  assert.equal(bad.status, 400)
  await fetch(`${api}/page-state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(STORAGE),
  })

  await fetch(`${api}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'PAGESTATE' }),
  })
  const env = await waitFor(async () => {
    const s = (await world.state(port)) as { conversation?: { role: string; text: string }[] }
    const reply = s.conversation?.find((e) => e.role === 'agent' && e.text.includes('"token"'))
    return reply ? (JSON.parse(reply.text) as { url: string; token: string }) : null
  }, 'the agent to report its environment')
  assert.equal(env.url, `${api}/page-state`)

  assert.equal((await fetch(env.url)).status, 401, 'no token, no session')
  assert.equal((await fetch(env.url, { headers: { authorization: 'Bearer guess' } })).status, 401)
  const state = (await (
    await fetch(env.url, { headers: { authorization: `Bearer ${env.token}` } })
  ).json()) as StorageState
  assert.deepEqual(
    state.cookies.map((c) => [c.name, c.value, c.domain]),
    [
      ['sid', 's1', 'localhost'],
      ['theme', 'dark', 'localhost'],
    ],
  )
  assert.equal(state.origins[0]?.origin, origin)
  assert.deepEqual(state.origins[0]?.indexedDB, STORAGE.indexedDB)

  if (!(await chromeAvailable())) return t.skip('no Chrome to open the page in')
  const measure = async (withState: boolean) => {
    const { stdout } = await run('node', [PAGE_SCRIPT, 'measure', `${origin}/app`], {
      env: {
        ...process.env,
        ...(withState
          ? { EZTWEAK_PAGE_STATE: env.url, EZTWEAK_PAGE_STATE_TOKEN: env.token }
          : { EZTWEAK_PAGE_STATE: '', EZTWEAK_PAGE_STATE_TOKEN: '' }),
      },
    })
    return JSON.parse(stdout) as { redirected?: string }
  }
  assert.equal((await measure(true)).redirected, undefined, 'signed in, it stays on the page')
  assert.equal((await measure(false)).redirected, `${origin}/login`, 'signed out, it says so')
})
