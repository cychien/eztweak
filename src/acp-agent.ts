/** SPIKE: drive a coding agent over ACP so the review never leaves the shell.
 *
 *  The CLI loop makes the agent the only active party: the shell sees whatever
 *  the agent chooses to post, and everything else - streaming output, questions,
 *  permission prompts - stays in the terminal. ACP inverts that: the daemon is
 *  the *client*, the agent a child process speaking JSON-RPC on stdio, and the
 *  protocol guarantees the stream (`session/update`) and routes the questions
 *  (`session/request_permission`) here, whatever the agent is.
 *
 *  One session at a time, one turn at a time, feed capped - a spike's ambitions.
 *  "One session at a time" rather than "one session": `/new` throws the agent's
 *  context away by replacing the ACP session under a connection that stays up,
 *  which is the only way to stop paying for a history the review has moved past. */

import { type ChildProcess, spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  type ActiveSession,
  type ActiveSessionMessage,
  type ClientContext,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
} from '@agentclientprotocol/sdk'

export type AcpState = 'starting' | 'idle' | 'working' | 'exited'

/** One item of the live activity feed, in the order the turn produced them -
 *  the agent says a sentence, runs a tool, says another, and the feed has to
 *  keep that interleaving or a tool line renders above the words that preceded
 *  it. `say` segments joined together are also the turn's reply. */
export type AcpFeedItem =
  | { kind: 'say'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; toolCallId: string; title: string; status: string }
  | { kind: 'plan'; entries: { content: string; status: string }[] }

export interface AcpAskOption {
  id: string
  name: string
  description?: string
  /** Permission-option kind (allow_once, reject_once, ...) - styling hint. */
  hint?: string
}

export interface AcpAskQuestion {
  key: string
  text?: string
  options: AcpAskOption[]
}

/** A decision routed out of the agent, waiting on the user in the shell. A
 *  permission prompt is one question; an AskUserQuestion form can be several.
 *  Either way the shell answers with one option id per question key. */
export interface AcpAsk {
  id: string
  kind: 'permission' | 'question'
  title: string
  questions: AcpAskQuestion[]
}

export interface AcpSnapshot {
  agent: string
  state: AcpState
  feed: AcpFeedItem[]
  ask?: AcpAsk
  /** A cancel is out and the agent has not yet said the turn is over. The button
   *  that sent it has to stop offering to send it again. */
  cancelling?: true
  /** Why the agent is gone, when it is. */
  error?: string
}

export interface AcpAgentOptions {
  /** Shell command that starts an ACP agent on stdio. */
  command: string
  cwd: string
  onChange: () => void
  /** The turn is over: its accumulated message - the agent's reply to the batch,
   *  which a cancelled turn can still have part of - and why it stopped. */
  onTurnEnd: (reply: string, stopReason: string) => void
  onExit: (error: string | null) => void
}

const FEED_CAP = 100

/** Tool titles quote absolute paths, and the sidebar is 340px wide: the project
 *  prefix is the part every one of them shares and says nothing. */
function trimTitle(title: string, cwd: string): string {
  return title.replaceAll(`${cwd}/`, '')
}

/** Every live agent child, killed when the daemon goes down whichever way it
 *  goes down - an orphaned agent would keep burning the user's quota. */
const liveChildren = new Set<ChildProcess>()
process.on('exit', () => {
  for (const child of liveChildren) child.kill('SIGKILL')
})

export class AcpAgent {
  private child: ChildProcess
  private ctx: ClientContext | null = null
  /** The live session. Held as the SDK's `ActiveSession` for one reason: it funnels
   *  this session's updates *and* its turn's `stop` into a single queue, in stream
   *  order. That ordering is load-bearing - see `pump`. */
  private session: ActiveSession | null = null
  /** Retires the pump on the session being replaced, so it stops waiting on a
   *  `nextUpdate` that will never come. */
  private retire: (() => void) | null = null
  private state: AcpState = 'starting'
  private feed: AcpFeedItem[] = []
  private ask: AcpAsk | null = null
  private askResolve: ((answers: Record<string, string> | null) => void) | null = null
  private askSeq = 0
  private cancelling = false
  /** Bumped whenever the live session is replaced. A turn, or an update, that
   *  belonged to the session before the bump must not land in the one after -
   *  and the old session's `prompt` promise settles long after we let go of it. */
  private epoch = 0
  /** Set when the agent advertises `session/close`, which is the only way to
   *  tell it a session it is still holding is finished with. */
  private canClose = false
  /** Resolved when the agent is done, and nothing else: it is what holds the
   *  connection open, so a session swap must not disturb it. */
  private finish: (() => void) | null = null
  private error: string | null = null
  private stderrTail: string[] = []

  constructor(private readonly opts: AcpAgentOptions) {
    // Through a shell, because a profile is a command line ("npx -y ...") and
    // quoting rules belong to the shell the user would have typed it into.
    this.child = spawn(opts.command, {
      shell: true,
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = [...this.stderrTail, chunk.toString()].slice(-20)
    })
    liveChildren.add(this.child)
    // A spawn that never got off the ground reports asynchronously and emits no
    // `exit`, so without this it is an uncaught exception rather than an agent
    // that failed to start. Reachable whenever `cwd` is gone - a restored session
    // whose project has since been deleted, moved, or is on an unmounted volume -
    // and there it would take the daemon, and every other session, down with it.
    this.child.on('error', (err: Error) => {
      liveChildren.delete(this.child)
      this.fail(`agent could not start: ${err.message}`)
    })
    this.child.on('exit', (code) => {
      liveChildren.delete(this.child)
      if (this.state === 'exited') return
      this.fail(`agent exited (${code ?? 'signal'})`)
    })
    void this.run().catch((err: unknown) => {
      this.fail(err instanceof Error ? err.message : String(err))
    })
  }

  snapshot(): AcpSnapshot {
    return {
      agent: this.opts.command,
      state: this.state,
      feed: this.feed,
      ...(this.ask ? { ask: this.ask } : {}),
      ...(this.cancelling ? { cancelling: true as const } : {}),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  /** Send one prompt turn. Serialised by the caller: the review composes one
   *  batch at a time, so a second prompt mid-turn is a bug upstream. */
  prompt(text: string): void {
    if (!this.session || this.state !== 'idle') return
    const epoch = this.epoch
    this.state = 'working'
    this.feed = []
    this.opts.onChange()
    // The turn's *end* is read off the session queue in `pump`, not from this
    // promise. This only has to notice a request that failed outright.
    void this.session.prompt(text).catch((err: unknown) => {
      // A prompt against a session `/new` has already replaced fails on its way
      // out. The session that replaced it is fine, so this is not a death.
      if (epoch !== this.epoch) return
      this.fail(err instanceof Error ? err.message : String(err))
    })
  }

  /** The user answered in the shell: one option id per question key. */
  answer(id: string, answers: Record<string, string>): boolean {
    if (!this.ask || this.ask.id !== id || !this.askResolve) return false
    if (!this.ask.questions.every((q) => q.options.some((o) => o.id === answers[q.key]))) {
      return false
    }
    const resolve = this.askResolve
    this.ask = null
    this.askResolve = null
    resolve(answers)
    this.opts.onChange()
    return true
  }

  /** Stop the turn the agent is in the middle of. The turn still ends through
   *  `prompt`'s own promise - with `stopReason: 'cancelled'` and whatever it had
   *  already said - so the partial work stays on the record. */
  cancelTurn(): boolean {
    if (!this.session || this.state !== 'working') return false
    this.sendCancel(this.session.sessionId)
    this.cancelling = true
    this.opts.onChange()
    return true
  }

  /** Throw away the agent's memory of this review and carry on in a fresh
   *  session. The child process and the connection both stay: what costs tokens
   *  is the history the agent replays on every turn, and that belongs to the
   *  session, not to the process.
   *
   *  A turn in flight is cancelled rather than waited on - starting over is the
   *  whole point of asking - and its end is then dropped on the epoch. */
  newChat(): boolean {
    if (!this.ctx || !this.session) return false
    if (this.state !== 'idle' && this.state !== 'working') return false
    const old = this.session
    if (this.state === 'working') this.sendCancel(old.sessionId)
    this.epoch++
    this.session = null
    this.state = 'starting'
    this.feed = []
    this.cancelling = false
    // A question routed out of a session nobody will answer for any more: the
    // agent is blocked on it, and it has to be released before we let go.
    this.settleAsk()
    this.opts.onChange()
    this.retire?.()
    old.dispose()
    void this.closeSession(old.sessionId)
    void this.openSession().catch((err: unknown) => {
      this.fail(err instanceof Error ? err.message : String(err))
    })
    return true
  }

  private sendCancel(sessionId: string): void {
    void this.ctx?.notify(methods.agent.session.cancel, { sessionId }).catch(() => {})
  }

  /** Best-effort, and capability-gated: only some agents can be told a session is
   *  finished with, and one that refuses must not take the live session down. */
  private async closeSession(sessionId: string): Promise<void> {
    if (!this.canClose || !this.ctx) return
    try {
      await this.ctx.request(methods.agent.session.close, { sessionId })
    } catch {}
  }

  /** Starts the session this agent is currently meant to be on, and installs it
   *  only if it is still the one wanted by the time the agent answers. */
  private async openSession(): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    const epoch = this.epoch
    const session = await ctx.buildSession(this.opts.cwd).start()
    // A newer `/new` landed while the agent was answering this one: that request
    // owns the session now, so this one is closed rather than installed.
    if (epoch !== this.epoch) {
      session.dispose()
      void this.closeSession(session.sessionId)
      return
    }
    this.session = session
    this.state = 'idle'
    this.opts.onChange()
    void this.pump(session, epoch).catch((err: unknown) => {
      if (epoch !== this.epoch) return
      this.fail(err instanceof Error ? err.message : String(err))
    })
  }

  /** Drains one session's messages in the order the agent wrote them.
   *
   *  This is the whole reason the session is held as an `ActiveSession`: its
   *  queue carries the streamed updates *and* the turn's own `stop`, and a reply
   *  chunk written before the prompt response is therefore *seen* before it.
   *  Reading the two off separate promises loses that - they are independent
   *  microtask chains, and the response can settle first, ending the turn before
   *  the words it was made of have arrived. That produced an empty reply about
   *  one turn in ten.
   *
   *  Retired rather than abandoned: a pump parked on a session `/new` replaced
   *  would hold that session's queue - and everything the agent still sends to it
   *  - for the life of the process. */
  private async pump(session: ActiveSession, epoch: number): Promise<void> {
    const retired = new Promise<'retired'>((resolve) => {
      this.retire = () => resolve('retired')
    })
    for (;;) {
      const msg: ActiveSessionMessage | 'retired' = await Promise.race([
        session.nextUpdate(),
        retired,
      ])
      if (msg === 'retired' || epoch !== this.epoch) return
      if (msg.kind === 'session_update') this.onUpdate(msg.notification)
      else if (msg.kind === 'stop') this.turnEnded(msg.stopReason, epoch)
    }
  }

  stop(): void {
    this.state = 'exited'
    this.settleAsk()
    this.retire?.()
    this.finish?.()
    this.child.kill('SIGTERM')
    const child = this.child
    setTimeout(() => child.kill('SIGKILL'), 3000).unref()
  }

  private fail(message: string): void {
    if (this.state === 'exited') return
    this.state = 'exited'
    const tail = this.stderrTail.join('').trim().split('\n').slice(-3).join('\n')
    this.error = tail ? `${message}\n${tail}` : message
    this.settleAsk()
    this.retire?.()
    this.finish?.()
    this.opts.onExit(this.error)
    this.opts.onChange()
  }

  /** A question nobody can answer any more must not hang the agent's request. */
  private settleAsk(): void {
    const resolve = this.askResolve
    this.ask = null
    this.askResolve = null
    resolve?.(null)
  }

  private turnEnded(stopReason: string, epoch: number): void {
    if (epoch !== this.epoch || this.state !== 'working') return
    this.state = 'idle'
    this.cancelling = false
    // The reply is the said segments of the feed, in order. Everything between
    // them - the tool runs - is what the paragraphs are narrating, so joining
    // with a blank line keeps each one a paragraph of its own.
    const reply = this.feed
      .flatMap((f) => (f.kind === 'say' ? [f.text.trim()] : []))
      .filter(Boolean)
      .join('\n\n')
    this.feed = []
    this.opts.onTurnEnd(reply, stopReason)
    this.opts.onChange()
  }

  /** Parks an ask and resolves with the user's answers - or null when the ask
   *  was settled by a shutdown. One at a time by protocol shape: the agent
   *  blocks on the request, so a second cannot arrive while one is pending. */
  private pendAsk(ask: Omit<AcpAsk, 'id'>): Promise<Record<string, string> | null> {
    return new Promise((resolve) => {
      this.ask = { id: `ask-${++this.askSeq}`, ...ask }
      this.askResolve = resolve
      this.opts.onChange()
    })
  }

  private async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const answers = await this.pendAsk({
      kind: 'permission',
      title: params.toolCall.title ?? 'The agent needs a decision',
      questions: [
        {
          key: 'option',
          options: params.options.map((o) => ({ id: o.optionId, name: o.name, hint: o.kind })),
        },
      ],
    })
    const optionId = answers?.option
    if (!optionId) return { outcome: { outcome: 'cancelled' } }
    return { outcome: { outcome: 'selected', optionId } }
  }

  /** Form elicitation, the shape `claude-agent-acp` renders AskUserQuestion in:
   *  an object schema of single-select string fields, each a titled `oneOf` of
   *  option labels, with optional free-text companions. The spike answers the
   *  selects and skips the rest; anything without options at all is declined
   *  rather than parked on a card the user could never complete. */
  private async requestElicitation(
    params: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    if (params.mode !== 'form') return { action: 'decline' }
    const schema = params.requestedSchema as {
      properties?: Record<
        string,
        {
          title?: string
          description?: string
          oneOf?: { const?: unknown; title?: string; description?: string }[]
        }
      >
    }
    const questions: AcpAskQuestion[] = Object.entries(schema.properties ?? {}).flatMap(
      ([key, field]) => {
        const options = (field.oneOf ?? []).flatMap((o) =>
          typeof o.const === 'string'
            ? [{ id: o.const, name: o.title ?? o.const, ...(o.description ? { description: o.description } : {}) }]
            : [],
        )
        if (!options.length) return []
        return [
          {
            key,
            ...(field.description ?? field.title ? { text: field.description ?? field.title } : {}),
            options,
          },
        ]
      },
    )
    if (!questions.length) return { action: 'decline' }
    const answers = await this.pendAsk({ kind: 'question', title: params.message, questions })
    if (!answers) return { action: 'cancel' }
    return { action: 'accept', content: answers }
  }

  /** Only ever called from `pump`, which has already established that the update
   *  belongs to the live session and the live epoch. */
  private onUpdate(notification: SessionNotification): void {
    const update = notification.update
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type !== 'text') return
        const last = this.feed.at(-1)
        if (last?.kind === 'say') last.text += update.content.text
        else this.feed.push({ kind: 'say', text: update.content.text })
        break
      }
      case 'agent_thought_chunk': {
        if (update.content.type !== 'text') return
        const last = this.feed.at(-1)
        if (last?.kind === 'thought') last.text += update.content.text
        else this.feed.push({ kind: 'thought', text: update.content.text })
        break
      }
      case 'tool_call':
        this.feed.push({
          kind: 'tool',
          toolCallId: update.toolCallId,
          title: trimTitle(update.title, this.opts.cwd),
          status: update.status ?? 'pending',
        })
        break
      case 'tool_call_update': {
        const tool = this.feed.find(
          (f) => f.kind === 'tool' && f.toolCallId === update.toolCallId,
        ) as Extract<AcpFeedItem, { kind: 'tool' }> | undefined
        if (!tool) return
        if (update.status) tool.status = update.status
        if (update.title) tool.title = trimTitle(update.title, this.opts.cwd)
        break
      }
      case 'plan': {
        const entries = update.entries.map((e) => ({ content: e.content, status: e.status }))
        const existing = this.feed.find((f) => f.kind === 'plan') as
          | Extract<AcpFeedItem, { kind: 'plan' }>
          | undefined
        if (existing) existing.entries = entries
        else this.feed.push({ kind: 'plan', entries })
        break
      }
      default:
        return
    }
    if (this.feed.length > FEED_CAP) this.feed = this.feed.slice(-FEED_CAP)
    this.opts.onChange()
  }

  private async run(): Promise<void> {
    if (!this.child.stdin || !this.child.stdout) throw new Error('agent has no stdio')
    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
    )
    await client({ name: 'eztweak' })
      .onRequest(methods.client.session.requestPermission, (ctx) =>
        this.requestPermission(ctx.params),
      )
      .onRequest(methods.client.elicitation.create, (ctx) => this.requestElicitation(ctx.params))
      .connectWith(stream, async (ctx) => {
        const init = await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          // Form elicitation is what unlocks the agent's own question tool -
          // claude-agent-acp disallows AskUserQuestion without it.
          clientCapabilities: { elicitation: { form: {} } },
        })
        this.canClose = !!init.agentCapabilities?.sessionCapabilities?.close
        this.ctx = ctx
        await this.openSession()
        // `connectWith` closes the stream when this returns, so this is the
        // connection's lifetime - and it outlives any one session. It also
        // rejects if the stream dies first, which is how a killed agent gets
        // reported even though nothing here is awaiting the child.
        await new Promise<void>((resolve) => {
          this.finish = resolve
        })
      })
  }
}
