import { EventEmitter } from 'node:events'
import { accessSync, constants, readFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Socket } from 'node:net'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
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
import { chatTitles, worthListing } from './chat-titles.js'
import { readLimit, rememberedLimit, rememberLimit } from './usage-limit.js'
import type { AcpSnapshot } from './acp-agent.js'
import { type AcpConfigValue, configLabel, configValueName } from './acp-config.js'
import { AGENT_PROFILES, type AgentProfile, agentBrandFor, agentProfileFor } from './agents.js'
import { clearAgentRecord, reapOrphanedAgents } from './agent-children.js'
import { attachmentIds, parseReferences, sanitizeAnchor, sanitizeCapture } from './anchor.js'
import { injectOverlay, wantsHtml } from './inject.js'
import type { AttachmentLocator } from './label.js'
import { shortAnchor, toAgentAttachments, toAgentItem, toConversationItem } from './label.js'
import { type IncomingVariant, ExploreMcp, MCP_ROUTE, isExploreTool } from './mcp-explore.js'
import type {
  Anchor,
  Annotation,
  Attachment,
  ExploreCapture,
  ExploreState,
  ExploreStatus,
  PollResult,
  Reference,
  SessionEndedBy,
} from './protocol.js'
import { listSkills, skillPrefix, spendSkillMarkers } from './skills.js'
import { SessionStore, listRestorableSessions, newId } from './store.js'
import {
  clearRegistry,
  launchDaemon,
  probeDaemon,
  readRegistry,
  writeRegistry,
} from './registry.js'
import { installVersion, pruneInstalledVersions } from './installer.js'
import { latestVersion, updateChecksDisabled } from './update-check.js'
import { Updater, type UpdateWire } from './updater.js'
import { versionGate } from './version.js'

/** Whether a profile's CLI is on the PATH.
 *
 *  Advisory only, and lives here rather than beside the profiles because the
 *  shell imports those too - and a `node:fs` call reached through that import
 *  would end up in the browser bundle. */
function agentInstalled(profile: AgentProfile, env = process.env): boolean {
  return (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        accessSync(join(dir, profile.binary), constants.X_OK)
        return true
      } catch {
        return false
      }
    })
}

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
  /** The conversations this review has had, newest first, and which one is shown.
   *  Only ever sent in ACP mode: a poll-mode agent owns its own context and
   *  nothing here can move it. */
  chats?: ChatWire[]
  /** A newer version or a stale skill to offer, and the update's progress once
   *  taken up. Daemon-wide: every session's shell shows the same one. */
  update?: UpdateWire
  /** The explore rounds still on the page, oldest first. Not filtered by which
   *  conversation is showing: a round's variant stands in the page whichever
   *  thread the user is reading, and the strip is about the page. */
  explores?: ExploreState[]
  /** Whether this review can start one at all. Depends on what the agent
   *  advertised, so the page is told rather than left to guess: a command in the
   *  menu that always fails is worse than one that is not offered. */
  canExplore?: true
}

/** One conversation as the picker draws it. The count is what tells two of them
 *  apart when neither has anything else to go on - a chat is not named, it is
 *  when it happened and how much was said. */
interface ChatWire {
  id: string
  startedAt: number
  entries: number
  current: boolean
  /** The conversation this one branched off, when it did. The picker draws the
   *  indent from it, and 回主線 is a switch to it. */
  parentChatId?: string
  /** What this conversation is called, when it is not the review itself. */
  title?: string
  /** What it was opened about - the element, for an explore - which is what
   *  tells two rounds with the same name apart. */
  detail?: string
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
function acpPrompt(
  feedback: Extract<PollResult, { type: 'feedback' }>,
  skills: string[],
  agent: string,
): string {
  // The markers the composer left behind, spent now that the agent is known. The
  // record keeps `[skill n]`, which belongs to nobody; what goes over the wire is
  // the name in the language this agent reads.
  const named = (text: string | null): string | null =>
    text === null ? null : spendSkillMarkers(text, skills, agent)
  const spoken: typeof feedback = {
    ...feedback,
    note: named(feedback.note),
    items: feedback.items.map((item) => ({
      ...item,
      comment: named(item.comment) ?? item.comment,
    })),
  }
  return [
    // The first one, hoisted. The agent expands a leading slash command itself,
    // so this is an invocation rather than a request to consider one - and its
    // own line, because the expansion takes the rest of the first line as the
    // command's argument. Only the first: a second leading command is swallowed
    // as that argument, measured against the real agent, which read two as
    // "invoke alpha-probe with a `/beta-probe` argument" and ran neither. The
    // rest still reach the agent, named in the user's own sentence below, where
    // they read as what they are - something the user asked for.
    ...(skills.length ? [`${skillPrefix(agent)}${skills[0]}`, ''] : []),
    'The user reviewed the running app in their browser and sent this feedback batch.',
    'Each item resolves to source: trust `anchor.source` (file:line) when present, else',
    'use `anchor.components` / `anchor.section` / `anchor.selector` / `anchor.text`.',
    '`[file n]` in a comment is `attachments[n-1]` (read the file at `path`);',
    '`[ref n]` names the entry in `references` whose `n` matches.',
    'Apply every item, then reply with what you changed, item by item, one short line each.',
    '',
    JSON.stringify(spoken, null, 2),
  ].join('\n')
}

/** What an explore branch is asked for.
 *
 *  Its own prompt rather than `acpPrompt`, because it is a different request: no
 *  file is to be edited, the answer comes back through a tool rather than in
 *  prose, and what the agent is looking at is markup it has been handed rather
 *  than a queue of comments about a page.
 *
 *  The rules the tool enforces are stated here too. A rejection costs a turn and
 *  arrives after the agent has written the variant; a rule read before it starts
 *  costs nothing. */
function explorePrompt(
  round: ExploreState,
  capture: ExploreCapture,
  files: AttachmentLocator,
): string {
  const attachments = toAgentAttachments(round.attachments, files)
  const styles = Object.entries(capture.styles ?? {})
  const slot = capture.slot
  const layout = slot
    ? (['display', 'direction', 'align', 'justify', 'gap'] as const)
        .filter((key) => slot[key])
        .map((key) => `${key}: ${slot[key]}`)
    : []
  const inherits = Object.entries(slot?.inherits ?? {})
  const tokens = Object.entries(capture.tokens ?? {})
  const siblings = capture.siblings ?? []
  const theme = capture.theme
  return [
    `The user is exploring UI variants of one element on the page they are reviewing: ${round.label}.`,
    round.direction
      ? `They asked for: ${round.direction}`
      : 'They gave no direction, so range across genuinely different treatments rather than varying one thing.',
    ...(attachments?.length
      ? [
          '',
          '`[file n]` in that direction is `attachments[n-1]` here - read the file at `path`:',
          '',
          '```json',
          JSON.stringify(attachments, null, 2),
          '```',
        ]
      : []),
    ...(round.references?.length
      ? [
          '',
          '`[ref n]` in that direction names the entry here whose `n` matches. Each is another element',
          'on the same page the user is pointing you at - resolve it from `anchor.source` (file:line)',
          'when present, else from `components` / `section` / `selector` / `text`:',
          '',
          '```json',
          JSON.stringify(round.references, null, 2),
          '```',
        ]
      : []),
    '',
    '## The element, as it currently renders',
    '',
    '```html',
    capture.html,
    '```',
    ...(capture.truncated
      ? ['', 'That markup was cut short - the element has more in it than you are being shown.']
      : []),
    ...(styles.length
      ? ['', 'Its computed styling, resolved:', ...styles.map(([k, v]) => `- ${k}: ${v}`)]
      : []),
    ...(capture.rules?.length
      ? [
          '',
          "The page's CSS that currently styles it (and what is inside it), as authored. Hover, focus",
          'and pseudo-element states are here; copy from these rather than re-deriving them:',
          '',
          '```css',
          ...capture.rules,
          '```',
        ]
      : []),
    '',
    '## Where it stands',
    '',
    ...(capture.parentWidth ? [`- The container is ${capture.parentWidth}px wide.`] : []),
    ...(layout.length ? [`- The container lays its children out with ${layout.join(', ')}.`] : []),
    ...(siblings.length
      ? [
          `- Its siblings in that container, in order: ${siblings
            .map(
              (s) =>
                `<${s.tag}${s.class ? ` class="${s.class}"` : ''}> ${s.width}×${s.height}${s.text ? ` "${s.text}"` : ''}`,
            )
            .join('; ')}.`,
          '  A wider variant pushes them; a taller one changes the row.',
        ]
      : []),
    ...(theme
      ? [
          `- Theme: ${[
            theme.scheme ? `color-scheme ${theme.scheme}` : null,
            theme.dataTheme ? `data-theme="${theme.dataTheme}"` : null,
            theme.classes ? `classes "${theme.classes}"` : null,
          ]
            .filter(Boolean)
            .join(', ')}.`,
        ]
      : []),
    '',
    '## How your variant is rendered - read this before writing any CSS',
    '',
    "The variant is placed in a **shadow root** standing in the element's slot. Consequences:",
    '',
    capture.styles?.['box-sizing']
      ? `- **\`box-sizing\` is \`${capture.styles['box-sizing']}\` on every element inside the root**, matching the element it`
      : '- **`box-sizing` inside the root matches the element it stands in for**, on every element - the',
    capture.styles?.['box-sizing']
      ? '  stands in for, so `width: 100%` with padding lays out the way it does on the page. Nothing'
      : '  page has set it, so `width: 100%` with padding lays out the way it does on the page. Nothing',
    '  else from the page comes with it.',
    "- **None of the page's CSS reaches it.** Not `.btn`, not resets, nothing. Class names from the",
    '  page do nothing inside; write every rule the variant needs yourself, in one `<style>` inside the',
    '  root or as inline styles. The rules above are there to be copied from.',
    ...(inherits.length
      ? [
          '- **What it does inherit** from its position, so you need not restate these unless changing them:',
          ...inherits.map(([k, v]) => `  - ${k}: ${v}`),
          "  Note these are the *container's* values. A white `color` on the original comes from its own",
          '  class and will not carry over.',
        ]
      : []),
    ...(tokens.length
      ? [
          "- **The page's CSS custom properties are available** inside the variant and keep it in step with the",
          '  theme. Prefer them where they fit:',
          ...tokens.map(([k, v]) => `  - ${k}: ${v}`),
        ]
      : []),
    '- `@media`, `@keyframes`, `@supports` all work. Write `:host` where you would write `:root`;',
    '  `:root` matches nothing in a shadow tree.',
    '',
    '## Rules',
    '',
    '- Do not edit, create or delete any file. Nothing here is being implemented.',
    "- You may read the file in the element's anchor for context; nothing else needs reading.",
    '- Each variant is exactly one root element, at most one `<style>` inside it.',
    '- **No JavaScript** - no `<script>`, no inline handlers, no `javascript:` urls. Interaction is done',
    '  with the platform: `:hover`/`:focus-visible`/`:active`; `<details>`; `<input type=checkbox>` +',
    '  `:checked` + `:has()`; the `popover` attribute with `popovertarget`; `<dialog open>`; CSS',
    '  transitions and `@keyframes`; `scroll-snap`. A state that needs a click to see is better as a',
    '  second variant ("menu open") than as behaviour.',
    '- No `<iframe>`, `<link>`, `<object>`, `<embed>`.',
    '- The variants stand in for the real element on the page, so keep them the same kind of thing:',
    '  the same text, the same purpose, a different treatment.',
    '',
    'Produce 4 variants. Send each one with the `explore_variant` tool the moment it is ready,',
    'rather than writing them all out first: each call puts another option in front of the user.',
    '',
    'This conversation is a branch. The user may keep talking to you here about the variants, and',
    'nothing said here reaches the review they branched from unless they adopt one.',
    'When all four are sent, reply with one short line and stop.',
  ].join('\n')
}

/** Why the turn stopped, for the thread. Only ever shown for a stop the user did
 *  not get a reply out of - `end_turn` is the normal one and says nothing. The
 *  raw reason is kept in the fallback: an unmapped stop is still worth naming. */
/** A turn that ran to its own end without a word. Not an error - an agent that
 *  only ran tools, or whose skill did its work silently, has finished properly -
 *  so this states what happened rather than reporting a fault. */
const SAID_NOTHING_NOTE = '這一輪結束了，agent 沒有回覆內容'

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

/** What the thread is told when the review changes agent. Names the one it moved
 *  to, because the thread above belongs to a different one and the reader needs
 *  to know which. */
function agentSwitchNote(command: string): string {
  return `已改用 ${agentProfileFor(command)?.name ?? command}，這是新的對話`
}

/** A pick the user made, for the thread.
 *
 *  Recorded because a reply's worth is not separable from which model wrote it:
 *  a thread read back a month later without the switches in it says three
 *  answers came from one agent when they came from three. It also happens to be
 *  the only place a mode change becomes visible, and selecting some models
 *  changes the mode as a side effect.
 *
 *  Every switch gets a line, including a run of them. Collapsing a run was the
 *  first instinct and it is wrong here: the log is append-only and stamped in
 *  real time - that is what makes it the record - and rewriting the last entry
 *  to tidy the display would trade the property for the tidying. A deliberate
 *  keystroke is also not the kind of thing that arrives in floods; the note this
 *  sits beside is de-duplicated because a dev daemon restarts on every file save,
 *  which is a machine repeating itself, not a person changing their mind. */
function configChangeNote(option: SessionConfigOption, value: AcpConfigValue): string {
  const label = configLabel(option)
  if (typeof value === 'boolean') return `${label}已${value ? '開啟' : '關閉'}`
  return `已切換${label}：${configValueName(option, value)}`
}

class SessionRuntime {
  readonly store: SessionStore
  readonly bus = new EventEmitter()
  /** The explore rounds this session is taking variants for, and the tool the
   *  agent sends them through. */
  readonly exploreMcp = new ExploreMcp()
  /** The ask for a round whose branch is still opening. Held rather than sent,
   *  because a prompt to a session that is not up yet is a prompt that is
   *  dropped - see `deliverToAcp`. */
  private pendingExplore: string | null = null
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
  /** The skill the batch being delivered asked for. Read out of the outbox at
   *  delivery time rather than carried on the poll payload: `PollResult` is the
   *  portable CLI contract, and a slash command is meaningless to an agent that
   *  is not the one expanding it. */
  private activeSkills: string[] = []
  /** The agent-side session this review is on right now, recorded against the
   *  chat only once it has taken a turn. */
  private liveSession: string | null = null
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
    // A dismissed round is history: the thread still names it, but nothing of it
    // is on the page and nothing about it is on offer.
    const live = this.store.explores.filter((e) => e.status !== 'dismissed')
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
      ...(this.acp ? { acp: this.acp.snapshot(), chats: this.chatsWire() } : {}),
      ...(update ? { update } : {}),
      ...(live.length ? { explores: live } : {}),
      ...(this.canExplore ? { canExplore: true as const } : {}),
    }
  }

  /** The chat list as the shell draws it: newest first, because that is the one
   *  a review is normally on. The projection itself is the store's - it shares the
   *  entry-belongs-to-chat rule with the thread window, which is the only way the
   *  two can agree. */
  private chatsWire(): ChatWire[] {
    // A branch is named by what it was opened to do, and that outlives the round
    // being dismissed - the conversation is still there to go back to, and a
    // nameless row in the picker is one the user cannot choose between.
    const explores = this.store.explores
    return this.store
      .chatSummaries()
      .map((chat) => {
        const round = explores.find((e) => e.chatId === chat.id)
        return round ? { ...chat, title: '探索樣式', detail: round.label } : chat
      })
      .reverse()
  }

  broadcast(): void {
    const data = `data: ${JSON.stringify(this.snapshot())}\n\n`
    for (const res of this.sseClients) res.write(data)
  }

  /** Bring back the agent a previous daemon was driving.
   *
   *  Nothing is said to the thread here any more. The agent is asked to resume the
   *  conversation this review was already having, and whether it can is its answer
   *  to give - so the note about a lost context is written from `onSessionOpen`,
   *  by what actually happened, rather than from here by assuming the worst. */
  restoreAcpAgent(command: string): void {
    this.attachAcpAgent(command)
  }

  /** The thread is told its agent no longer remembers what came before.
   *
   *  Only when there is context to have lost, and only once per loss: an empty
   *  thread had none, and a restart that follows another with nothing said in
   *  between is the same loss reported twice. A dev daemon restarts on every save,
   *  which is what makes both cases the common ones. */
  private noteContextLost(): void {
    const thread = this.store.visibleConversation
    const last = thread.at(-1)
    if (thread.length === 0 || last?.text === AGENT_RESTARTED_NOTE) return
    this.store.appendConversation({
      role: 'system',
      text: AGENT_RESTARTED_NOTE,
      ts: Date.now(),
    })
  }

  /** Drive this review with a different agent.
   *
   *  Always into a fresh conversation, because a session id belongs to the agent
   *  that issued it: Claude keeps its conversations in one store and Codex in
   *  another, and neither can resolve the other's. There is no protocol for
   *  handing a conversation over, so the new agent starts knowing nothing - and
   *  a chat is what a *conversation* is here, so it gets its own.
   *
   *  Nothing is lost that eztweak owns. Every earlier chat stays in the picker
   *  with the agent that had it, and switching back finds that conversation
   *  again, resumable by the agent that remembers it. */
  switchAcpAgent(command: string): boolean {
    if (!command.trim()) return false
    if (this.acp?.snapshot().agent === command && this.acp.snapshot().state !== 'exited') {
      return true
    }
    this.acp?.stop()
    this.acp = null
    this.agentBusy = false
    this.activeBatch = null
    this.activeSkills = []
    this.agentProgress = null
    // Anything the old agent had not finished with. It is not coming back to
    // them, and the new agent was never asked.
    for (const id of this.store.pendingBatchIds()) this.store.ack(id)
    // Before the agent starts, so the session it opens is recorded against the
    // new chat rather than against the one the old agent was on.
    if (!this.store.onEmptyNewestChat) this.store.startChat()
    this.store.appendConversation({
      role: 'system',
      text: agentSwitchNote(command),
      ts: Date.now(),
    })
    this.attachAcpAgent(command)
    this.broadcast()
    return true
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
      // The figure outlives the process that was told it: it only ever arrives
      // pushed, so a daemon that forgot it would show nothing until the review's
      // next turn.
      rememberedLimit: () => rememberedLimit(command),
      onLimitChange: (limit) => rememberLimit(command, limit),
      // Whatever rounds are taking variants when this session opens. The port is
      // read now rather than captured, because a restored session can come back
      // on a different one.
      mcpServers: () => this.exploreMcp.serverEntries(this.port),
      ownTool: isExploreTool,
      // Delivery rides on every state change: the moment the agent first goes
      // idle - or comes back idle - whatever is queued goes out.
      onChange: () => {
        this.deliverToAcp()
        this.broadcast()
      },
      onTurnEnd: (text, stopReason) => {
        // Now, and not when the session opened. A session with no turns has no
        // transcript, so it cannot be resumed - recording one at open time meant
        // that two restarts with nothing said in between replaced a resumable
        // session with an unresumable one and lost the conversation that had the
        // content. A dev daemon restarts on every file save, which is exactly
        // where that happened.
        if (this.liveSession) this.store.setChatSession(this.liveSession, command)
        // A turn is the only thing that moves the account's usage, so it is the
        // cue to ask again. Free on both agents, and throttled anyway.
        this.refreshLimit(command)
        this.agentBusy = false
        this.agentProgress = null
        this.activeSkills = []
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
        // Every turn leaves something behind. A turn that ends well and says
        // nothing used to leave nothing at all: the user's message sat there with
        // no reply and no explanation, which reads as a turn still running long
        // after it stopped - the one thing the thread must never do, because
        // there is no other way to tell waiting from finished.
        const note =
          stopReason === 'end_turn' ? (text ? null : SAID_NOTHING_NOTE) : turnEndNote(stopReason)
        if (note) {
          this.store.appendConversation({
            role: 'system',
            text: note,
            ts: Date.now(),
            ...answers,
          })
        }
        // After the reply and its note, so the round's own note reads as the
        // last word on the turn rather than as an interruption of it. A round
        // lasts exactly as long as the turn that asked for it: whatever arrived
        // stays, and what stops is the agent's ability to send more, because a
        // variant arriving after that turn answers a question nobody is waiting
        // on.
        this.endExplore(stopReason === 'cancelled' ? 'cancelled' : 'done')
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
        this.activeSkills = []
        this.broadcast()
      },
      resumeSessionId: () => this.store.resumableSessionId(command),
      onSessionOpen: (sessionId, how) => {
        const wanted = this.store.resumableSessionId(command)
        // Held, not recorded. A session is only worth remembering once it has
        // said something - see `onTurnEnd`.
        this.liveSession = sessionId
        // The conversation was there to be picked up and the agent could not do
        // it: a transcript that has been deleted, or an agent that does not do
        // resume at all. That is the one case the thread has to hear about, and
        // the only one - a chat that never had a session had nothing to lose.
        if (wanted && how === 'new') this.noteContextLost()
        this.broadcast()
      },
      onModeChange: (name) => {
        this.store.appendConversation({
          role: 'system',
          text: `agent 把權限模式改成了「${name}」`,
          ts: Date.now(),
        })
        this.broadcast()
      },
      pinnedConfig: () => this.store.session.agentConfig ?? {},
      onConfigChange: (configId, value, option) => {
        this.store.setAgentConfig(configId, value)
        this.store.appendConversation({
          role: 'system',
          text: configChangeNote(option, value),
          ts: Date.now(),
        })
      },
    })
    this.refreshLimit(command)
    return true
  }

  /** The figure, asked for rather than waited on.
   *
   *  Both agents answer this for free - a local command on one, a local RPC on
   *  the other - so it is simply asked whenever the answer could have changed:
   *  when the agent starts, and at the end of every turn, a turn being the only
   *  thing that moves an account's usage. `readLimit` throttles it.
   *
   *  Fired and forgotten: it is a line of text arriving late, and nothing waits
   *  on it. */
  private refreshLimit(command: string): void {
    const agent = this.acp
    void readLimit(command)
      .then((limit) => {
        // The agent may have been swapped out while this was in flight, and the
        // figure would then describe an account nobody is looking at.
        if (!limit || !agent || this.acp !== agent) return
        rememberLimit(command, limit)
        agent.seedLimit(limit)
      })
      .catch(() => {
        /* best effort - the line keeps whatever it last had */
      })
  }

  answerAcp(id: string, answers: unknown): boolean {
    return this.acp?.answer(id, answers) ?? false
  }

  declineAcp(id: string): boolean {
    return this.acp?.decline(id) ?? false
  }

  /** The user picked a model, an effort level, a mode - whatever this agent
   *  offers. Awaited, because the answer carries the reshaped option set and the
   *  broadcast that follows is what the picker redraws from. */
  async setAcpConfig(configId: string, value: AcpConfigValue): Promise<boolean> {
    if (!this.acp) return false
    if (!(await this.acp.setConfigOption(configId, value))) return false
    this.broadcast()
    return true
  }

  /** SPIKE: stop the turn the agent is in the middle of. The turn's own end does
   *  the bookkeeping - the agent still answers the prompt, with `cancelled` and
   *  whatever it had already said. */
  cancelAcpTurn(): boolean {
    return this.acp?.cancelTurn() ?? false
  }

  /** Carry on in a fresh conversation.
   *
   *  The shell shows an empty thread afterwards, because that is what "new chat"
   *  means to the person who asked for one - a notice explaining that the history
   *  above no longer counts is still history above. The log on disk is untouched
   *  either way: it is the record of the review, and windowing it costs nothing
   *  while deleting it would cost the only copy. */
  newAcpChat(): boolean {
    // Already on a fresh one. Asking again is asking for what is already there,
    // and honouring it literally would pile up empty conversations in the picker
    // and throw away a session that has nothing to throw away.
    if (this.store.onEmptyNewestChat) return !!this.acp
    return this.moveToChat(() => this.store.startChat().id)
  }

  /** Branch the review off the conversation it is on: the agent copies the
   *  transcript into a new session, a new chat is recorded against it, and the
   *  review moves there. Everything said from now on belongs to the branch and
   *  never reaches the parent.
   *
   *  The copy has to happen before the move, because a branch is only a branch if
   *  the agent kept the history: a fork the agent refused would otherwise leave
   *  the review on a fresh, empty conversation that looks like a branch and is
   *  not. So a refusal here leaves everything exactly where it was, and the
   *  caller decides what to say about it.
   *
   *  Resuming the copy is `reopenSession`'s job, which is also where the mcp
   *  servers and the review's pinned model get re-asserted - both of which a
   *  resumed session needs, since it comes back on the agent's own defaults. */
  async branchAcpChat(): Promise<boolean> {
    if (!this.acp?.canBranch) return false
    // Nothing said yet means nothing to carry, and an agent refuses to fork a
    // session with no transcript - which made `/explore` fail on every review
    // that had not had a turn yet, which is most of them at the moment someone
    // first reaches for it. A plain new chat is then not a degradation but the
    // identical outcome: same empty context, same isolation from the review. The
    // *parent* is still recorded, so 回主線 still goes back.
    if (!this.acp.hasTranscript) {
      return this.moveToChat(() => this.store.startBranch(undefined, undefined).id)
    }
    const agent = this.acp.snapshot().agent
    const forked = await this.acp.forkSession()
    if (!forked) return false
    return this.moveToChat(() => this.store.startBranch(forked, agent).id)
  }

  /** The conversation this one branched off, when it did. */
  parentChatId(): string | undefined {
    return this.store.currentChat.parentChatId
  }

  /** Whether this session can run an explore at all: an agent that takes a tool
   *  over HTTP MCP, and one that branches. Both, because a round without the
   *  tool has no way back and a round without the branch would be had in the
   *  review itself. */
  get canExplore(): boolean {
    return !!this.acp?.canBranch && this.acp.servesMcpHttp
  }

  /** Open a round: a url for the agent to send variants to, a branch to have it
   *  on, and the turn that asks for them.
   *
   *  The order is forced. The round's mcp server has to exist before the branch
   *  session is opened, because `mcpServers` is read at open time and a session
   *  opened without it has no tool to answer with - which fails as silence
   *  rather than as an error. So: open the round, branch, record, ask.
   *
   *  A branch that does not happen takes the round with it. Running the explore
   *  in the review itself would be the one thing this feature exists not to do. */
  async startExplore(input: {
    anchor: Anchor
    capture: ExploreCapture
    direction?: string
    attachments?: Attachment[]
    references?: Reference[]
  }): Promise<ExploreState | null> {
    if (!this.canExplore) return null
    const id = newId()
    this.exploreMcp.open(id, (variant) => this.takeVariant(id, variant))
    if (!(await this.branchAcpChat())) {
      this.exploreMcp.close(id)
      return null
    }
    const label = shortAnchor(input.anchor)
    const round = this.store.startExplore({
      id,
      chatId: this.store.currentChat.id,
      label,
      anchor: input.anchor,
      ...(input.direction ? { direction: input.direction } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.references?.length ? { references: input.references } : {}),
    })
    this.store.appendConversation({
      role: 'user',
      text: input.direction ? `探索 ${label}：${input.direction}` : `探索 ${label}`,
      ts: Date.now(),
      ...(round.attachments?.length ? { attachments: round.attachments.map((a) => a.name) } : {}),
      ...(round.references?.length
        ? { references: round.references.map((r) => ({ n: r.n, label: r.label })) }
        : {}),
    })
    this.pendingExplore = explorePrompt(round, input.capture, this.store)
    this.deliverToAcp()
    this.broadcast()
    return round
  }

  /** One variant, arriving from the agent's tool call. The string goes back as
   *  the tool's result, which is the agent's cue for what to do next: how many
   *  have landed is what tells it when it is done. */
  private takeVariant(id: string, variant: IncomingVariant): string {
    const round = this.store.addVariant(id, variant)
    if (!round)
      return 'This explore round is over; the user is no longer looking at it. Stop sending variants.'
    // The first one goes on the page by itself. The user asked to see variants,
    // and a strip of buttons that all have to be clicked before anything happens
    // is a worse answer to that than showing the first and letting them move.
    if (round.variants.length === 1) this.store.selectVariant(id, round.variants[0]!.id)
    this.broadcast()
    return `Variant ${round.variants.length} ("${variant.name}") is now on the user's page.`
  }

  /** The round the current branch is running, while it is still running it. */
  private generatingExplore(): ExploreState | undefined {
    const chatId = this.store.currentChat.id
    return this.store.explores.find((e) => e.chatId === chatId && e.status === 'generating')
  }

  /** The branch's turn is over, however it ended. The url stops taking variants
   *  either way: an agent that goes on calling the tool after the turn it was
   *  asked in is answering a question nobody is waiting on. */
  private endExplore(status: ExploreStatus): void {
    const round = this.generatingExplore()
    if (!round) return
    this.exploreMcp.close(round.id)
    this.store.setExploreStatus(round.id, status)
    if (!round.variants.length && status === 'done') {
      this.store.appendConversation({
        role: 'system',
        text: '這一輪沒有產出任何 variant',
        ts: Date.now(),
      })
    }
  }

  selectVariant(id: string, variantId: string | null): boolean {
    if (!this.store.selectVariant(id, variantId)) return false
    this.broadcast()
    return true
  }

  dismissExplore(id: string): boolean {
    if (!this.store.dismissExplore(id)) return false
    this.exploreMcp.close(id)
    this.broadcast()
    return true
  }

  /** Show an earlier conversation and put the agent back on it. */
  switchAcpChat(id: string): boolean {
    if (!this.store.chats.some((c) => c.id === id)) return false
    if (id === this.store.currentChat.id) return true
    return this.moveToChat(() => this.store.switchChat(id)?.id)
  }

  /** Move the review onto another conversation and the agent with it.
   *
   *  The store moves first and the agent second, because what the agent opens is
   *  read back off the store: a chat with a session id is resumed, one without
   *  starts fresh. Ordered the other way it would reopen the conversation it was
   *  already on.
   *
   *  A failure to move the store leaves the agent alone; a refusal from the agent
   *  puts the store back, because a thread showing one conversation while the
   *  agent is on another is the one state nothing downstream can make sense of. */
  private moveToChat(move: () => string | undefined): boolean {
    if (!this.acp) return false
    const from = this.store.currentChat.id
    const to = move()
    if (!to) return false
    if (!this.acp.reopenSession()) {
      this.store.switchChat(from)
      return false
    }
    this.agentBusy = false
    this.activeBatch = null
    this.activeSkills = []
    this.agentProgress = null
    // Everything the agent had not finished with, not just the turn it was on: the
    // one in flight went with the session it was asked of, and the ones queued
    // behind it were asked of a conversation the review has just moved off.
    // Acking is what stops the session that opens next being handed them.
    for (const id of this.store.pendingBatchIds()) this.store.ack(id)
    this.broadcast()
    return true
  }

  /** Hand the next queued batch to the ACP agent, if both exist. The payload is
   *  the same JSON `poll` prints, so the skill's reading of it carries over. */
  private deliverToAcp(): void {
    if (!this.acp || this.acp.snapshot().state !== 'idle') return
    // The explore's own turn goes first and alone. Branching only *starts* the
    // session it will run in - `reopenSession` returns as soon as it has let go
    // of the old one - so the ask waits here for the branch to actually be open,
    // the same way a queued batch waits for the agent to be ready for it.
    const explore = this.pendingExplore
    if (explore) {
      this.pendingExplore = null
      this.agentBusy = true
      this.acp.prompt(explore)
      this.broadcast()
      return
    }
    const outcome = this.pollOutcome()
    if (!outcome) return
    if (outcome.type === 'session-ended') {
      this.acp.stop()
      this.acp = null
      return
    }
    this.acp.prompt(acpPrompt(outcome, this.activeSkills, this.acp.snapshot().agent))
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
    this.activeSkills = batch.skills ?? []
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

    // The agent's own end of the review: one url per live explore round, each
    // behind its own token. Mounted on this session's app because a round
    // belongs to a session, so a url cannot reach across to another one's.
    api.post(MCP_ROUTE, this.exploreMcp.handler())

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
      const skills = Array.isArray(req.body?.skills)
        ? (req.body.skills as unknown[]).filter((v): v is string => typeof v === 'string')
        : []
      // Every one checked against what is actually on disk: a name becomes a
      // command in a prompt, and a name nobody vetted is a line of the user's
      // text being handed to the agent as an instruction. Checked as a set, so a
      // batch naming the same skill twice costs one read rather than two.
      const known = new Set(listSkills(this.project).map((s) => s.name))
      if (skills.some((name) => !known.has(name))) {
        return res.status(400).json({ error: 'unknown skill' })
      }
      const batch = this.store.sendBatch(req.body?.note ?? null, files, refs, skills)
      if (!batch) return res.status(400).json({ error: 'nothing to send' })
      this.store.appendConversation({
        role: 'user',
        text: batch.note ?? '',
        ts: Date.now(),
        batchId: batch.batchId,
        items: batch.items.map(toConversationItem),
        ...(batch.attachments?.length ? { attachments: batch.attachments.map((a) => a.name) } : {}),
        ...(batch.references?.length
          ? { references: batch.references.map((r) => ({ n: r.n, label: r.label })) }
          : {}),
        ...(batch.skills?.length ? { skills: batch.skills } : {}),
      })
      if (this.acp) this.deliverToAcp()
      this.wakePollers()
      res.json({ batchId: batch.batchId })
    })

    // SPIKE: the user answered the agent's question card in the shell.
    // Either the answers, or `decline: true` for a question the user would
    // rather not answer. The shape of the answers is the agent's to check
    // against the fields it asked for; a mismatch reads as the question having
    // moved on, which for the shell it has.
    api.post('/acp/answer', (req, res) => {
      const id = String(req.body?.id ?? '')
      if (!id) return res.status(400).json({ error: 'id is required' })
      const settled =
        req.body?.decline === true
          ? this.declineAcp(id)
          : typeof req.body?.answers === 'object' && req.body.answers !== null
            ? this.answerAcp(id, req.body.answers)
            : null
      if (settled === null) return res.status(400).json({ error: 'answers or decline is required' })
      if (!settled) return res.status(409).json({ error: 'that question is no longer waiting' })
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

    // The user set one of the agent's config options - which model to carry on
    // with, how hard to think, which mode to be in.
    api.post('/acp/config', (req, res) => {
      const configId = String(req.body?.configId ?? '')
      const value = req.body?.value
      if (!configId || (typeof value !== 'string' && typeof value !== 'boolean')) {
        return res
          .status(400)
          .json({ error: 'configId and a string or boolean value are required' })
      }
      // The agent can refuse - a value it no longer offers, or a hook that blocks
      // the switch - and its refusal is not this daemon's fault, so it travels as
      // the conflict it is rather than as a 500.
      this.setAcpConfig(configId, value).then(
        (ok) =>
          ok
            ? res.json({ ok: true })
            : res.status(409).json({ error: 'that option cannot be set right now' }),
        (err: unknown) =>
          res
            .status(409)
            .json({ error: err instanceof Error ? err.message : 'the agent refused the change' }),
      )
    })

    // The agents this review can be driven by, and which one is on.
    api.get('/acp/agents', (_req, res) => {
      const running = this.acp?.snapshot().agent
      res.json({
        agents: AGENT_PROFILES.map((profile) => ({
          id: profile.id,
          name: profile.name,
          installed: agentInstalled(profile),
          current: profile.command === running,
        })),
      })
    })

    // Drive the review with a different agent. Always a new conversation - the
    // shell says so before it asks for this.
    api.post('/acp/agent', (req, res) => {
      const id = String(req.body?.id ?? '')
      const profile = AGENT_PROFILES.find((p) => p.id === id)
      // By id, never by a command from the wire: this starts a process.
      if (!profile) return res.status(400).json({ error: 'unknown agent' })
      if (!this.acp) {
        return res.status(409).json({ error: 'this review is not driving an agent' })
      }
      if (!this.switchAcpAgent(profile.command)) {
        return res.status(409).json({ error: 'that agent cannot be started right now' })
      }
      res.json({ ok: true })
    })

    // The skills this project can ask the agent to run. Read on request rather
    // than carried in the snapshot: the snapshot goes out on every streamed
    // chunk, and this reads the disk.
    api.get('/acp/skills', (_req, res) => {
      res.json({ skills: listSkills(this.project) })
    })

    // Show an earlier conversation and put the agent back on it.
    // The conversations this review has had, named. Fetched when the picker is
    // opened rather than ridden along on every broadcast: naming them reaches
    // outside this process - a transcript on disk, a call to codex - and a turn
    // streaming chunks must not pay for that a hundred times a second.
    // The conversations `/resume` offers: the review's own lines, not the
    // branches off them. A branch is reached from the breadcrumb of the line it
    // came off, where its siblings are and where the context makes it mean
    // something; in a flat list of everything the review has ever had, a row
    // called 探索樣式 says nothing about which conversation it belongs to.
    // Filtered before the titles are fetched, so nothing is asked of the agent
    // for rows that will not be drawn.
    api.get('/acp/chats', async (_req, res) => {
      const summaries = this.store.chatSummaries().filter((chat) => !chat.parentChatId)
      const command = this.acp?.snapshot().agent ?? ''
      let titles = new Map<string, string>()
      try {
        titles = await chatTitles(summaries, command, this.project)
      } catch {
        /* a picker of timestamps still works */
      }
      res.json({
        chats: summaries
          .map((chat) => ({
            id: chat.id,
            startedAt: chat.startedAt,
            entries: chat.entries,
            current: chat.current,
            ...(titles.get(chat.id) ? { title: titles.get(chat.id) } : {}),
          }))
          // Not every conversation is one - see `worthListing`.
          .filter(worthListing)
          .reverse(),
      })
    })

    // The figure, asked for because the user is looking at it. Usage moves in
    // whatever else is running on this machine - a terminal session, another
    // review - and a turn here is only one of the things that spends it, so the
    // end of a turn cannot be the only time this is asked. `readLimit` throttles,
    // so a shell that asks on every focus costs nothing it should not.
    api.post('/acp/limit', (_req, res) => {
      const command = this.acp?.snapshot().agent
      if (command) this.refreshLimit(command)
      res.json({ ok: true })
    })

    api.post('/acp/chat', (req, res) => {
      const id = String(req.body?.id ?? '')
      if (!id) return res.status(400).json({ error: 'id is required' })
      if (!this.switchAcpChat(id)) {
        return res.status(409).json({ error: 'that conversation cannot be opened right now' })
      }
      res.json({ ok: true })
    })

    // Start a round: branch the conversation and ask for variants of one element.
    api.post('/explore/start', async (req, res) => {
      const anchor = sanitizeAnchor(req.body?.anchor)
      const capture = sanitizeCapture(req.body?.capture)
      if (!anchor || !capture) {
        return res.status(400).json({ error: 'anchor and capture are required' })
      }
      const direction = typeof req.body?.direction === 'string' ? req.body.direction.trim() : ''
      // The same resolution `/annotations` does, because the markers in the text
      // mean the same thing here: `[file n]` is a path the agent opens, `[ref n]`
      // an element it is being pointed at.
      const ids = attachmentIds(req.body?.attachments)
      if (!ids) return res.status(400).json({ error: 'attachments must be an array of ids' })
      const files = this.store.getAttachments(ids)
      if (!files) return res.status(400).json({ error: 'unknown attachment id' })
      const refs = parseReferences(req.body?.references)
      if (!refs) return res.status(400).json({ error: 'references must be an array of anchors' })
      const round = await this.startExplore({
        anchor,
        capture,
        ...(direction ? { direction } : {}),
        ...(files.length ? { attachments: files } : {}),
        ...(refs.length ? { references: refs } : {}),
      })
      if (!round) {
        return res.status(409).json({ error: 'this agent cannot run an explore right now' })
      }
      res.json({ exploreId: round.id })
    })

    // Put one variant on the page, or `null` for the element as it really is.
    api.post('/explore/select', (req, res) => {
      const id = String(req.body?.id ?? '')
      const variantId = req.body?.variantId
      if (!id || (variantId !== null && typeof variantId !== 'string')) {
        return res.status(400).json({ error: 'id and variantId are required' })
      }
      if (!this.selectVariant(id, variantId)) {
        return res.status(409).json({ error: 'no such variant in that round' })
      }
      res.json({ ok: true })
    })

    // Close a round: the page goes back to what it really is, and the agent's
    // url for it stops taking variants.
    api.post('/explore/dismiss', (req, res) => {
      const id = String(req.body?.id ?? '')
      if (!id) return res.status(400).json({ error: 'id is required' })
      if (!this.dismissExplore(id)) return res.status(409).json({ error: 'no such explore round' })
      res.json({ ok: true })
    })

    // Branch the conversation: the agent copies what has been said so far into a
    // session of its own and the review moves there. Answers with the new chat
    // and the one it came from, so the caller can offer the way back without
    // reading the whole picker.
    api.post('/acp/branch', async (_req, res) => {
      if (!(await this.branchAcpChat())) {
        return res
          .status(409)
          .json({ error: 'this agent cannot branch the conversation right now' })
      }
      res.json({ chatId: this.store.currentChat.id, parentChatId: this.parentChatId() })
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
      // A different agent already on this session is a switch, not a conflict.
      // It was a conflict when there was no safe way to change one; there is now
      // - the shell's own picker does it - and `--agent X` has only ever meant
      // "this session runs X". Refusing it while the shell allows it would make
      // the CLI the odd one out, and the advice it used to give (end the session)
      // was destructive for something that costs a new conversation.
      if (!runtime.attachAcpAgent(agent) && !runtime.switchAcpAgent(agent)) {
        return res.status(409).json({ error: 'that agent cannot be started right now' })
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
  // Whatever a killed predecessor could not kill for itself. Before any session
  // is restored, so a review that is about to start its agent again is not
  // sharing the machine with the one it left behind.
  const reaped = reapOrphanedAgents()
  if (reaped > 0) {
    // eslint-disable-next-line no-console
    console.error(`reaped ${reaped} agent process group(s) left by a killed daemon`)
  }
  const cleanup = () => {
    clearRegistry(process.pid)
    clearAgentRecord()
    process.exit(0)
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)

  // The predecessor lets go of its session ports only once this daemon is
  // registered, so restoring before it has exited would land them elsewhere
  // and orphan every open shell. If it never exits, restore anyway - a daemon
  // on other ports beats no daemon.
  const predecessorGone = opts.succeed === undefined || (await waitForExit(opts.succeed, 15_000))
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
