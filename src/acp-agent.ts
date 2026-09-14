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
  type ClientContext,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import { type AcpConfigValue, configValues } from './acp-config.js'
import { type AttachedSession, SessionRouter } from './acp-session.js'

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
  /** Everything the agent lets this session be configured with - model, mode,
   *  effort, and whatever else it offers - in the agent's own order.
   *
   *  Passed through as the protocol's `SessionConfigOption` rather than reduced
   *  to a model field: the set is not fixed. It changes *with* the choice, and
   *  not only in its values - selecting a model that supports neither effort
   *  levels nor Fast mode drops both options from the list. A client that names
   *  the options it knows would have to be taught each new one; this one only
   *  has to be taught how to *draw* a select and a boolean. */
  configOptions?: SessionConfigOption[]
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
  /** The picks to re-assert on every session this agent opens. Read at open
   *  time rather than taken once: `/new` and a daemon restart both open a fresh
   *  session, and by then the user may have changed the pick. */
  pinnedConfig?: () => Record<string, AcpConfigValue>
  /** The user set an option. Only ever called for a pick *they* made - an option
   *  the agent moved on its own is reported, not remembered, because carrying it
   *  forward would propagate a change nobody asked for into every later session.
   *  The clearest case is a model without Auto-mode support: selecting it
   *  downgrades the permission mode, and pinning that would keep the session
   *  downgraded long after the model that caused it was switched away from. */
  onConfigChange?: (configId: string, value: AcpConfigValue, option: SessionConfigOption) => void
  /** The permission mode moved without anyone here asking it to - which is the
   *  only way it moves, since the shell does not offer it. Selecting a model the
   *  current mode is not available on is what does it, and the change outlives
   *  the model that caused it, so it is reported rather than left silent. */
  onModeChange?: (name: string) => void
  /** The ACP session this review already had, if any. Read at open time, not
   *  taken once: every session this agent opens asks again, and the answer
   *  changes as the review moves between its own conversations. */
  resumeSessionId?: () => string | undefined
  /** A session is up, and how. The two mean different things to the thread - one
   *  conversation continued, the other started over - so the caller is told
   *  which rather than left to assume the pessimistic one. */
  onSessionOpen?: (sessionId: string, how: AcpSessionStart) => void
}

/** Whether the session on the other end remembers this review or is meeting it
 *  for the first time. */
export type AcpSessionStart = 'new' | 'resumed'

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
  /** Routes this connection's session updates into whichever session is live. */
  private readonly router = new SessionRouter()
  /** The live session. One ordered queue carrying its updates *and* its turn's
   *  `stop` - see `acp-session.ts`, which is where that matters. */
  private session: AttachedSession | null = null
  private state: AcpState = 'starting'
  private feed: AcpFeedItem[] = []
  /** The live session's options. Kept across a session swap rather than cleared:
   *  the next session is about to be pinned back to the same picks, and a control
   *  that vanishes and returns reads as a failure where a stale label for the
   *  moment the swap takes does not. `state` already says it cannot be used. */
  private configOptions: SessionConfigOption[] = []
  /** The mode as it stood when this session's options were last installed. Null
   *  until a session has one, so opening a session establishes a baseline rather
   *  than reporting a change against the session before it. */
  private modeValue: string | null = null
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
  /** Set when the agent advertises `session/resume`, which is what lets a review
   *  pick its own conversation back up after the daemon that held it went away. */
  private canResume = false
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

  /** Install a fresh option set and report a mode that moved with it. */
  private setConfigOptions(options: SessionConfigOption[]): void {
    this.configOptions = options
    const mode = options.find((o) => o.category === 'mode')
    const value = mode && mode.type === 'select' ? String(mode.currentValue) : null
    if (value && this.modeValue && value !== this.modeValue) {
      const name = configValues(mode!).find((o) => o.value === value)?.name ?? value
      this.opts.onModeChange?.(name)
    }
    this.modeValue = value
  }

  snapshot(): AcpSnapshot {
    return {
      agent: this.opts.command,
      state: this.state,
      feed: this.feed,
      ...(this.ask ? { ask: this.ask } : {}),
      ...(this.configOptions.length ? { configOptions: this.configOptions } : {}),
      ...(this.cancelling ? { cancelling: true as const } : {}),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  /** The user picked a value for one of the agent's config options.
   *
   *  The answer carries the whole option set back, because one pick reshapes the
   *  others: switching to a model with no effort levels removes that option
   *  outright. So the response replaces the list rather than patching a value
   *  into it, and the caller's own idea of what the options are never has to be
   *  reconciled with the agent's.
   *
   *  Allowed mid-turn. The agent accepts it and the turn in flight still ends
   *  normally; the change applies from the next one. Refusing it would take the
   *  control away at the one moment it is most wanted - watching a turn go wrong
   *  is what prompts a switch. */
  async setConfigOption(configId: string, value: AcpConfigValue): Promise<boolean> {
    const session = this.session
    if (!session || !this.ctx) return false
    if (this.state !== 'idle' && this.state !== 'working') return false
    const option = this.configOptions.find((o) => o.id === configId)
    if (!option) return false
    const epoch = this.epoch
    const answer = await this.ctx.request(methods.agent.session.setConfigOption, {
      sessionId: session.sessionId,
      configId,
      ...(typeof value === 'boolean' ? { type: 'boolean' as const, value } : { value }),
    })
    // The session this was asked of is gone - `/new`, or the agent died while the
    // request was out. Installing its answer would describe a session nobody is
    // on any more.
    if (epoch !== this.epoch) return false
    if (answer?.configOptions) this.setConfigOptions(answer.configOptions)
    // Only what actually took is remembered, and the answer is what says so - a
    // request can succeed without the change landing, which is what a
    // `PreModelSwitch` hook refusing a model does. Pinning a value the agent
    // declined would re-offer it to every later session and be declined again
    // each time, and the thread would carry a switch that never happened.
    const applied = this.configOptions.find((o) => o.id === configId)
    if (applied?.currentValue !== value) {
      this.opts.onChange()
      return false
    }
    this.opts.onConfigChange?.(configId, value, applied)
    this.opts.onChange()
    return true
  }

  /** Re-assert the user's picks on a session that has just opened.
   *
   *  Sequential rather than parallel, because the options are interdependent: a
   *  pinned effort level is only offered once the pinned model is in place, and
   *  the agent's answer to each request is what says whether the next one is
   *  still on the list.
   *
   *  Every failure is survivable and none of them is the session's fault - a
   *  model that has since left the account's list, an effort level the new
   *  default model does not have. The pick is skipped and the session opens on
   *  whatever the agent chose; refusing to open would cost the user their review
   *  over a preference. */
  private async applyPinnedConfig(epoch: number): Promise<void> {
    const pinned = this.opts.pinnedConfig?.() ?? {}
    for (const [configId, value] of Object.entries(pinned)) {
      if (epoch !== this.epoch) return
      const option = this.configOptions.find((o) => o.id === configId)
      // Already where the user wanted it, or not on offer for this model. Asking
      // anyway would spend a round trip to be told what we can already see.
      if (!option || option.currentValue === value) continue
      try {
        const answer = await this.ctx?.request(methods.agent.session.setConfigOption, {
          sessionId: this.session?.sessionId ?? '',
          configId,
          ...(typeof value === 'boolean' ? { type: 'boolean' as const, value } : { value }),
        })
        if (epoch !== this.epoch) return
        if (answer?.configOptions) this.setConfigOptions(answer.configOptions)
      } catch {
        /* the pick is no longer available - the agent's own choice stands */
      }
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

  /** Let go of the session this agent is on and open whichever one it should be
   *  on now - which `resumeSessionId` answers, so the caller decides by moving
   *  the review before calling this. A fresh conversation is that answer being
   *  nothing; going back to an earlier one is it being that one's id.
   *
   *  The child process and the connection both stay either way. What costs tokens
   *  is the history the agent replays on every turn, and that belongs to the
   *  session, not to the process.
   *
   *  A turn in flight is cancelled rather than waited on - moving off this
   *  conversation is the whole point of asking - and its end is then dropped on
   *  the epoch. */
  reopenSession(): boolean {
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
    old.retire()
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

  /** The session this agent should be on: the one the review already had, picked
   *  back up, or a fresh one.
   *
   *  Resume is tried first, because a review that still has a session id wants
   *  *that* conversation rather than a copy of it, and resume is cheap - the
   *  agent replays nothing. Its failure is ordinary rather than fatal: the
   *  transcript can be gone, the project can have moved, the agent may not do
   *  resume at all. A fresh session is the fallback, and the caller is told which
   *  of the two it got.
   *
   *  The session is only installed if it is still the one wanted by the time the
   *  agent answers. */
  private async openSession(): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    const epoch = this.epoch
    const wanted = this.opts.resumeSessionId?.()
    let sessionId: string | null = null
    let configOptions: SessionConfigOption[] = []
    let how: AcpSessionStart = 'new'
    if (wanted && this.canResume) {
      try {
        const resumed = await ctx.request(methods.agent.session.resume, {
          sessionId: wanted,
          cwd: this.opts.cwd,
          mcpServers: [],
        })
        sessionId = wanted
        configOptions = resumed?.configOptions ?? []
        how = 'resumed'
      } catch {
        /* the agent does not have it any more - a fresh session it is */
      }
    }
    if (epoch !== this.epoch) return
    if (!sessionId) {
      const created = await ctx.request(methods.agent.session.new, {
        cwd: this.opts.cwd,
        mcpServers: [],
      })
      sessionId = created.sessionId
      configOptions = created.configOptions ?? []
    }
    // A newer request landed while the agent was answering this one: that request
    // owns the session now, so this one is closed rather than installed.
    if (epoch !== this.epoch) {
      void this.closeSession(sessionId)
      return
    }
    const session = this.router.attach(ctx, sessionId)
    this.session = session
    // Baseline, not a change: this is a different conversation's options.
    this.modeValue = null
    this.setConfigOptions(configOptions)
    // Before `idle`, and this is load-bearing. Going idle is what `onChange`
    // turns into a delivery, so a queued batch leaves the moment the flag flips -
    // and a pick re-asserted after that point would arrive one turn too late,
    // every time. A reopened session with feedback already waiting is the common
    // path, not the corner case: its first turn is the one the model was chosen
    // for. A resumed session needs it too - resume comes back on the agent's
    // default, not on what the review was last running.
    await this.applyPinnedConfig(epoch)
    if (epoch !== this.epoch) {
      session.retire()
      return
    }
    this.state = 'idle'
    // Before `onChange`, which is what turns going idle into a delivery: the
    // caller records the session id here, and a batch must not go out against a
    // session nothing has written down yet.
    this.opts.onSessionOpen?.(sessionId, how)
    this.opts.onChange()
    void this.pump(session, epoch).catch((err: unknown) => {
      if (epoch !== this.epoch) return
      this.fail(err instanceof Error ? err.message : String(err))
    })
  }

  /** Drains one session's messages in the order the agent wrote them. The
   *  ordering that makes this correct belongs to the queue - see
   *  `acp-session.ts`. This only has to stop when the session is retired, which
   *  the queue answers rather than leaving it parked forever. */
  private async pump(session: AttachedSession, epoch: number): Promise<void> {
    for (;;) {
      const message = await session.next()
      if (message.kind === 'retired' || epoch !== this.epoch) return
      if (message.kind === 'update') this.onUpdate(message.notification)
      else this.turnEnded(message.stopReason, epoch)
    }
  }

  stop(): void {
    this.state = 'exited'
    this.settleAsk()
    this.session?.retire()
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
    this.session?.retire()
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
      // Not the feed's business, and not the turn's: these describe the session,
      // so they must not be capped away with the turn's activity or cleared when
      // it ends. Both arrive unprompted - the agent can change its own mind about
      // the model, and does.
      case 'config_option_update':
        this.setConfigOptions(update.configOptions)
        this.opts.onChange()
        return
      // The mode has its own notification as well as its place in the option
      // list, and an agent is free to send only this one. Matched on the category
      // rather than on an id, because `mode` is what the *spec* names the concept
      // and the id holding it is the agent's to choose.
      case 'current_mode_update': {
        const mode = this.configOptions.find((o) => o.category === 'mode')
        if (!mode || mode.type !== 'select' || mode.currentValue === update.currentModeId) return
        this.setConfigOptions(
          this.configOptions.map((o) =>
            o === mode ? { ...o, currentValue: update.currentModeId } : o,
          ),
        )
        this.opts.onChange()
        return
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
      // Every session update this connection carries, sorted to whichever session
      // is live. The SDK's own router leaves these unconsumed, so both can watch.
      .onNotification(methods.client.session.update, (ctx) => this.router.route(ctx.params))
      .onRequest(methods.client.session.requestPermission, (ctx) =>
        this.requestPermission(ctx.params),
      )
      .onRequest(methods.client.elicitation.create, (ctx) => this.requestElicitation(ctx.params))
      .connectWith(stream, async (ctx) => {
        const init = await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          // Form elicitation is what unlocks the agent's own question tool -
          // claude-agent-acp disallows AskUserQuestion without it.
          //
          // A boolean config option is only sent to a client that says it can
          // draw one; without this an on/off toggle arrives as a two-value
          // select, which is the same question asked in more clicks.
          clientCapabilities: {
            elicitation: { form: {} },
            session: { configOptions: { boolean: {} } },
          },
        })
        this.canClose = !!init.agentCapabilities?.sessionCapabilities?.close
        this.canResume = !!init.agentCapabilities?.sessionCapabilities?.resume
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
