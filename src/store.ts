import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ATTACHMENT_GRACE_MS, SESSIONS_DIR } from './constants.js'
import type {
  Annotation,
  Attachment,
  ConversationEntry,
  FeedbackBatch,
  Reference,
  SessionEndedBy,
} from './protocol.js'

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

  addAnnotation(a: Annotation): void {
    this.writeJson('queue.json', [...this.annotations, a])
  }

  updateAnnotation(id: string, patch: Partial<Pick<Annotation, 'comment'>>): boolean {
    const list = this.annotations
    const target = list.find((a) => a.id === id)
    if (!target) return false
    Object.assign(target, patch)
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
  ): FeedbackBatch | null {
    const items = this.annotations
    if (items.length === 0 && !note?.trim() && attachments.length === 0 && references.length === 0) {
      return null
    }
    const batch: FeedbackBatch = {
      batchId: newId(),
      items,
      note: note?.trim() || null,
      ...(attachments.length ? { attachments } : {}),
      ...(references.length ? { references } : {}),
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
    const doomed = Object.values(index).filter(
      (a) => !referenced.has(a.id) && a.createdAt < cutoff,
    )
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

  appendConversation(entry: ConversationEntry): void {
    this.writeJson('conversation.json', [...this.conversation, entry])
  }

  setPort(port: number): void {
    this.patchSession({ port })
  }

  end(by: SessionEndedBy): void {
    this.patchSession({ state: 'ended', endedBy: by })
  }

  reopen(): void {
    const { endedBy: _endedBy, ...rest } = this.session
    this.writeJson('session.json', { ...rest, state: 'active' })
  }
}
