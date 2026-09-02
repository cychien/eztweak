#!/usr/bin/env node
/** A stand-in ACP agent, spawned by the ACP tests the way a real one is.
 *
 *  Everything it reports it reports through the protocol - a `REPORT` prompt
 *  answers with its own bookkeeping as the turn's reply. A side channel would
 *  have to be read past `AcpAgent`, which owns the child's stdio.
 *
 *  Prompt vocabulary:
 *    SLOW    park the turn until cancelled, then stop with `cancelled`
 *    CHUNKS  stream CHUNK_COUNT message chunks back-to-back, then end the turn
 *    REPORT  reply with {opened, closed, prompts} as JSON
 *    else    reply with `<sessionId>:<prompt>` and stop with `end_turn` */

import { Readable, Writable } from 'node:stream'
import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from '@agentclientprotocol/sdk'

/** Enough that a client which races the turn's `stop` against its updates, rather
 *  than reading both off one ordered queue, is near-certain to drop at least the
 *  last of them. One chunk made that a one-in-thirty flake. */
const CHUNK_COUNT = 80

const opened = []
const closed = []
/** Which session each prompt landed on, so a replaced one cannot go unnoticed. */
const prompts = []
const turns = new Map()

const app = agent({ name: 'fake-acp-agent' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { sessionCapabilities: { close: {} } },
  }))
  .onRequest(methods.agent.session.new, () => {
    const sessionId = `s${opened.length + 1}`
    opened.push(sessionId)
    return { sessionId }
  })
  .onRequest(methods.agent.session.close, (ctx) => {
    closed.push(ctx.params.sessionId)
    return {}
  })
  .onNotification(methods.agent.session.cancel, (ctx) => {
    turns.get(ctx.params.sessionId)?.abort()
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    const { sessionId, prompt } = ctx.params
    const text = prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')
    const say = (t) =>
      ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } },
      })
    if (text.includes('CHUNKS')) {
      prompts.push({ sessionId, text })
      // Fired without awaiting each one, so they coalesce into as few writes as
      // possible and the response lands on the client's heels. Awaiting per chunk
      // lets a client that races the two keep pace between reads, which is what
      // made the same bug show up only half the time.
      await Promise.all(Array.from({ length: CHUNK_COUNT }, (_, i) => say(`c${i + 1} `)))
      return { stopReason: 'end_turn' }
    }
    if (text.includes('REPORT')) {
      await say(JSON.stringify({ opened, closed, prompts }))
      return { stopReason: 'end_turn' }
    }
    prompts.push({ sessionId, text })
    await say(`${sessionId}:${text}`)
    if (!text.includes('SLOW')) return { stopReason: 'end_turn' }
    const abort = new AbortController()
    turns.set(sessionId, abort)
    await new Promise((resolve) => abort.signal.addEventListener('abort', resolve, { once: true }))
    turns.delete(sessionId)
    return { stopReason: 'cancelled' }
  })

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
await app.connectWith(stream, () => new Promise(() => {}))
