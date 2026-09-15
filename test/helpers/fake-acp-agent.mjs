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
 *
 *  Env: EZ_FAKE_NO_RESUME     do not advertise session/resume
 *       EZ_FAKE_REFUSE_RESUME advertise it, then refuse every resume
 *       EZ_FAKE_NO_FORK       do not advertise session/fork
 *       EZ_FAKE_REFUSE_FORK   advertise it, then refuse every fork
 *       EZ_FAKE_NO_MCP        do not advertise mcpCapabilities.http
 *    REPORT    reply with {opened, closed, prompts, log} as JSON
 *    else      reply with `<sessionId>:<prompt>` and stop with `end_turn` */

import { readFileSync, writeFileSync } from 'node:fs'
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
/** Whether this agent advertises `session/resume` at all, and whether it honours
 *  one when asked. `EZ_FAKE_NO_RESUME` makes it an agent that cannot;
 *  `EZ_FAKE_REFUSE_RESUME` an agent that says it can and then cannot find the
 *  session - a deleted transcript. Both are real cases and they differ: one is
 *  known before asking, the other only after. */
const canResume = !process.env.EZ_FAKE_NO_RESUME
const refuseResume = !!process.env.EZ_FAKE_REFUSE_RESUME
/** Whether this agent branches, and whether it takes the request and fails.
 *  `EZ_FAKE_NO_FORK` is an agent that cannot; `EZ_FAKE_REFUSE_FORK` one that
 *  says it can and then will not - both are real, and they differ in whether
 *  the client knows before asking. */
const canFork = !process.env.EZ_FAKE_NO_FORK
const refuseFork = !!process.env.EZ_FAKE_REFUSE_FORK
/** Whether this agent can reach an HTTP MCP server, which is what decides
 *  whether the client offers it any. */
const mcpHttp = !process.env.EZ_FAKE_NO_MCP
/** Where the sessions this agent has live, when a test wants them to outlast the
 *  process. A real agent keeps transcripts on disk, which is the whole reason a
 *  restarted daemon can resume one; an agent that forgot them on exit would make
 *  the resume path untestable for the case it exists to serve. */
const STATE = process.env.EZ_FAKE_STATE
const persisted = (() => {
  if (!STATE) return null
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return null
  }
})()

/** Sessions this agent still has. A resume of anything else is refused. */
const live = new Set(persisted?.live ?? [])
/** Sessions that have been forked but not yet resumed. Mirrors the real agent
 *  measured on claude-agent-acp 0.77.0: `session/fork` answers with an id, and
 *  that id is not promptable until `session/resume` has read the copied
 *  transcript. A client that forks and then prompts is wrong, and this is what
 *  says so. */
const unresumedForks = new Set()
/** Which session each fork was taken from, so a test can prove the copy was
 *  made from the conversation the review was actually on. */
const forkedFrom = new Map()
/** The mcp servers each session was opened with, by name. The whole point of
 *  the explore tool is that they reach the agent, and a session opened without
 *  them is the failure that looks like nothing at all. */
const mcpBySession = new Map()
/** How many sessions have ever been opened, so ids do not restart at s1 in a
 *  second process and quietly collide with the first one's. */
let everOpened = persisted?.everOpened ?? 0

function persist() {
  if (!STATE) return
  writeFileSync(STATE, JSON.stringify({ live: [...live], everOpened }))
}

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
      agentCapabilities: {
        sessionCapabilities: {
          close: {},
          ...(canResume ? { resume: {} } : {}),
          ...(canFork ? { fork: {} } : {}),
        },
        ...(mcpHttp ? { mcpCapabilities: { http: true } } : {}),
      },
    }
  })
  .onRequest(methods.agent.session.new, (ctx) => {
    const sessionId = `s${++everOpened}`
    mcpBySession.set(sessionId, (ctx.params.mcpServers ?? []).map((m) => m.name))
    opened.push(sessionId)
    live.add(sessionId)
    persist()
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
  .onRequest(methods.agent.session.fork, (ctx) => {
    const { sessionId } = ctx.params
    log.push(`fork:${sessionId}`)
    if (refuseFork || !live.has(sessionId)) throw new Error(`cannot fork: ${sessionId}`)
    const forked = `s${++everOpened}`
    live.add(forked)
    unresumedForks.add(forked)
    forkedFrom.set(forked, sessionId)
    opened.push(forked)
    persist()
    // Only the id, the way the real one answers. No configOptions: the client
    // has to resume to get them, and to make the session promptable at all.
    return { sessionId: forked }
  })
  .onRequest(methods.agent.session.resume, (ctx) => {
    const { sessionId } = ctx.params
    log.push(`resume:${sessionId}`)
    if (refuseResume || !live.has(sessionId)) throw new Error(`no such session: ${sessionId}`)
    unresumedForks.delete(sessionId)
    mcpBySession.set(sessionId, (ctx.params.mcpServers ?? []).map((m) => m.name))
    // A resumed session comes back on this agent's defaults, the way the real one
    // does - which is what makes a re-asserted pick observable on this path too.
    config.model = 'opus'
    config.mode = 'default'
    config.fast = false
    return { configOptions: configOptions() }
  })
  .onRequest(methods.agent.session.close, (ctx) => {
    closed.push(ctx.params.sessionId)
    // Closing is the client letting go, not the session being deleted: a closed
    // session is still resumable, which is exactly the daemon-restart case.
    return {}
  })
  .onNotification(methods.agent.session.cancel, (ctx) => {
    turns.get(ctx.params.sessionId)?.abort()
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    const { sessionId, prompt } = ctx.params
    // A forked session is not live until it has been resumed.
    if (unresumedForks.has(sessionId)) throw new Error(`Session not found: ${sessionId}`)
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
      await say(
        JSON.stringify({
          opened,
          closed,
          prompts,
          log,
          forkedFrom: Object.fromEntries(forkedFrom),
          mcpBySession: Object.fromEntries(mcpBySession),
        }),
      )
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
    // The one channel a subscription limit reaches a client on: a `usage_update`
    // carrying a vendor bag. The payload comes from the prompt so a test can send
    // a shape the client is not supposed to understand as easily as one it is.
    const limit = /LIMIT (\{.*\})/.exec(text)
    if (limit) {
      prompts.push({ sessionId, text })
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'usage_update',
          used: 1000,
          size: 200000,
          ...JSON.parse(limit[1]),
        },
      })
      await say('ok')
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
    // Ask the user a form, the way AskUserQuestion reaches a client: the payload
    // is `{ message, requestedSchema }` from the prompt, and the turn's reply is
    // the client's answer verbatim - accept with its content, decline, or cancel -
    // so a test sees exactly what the agent would have been handed.
    const elicit = /ELICIT (\{.*\})/.exec(text)
    if (elicit) {
      prompts.push({ sessionId, text })
      // Through the daemon the note arrives inside the batch's own JSON, quotes
      // escaped; straight from a test it arrives bare. Either reads.
      const { message, requestedSchema } = JSON.parse(
        elicit[1].startsWith('{\\') ? elicit[1].replace(/\\"/g, '"') : elicit[1],
      )
      const response = await ctx.client.request(methods.client.elicitation.create, {
        sessionId,
        mode: 'form',
        message,
        requestedSchema,
      })
      await say(JSON.stringify(response))
      return { stopReason: 'end_turn' }
    }
    // A turn that ends properly having said nothing - an agent that only ran
    // tools, or whose skill did its work silently. The thread used to record
    // nothing at all for one of these.
    if (text.includes('SILENT')) {
      prompts.push({ sessionId, text })
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
