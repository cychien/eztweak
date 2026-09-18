/** One ACP session's messages, in the order the agent wrote them.
 *
 *  The SDK has this already, as `ActiveSession` - but only for a session it
 *  created itself: `buildSession(...).start()` wraps `session/new`, and the
 *  `attachSession` that does the wrapping is private. A session reached any other
 *  way - `session/resume` after a daemon restart, a fork - has no wrapper, and
 *  once resume is the common path it cannot be the one without a queue.
 *
 *  So this is that wrapper, for any session id however it was obtained, and it is
 *  the only one: `session/new` goes through it too. Two implementations of an
 *  ordering guarantee would drift, and the one that drifted would say so by
 *  losing a reply about one turn in ten.
 *
 *  ## The ordering guarantee
 *
 *  A turn's streamed chunks arrive as `session/update` notifications; the turn's
 *  end is the `session/prompt` *response*. Those are two independent microtask
 *  chains, so a reader awaiting them separately can see the response first and
 *  end the turn before the words it was made of have arrived.
 *
 *  One queue fed by both fixes it, and the reason it works is the order the two
 *  are put in. The SDK dispatches each inbound message as it reads it, so a
 *  notification is enqueued while the stream is being read; the stop is enqueued
 *  in a `.then()` on the prompt response, which is a continuation of the read
 *  that delivered it. Anything that arrived before the response on the wire is
 *  therefore already in the queue when the stop goes in.
 *
 *  The rule that keeps it true: `route` must not defer past the turn the
 *  notification was read in. Enqueueing synchronously is how it does that here.
 *  A microtask would in fact survive - the stop's own `.then()` is one too, and
 *  queues behind the ones already scheduled - but a timer, an I/O wait, or
 *  anything else that reaches a later macrotask puts the stop in first and loses
 *  the tail of the reply. The chunk-ordering test catches that; it does not catch
 *  the microtask case, which is why the rule is written as "synchronous" rather
 *  than left to whatever the tests happen to notice. */

import {
  type ClientContext,
  type PromptResponse,
  type SessionNotification,
  methods,
} from '@agentclientprotocol/sdk'

/** A session update, or the end of a turn. `retired` is neither: it is this
 *  reader being told to stop, so a loop parked on `next()` can return instead of
 *  waiting on a session nobody owns any more. */
export type SessionMessage =
  | { kind: 'update'; notification: SessionNotification }
  | { kind: 'stop'; stopReason: string }
  | { kind: 'retired' }

const RETIRED: SessionMessage = { kind: 'retired' }

/** Single-reader queue. One reader by construction - the pump - so there is at
 *  most one waiter and no need for a waiter list. */
class MessageQueue {
  private queued: SessionMessage[] = []
  private waiting: ((message: SessionMessage) => void) | null = null
  private retired = false

  enqueue(message: SessionMessage): void {
    if (this.retired) return
    const waiting = this.waiting
    if (waiting) {
      this.waiting = null
      waiting(message)
      return
    }
    this.queued.push(message)
  }

  next(): Promise<SessionMessage> {
    if (this.queued.length) return Promise.resolve(this.queued.shift()!)
    if (this.retired) return Promise.resolve(RETIRED)
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }

  /** Wakes the reader and answers every later read. Retiring rather than
   *  abandoning is what stops a pump - and through it the whole session's
   *  backlog - being held for the life of the process. */
  retire(): void {
    if (this.retired) return
    this.retired = true
    this.queued = []
    const waiting = this.waiting
    this.waiting = null
    waiting?.(RETIRED)
  }
}

/** Routes this connection's `session/update` notifications to whichever session
 *  is attached. Registered once, at `client()` build time, and asked for nothing
 *  else: the SDK's own router returns `Handled.no` for these, so it does not
 *  consume them and both can watch. */
export class SessionRouter {
  private queues = new Map<string, MessageQueue>()

  /** Synchronous on purpose - see the note on ordering above. */
  route(notification: SessionNotification): void {
    this.queues.get(notification.sessionId)?.enqueue({ kind: 'update', notification })
  }

  attach(ctx: ClientContext, sessionId: string): AttachedSession {
    const queue = new MessageQueue()
    this.queues.set(sessionId, queue)
    return new AttachedSession(ctx, sessionId, queue, () => {
      if (this.queues.get(sessionId) === queue) this.queues.delete(sessionId)
    })
  }
}

export class AttachedSession {
  constructor(
    private readonly ctx: ClientContext,
    readonly sessionId: string,
    private readonly queue: MessageQueue,
    private readonly detach: () => void,
  ) {}

  /** Send one prompt turn. The returned promise is for the caller to watch for a
   *  request that failed outright; the turn's *end* is read off the queue, which
   *  is the point of the queue. */
  prompt(text: string): Promise<PromptResponse> {
    const response = this.ctx.request(methods.agent.session.prompt, {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    })
    void response.then(
      (value) => this.queue.enqueue({ kind: 'stop', stopReason: value.stopReason }),
      // Left to the caller: it already has the rejection, and a session whose
      // prompt failed is being torn down rather than read further.
      () => {},
    )
    return response
  }

  next(): Promise<SessionMessage> {
    return this.queue.next()
  }

  /** Stop reading. Does not end the session on the agent - that is `session/close`,
   *  and whether it is even available is the caller's business. */
  retire(): void {
    this.detach()
    this.queue.retire()
  }
}
