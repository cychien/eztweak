import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_RESTORE_MAX_AGE_MS, SESSIONS_DIR } from './constants.js'
import type { Annotation, ConversationEntry, FeedbackBatch, SessionEndedBy } from './protocol.js'

export function newId(): string {
  return randomBytes(6).toString('hex')
}

export function originKey(targetOrigin: string): string {
  return createHash('sha1').update(targetOrigin).digest('hex').slice(0, 12)
}

export interface PersistedSession {
  targetOrigin: string
  state: 'active' | 'ended'
  endedBy?: SessionEndedBy
  createdAt: number
  /** Last port this session's proxy held. A restarted daemon re-binds it so the
   *  shell tab the user already has open survives a reload. */
  port?: number
}

/** A session's record plus when it was last written, which is what bounds
 *  restore-on-startup. */
export interface SessionOnDisk extends PersistedSession {
  updatedAt: number
}

/** Every session on disk. */
export function listPersistedSessions(): SessionOnDisk[] {
  let keys: string[]
  try {
    keys = readdirSync(SESSIONS_DIR)
  } catch {
    return []
  }
  const sessions: SessionOnDisk[] = []
  for (const key of keys) {
    try {
      const file = join(SESSIONS_DIR, key, 'session.json')
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as PersistedSession
      if (typeof parsed?.targetOrigin === 'string') {
        sessions.push({ ...parsed, updatedAt: statSync(file).mtimeMs })
      }
    } catch {
      /* half-written or foreign directory - skip it */
    }
  }
  return sessions
}

/** The sessions a starting daemon should rebuild proxies for: still active, and
 *  recent enough that the user plausibly still has that target open. Nothing
 *  marks a session `ended` when the daemon dies, so the age bound is the only
 *  thing keeping this list from growing without limit. */
export function listRestorableSessions(): SessionOnDisk[] {
  const cutoff = Date.now() - SESSION_RESTORE_MAX_AGE_MS
  return listPersistedSessions().filter((s) => s.state === 'active' && s.updatedAt >= cutoff)
}

/**
 * Disk-backed state for one review session (one target origin). Files are tiny
 * and every mutation rewrites the file synchronously — queued feedback must
 * survive daemon restarts and crashes.
 */
export class SessionStore {
  readonly dir: string

  constructor(readonly targetOrigin: string) {
    this.dir = join(SESSIONS_DIR, originKey(targetOrigin))
    mkdirSync(this.dir, { recursive: true })
    if (!this.readJson<PersistedSession>('session.json')) {
      this.writeJson('session.json', {
        targetOrigin,
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
    const next = list.filter((a) => a.id !== id)
    if (next.length === list.length) return false
    this.writeJson('queue.json', next)
    return true
  }

  /** Move the queue (+ optional note) into a sealed batch awaiting agent pickup. */
  sendBatch(note: string | null): FeedbackBatch | null {
    const items = this.annotations
    if (items.length === 0 && !note?.trim()) return null
    const batch: FeedbackBatch = {
      batchId: newId(),
      items,
      note: note?.trim() || null,
      sentAt: Date.now(),
    }
    this.writeJson('outbox.json', [...this.outbox, batch])
    this.writeJson('queue.json', [])
    return batch
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
    this.writeJson('session.json', { ...this.session, port })
  }

  end(by: SessionEndedBy): void {
    this.writeJson('session.json', { ...this.session, state: 'ended', endedBy: by })
  }

  reopen(): void {
    const { endedBy: _endedBy, ...rest } = this.session
    this.writeJson('session.json', { ...rest, state: 'active' })
  }
}
