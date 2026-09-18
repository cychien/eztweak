import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ATTACHMENT_GRACE_MS, SESSIONS_DIR } from './constants.js'
import type { AcpConfigValue } from './acp-config.js'
import type {
  Anchor,
  Annotation,
  Attachment,
  ConversationEntry,
  ExploreState,
  ExploreStatus,
  ExploreVariant,
  FeedbackBatch,
  Reference,
  SessionEndedBy,
} from './protocol.js'

/** Whether two anchors point at the same place on the page, for the one
 *  question that needs to know: can these two explore rounds both have their
 *  variant standing in a slot, or are they fighting over one.
 *
 *  `source` first, because `file:line` is the only identity here that survives a
 *  re-render. Without the build plugin there is only the selector, which is
 *  weaker - two rounds on structurally identical elements may be judged the same
 *  - and the cost of that is one selection cleared, not a wrong swap. */
/** How a round closes: with its variants under `status`, or - holding none -
 *  dismissed, off the strip and off the page. A round already dismissed stays so
 *  whatever it holds. */
function closeExplore(round: ExploreState, status: ExploreStatus): ExploreState {
  if (round.status === 'dismissed') return round
  return round.variants.length
    ? { ...round, status }
    : { ...round, status: 'dismissed', selected: null }
}

export function sameTarget(a: Anchor, b: Anchor): boolean {
  if (a.source && b.source) return a.source === b.source && a.text === b.text
  return !!a.selector && a.selector === b.selector
}

export function newId(): string {
  return randomBytes(6).toString('hex')
}

/** Origin alone is not an identity: dev servers default to the same port, so
 *  two projects reviewed on `localhost:5173` would share one store and the
 *  first one's undelivered feedback would be handed to the second one's agent. */
export function sessionKey(targetOrigin: string, project: string): string {
  return createHash('sha1').update(`${targetOrigin}\n${project}`).digest('hex').slice(0, 12)
}

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
}

function extensionFor(mime: string): string {
  const known = MIME_EXT[mime]
  if (known) return known
  const subtype = mime.split('/')[1] ?? ''
  return /^[a-z0-9]{1,8}$/.test(subtype) ? `.${subtype}` : ''
}

/** The stored filename is built from this, so it has to give up anything that
 *  could leave the attachments directory: separators first, then the leading
 *  dots that `..` and dotfiles are made of. Non-ASCII names survive - they are
 *  not dangerous, and a Chinese filename mangled to `file.png` is a worse
 *  outcome than one kept intact. */
export function sanitizeAttachmentName(raw: string, mime: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60)
  return cleaned || `file${extensionFor(mime)}`
}

/** Clipboard screenshots all arrive as `image.png`, so a session would otherwise
 *  fill with chips the user cannot tell apart. */
function dedupeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

export interface PersistedSession {
  targetOrigin: string
  /** Absolute path of the project being reviewed on this origin. */
  project: string
  state: 'active' | 'ended'
  endedBy?: SessionEndedBy
  createdAt: number
  /** Last port this session's proxy held. A restarted daemon re-binds it so the
   *  shell tab the user already has open survives a reload. */
  port?: number
  /** The ACP command this session's agent was started with. A restarted daemon
   *  spawns it again, so the review does not lose its agent along with the
   *  daemon - though it does lose the agent's context, which is what the shell
   *  is told. */
  agent?: string
  /** The agent-config picks the user made - model, effort, mode - keyed by the
   *  agent's own config ids. Re-asserted on every session this agent opens, so a
   *  `/new` or a daemon restart does not quietly hand the review back to the
   *  agent's default model. Only the user's own picks live here: see
   *  `AcpAgentOptions.onConfigChange`. */
  agentConfig?: Record<string, AcpConfigValue>
  /** The conversations this review has had, oldest first. A window onto the log,
   *  never a cut in it: the record stays whole on disk and the shell is shown one
   *  chat at a time, which is what "new chat" means to the person who asked for
   *  one - and what lets an earlier one be picked back up.
   *
   *  Written on first use, so a session recorded before chats existed gets one
   *  built from its `conversationClear`. */
  chats?: Chat[]
  /** Which of `chats` the shell is showing and the agent is on. */
  currentChatId?: string
  /** Superseded by `chats`. Read once, to migrate; never written again. */
  conversationClear?: ConversationClear
}

/** One conversation: a window onto the log, and the ACP session that remembers
 *  it. */
export interface Chat {
  id: string
  /** The agent-side session backing this chat, once one is open. Absent on a
   *  chat that has never reached an agent, and replaced when the agent turns out
   *  not to have the old one any more. */
  acpSessionId?: string
  /** Which agent issued `acpSessionId`. A session id is only meaningful to the
   *  agent that made it - Claude keeps its conversations in one store and Codex
   *  in another, and neither can resolve the other's - so without this a review
   *  that changed agent would offer one of them the other's id and be told, at
   *  best, that no such session exists. */
  agent?: string
  startedAt: number
  /** The conversation this one was branched off, when it was. A branch carries
   *  the parent's history - the agent was handed a copy of it - but nothing said
   *  in the branch reaches the parent, which is the point: an explore can be
   *  talked about at length and the review still returns to where it forked
   *  from, carrying only what the user chose to take back. */
  parentChatId?: string
}

/** One chat, with what it takes to choose between them: when, how much, and
 *  whether it is the one showing. */
export interface ChatSummary {
  id: string
  startedAt: number
  entries: number
  current: boolean
  /** The ACP session this conversation ran on, when it ever ran one. What the
   *  agents' own names for it are keyed by - see `chat-titles.ts`. */
  acpSessionId?: string
  /** The agent it ran on, since each names its conversations in its own way. */
  agent?: string
  /** The first thing the user said in it, for a conversation no agent will name. */
  said?: string
  /** The conversation this one branched off, when it did. What the picker draws
   *  the indent from, and what 回主線 goes back to. */
  parentChatId?: string
}

export interface ConversationClear {
  /** Entries stamped at or after this are the new thread. */
  at: number
}

/** Every session on disk. */
export function listPersistedSessions(): PersistedSession[] {
  let keys: string[]
  try {
    keys = readdirSync(SESSIONS_DIR)
  } catch {
    return []
  }
  const sessions: PersistedSession[] = []
  for (const key of keys) {
    try {
      const raw = readFileSync(join(SESSIONS_DIR, key, 'session.json'), 'utf8')
      const parsed = JSON.parse(raw) as PersistedSession
      // Pre-`project` directories are inert: without knowing which project they
      // belong to, reusing one is the very mix-up `sessionKey` exists to stop.
      if (typeof parsed?.targetOrigin === 'string' && typeof parsed?.project === 'string') {
        sessions.push(parsed)
      }
    } catch {
      /* half-written or foreign directory - skip it */
    }
  }
  return sessions
}

/** The sessions a starting daemon should rebuild proxies for. Only one project
 *  can hold a given origin at a time, so when several are on record for one
 *  origin the newest is the one whose dev server is plausibly still there. */
export function listRestorableSessions(): PersistedSession[] {
  const newestPerOrigin = new Map<string, PersistedSession>()
  for (const session of listPersistedSessions()) {
    if (session.state !== 'active') continue
    const held = newestPerOrigin.get(session.targetOrigin)
    if (!held || session.createdAt > held.createdAt) {
      newestPerOrigin.set(session.targetOrigin, session)
    }
  }
  return [...newestPerOrigin.values()]
}

/**
 * Disk-backed state for one review session (one target origin). Files are tiny
 * and every mutation rewrites the file synchronously — queued feedback must
 * survive daemon restarts and crashes.
 */
export class SessionStore {
  readonly dir: string

  constructor(
    readonly targetOrigin: string,
    readonly project: string,
  ) {
    this.dir = join(SESSIONS_DIR, sessionKey(targetOrigin, project))
    mkdirSync(this.dir, { recursive: true })
    if (!this.readJson<PersistedSession>('session.json')) {
      this.writeJson('session.json', {
        targetOrigin,
        project,
        state: 'active',
        createdAt: Date.now(),
      } satisfies PersistedSession)
    }
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as T
    } catch {
      return null
    }
  }

  private writeJson(file: string, value: unknown): void {
    writeFileSync(join(this.dir, file), JSON.stringify(value, null, 2))
  }

  private patchSession(patch: Partial<PersistedSession>): void {
    this.writeJson('session.json', { ...this.session, ...patch })
  }

  get session(): PersistedSession {
    return this.readJson<PersistedSession>('session.json')!
  }

  get annotations(): Annotation[] {
    return this.readJson<Annotation[]>('queue.json') ?? []
  }

  get outbox(): FeedbackBatch[] {
    return this.readJson<FeedbackBatch[]>('outbox.json') ?? []
  }

  get conversation(): ConversationEntry[] {
    return this.readJson<ConversationEntry[]>('conversation.json') ?? []
  }

  // ------------------------------------------------------------------ explore

  /** Every round this review has had, oldest first, dismissed ones included -
   *  the thread still refers to them, and a dismissed round is history rather
   *  than a mistake. Callers that draw the strip filter them out. */
  get explores(): ExploreState[] {
    return this.readJson<ExploreState[]>('explores.json') ?? []
  }

  private writeExplores(explores: ExploreState[]): void {
    this.writeJson('explores.json', explores)
  }

  private patchExplore(id: string, patch: (e: ExploreState) => ExploreState): ExploreState | null {
    const explores = this.explores
    const found = explores.find((e) => e.id === id)
    if (!found) return null
    const next = patch(found)
    this.writeExplores(explores.map((e) => (e.id === id ? next : e)))
    return next
  }

  /** Open a round on one element.
   *
   *  Any live round already holding this element's place gives it up: two rounds
   *  cannot both have their variant standing in one slot, and the newer one is
   *  the one the user just asked for. Rounds on *other* elements are left alone,
   *  which is what lets a button and a heading be explored at once. */
  startExplore(
    round: Omit<ExploreState, 'status' | 'variants' | 'selected' | 'startedAt'>,
  ): ExploreState {
    const fresh: ExploreState = {
      ...round,
      status: 'generating',
      variants: [],
      selected: null,
      startedAt: Date.now(),
    }
    const explores = this.explores.map((e) =>
      e.selected && sameTarget(e.anchor, fresh.anchor) ? { ...e, selected: null } : e,
    )
    this.writeExplores([...explores, fresh])
    return fresh
  }

  /** Record a variant against a round that is still taking them. Null when the
   *  round is over or gone, which is how a late one is refused. */
  addVariant(id: string, variant: Omit<ExploreVariant, 'id' | 'createdAt'>): ExploreState | null {
    const round = this.explores.find((e) => e.id === id)
    if (!round || round.status !== 'generating') return null
    return this.patchExplore(id, (e) => ({
      ...e,
      variants: [...e.variants, { ...variant, id: newId(), createdAt: Date.now() }],
    }))
  }

  /** The round's turn is over, however it ended. What a closed round keeps is
   *  what had arrived, so one that ends holding nothing is dismissed outright:
   *  there is no variant to leave on the page and no reason for a tab. */
  endExplore(id: string, status: ExploreStatus): ExploreState | null {
    return this.patchExplore(id, (e) => closeExplore(e, status))
  }

  /** Bring every round into line with how rounds close now, on restore.
   *
   *  No turn survives the daemon, so a round still generating when its session
   *  comes back is over - cancelled, with whatever had arrived. Left alone it
   *  stayed generating for good, a strip saying 還在想 about an agent that was
   *  not. And a round closed by an earlier version holding nothing is dismissed
   *  the way `endExplore` would dismiss it today, so the strip is not carrying
   *  tabs for rounds that were empty before the rule existed. */
  settleExplores(): void {
    const explores = this.explores
    const settled = explores.map((e) =>
      closeExplore(e, e.status === 'generating' ? 'cancelled' : e.status),
    )
    if (settled.some((e, i) => e.status !== explores[i]!.status)) this.writeExplores(settled)
  }

  /** The round is taking variants again, because a turn is about to run in the
   *  branch it belongs to. Not `endExplore`'s inverse: that one *settles* a round,
   *  and settling one that holds nothing dismisses it outright. A dismissed round
   *  is past reviving - nothing of it is on the page and its url is gone. */
  resumeExplore(id: string): ExploreState | null {
    return this.patchExplore(id, (e) =>
      e.status === 'dismissed' ? e : { ...e, status: 'generating' },
    )
  }

  /** Put one of a round's variants on the page, or `null` for the original.
   *  Refused for a variant the round does not have, so the page can never be
   *  asked to show markup nothing recorded. */
  selectVariant(id: string, variantId: string | null): ExploreState | null {
    const round = this.explores.find((e) => e.id === id)
    if (!round) return null
    if (variantId !== null && !round.variants.some((v) => v.id === variantId)) return null
    return this.patchExplore(id, (e) => ({ ...e, selected: variantId }))
  }

  /** Close a round: nothing of it is on the page any more, and its url stops
   *  taking variants. Kept in the list, because the thread refers to it. */
  dismissExplore(id: string): ExploreState | null {
    return this.patchExplore(id, (e) => ({ ...e, status: 'dismissed', selected: null }))
  }

  markExploreAdopted(id: string, variantId: string): ExploreState | null {
    return this.patchExplore(id, (e) => ({ ...e, adopted: variantId }))
  }

  addAnnotation(a: Annotation): void {
    this.writeJson('queue.json', [...this.annotations, a])
  }

  /** Files dropped by an edit are deliberately left on disk: `sweepAttachments`
   *  is what collects an unreferenced attachment, and deleting eagerly here would
   *  make saving a comment destroy bytes the user cannot see they are losing.
   *  `removeAnnotation` drops them because the annotation itself is gone. */
  updateAnnotation(
    id: string,
    patch: Partial<Pick<Annotation, 'comment' | 'attachments' | 'references'>>,
  ): boolean {
    const list = this.annotations
    const target = list.find((a) => a.id === id)
    if (!target) return false
    // Assigned key by key, dropping the empty ones: an `Object.assign` of a patch
    // holding `comment: undefined` would blank the comment rather than leave it,
    // and an empty `attachments: []` should mean the field is gone, not present
    // and empty - that is the shape `addAnnotation` writes.
    if (patch.comment !== undefined) target.comment = patch.comment
    if (patch.attachments !== undefined) {
      if (patch.attachments.length) target.attachments = patch.attachments
      else delete target.attachments
    }
    if (patch.references !== undefined) {
      if (patch.references.length) target.references = patch.references
      else delete target.references
    }
    this.writeJson('queue.json', list)
    return true
  }

  removeAnnotation(id: string): boolean {
    const list = this.annotations
    const target = list.find((a) => a.id === id)
    if (!target) return false
    this.writeJson(
      'queue.json',
      list.filter((a) => a.id !== id),
    )
    // After the queue write, so a crash in between leaves an orphan file for the
    // sweep rather than an annotation pointing at bytes that are already gone.
    this.dropAttachments(target.attachments)
    return true
  }

  /** Move the queue (+ optional note and its files) into a sealed batch awaiting
   *  agent pickup. Attachment bytes stay put - the batch now references them. */
  sendBatch(
    note: string | null,
    attachments: Attachment[] = [],
    references: Reference[] = [],
    skills: string[] = [],
  ): FeedbackBatch | null {
    const items = this.annotations
    // A skill on its own is a batch: "run this over what you can see" is a
    // request, even with nothing annotated and nothing typed.
    if (
      items.length === 0 &&
      !note?.trim() &&
      attachments.length === 0 &&
      references.length === 0 &&
      skills.length === 0
    ) {
      return null
    }
    const batch: FeedbackBatch = {
      batchId: newId(),
      items,
      note: note?.trim() || null,
      ...(attachments.length ? { attachments } : {}),
      ...(references.length ? { references } : {}),
      ...(skills.length ? { skills } : {}),
      sentAt: Date.now(),
    }
    this.writeJson('outbox.json', [...this.outbox, batch])
    this.writeJson('queue.json', [])
    return batch
  }

  // -------------------------------------------------------------- attachments

  get attachmentsDir(): string {
    return join(this.dir, 'attachments')
  }

  /** id → metadata for every attachment held by this session, including ones no
   *  annotation references yet because the user is still typing. */
  get attachmentIndex(): Record<string, Attachment> {
    return this.readJson<Record<string, Attachment>>('attachments.json') ?? {}
  }

  attachmentPath(a: Attachment): string {
    return join(this.attachmentsDir, `${a.id}-${a.name}`)
  }

  addAttachment(rawName: string, mime: string, bytes: Buffer): Attachment {
    const index = this.attachmentIndex
    const taken = new Set(Object.values(index).map((a) => a.name))
    const attachment: Attachment = {
      id: newId(),
      name: dedupeName(sanitizeAttachmentName(rawName, mime), taken),
      mime,
      size: bytes.byteLength,
      createdAt: Date.now(),
    }
    mkdirSync(this.attachmentsDir, { recursive: true })
    // Bytes before index: an index entry pointing at no file would break every
    // reader, while a file no entry names is just something for the sweep.
    writeFileSync(this.attachmentPath(attachment), bytes)
    this.writeJson('attachments.json', { ...index, [attachment.id]: attachment })
    return attachment
  }

  /** Null when any id is unknown - a partial resolution would silently drop a
   *  file the user watched themselves attach. */
  getAttachments(ids: string[]): Attachment[] | null {
    const index = this.attachmentIndex
    const found: Attachment[] = []
    for (const id of ids) {
      const a = index[id]
      if (!a) return null
      found.push(a)
    }
    return found
  }

  removeAttachment(id: string): 'ok' | 'referenced' | 'unknown' {
    const index = this.attachmentIndex
    const target = index[id]
    if (!target) return 'unknown'
    if (this.referencedAttachmentIds().has(id)) return 'referenced'
    this.dropAttachments([target])
    return 'ok'
  }

  /** Deletes files and index entries outright. Callers own the check that
   *  nothing still references them. */
  private dropAttachments(list: Attachment[] | undefined): void {
    if (!list?.length) return
    const index = this.attachmentIndex
    for (const a of list) {
      try {
        unlinkSync(this.attachmentPath(a))
      } catch {
        /* already gone - the index entry is still worth dropping */
      }
      delete index[a.id]
    }
    this.writeJson('attachments.json', index)
  }

  private referencedAttachmentIds(): Set<string> {
    const ids = new Set<string>()
    const take = (list?: Attachment[]) => {
      for (const a of list ?? []) ids.add(a.id)
    }
    for (const a of this.annotations) take(a.attachments)
    for (const batch of this.outbox) {
      take(batch.attachments)
      for (const item of batch.items) take(item.attachments)
    }
    for (const round of this.explores) take(round.attachments)
    return ids
  }

  /** Drops attachments nothing references and nothing is plausibly still
   *  composing. Runs at session start rather than on send: a sweep must never
   *  race a composer that is holding freshly uploaded ids, and the grace window
   *  is what buys that safety without any coordination. */
  sweepAttachments(now = Date.now()): void {
    const cutoff = now - ATTACHMENT_GRACE_MS
    const referenced = this.referencedAttachmentIds()
    const index = this.attachmentIndex
    const doomed = Object.values(index).filter((a) => !referenced.has(a.id) && a.createdAt < cutoff)
    this.dropAttachments(doomed)

    // Files written before the crash that stopped their index entry. Nothing
    // will ever name them, so age is the only thing that can decide.
    const kept = new Set(Object.values(this.attachmentIndex).map((a) => `${a.id}-${a.name}`))
    let entries: string[]
    try {
      entries = readdirSync(this.attachmentsDir)
    } catch {
      return
    }
    for (const name of entries) {
      if (kept.has(name)) continue
      const path = join(this.attachmentsDir, name)
      try {
        if (statSync(path).mtimeMs >= cutoff) continue
        unlinkSync(path)
      } catch {
        /* raced with another sweep or a manual delete */
      }
    }
  }

  /** Oldest batch not yet acked. Redelivers delivered-but-unacked batches (at-least-once). */
  nextBatch(): FeedbackBatch | null {
    return this.outbox.find((b) => !b.ackedAt) ?? null
  }

  /** Batches handed out but never acked - what an ACP turn's end settles. At most
   *  one at a time: `nextBatch` only ever hands out the oldest unacked. */
  deliveredBatchIds(): string[] {
    return this.outbox.filter((b) => b.deliveredAt && !b.ackedAt).map((b) => b.batchId)
  }

  /** Everything the agent has not finished with - the one it is on, and the ones
   *  still waiting behind it. What `/new` settles: a fresh session is not going to
   *  answer questions the user has just said to start over from. */
  pendingBatchIds(): string[] {
    return this.outbox.filter((b) => !b.ackedAt).map((b) => b.batchId)
  }

  markDelivered(batchId: string): void {
    const outbox = this.outbox
    const batch = outbox.find((b) => b.batchId === batchId)
    if (batch && !batch.deliveredAt) {
      batch.deliveredAt = Date.now()
      this.writeJson('outbox.json', outbox)
    }
  }

  ack(batchId: string): void {
    const outbox = this.outbox
    const batch = outbox.find((b) => b.batchId === batchId)
    if (batch && !batch.ackedAt) {
      batch.ackedAt = Date.now()
      this.writeJson('outbox.json', outbox)
    }
  }

  /** Stamped with the chat it was written during, which is what lets the window
   *  be a filter rather than a time range - an earlier chat picked back up goes
   *  on collecting entries stamped later than the chat that followed it. */
  appendConversation(entry: ConversationEntry): void {
    const stamped: ConversationEntry = { chatId: this.currentChat.id, ...entry }
    this.writeJson('conversation.json', [...this.conversation, stamped])
  }

  setPort(port: number): void {
    this.patchSession({ port })
  }

  setAgent(command: string): void {
    this.patchSession({ agent: command })
  }

  /** Remember one of the user's agent-config picks - the model, and anything else
   *  the agent offers - so the next session opens on it. */
  setAgentConfig(configId: string, value: AcpConfigValue): void {
    this.patchSession({ agentConfig: { ...this.session.agentConfig, [configId]: value } })
  }

  /** Ending drops the agent with the session: a reopen decides afresh whether
   *  it is ACP-driven, and a restore must not resurrect an agent nobody asked for.
   *  The picks go with it - they described that agent's options, and the next one
   *  need not have them. */
  end(by: SessionEndedBy): void {
    const { agent: _agent, agentConfig: _agentConfig, ...rest } = this.session
    this.writeJson('session.json', { ...rest, state: 'ended', endedBy: by })
  }

  /** This review's conversations, oldest first, with one guaranteed to exist.
   *
   *  Built on demand rather than at session creation so a store recorded before
   *  chats existed grows one: its `conversationClear` becomes the first chat's
   *  `startedAt`, which is the same window under a new name. */
  get chats(): Chat[] {
    const session = this.session
    if (session.chats?.length) return session.chats
    const chats: Chat[] = [
      { id: newId(), startedAt: session.conversationClear?.at ?? session.createdAt },
    ]
    this.patchSession({ chats, currentChatId: chats[0]!.id })
    return chats
  }

  /** The conversation the shell is showing and the agent is on. */
  get currentChat(): Chat {
    const chats = this.chats
    const id = this.session.currentChatId
    return chats.find((c) => c.id === id) ?? chats[chats.length - 1]!
  }

  /** Begin a conversation. Nothing is deleted: the log keeps every word, and only
   *  the window moves. */
  startChat(): Chat {
    const chat: Chat = { id: newId(), startedAt: Date.now() }
    this.patchSession({ chats: [...this.chats, chat], currentChatId: chat.id })
    return chat
  }

  /** Begin a conversation branched off the current one.
   *
   *  Unlike `startChat`, this one is born knowing its session: the agent has
   *  already copied the transcript into `acpSessionId`, and recording it here is
   *  what makes the reopen that follows a *resume of the copy* rather than a
   *  fresh start. The order matters - the store moves first, because what the
   *  agent opens is read back off it. */
  startBranch(acpSessionId: string | undefined, agent: string | undefined): Chat {
    const chat: Chat = {
      id: newId(),
      startedAt: Date.now(),
      parentChatId: this.currentChat.id,
      ...(acpSessionId && agent ? { acpSessionId, agent } : {}),
    }
    this.patchSession({ chats: [...this.chats, chat], currentChatId: chat.id })
    return chat
  }

  /** Show an earlier conversation and put the agent back on it. */
  switchChat(id: string): Chat | null {
    const chat = this.chats.find((c) => c.id === id)
    if (!chat) return null
    this.patchSession({ currentChatId: chat.id })
    return chat
  }

  /** Record the agent-side session now backing the current chat, and which agent
   *  issued it. Replaces what was there: a resume the agent could not honour
   *  leaves the chat on a different session than it started with, and the old id
   *  names nothing. */
  setChatSession(acpSessionId: string, agent: string): void {
    const current = this.currentChat
    this.patchSession({
      chats: this.chats.map((c) => (c.id === current.id ? { ...c, acpSessionId, agent } : c)),
    })
  }

  /** The session to ask this agent to resume, if the current chat has one *it*
   *  issued. A chat from another agent has an id that agent cannot resolve, so
   *  the honest answer is nothing and a fresh session. */
  resumableSessionId(agent: string): string | undefined {
    const chat = this.currentChat
    return chat.agent === agent ? chat.acpSessionId : undefined
  }

  /** Whether one logged entry belongs to one chat.
   *
   *  Two rules, because the log outlived the change. An entry stamped with a chat
   *  belongs to that chat. An entry from before stamping belongs to the first
   *  chat, gated by its `startedAt` - which is the `conversationClear` it was
   *  migrated from, so an old session draws exactly what it drew before.
   *
   *  One predicate, used by both the thread window and the chat list: they were
   *  written twice once, and the copy disagreeing with the original is how a
   *  conversation comes to be counted as empty while its thread is on screen. */
  private belongsTo(entry: ConversationEntry, chat: Chat, isFirst: boolean): boolean {
    return entry.chatId === undefined
      ? isFirst && entry.ts >= chat.startedAt
      : entry.chatId === chat.id
  }

  /** The thread as the shell should draw it: the current chat, and nothing else. */
  get visibleConversation(): ConversationEntry[] {
    const current = this.currentChat
    const isFirst = this.chats[0]?.id === current.id
    return this.conversation.filter((entry) => this.belongsTo(entry, current, isFirst))
  }

  /** Every chat with enough about it to be chosen between, oldest first.
   *
   *  Every one, including a chat nothing has been said in yet: the caller reads
   *  "an earlier conversation is showing" off the current chat's position in this
   *  list, so dropping an empty newer one would make an older one look like the
   *  newest and take that signal away in the one state it exists to report. */
  chatSummaries(): ChatSummary[] {
    const chats = this.chats
    const current = this.currentChat.id
    const firstId = chats[0]?.id
    const log = this.conversation
    return chats.map((chat) => {
      const mine = log.filter((entry) => this.belongsTo(entry, chat, chat.id === firstId))
      const said = mine.find(
        (entry) =>
          entry.role === 'user' &&
          (entry.text?.trim() || entry.items?.some((item) => item.comment?.trim())),
      )
      return {
        id: chat.id,
        startedAt: chat.startedAt,
        entries: mine.length,
        current: chat.id === current,
        ...(chat.acpSessionId ? { acpSessionId: chat.acpSessionId } : {}),
        ...(chat.agent ? { agent: chat.agent } : {}),
        ...(chat.parentChatId ? { parentChatId: chat.parentChatId } : {}),
        ...(said
          ? {
              said:
                said.text?.trim() ||
                said.items?.find((item) => item.comment?.trim())?.comment?.trim(),
            }
          : {}),
      }
    })
  }

  /** Whether the newest chat is showing and has nothing in it - i.e. the review
   *  is already on a fresh conversation, and being asked for one again has
   *  nothing to do. */
  get onEmptyNewestChat(): boolean {
    const summaries = this.chatSummaries()
    const last = summaries[summaries.length - 1]
    return !!last?.current && last.entries === 0
  }

  reopen(): void {
    const { endedBy: _endedBy, ...rest } = this.session
    this.writeJson('session.json', { ...rest, state: 'active' })
  }
}
