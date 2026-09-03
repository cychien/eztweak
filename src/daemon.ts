import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Socket } from 'node:net'
import express, { type ErrorRequestHandler, type Response, Router } from 'express'
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware'
import {
  DAEMON_LOG,
  IDLE_STOP_MS,
  MAX_ATTACHMENT_BYTES,
  PKG_NAME,
  POLL_TIMEOUT_MS,
  UPDATE_CHECK_TTL_MS,
  URL_PREFIX,
  controlPortRange,
} from './constants.js'
import { AcpAgent } from './acp-agent.js'
import type { AcpSnapshot } from './acp-agent.js'
import { attachmentIds, parseReferences } from './anchor.js'
import { injectOverlay, wantsHtml } from './inject.js'
import { toAgentAttachments, toAgentItem, toConversationItem } from './label.js'
import type { Annotation, PollResult, SessionEndedBy } from './protocol.js'
import { SessionStore, listRestorableSessions, newId } from './store.js'
import { clearRegistry, launchDaemon, probeDaemon, readRegistry, writeRegistry } from './registry.js'
import { installVersion, pruneInstalledVersions } from './installer.js'
import { latestVersion, updateChecksDisabled } from './update-check.js'
import { Updater, type UpdateWire } from './updater.js'
import { versionGate } from './version.js'

const distDir = dirname(fileURLToPath(import.meta.url))
const asset = (name: string) => readFileSync(join(distDir, name))

/** The client percent-encodes it, because a filename is free to hold bytes no
 *  HTTP header may carry. A value that survived that unencoded is still a usable
 *  name - the store sanitizes either way. */
function decodeAttachmentName(raw: string | undefined): string {
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

const SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PKG_NAME}</title>
<link rel="stylesheet" href="${URL_PREFIX}/shell.css">
</head>
<body>
<div id="ez-shell"></div>
<script src="${URL_PREFIX}/shell.js"></script>
</body>
</html>`

interface SnapshotWire {
  /** The daemon's version. The shell compares it across reconnects: a change
   *  means a different daemon took the port, and its assets are stale. */
  version: string
  state: 'active' | 'ended'
  endedBy?: SessionEndedBy
  targetOrigin: string
  annotations: Annotation[]
  conversation: unknown[]
  agentOnline: boolean
  /** Agent took a batch and hasn't come back to poll — it's off editing. */
  agentBusy: boolean
  /** The agent's latest word on what it is doing right now. Transient by design:
   *  progress is status, not conversation, so it lives next to `agentBusy` and
   *  dies with it instead of accumulating stale lines in the log. */
  agentProgress?: string
  /** The batch the agent is answering right now. The live turn is drawn under the
   *  question that caused it, not under whatever the user typed since. */
  activeBatchId?: string
  /** SPIKE: present when this session drives its agent over ACP. */
  acp?: AcpSnapshot
  /** A newer version or a stale skill to offer, and the update's progress once
   *  taken up. Daemon-wide: every session's shell shows the same one. */
  update?: UpdateWire
}

/** Bind `app` on the loopback at `port`, or reject. Deliberately not
 *  `app.listen`: Express 5 calls its callback on a bind error too, error-first,
 *  and a callback that ignores its argument mistakes a taken port for a bound one. */
function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer(app)
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      // Bind failures are the promise's business; anything after that would
      // reject a settled promise and vanish, so log it instead.
      server.off('error', reject)
      server.on('error', (err: Error) => {
        // eslint-disable-next-line no-console
        console.error(`server on port ${port} failed: ${err.message}`)
      })
      resolve(server)
    })
  })
}

/** First port in `candidates` that binds. A `0` entry always succeeds, so keep
 *  it last as the fallback. */
async function listenOn(app: express.Express, candidates: number[]): Promise<Server> {
  let lastError: unknown
  for (const port of candidates) {
    try {
      return await listen(app, port)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no port available')
}

/** The batch as one prompt turn. The JSON is exactly what `poll` prints, so an
 *  agent that knows the skill reads it unchanged; the preamble covers one that
 *  has never seen eztweak. */
function acpPrompt(feedback: Extract<PollResult, { type: 'feedback' }>): string {
  return [
    'The user reviewed the running app in their browser and sent this feedback batch.',
    'Each item resolves to source: trust `anchor.source` (file:line) when present, else',
    'use `anchor.components` / `anchor.section` / `anchor.selector` / `anchor.text`.',
    '`[file n]` in a comment is `attachments[n-1]` (read the file at `path`);',
    '`[ref n]` names the entry in `references` whose `n` matches.',
    'Apply every item, then reply with what you changed, item by item, one short line each.',
    '',
    JSON.stringify(feedback, null, 2),
  ].join('\n')
}

/** Why the turn stopped, for the thread. Only ever shown for a stop the user did
 *  not get a reply out of - `end_turn` is the normal one and says nothing. The
 *  raw reason is kept in the fallback: an unmapped stop is still worth naming. */
function turnEndNote(stopReason: string): string {
  switch (stopReason) {
    case 'cancelled':
      return '已中止'
    case 'max_tokens':
      return 'agent 用完這一輪的 token 額度，提早結束'
    case 'max_turn_requests':
      return 'agent 用完這一輪的請求次數，提早結束'
    case 'refusal':
      return 'agent 拒絕了這一輪'
    default:
      return `這一輪提早結束（${stopReason}）`
  }
}

/** What the thread is told when a daemon restart took the agent's context with
 *  it - the same thing the shell's update card promises in advance, in the same
 *  words, because it is the same event seen from either side of it. */
const AGENT_RESTARTED_NOTE = '已開啟新 session，之前的對話不會延續'

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
  /** The batch the agent is working on. Not derived from the outbox: a poll-mode
   *  agent acks on *receipt*, before it does the work, so by the time it replies
   *  the batch it is answering is no longer delivered-and-unacked and only this
   *  remembers which one it was. Set when a batch is handed over, cleared when the
   *  agent comes back - it tracks `agentBusy`, except that `/agent/progress` can
   *  raise that flag with no batch behind it at all. */
  private activeBatch: string | null = null
  private agentProgress: string | null = null
  /** SPIKE: the ACP-driven agent, when this session owns one. */
  private acp: AcpAgent | null = null
  lastActivity = Date.now()

  constructor(
    readonly targetOrigin: string,
    readonly project: string,
    private readonly version: string,
    private readonly updater: Updater,
  ) {
    this.store = new SessionStore(targetOrigin, project)
    // Session start is the one moment no composer can be holding a fresh upload,
    // which is what makes an unreferenced attachment safe to judge by age alone.
    this.store.sweepAttachments()
    this.bus.setMaxListeners(50)
  }

  /** Release the port and detach everyone attached, so the origin can be handed
   *  to a different project's session without leaking a listener. */
  async stop(): Promise<void> {
    this.acp?.stop()
    this.acp = null
    for (const resolve of this.pollWaiters) resolve(null)
    this.pollWaiters.clear()
    for (const client of this.sseClients) client.end()
    this.sseClients.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
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
    const update = this.updater.snapshot()
    return {
      version: this.version,
      state: s.state,
      endedBy: s.endedBy,
      targetOrigin: this.targetOrigin,
      annotations: this.store.annotations,
      conversation: this.store.visibleConversation,
      agentOnline:
        this.pollWaiters.size > 0 || (!!this.acp && this.acp.snapshot().state !== 'exited'),
      agentBusy: this.agentBusy,
      ...(this.agentProgress ? { agentProgress: this.agentProgress } : {}),
      ...(this.agentBusy && this.activeBatch ? { activeBatchId: this.activeBatch } : {}),
      ...(this.acp ? { acp: this.acp.snapshot() } : {}),
      ...(update ? { update } : {}),
    }
  }

  broadcast(): void {
    const data = `data: ${JSON.stringify(this.snapshot())}\n\n`
    for (const res of this.sseClients) res.write(data)
  }

  /** Bring back the agent a previous daemon was driving. Its context died with
   *  that daemon, and the batch it was on comes round again unacked, so the one
   *  thing owed here is telling the thread that the reply will not remember -
   *  which is what the update card said would happen, in the same words. */
  restoreAcpAgent(command: string): void {
    this.attachAcpAgent(command)
    // Only when there is context to have lost, and only once per loss: an empty
    // thread had none, and a restart that follows another with nothing said in
    // between is the same loss reported twice. A dev daemon restarts on every
    // save, which is what makes both cases the common ones.
    const thread = this.store.visibleConversation
    const last = thread.at(-1)
    if (thread.length === 0 || last?.text === AGENT_RESTARTED_NOTE) return
    this.store.appendConversation({
      role: 'system',
      text: AGENT_RESTARTED_NOTE,
      ts: Date.now(),
    })
  }

  /** SPIKE: attach an ACP-driven agent to this session. Replaces a dead one;
   *  a live one stays - two agents on one review is never what anyone meant. */
  attachAcpAgent(command: string): boolean {
    if (this.acp && this.acp.snapshot().state !== 'exited') {
      return this.acp.snapshot().agent === command
    }
    this.store.setAgent(command)
    this.acp = new AcpAgent({
      command,
      cwd: this.project,
      // Delivery rides on every state change: the moment the agent first goes
      // idle - or comes back idle - whatever is queued goes out.
      onChange: () => {
        this.deliverToAcp()
        this.broadcast()
      },
      onTurnEnd: (text, stopReason) => {
        this.agentBusy = false
        this.agentProgress = null
        // The batch this turn answered, read before it is cleared. Stamping it is
        // what lets the thread draw the reply under its own question rather than
        // under whatever the user typed while the turn was running.
        const answers = this.activeBatch ? { batchId: this.activeBatch } : {}
        this.activeBatch = null
        const delivered = this.store.deliveredBatchIds()
        // A cancelled turn can still have said something before it was stopped,
        // and an empty one is not a message - the note below is what explains it.
        if (text) {
          this.store.appendConversation({ role: 'agent', text, ts: Date.now(), ...answers })
        }
        if (stopReason !== 'end_turn') {
          this.store.appendConversation({
            role: 'system',
            text: turnEndNote(stopReason),
            ts: Date.now(),
            ...answers,
          })
        }
        // The turn is the whole delivery in ACP mode, so its end is the ack -
        // including a cancelled one: the user stopped it, and handing the batch
        // straight back would undo that.
        for (const id of delivered) this.store.ack(id)
        this.deliverToAcp()
        this.broadcast()
      },
      onExit: () => {
        this.agentBusy = false
        this.activeBatch = null
        this.broadcast()
      },
    })
    return true
  }

  answerAcp(id: string, answers: Record<string, string>): boolean {
    return this.acp?.answer(id, answers) ?? false
  }

  /** SPIKE: stop the turn the agent is in the middle of. The turn's own end does
   *  the bookkeeping - the agent still answers the prompt, with `cancelled` and
   *  whatever it had already said. */
  cancelAcpTurn(): boolean {
    return this.acp?.cancelTurn() ?? false
  }

  /** SPIKE: drop the agent's context and carry on in a fresh ACP session.
   *
   *  The shell shows an empty thread afterwards, because that is what "new chat"
   *  means to the person who asked for one - a notice explaining that the history
   *  above no longer counts is still history above. The log on disk is untouched
   *  either way: it is the record of the review, and windowing it costs nothing
   *  while deleting it would cost the only copy. */
  newAcpChat(): boolean {
    if (!this.acp?.newChat()) return false
    this.agentBusy = false
    this.activeBatch = null
    this.agentProgress = null
    // Everything the agent had not finished with, not just the turn it was on: the
    // one in flight died with its session, and the ones queued behind it were
    // asked of a context the user has just said to start over from. Acking is what
    // stops the fresh session being handed them the moment it goes idle.
    for (const id of this.store.pendingBatchIds()) this.store.ack(id)
    this.store.clearConversation()
    this.broadcast()
    return true
  }

  /** Hand the next queued batch to the ACP agent, if both exist. The payload is
   *  the same JSON `poll` prints, so the skill's reading of it carries over. */
  private deliverToAcp(): void {
    if (!this.acp || this.acp.snapshot().state !== 'idle') return
    const outcome = this.pollOutcome()
    if (!outcome) return
    if (outcome.type === 'session-ended') {
      this.acp.stop()
      this.acp = null
      return
    }
    this.acp.prompt(acpPrompt(outcome))
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
    this.activeBatch = batch.batchId
    const attachments = toAgentAttachments(batch.attachments, this.store)
    return {
      type: 'feedback',
      batchId: batch.batchId,
      url: this.targetOrigin,
      note: batch.note,
      items: batch.items.map((a) => toAgentItem(a, this.store)),
      ...(attachments ? { attachments } : {}),
      ...(batch.references?.length ? { references: batch.references } : {}),
    }
  }

  async waitForPoll(): Promise<PollResult | null> {
    // The agent is back. Clear before `pollOutcome`, which re-arms both if another
    // batch is already queued.
    this.agentBusy = false
    this.activeBatch = null
    this.agentProgress = null
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
    api.use((_req, _res, next) => {
      this.touch()
      next()
    })

    // Ahead of the JSON parser on purpose: a pasted .json file arrives as
    // `application/json`, and behind it would be parsed as a request body and
    // held to the JSON limit instead of the attachment one.
    api.post(
      '/attachments',
      express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }),
      (req, res) => {
        const bytes = req.body
        if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
          return res.status(400).json({ error: 'attachment body is empty' })
        }
        const mime = (req.get('content-type') ?? '').split(';')[0]?.trim()
        const attachment = this.store.addAttachment(
          decodeAttachmentName(req.get('x-ez-name')),
          mime || 'application/octet-stream',
          bytes,
        )
        res.json(attachment)
      },
    )

    api.use(express.json({ limit: '2mb' }))

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
      const { kind, comment, anchor, attachments, references } = req.body ?? {}
      if (!kind || typeof anchor !== 'object' || anchor === null) {
        return res.status(400).json({ error: 'kind and anchor are required' })
      }
      const ids = attachmentIds(attachments)
      if (!ids) return res.status(400).json({ error: 'attachments must be an array of ids' })
      const files = this.store.getAttachments(ids)
      if (!files) return res.status(400).json({ error: 'unknown attachment id' })
      const refs = parseReferences(references)
      if (!refs) return res.status(400).json({ error: 'references must be an array of anchors' })
      // A pasted screenshot can be the whole point the user is making, so a
      // comment is only required when nothing came with it.
      if (!comment && files.length === 0) {
        return res.status(400).json({ error: 'comment or attachment is required' })
      }
      const annotation: Annotation = {
        id: newId(),
        kind,
        comment: comment ? String(comment) : '',
        anchor,
        createdAt: Date.now(),
        ...(files.length ? { attachments: files } : {}),
        ...(refs.length ? { references: refs } : {}),
      }
      this.store.addAnnotation(annotation)
      this.broadcast()
      res.json(annotation)
    })

    api.delete('/attachments/:id', (req, res) => {
      switch (this.store.removeAttachment(req.params.id)) {
        case 'unknown':
          return res.status(404).json({ error: 'attachment not found' })
        case 'referenced':
          return res.status(409).json({ error: 'attachment belongs to queued or sent feedback' })
        default:
          return res.json({ ok: true })
      }
    })

    // The queue is editable until it is sent: the same fields `POST /annotations`
    // accepts, validated the same way, so a comment reopened in the shell can be
    // saved back with its files and picked elements changed.
    api.patch('/annotations/:id', (req, res) => {
      const { comment, attachments, references } = req.body ?? {}
      const patch: Parameters<SessionStore['updateAnnotation']>[1] = {}
      if (comment !== undefined) {
        if (typeof comment !== 'string') {
          return res.status(400).json({ error: 'comment must be a string' })
        }
        patch.comment = comment
      }
      if (attachments !== undefined) {
        const ids = attachmentIds(attachments)
        if (!ids) return res.status(400).json({ error: 'attachments must be an array of ids' })
        const files = this.store.getAttachments(ids)
        if (!files) return res.status(400).json({ error: 'unknown attachment id' })
        patch.attachments = files
      }
      if (references !== undefined) {
        const refs = parseReferences(references)
        if (!refs) return res.status(400).json({ error: 'references must be an array of anchors' })
        patch.references = refs
      }
      // The same rule the annotation was created under: a pasted screenshot or a
      // pointed-at element can be the whole remark, but an annotation that carries
      // nothing at all is one the user meant to delete.
      const current = this.store.annotations.find((a) => a.id === req.params.id)
      if (!current) return res.status(404).json({ error: 'annotation not found' })
      const nextComment = patch.comment ?? current.comment
      const nextFiles = patch.attachments ?? current.attachments ?? []
      const nextRefs = patch.references ?? current.references ?? []
      if (!nextComment.trim() && !nextFiles.length && !nextRefs.length) {
        return res.status(400).json({ error: 'comment, attachment or reference is required' })
      }
      if (!this.store.updateAnnotation(req.params.id, patch)) {
        return res.status(404).json({ error: 'annotation not found' })
      }
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
      const ids = attachmentIds(req.body?.attachments)
      if (!ids) return res.status(400).json({ error: 'attachments must be an array of ids' })
      const files = this.store.getAttachments(ids)
      if (!files) return res.status(400).json({ error: 'unknown attachment id' })
      const refs = parseReferences(req.body?.references)
      if (!refs) return res.status(400).json({ error: 'references must be an array of anchors' })
      const batch = this.store.sendBatch(req.body?.note ?? null, files, refs)
      if (!batch) return res.status(400).json({ error: 'nothing to send' })
      this.store.appendConversation({
        role: 'user',
        text: batch.note ?? '',
        ts: Date.now(),
        batchId: batch.batchId,
        items: batch.items.map(toConversationItem),
        ...(batch.attachments?.length
          ? { attachments: batch.attachments.map((a) => a.name) }
          : {}),
        ...(batch.references?.length
          ? { references: batch.references.map((r) => ({ n: r.n, label: r.label })) }
          : {}),
      })
      if (this.acp) this.deliverToAcp()
      this.wakePollers()
      res.json({ batchId: batch.batchId })
    })

    // SPIKE: the user answered the agent's question card in the shell.
    api.post('/acp/answer', (req, res) => {
      const id = String(req.body?.id ?? '')
      const answers = req.body?.answers as Record<string, string> | undefined
      if (!id || typeof answers !== 'object' || answers === null) {
        return res.status(400).json({ error: 'id and answers are required' })
      }
      if (!this.answerAcp(id, answers)) {
        return res.status(409).json({ error: 'that question is no longer waiting' })
      }
      res.json({ ok: true })
    })

    // SPIKE: the agent is heading the wrong way - stop this turn.
    api.post('/acp/cancel', (_req, res) => {
      if (!this.cancelAcpTurn()) {
        return res.status(409).json({ error: 'the agent is not in the middle of a turn' })
      }
      this.broadcast()
      res.json({ ok: true })
    })

    // SPIKE: clear the agent's context and carry on in a fresh session.
    api.post('/acp/new', (_req, res) => {
      if (!this.newAcpChat()) {
        return res.status(409).json({ error: 'no ACP agent is ready on this session' })
      }
      res.json({ ok: true })
    })

    // The user took up the update offer. Progress comes back over `/events`,
    // and a daemon update ends with this port changing hands. The one endpoint
    // that installs and runs code, so it insists on the JSON content type the
    // shell always sends: a cross-site form post cannot set it without a
    // preflight, and there is no CORS here to pass one.
    api.post('/update', (req, res) => {
      if ((req.get('content-type') ?? '').split(';')[0]?.trim() !== 'application/json') {
        return res.status(415).json({ error: 'expected application/json' })
      }
      switch (this.updater.run()) {
        case 'busy':
          return res.status(409).json({ error: 'an update is already running' })
        case 'nothing':
          return res.status(409).json({ error: 'nothing to update' })
        default:
          return res.json({ ok: true })
      }
    })

    api.post('/end', (req, res) => {
      const by: SessionEndedBy = req.body?.by === 'agent' ? 'agent' : 'user'
      this.acp?.stop()
      this.acp = null
      this.agentBusy = false
      this.activeBatch = null
      this.agentProgress = null
      this.store.end(by)
      this.store.appendConversation({
        role: 'system',
        text: by === 'user' ? 'Session ended by user' : 'Session ended by agent',
        ts: Date.now(),
      })
      this.wakePollers()
      res.json({ ok: true })
    })

    // A reconnecting poll can land straight on this port after a daemon
    // restart re-bound it, skipping the gated control lookup — so the agent
    // endpoints enforce the version themselves. Shell routes stay open: the
    // browser sends no version header.
    api.use('/agent', versionGate(this.version))

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
      // The reply is the finished form of whatever the progress line promised.
      this.agentProgress = null
      // Left set until the agent's next poll, which is what makes it readable
      // here: the ack already happened, on receipt.
      const answering = this.activeBatch
      this.store.appendConversation({
        role: 'agent',
        text: message,
        ts: Date.now(),
        ...(answering ? { batchId: answering } : {}),
      })
      this.broadcast()
      res.json({ ok: true })
    })

    api.post('/agent/progress', (req, res) => {
      const message = String(req.body?.message ?? '').trim()
      if (!message) return res.status(400).json({ error: 'message is required' })
      // Progress is a claim of work in flight, so it also raises the busy flag -
      // an agent narrating before its first poll is still an agent working.
      this.agentBusy = true
      this.agentProgress = message
      this.broadcast()
      res.json({ ok: true })
    })

    // Body parsers reject by throwing, and Express's default handler answers an
    // HTML error page, which the composer - expecting JSON - could only report
    // as a generic failure.
    api.use(((err, _req, res, next) => {
      if (res.headersSent) return next(err)
      if ((err as { type?: string })?.type === 'entity.too.large') {
        return res.status(413).json({ error: 'attachment is too large' })
      }
      next(err)
    }) satisfies ErrorRequestHandler)

    return api
  }

  async start(): Promise<number> {
    const app = express()

    const rk = Router()
    rk.get('/shell', (_req, res) => res.type('html').send(SHELL_HTML))
    // Never cached. These assets are the daemon's, and the daemon is replaceable
    // under an open shell - by a self-update, or by a `@latest` CLI run. The
    // reload that follows has to fetch the new code, and a heuristically cached
    // copy would leave the previous version's UI driving the new daemon.
    for (const file of ['overlay.js', 'overlay.css', 'shell.js', 'shell.css']) {
      const type = file.endsWith('.css') ? 'text/css' : 'text/javascript'
      rk.get(`/${file}`, (_req, res) =>
        res.type(type).set('cache-control', 'no-store').send(asset(file)),
      )
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

    // Prefer the port this session last held so an already-open shell tab only
    // needs a reload after a daemon restart, but never fail over a taken port.
    const preferred = this.store.session.port
    this.server = await listenOn(app, preferred ? [preferred, 0] : [0])
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url?.startsWith(URL_PREFIX)) return socket.destroy()
      rawProxy.upgrade(req, socket as Socket, head)
    })
    const address = this.server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    this.store.setPort(this.port)
    return this.port
  }

  shellUrl(path: string): string {
    return `http://127.0.0.1:${this.port}${URL_PREFIX}/shell?path=${encodeURIComponent(path)}`
  }
}

/** A daemon already holding the control range — from a run whose registry file
 *  was deleted or corrupted. Adopting it beats racing it for ports and leaving
 *  two daemons alive with one registry between them. */
async function findLiveDaemonInRange(range: {
  start: number
  end: number
}): Promise<{ port: number; pid: number } | null> {
  for (let port = range.start; port <= range.end; port++) {
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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Resolves when `pid` is gone, or after `timeoutMs` if it never goes. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await delay(100)
  }
  return false
}

/** Start the daemon at `cliEntry` as this one's successor and wait until it owns
 *  the registry and answers healthy. It binds and registers before touching any
 *  session, so this resolving means "a working daemon is up" - and rejecting
 *  means nothing has changed hands yet, and this daemon carries on. */
async function handoverTo(cliEntry: string): Promise<void> {
  const child = launchDaemon(cliEntry, ['--succeed', String(process.pid)])
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await delay(150)
    if (child.exitCode !== null) {
      throw new Error(`new daemon exited with ${child.exitCode} (see ${DAEMON_LOG})`)
    }
    const info = readRegistry()
    if (info && info.pid !== process.pid && (await probeDaemon(info.port, info.pid))) return
  }
  child.kill('SIGKILL')
  throw new Error(`new daemon did not come up within 20s (see ${DAEMON_LOG})`)
}

export interface DaemonOptions {
  /** The daemon handing over to this one. Set, this daemon skips adoption, takes
   *  the registry as soon as it binds, and restores sessions only once that pid
   *  has released their ports. */
  succeed?: number
}

export async function daemonMain(version: string, opts: DaemonOptions = {}): Promise<void> {
  const range = controlPortRange()
  if (opts.succeed === undefined) {
    const adopted = await findLiveDaemonInRange(range)
    if (adopted) {
      writeRegistry({ ...adopted, startedAt: Date.now() })
      // eslint-disable-next-line no-console
      console.log(`adopted existing daemon on 127.0.0.1:${adopted.port} (pid ${adopted.pid})`)
      return
    }
  }

  const sessions = new Map<string, SessionRuntime>()
  const broadcastAll = () => {
    for (const s of sessions.values()) s.broadcast()
  }

  let stopping = false

  const updater = new Updater({
    current: version,
    latestVersion: updateChecksDisabled() ? async () => null : () => latestVersion(),
    install: installVersion,
    handover: handoverTo,
    // Exit is the release: it frees every port at once and takes the agent
    // children with it, which is what the successor is waiting for.
    retire: async () => process.exit(0),
    onChange: broadcastAll,
  })

  /** Rebuild the session map from disk. Without this a restarted daemon answers
   *  `/sessions/find` with 404 and a reconnecting `poll` gives up on a session
   *  whose queued feedback is sitting right there on disk. */
  const restoreSessions = async () => {
    for (const persisted of listRestorableSessions()) {
      try {
        const runtime = new SessionRuntime(
          persisted.targetOrigin,
          persisted.project,
          version,
          updater,
        )
        await runtime.start()
        if (persisted.agent) runtime.restoreAcpAgent(persisted.agent)
        sessions.set(persisted.targetOrigin, runtime)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `could not restore session for ${persisted.targetOrigin}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  const control = express()
  control.use(express.json())

  control.get('/control/health', (_req, res) => {
    // A daemon on its way out must not look healthy, or a daemon starting up in
    // that window adopts it and exits — leaving no daemon at all.
    if (stopping) return res.status(503).json({ ok: false, stopping: true })
    res.json({ ok: true, service: PKG_NAME, version, pid: process.pid })
  })

  // Registered before sessions are restored, so a CLI that finds this daemon
  // straight away is held here until its sessions exist rather than told
  // there are none.
  let ready!: () => void
  const restored = new Promise<void>((resolve) => {
    ready = resolve
  })
  control.use('/control/sessions', (_req, _res, next) => {
    restored.then(() => next(), next)
  })

  // Health and stop stay ungated: a mismatched CLI must still be able to see
  // the daemon and replace it.
  control.use('/control/sessions', versionGate(version))

  control.get('/control/sessions', (_req, res) => {
    res.json(
      [...sessions.values()].map((s) => ({
        targetOrigin: s.targetOrigin,
        project: s.project,
        port: s.port,
        state: s.store.session.state,
      })),
    )
  })

  control.post('/control/sessions', async (req, res) => {
    const { url, reopen, project, agent } = req.body ?? {}
    let parsed: URL
    try {
      parsed = new URL(String(url))
    } catch {
      return res.status(400).json({ error: `invalid url: ${url}` })
    }
    if (typeof project !== 'string' || !project) {
      return res.status(400).json({ error: 'missing project' })
    }
    const origin = parsed.origin
    let runtime = sessions.get(origin)
    // A dev server that was this origin's is gone the moment another project
    // binds the port, so its review does not carry over to the new one.
    if (runtime && runtime.project !== project) {
      await runtime.stop()
      sessions.delete(origin)
      runtime = undefined
    }
    if (!runtime) {
      runtime = new SessionRuntime(origin, project, version, updater)
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
    // SPIKE: ACP mode - this session spawns and drives its own agent.
    if (typeof agent === 'string' && agent) {
      if (!runtime.attachAcpAgent(agent)) {
        return res.status(409).json({
          error: 'a different agent is already attached to this session',
          hint: 'end the session (or stop the daemon) before switching agents',
        })
      }
      runtime.broadcast()
    }
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
    clearRegistry(process.pid)
    res.json({ ok: true })
    setTimeout(() => process.exit(0), 100)
  })

  const candidates = Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i)
  const controlServer = await listenOn(control, [...candidates, 0])
  const controlAddress = controlServer.address()
  const port = typeof controlAddress === 'object' && controlAddress ? controlAddress.port : 0

  writeRegistry({ port, pid: process.pid, startedAt: Date.now() })
  const cleanup = () => {
    clearRegistry(process.pid)
    process.exit(0)
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)

  // The predecessor lets go of its session ports only once this daemon is
  // registered, so restoring before it has exited would land them elsewhere
  // and orphan every open shell. If it never exits, restore anyway - a daemon
  // on other ports beats no daemon.
  const predecessorGone =
    opts.succeed === undefined || (await waitForExit(opts.succeed, 15_000))
  if (!predecessorGone) {
    // eslint-disable-next-line no-console
    console.error(`predecessor pid ${opts.succeed} is still running; restoring sessions anyway`)
  }
  await restoreSessions()
  ready()
  // Only once the daemon we replaced is gone. It serves its shell assets by
  // reading them per request, so pruning the version it runs from while it is
  // still answering would break every session it has not handed over.
  if (predecessorGone) pruneInstalledVersions(join(distDir, 'cli.mjs'))

  void updater.check()
  setInterval(() => void updater.check(), UPDATE_CHECK_TTL_MS / 4).unref()

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
