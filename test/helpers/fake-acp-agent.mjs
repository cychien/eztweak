#!/usr/bin/env node
/** A stand-in ACP agent, spawned by the ACP tests the way a real one is.
 *
 *  Everything it reports it reports through the protocol - a `REPORT` prompt
 *  answers with its own bookkeeping as the turn's reply. A side channel would
 *  have to be read past `AcpAgent`, which owns the child's stdio.
 *
 *  Prompt vocabulary:
 *    SLOW      park the turn until cancelled, then stop with `cancelled`
 *    CHUNKS    stream CHUNK_COUNT message chunks back-to-back, then end the turn
 *    CONFIGPUSH  push a `config_option_update` nobody asked for, then end the turn
 *    MODEPUSH  push a bare `current_mode_update`, then end the turn
 *    REFUSEHAIKU  from here on, take the request to switch to haiku and decline it
 *    REPORT    reply with {opened, closed, prompts, log} as JSON
 *    else      reply with `<sessionId>:<prompt>` and stop with `end_turn` */

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
/** Every request in the order it arrived. What proves *when* something happened
 *  relative to something else - a pick re-asserted before the first prompt of a
 *  session, rather than merely at some point during it. */
const log = []
const turns = new Map()

/** Mirrors the shape a real agent reports: a select whose choice reshapes the
 *  rest, a mode carrying the spec's `mode` category, and a boolean. `fast` is
 *  only offered while the model supports it, which is what a client that names
 *  its options rather than drawing the list would get wrong. */
const MODELS = [
  { value: 'opus', name: 'Opus (1M context)', description: 'Best for complex tasks' },
  { value: 'sonnet', name: 'Sonnet' },
  { value: 'haiku', name: 'Haiku' },
]
const FAST_MODELS = new Set(['opus', 'sonnet'])

const config = { model: 'opus', mode: 'default', fast: false }
/** Armed by a REFUSEHAIKU prompt. Stands in for a hook that blocks a switch. */
let refuseHaiku = false

function configOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: config.model,
      options: MODELS,
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: config.mode,
      options: [
        { value: 'default', name: 'Manual' },
        { value: 'plan', name: 'Plan' },
      ],
    },
    ...(FAST_MODELS.has(config.model)
      ? [
          {
            id: 'fast',
            name: 'Fast mode',
            category: 'model_config',
            type: 'boolean',
            currentValue: config.fast,
          },
        ]
      : []),
  ]
}

const app = agent({ name: 'fake-acp-agent' })
  .onRequest(methods.agent.initialize, (ctx) => {
    log.push(`initialize:boolean=${!!ctx.params.clientCapabilities?.session?.configOptions?.boolean}`)
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { close: {} } },
    }
  })
  .onRequest(methods.agent.session.new, () => {
    const sessionId = `s${opened.length + 1}`
    opened.push(sessionId)
    log.push(`new:${sessionId}`)
    // Each session starts on the agent's own defaults, the way a real one does -
    // which is what makes a re-asserted pick observable.
    config.model = 'opus'
    config.mode = 'default'
    config.fast = false
    return { sessionId, configOptions: configOptions() }
  })
  .onRequest(methods.agent.session.setConfigOption, (ctx) => {
    const { configId, value } = ctx.params
    log.push(`set:${configId}=${value}`)
    if (!(configId in config)) throw new Error(`unknown config option: ${configId}`)
    if (configId === 'model' && !MODELS.some((m) => m.value === value)) {
      throw new Error(`invalid model: ${value}`)
    }
    // A pick the agent takes the request for and then declines, the way a
    // PreModelSwitch hook does: the call succeeds, the value does not move.
    if (configId === 'model' && value === 'haiku' && refuseHaiku) {
      return { configOptions: configOptions() }
    }
    config[configId] = value
    return { configOptions: configOptions() }
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
    if (text.includes('REFUSEHAIKU')) {
      prompts.push({ sessionId, text })
      refuseHaiku = true
      await say('armed')
      return { stopReason: 'end_turn' }
    }
    if (text.includes('REPORT')) {
      await say(JSON.stringify({ opened, closed, prompts, log }))
      return { stopReason: 'end_turn' }
    }
    // An option set by nobody's request: a real agent does this when its own
    // machinery moves a value - a refusal fallback switching the model out from
    // under the client.
    if (text.includes('CONFIGPUSH')) {
      prompts.push({ sessionId, text })
      config.model = 'haiku'
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions: configOptions() },
      })
      return { stopReason: 'end_turn' }
    }
    // The mode's own notification, sent alone. An agent may report a mode change
    // this way and never touch the option list, which is why the client cannot
    // rely on `config_option_update` for it.
    if (text.includes('MODEPUSH')) {
      prompts.push({ sessionId, text })
      config.mode = 'plan'
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
      })
      return { stopReason: 'end_turn' }
    }
    prompts.push({ sessionId, text })
    log.push(`prompt:${sessionId}`)
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
