import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
  /** Last real user or agent activity. The restore age bound reads this and
   *  nothing else, so a write the daemon performs on its own - `setPort` during
   *  startup restore - must never renew it, or the bound becomes a lease that
   *  renews itself and never expires. Absent on pre-existing records. */
  lastActivityAt?: number
  /** Last port this session's proxy held. A restarted daemon re-binds it so the
   *  shell tab the user already has open survives a reload. */
  port?: number
}

/** A record that never noted activity is only as fresh as its creation, and one
 *  that has neither timestamp counts as expired rather than as just-used. */
function activityAt(session: PersistedSession): number {
  return session.lastActivityAt ?? session.createdAt ?? 0
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
      if (typeof parsed?.targetOrigin === 'string') sessions.push(parsed)
    } catch {
      /* half-written or foreign directory - skip it */
    }
  }
  return sessions
}

/** The sessions a starting daemon should rebuild proxies for: still active, and
 *  used recently enough that the user plausibly still has that target open.
 *  Nothing marks a session `ended` when the daemon dies, so the age bound is the
 *  only thing keeping this list from growing without limit. */
export function listRestorableSessions(): PersistedSession[] {
  const cutoff = Date.now() - SESSION_RESTORE_MAX_AGE_MS
  return listPersistedSessions().filter((s) => s.state === 'active' && activityAt(s) >= cutoff)
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
      const now = Date.now()
      this.writeJson('session.json', {
        targetOrigin,
        state: 'active',
        createdAt: now,
        lastActivityAt: now,
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

  /** Records real user or agent activity, which is what keeps a session inside
   *  the restore window. Never call it for daemon-internal bookkeeping. */
  touch(): void {
    this.patchSession({ lastActivityAt: Date.now() })
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
    this.patchSession({ port })
  }

  end(by: SessionEndedBy): void {
    this.patchSession({ state: 'ended', endedBy: by, lastActivityAt: Date.now() })
  }

  reopen(): void {
    const { endedBy: _endedBy, ...rest } = this.session
    this.writeJson('session.json', { ...rest, state: 'active', lastActivityAt: Date.now() })
  }
}
