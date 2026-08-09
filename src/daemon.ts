import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Socket } from 'node:net'
import express, { type Response, Router } from 'express'
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware'
import {
  CONTROL_PORT_RANGE,
  IDLE_STOP_MS,
  PKG_NAME,
  POLL_TIMEOUT_MS,
  URL_PREFIX,
} from './constants.js'
import { injectOverlay, wantsHtml } from './inject.js'
import { toAgentItem, toConversationItem } from './label.js'
import type { Annotation, PollResult, SessionEndedBy } from './protocol.js'
import { SessionStore, newId } from './store.js'
import { writeRegistry, clearRegistry } from './registry.js'

const distDir = dirname(fileURLToPath(import.meta.url))
const asset = (name: string) => readFileSync(join(distDir, name))

const SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review</title>
<link rel="stylesheet" href="${URL_PREFIX}/shell.css">
</head>
<body>
<div id="ez-shell"></div>
<script src="${URL_PREFIX}/shell.js"></script>
</body>
</html>`

interface SnapshotWire {
  state: 'active' | 'ended'
  endedBy?: SessionEndedBy
  targetOrigin: string
  annotations: Annotation[]
  conversation: unknown[]
  agentOnline: boolean
  /** Agent took a batch and hasn't come back to poll — it's off editing. */
  agentBusy: boolean
}

class SessionRuntime {
  readonly store: SessionStore
  readonly bus = new EventEmitter()
  port = 0
  private server!: Server
  private sseClients = new Set<Response>()
  private pollWaiters = new Set<(r: PollResult | null) => void>()
  /** Set when a batch is handed to the agent, cleared when it polls again.
   *  Acks can't drive this: the agent acks on receipt, before it does the work. */
  private agentBusy = false
  lastActivity = Date.now()

  constructor(readonly targetOrigin: string) {
    this.store = new SessionStore(targetOrigin)
    this.bus.setMaxListeners(50)
  }

  /** Someone is attached — keeps the idle reaper off this session. */
  get inUse(): boolean {
    return this.sseClients.size > 0 || this.pollWaiters.size > 0
  }

  touch(): void {
    this.lastActivity = Date.now()
  }

  snapshot(): SnapshotWire {
    const s = this.store.session
    return {
      state: s.state,
      endedBy: s.endedBy,
      targetOrigin: this.targetOrigin,
      annotations: this.store.annotations,
      conversation: this.store.conversation,
      agentOnline: this.pollWaiters.size > 0,
      agentBusy: this.agentBusy,
    }
  }

  broadcast(): void {
    const data = `data: ${JSON.stringify(this.snapshot())}\n\n`
    for (const res of this.sseClients) res.write(data)
  }

  private wakePollers(): void {
    const waiters = [...this.pollWaiters]
    this.pollWaiters.clear()
    for (const resolve of waiters) resolve(this.pollOutcome())
    this.broadcast()
  }

  /** Immediate poll outcome, or null when the agent should keep waiting. */
  private pollOutcome(): PollResult | null {
    const session = this.store.session
    if (session.state === 'ended') {
      return { type: 'session-ended', endedBy: session.endedBy ?? 'user' }
    }
    const batch = this.store.nextBatch()
    if (!batch) return null
    this.store.markDelivered(batch.batchId)
    this.agentBusy = true
    return {
      type: 'feedback',
      batchId: batch.batchId,
      url: this.targetOrigin,
      note: batch.note,
      items: batch.items.map(toAgentItem),
    }
  }

  async waitForPoll(): Promise<PollResult | null> {
    // The agent is back. Clear before `pollOutcome`, which re-arms it if another
    // batch is already queued.
    this.agentBusy = false
    const immediate = this.pollOutcome()
    if (immediate) return immediate
    return new Promise((resolve) => {
      const waiter = (r: PollResult | null) => {
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => {
        this.pollWaiters.delete(waiter)
        this.broadcast()
        resolve(null)
      }, POLL_TIMEOUT_MS)
      this.pollWaiters.add(waiter)
      this.broadcast()
    })
  }

  private apiRouter(): Router {
    const api = Router()
    api.use(express.json({ limit: '2mb' }))
    api.use((_req, _res, next) => {
      this.touch()
      next()
    })

    api.get('/state', (_req, res) => res.json(this.snapshot()))

    api.get('/events', (req, res) => {
      res.set({
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.flushHeaders()
      res.write(`data: ${JSON.stringify(this.snapshot())}\n\n`)
      this.sseClients.add(res)
      const heartbeat = setInterval(() => res.write(': hb\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        this.sseClients.delete(res)
      })
    })

    api.post('/annotations', (req, res) => {
      const { kind, comment, anchor } = req.body ?? {}
      if (!comment || !kind || typeof anchor !== 'object') {
        return res.status(400).json({ error: 'kind, comment and anchor are required' })
      }
      const annotation: Annotation = {
        id: newId(),
        kind,
        comment: String(comment),
        anchor,
        createdAt: Date.now(),
      }
      this.store.addAnnotation(annotation)
      this.broadcast()
      res.json(annotation)
    })

    api.patch('/annotations/:id', (req, res) => {
      const ok = this.store.updateAnnotation(req.params.id, { comment: req.body?.comment })
      if (!ok) return res.status(404).json({ error: 'annotation not found' })
      this.broadcast()
      res.json({ ok: true })
    })

    api.delete('/annotations/:id', (req, res) => {
      const ok = this.store.removeAnnotation(req.params.id)
      if (!ok) return res.status(404).json({ error: 'annotation not found' })
      this.broadcast()
      res.json({ ok: true })
    })

    api.post('/send', (req, res) => {
      const batch = this.store.sendBatch(req.body?.note ?? null)
      if (!batch) return res.status(400).json({ error: 'nothing to send' })
      this.store.appendConversation({
        role: 'user',
        text: batch.note ?? '',
        ts: Date.now(),
        batchId: batch.batchId,
        items: batch.items.map(toConversationItem),
      })
      this.wakePollers()
      res.json({ batchId: batch.batchId })
    })

    api.post('/end', (req, res) => {
      const by: SessionEndedBy = req.body?.by === 'agent' ? 'agent' : 'user'
      this.agentBusy = false
      this.store.end(by)
      this.store.appendConversation({
        role: 'system',
        text: by === 'user' ? 'Session ended by user' : 'Session ended by agent',
        ts: Date.now(),
      })
      this.wakePollers()
      res.json({ ok: true })
    })

    api.get('/agent/poll', async (req, res) => {
      const ack = req.query.ack
      if (typeof ack === 'string' && ack) {
        this.store.ack(ack)
        this.broadcast()
      }
      const result = await this.waitForPoll()
      this.touch()
      if (!result) return res.json({ type: 'timeout' })
      res.json(result)
    })

    api.post('/agent/ack', (req, res) => {
      const batchId = String(req.body?.batchId ?? '')
      if (!batchId) return res.status(400).json({ error: 'batchId is required' })
      this.store.ack(batchId)
      this.broadcast()
      res.json({ ok: true })
    })

    api.post('/agent/reply', (req, res) => {
      const message = String(req.body?.message ?? '').trim()
      if (!message) return res.status(400).json({ error: 'message is required' })
      this.store.appendConversation({ role: 'agent', text: message, ts: Date.now() })
      this.broadcast()
      res.json({ ok: true })
    })

    return api
  }

  async start(): Promise<number> {
    const app = express()

    const rk = Router()
    rk.get('/shell', (_req, res) => res.type('html').send(SHELL_HTML))
    for (const file of ['overlay.js', 'overlay.css', 'shell.js', 'shell.css']) {
      const type = file.endsWith('.css') ? 'text/css' : 'text/javascript'
      rk.get(`/${file}`, (_req, res) => res.type(type).send(asset(file)))
    }
    rk.use('/api', this.apiRouter())
    app.use(URL_PREFIX, rk)

    const htmlProxy = createProxyMiddleware({
      target: this.targetOrigin,
      changeOrigin: true,
      selfHandleResponse: true,
      on: {
        proxyRes: responseInterceptor(async (buffer, proxyRes, _req, res) => {
          res.removeHeader('content-security-policy')
          res.removeHeader('x-frame-options')
          const type = String(proxyRes.headers['content-type'] ?? '')
          if (!type.includes('text/html')) return buffer
          return injectOverlay(buffer.toString('utf8'))
        }),
      },
    })
    const rawProxy = createProxyMiddleware({
      target: this.targetOrigin,
      changeOrigin: true,
      ws: true,
    })
    app.use((req, res, next) =>
      wantsHtml(req.headers.accept) ? htmlProxy(req, res, next) : rawProxy(req, res, next),
    )

    await new Promise<void>((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => resolve())
    })
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url?.startsWith(URL_PREFIX)) return socket.destroy()
      rawProxy.upgrade(req, socket as Socket, head)
    })
    const address = this.server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    return this.port
  }

  shellUrl(path: string): string {
    return `http://127.0.0.1:${this.port}${URL_PREFIX}/shell?path=${encodeURIComponent(path)}`
  }
}

/** A daemon already holding the control range — from a run whose registry file
 *  was deleted or corrupted. Adopting it beats racing it for ports and leaving
 *  two daemons alive with one registry between them. */
async function findLiveDaemonInRange(): Promise<{ port: number; pid: number } | null> {
  for (let port = CONTROL_PORT_RANGE.start; port <= CONTROL_PORT_RANGE.end; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/control/health`, {
        signal: AbortSignal.timeout(400),
      })
      if (!res.ok) continue
      const body = (await res.json()) as { service?: string; pid?: number }
      if (body.service === PKG_NAME && typeof body.pid === 'number') {
        return { port, pid: body.pid }
      }
    } catch {
      /* nothing listening, or not us */
    }
  }
  return null
}

export async function daemonMain(version: string): Promise<void> {
  const adopted = await findLiveDaemonInRange()
  if (adopted) {
    writeRegistry({ ...adopted, startedAt: Date.now() })
    // eslint-disable-next-line no-console
    console.log(`adopted existing daemon on 127.0.0.1:${adopted.port} (pid ${adopted.pid})`)
    return
  }

  const sessions = new Map<string, SessionRuntime>()
  const control = express()
  control.use(express.json())

  let stopping = false

  control.get('/control/health', (_req, res) => {
    // A daemon on its way out must not look healthy, or a daemon starting up in
    // that window adopts it and exits — leaving no daemon at all.
    if (stopping) return res.status(503).json({ ok: false, stopping: true })
    res.json({ ok: true, service: PKG_NAME, version, pid: process.pid })
  })

  control.get('/control/sessions', (_req, res) => {
    res.json(
      [...sessions.values()].map((s) => ({
        targetOrigin: s.targetOrigin,
        port: s.port,
        state: s.store.session.state,
      })),
    )
  })

  control.post('/control/sessions', async (req, res) => {
    const { url, reopen } = req.body ?? {}
    let parsed: URL
    try {
      parsed = new URL(String(url))
    } catch {
      return res.status(400).json({ error: `invalid url: ${url}` })
    }
    const origin = parsed.origin
    let runtime = sessions.get(origin)
    if (!runtime) {
      runtime = new SessionRuntime(origin)
      await runtime.start()
      sessions.set(origin, runtime)
    }
    const session = runtime.store.session
    if (session.state === 'ended') {
      if (session.endedBy === 'user' && !reopen) {
        return res.status(409).json({
          error: 'session was ended by the user',
          hint: 'pass --reopen only when the user asks for further review',
        })
      }
      runtime.store.reopen()
      runtime.broadcast()
    }
    runtime.touch()
    res.json({
      port: runtime.port,
      shellUrl: runtime.shellUrl(parsed.pathname + parsed.search),
      state: runtime.store.session.state,
    })
  })

  control.get('/control/sessions/find', (req, res) => {
    const origin = String(req.query.origin ?? '')
    const runtime = sessions.get(origin)
    if (!runtime) return res.status(404).json({ error: `no active session for ${origin}` })
    res.json({ port: runtime.port, state: runtime.store.session.state })
  })

  control.post('/control/stop', (_req, res) => {
    stopping = true
    clearRegistry()
    res.json({ ok: true })
    setTimeout(() => process.exit(0), 100)
  })

  let port = 0
  for (let p = CONTROL_PORT_RANGE.start; p <= CONTROL_PORT_RANGE.end; p++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = control.listen(p, '127.0.0.1', () => resolve())
        server.on('error', reject)
      })
      port = p
      break
    } catch {
      /* port busy — try next */
    }
  }
  if (!port) {
    await new Promise<void>((resolve) => {
      const server = control.listen(0, '127.0.0.1', () => {
        const address = server.address()
        port = typeof address === 'object' && address ? address.port : 0
        resolve()
      })
    })
  }

  writeRegistry({ port, pid: process.pid, startedAt: Date.now() })
  const cleanup = () => {
    clearRegistry()
    process.exit(0)
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)

  setInterval(() => {
    const now = Date.now()
    const anyBusy = [...sessions.values()].some(
      (s) => s.inUse || now - s.lastActivity < IDLE_STOP_MS,
    )
    if (sessions.size > 0 && !anyBusy) cleanup()
  }, 60_000).unref()

  // eslint-disable-next-line no-console
  console.log(`daemon listening on 127.0.0.1:${port}`)
}
