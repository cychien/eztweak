import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { after, test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpAgent } from '../src/acp-agent.js'
import { type McpServerEntry, isExploreTool } from '../src/mcp-explore.js'
import type { AcpLimit, AcpSessionStart, AcpSnapshot } from '../src/acp-agent.js'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-acp-agent.mjs')
/** Mirrors CHUNK_COUNT in the fake agent. */
const CHUNK_COUNT = 80

/** A file two fake agents can share their session list through, so the second
 *  one has the first one's sessions to resume - which is what a real agent's
 *  on-disk transcripts do for a restarted daemon. */
function sharedAgentState(): Record<string, string> {
  return { EZ_FAKE_STATE: join(mkdtempSync(join(tmpdir(), 'ez-fake-')), 'state.json') }
}

interface Turn {
  reply: string
  stopReason: string
}

interface HarnessOptions {
  /** The session id the review already has, as `Chat.acpSessionId` would supply
   *  it. Read on every open, so the test can change it between them. */
  resume?: () => string | undefined
  /** Env for the spawned fake agent, for the agents that cannot resume. */
  env?: Record<string, string>
  /** The picks to re-assert on every session, as `PersistedSession.agentConfig`
   *  would supply them. */
  pinned?: Record<string, string | boolean>
  /** A figure from before this daemon started, as `usage-limit.ts` would supply
   *  it. */
  rememberedLimit?: AcpLimit
  /** The mcp servers to open every session with, as the daemon's explore rounds
   *  would supply them. */
  mcpServers?: () => McpServerEntry[]
  /** Which tools are the daemon's own, as it would tell the agent. */
  ownTool?: (toolName: string) => boolean
  /** Prompts to hand over the way `deliverToAcp` does - on the agent going idle,
   *  from the same `onChange` the daemon acts on. Ordering claims about a pick
   *  landing before a session's first turn only mean anything against this. */
  deliver?: string[]
}

/** One fake agent, driven the way the daemon drives a real one. `turns` is the
 *  record `onTurnEnd` would have written to the conversation. */
function harness(options: HarnessOptions = {}) {
  const turns: Turn[] = []
  const waiters = new Set<() => void>()
  const pending = [...(options.deliver ?? [])]
  /** What `onConfigChange` was told, i.e. what the daemon would have persisted. */
  const configChanges: { configId: string; value: string | boolean }[] = []
  /** What `onLimitChange` was told, i.e. what the daemon would have written down. */
  const limitsReported: AcpLimit[] = []
  /** The option values in effect each time a queued prompt was handed over. */
  const deliveredWith: Record<string, unknown>[] = []
  const wake = () => {
    for (const w of [...waiters]) w()
  }
  /** A feed item observed while the agent is idle - which can only mean it arrived
   *  after the turn it belonged to had already ended. The reply is built from the
   *  feed at that moment, so anything landing later is a word the user was told
   *  about and then never shown. This is the sharper edge of the same defect an
   *  incomplete reply reveals, and it catches strictly more of it. */
  const strays: unknown[] = []

  /** `deliverToAcp`, in the daemon's own place: whatever is queued goes out the
   *  moment the agent is idle. */
  function deliver(s: AcpSnapshot): void {
    if (s.state !== 'idle' || !pending.length) return
    // The options as they stood at the instant of hand-over. Asserting on the
    // request order the agent saw instead would be a race - two writes to one
    // stream - where this is the invariant itself: what the turn leaves with is
    // what was in effect when it left.
    deliveredWith.push(currentValues(s))
    acp.prompt(pending.shift()!)
  }

  /** Every session this agent opened, and whether it was new or picked up. */
  const opens: { sessionId: string; how: AcpSessionStart }[] = []
  const acp = new AcpAgent({
    command: `${Object.entries(options.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')} node ${FAKE}`.trim(),
    cwd: process.cwd(),
    onChange: () => {
      const s = acp.snapshot()
      if (s.state === 'idle' && s.feed.length) strays.push(...s.feed)
      deliver(s)
      wake()
    },
    onTurnEnd: (reply, stopReason) => {
      turns.push({ reply, stopReason })
      wake()
    },
    onExit: wake,
    ...(options.pinned ? { pinnedConfig: () => options.pinned! } : {}),
    ...(options.rememberedLimit ? { rememberedLimit: () => options.rememberedLimit } : {}),
    onLimitChange: (limit) => {
      limitsReported.push(limit)
      wake()
    },
    ...(options.resume ? { resumeSessionId: options.resume } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(options.ownTool ? { ownTool: options.ownTool } : {}),
    onSessionOpen: (sessionId, how) => {
      opens.push({ sessionId, how })
      wake()
    },
    onConfigChange: (configId, value) => {
      configChanges.push({ configId, value })
      wake()
    },
  })

  /** Every state change is announced, so waiting on a condition beats sleeping
   *  on a guess about how long a round trip takes. */
  async function until(what: string, ok: (s: AcpSnapshot) => boolean): Promise<AcpSnapshot> {
    // Generous, because it is only a backstop: the loop exits the moment the
    // condition holds, so a large budget costs a passing run nothing - and these
    // tests spawn a process, which under a loaded machine is the one step that
    // can take far longer than it usually does.
    const deadline = Date.now() + 30_000
    for (;;) {
      const snapshot = acp.snapshot()
      if (ok(snapshot)) return snapshot
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}: ${JSON.stringify(snapshot)}`)
      await new Promise<void>((resolve) => {
        const done = () => {
          waiters.delete(done)
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(done, 50)
        waiters.add(done)
      })
    }
  }

  const idle = () => until('idle', (s) => s.state === 'idle')

  /** Prompt and wait for the turn it starts to end. */
  async function ask(text: string): Promise<Turn> {
    await idle()
    const before = turns.length
    acp.prompt(text)
    await until(`the turn for ${text}`, () => turns.length > before)
    return turns[turns.length - 1]!
  }

  /** Queue a batch the way the shell's send does: it goes out now if the agent is
   *  idle, and waits for the next session if one is still opening. */
  function queue(text: string): void {
    pending.push(text)
    deliver(acp.snapshot())
  }

  return {
    acp,
    turns,
    strays,
    configChanges,
    limitsReported,
    deliveredWith,
    opens,
    until,
    idle,
    ask,
    queue,
  }
}

/** The agent's bookkeeping, read back through the protocol. */
interface Report {
  opened: string[]
  closed: string[]
  prompts: { sessionId: string }[]
  log: string[]
}

/** One option out of a snapshot, by id. */
function option(s: AcpSnapshot, id: string) {
  return s.configOptions?.find((o) => o.id === id)
}

function currentValues(s: AcpSnapshot): Record<string, unknown> {
  return Object.fromEntries((s.configOptions ?? []).map((o) => [o.id, o.currentValue]))
}

test('a turn ends with the reply the agent streamed', async () => {
  const h = harness()
  after(() => h.acp.stop())
  assert.deepEqual(await h.ask('hello'), { reply: 's1:hello', stopReason: 'end_turn' })
})

// The point of cancel: whatever the agent had already said stays on the record,
// and the reason says the user stopped it rather than the agent finishing.
test('cancelling a turn ends it as cancelled, keeping what was already said', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()
  h.acp.prompt('SLOW')
  await h.until('the turn to be under way', (s) => s.state === 'working' && s.feed.length > 0)

  assert.equal(h.acp.cancelTurn(), true)
  assert.equal(h.acp.snapshot().cancelling, true, 'the button has to stop offering to send again')
  await h.until('the turn to end', () => h.turns.length > 0)
  assert.deepEqual(h.turns[0], { reply: 's1:SLOW', stopReason: 'cancelled' })
  const after_ = await h.idle()
  assert.equal(after_.cancelling, undefined)
  assert.deepEqual(after_.feed, [], 'the feed belongs to the turn, not to the session')
})

test('cancel is refused when no turn is in flight', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()
  assert.equal(h.acp.cancelTurn(), false)
})

// The whole point of /new: the next prompt lands on a session the agent has no
// history for, which is what stops the review paying for one.
test('reopening moves to a fresh session and closes the old one', async () => {
  const h = harness()
  after(() => h.acp.stop())
  assert.equal((await h.ask('first')).reply, 's1:first')

  assert.equal(h.acp.reopenSession(), true)
  await h.idle()
  assert.equal((await h.ask('second')).reply, 's2:second')

  const report = JSON.parse((await h.ask('REPORT')).reply) as {
    opened: string[]
    closed: string[]
    prompts: { sessionId: string }[]
  }
  assert.deepEqual(report.opened, ['s1', 's2'])
  assert.deepEqual(report.closed, ['s1'], 'an agent that can be told a session is done should be')
  assert.deepEqual(
    report.prompts.map((p) => p.sessionId),
    ['s1', 's2'],
  )
})

// A user who asks for a new chat mid-turn is starting over, not queueing behind
// the turn they have already given up on.
test('a new chat mid-turn cancels it and drops its outcome', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()
  h.acp.prompt('SLOW')
  await h.until('the turn to be under way', (s) => s.state === 'working')

  assert.equal(h.acp.reopenSession(), true)
  assert.equal(h.acp.snapshot().state, 'starting')
  assert.deepEqual(h.acp.snapshot().feed, [])
  await h.idle()

  assert.equal((await h.ask('after')).reply, 's2:after')
  // The abandoned turn resolved as cancelled somewhere in there. Reporting it
  // would put a stop the user never sees the effect of into the thread, and
  // acking a batch the fresh session was about to be handed.
  assert.deepEqual(
    h.turns.map((t) => t.reply),
    ['s2:after'],
  )
})

// A review that moves twice in quick succession - into a branch from the corner
// chip, then straight back out through the breadcrumb - asks for the second move
// while the first session is still opening. It used to be refused, so the click
// that asked for it did nothing at all and the review sat in a conversation the
// user had already left; only a second click, once the session was up, landed.
test('a move asked for while the session is still opening is honoured', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()

  assert.equal(h.acp.reopenSession(), true)
  assert.equal(h.acp.snapshot().state, 'starting')
  assert.equal(h.acp.reopenSession(), true, 'the second move was dropped')

  h.queue('after')
  await h.until('the turn on the newest session to end', () => h.turns.length > 0)
  assert.equal(h.turns[0]?.reply, 's3:after', 'the review answered on a superseded session')
})

test('a new chat is refused before the first session is up', () => {
  const h = harness()
  after(() => h.acp.stop())
  assert.equal(h.acp.snapshot().state, 'starting')
  assert.equal(h.acp.reopenSession(), false, 'there is no context to clear yet')
})

// The turn's end and the words it is made of travel the same stream, and the end
// comes last - so a client that reads the two off separate promises can finish a
// turn before its own reply has arrived. That is not hypothetical: it produced an
// empty reply about one turn in ten until the session's own ordered queue became
// the single source for both.
// Three attempts, because the defect is a race and no single attempt can be sure
// to lose it: one turn catches a regression here about four times in five, three
// turns better than ninety-nine in a hundred, and they cost a second each.
const ORDERING_ATTEMPTS = 3

test('a turn ends only after every chunk it streamed has been seen', async () => {
  const h = harness()
  after(() => h.acp.stop())
  const expected = Array.from({ length: CHUNK_COUNT }, (_, i) => `c${i + 1}`).join(' ')
  for (let attempt = 1; attempt <= ORDERING_ATTEMPTS; attempt++) {
    const turn = await h.ask('CHUNKS')
    assert.equal(turn.stopReason, 'end_turn', `attempt ${attempt}`)
    assert.equal(turn.reply, expected, `attempt ${attempt}: the reply lost a chunk`)
    assert.deepEqual(h.strays, [], `attempt ${attempt}: a chunk arrived after its turn ended`)
  }
})

// --------------------------------------------------------------- agent config

test('the session opens with the options the agent offers', async () => {
  const h = harness()
  after(() => h.acp.stop())
  const s = await h.idle()
  assert.deepEqual(currentValues(s), { model: 'opus', mode: 'default', fast: false })
  assert.equal(option(s, 'model')?.category, 'model')
})

// The client has to say it can draw a boolean before the agent is allowed to send
// one; without that, an on/off toggle arrives as a two-value select.
test('the client advertises support for boolean options', async () => {
  const h = harness()
  after(() => h.acp.stop())
  const report = JSON.parse((await h.ask('REPORT')).reply) as Report
  assert.ok(report.log.includes('initialize:boolean=true'), report.log.join(','))
})

// One pick reshapes the rest, so the answer replaces the option list rather than
// patching a value into it. A client holding its own idea of the list would keep
// offering Fast mode on a model that no longer has it.
test('setting an option installs the option set the agent answers with', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()

  assert.equal(await h.acp.setConfigOption('model', 'haiku'), true)
  const s = h.acp.snapshot()
  assert.deepEqual(currentValues(s), { model: 'haiku', mode: 'default' })
  assert.equal(option(s, 'fast'), undefined, 'an option the new model lacks must go')

  assert.equal(await h.acp.setConfigOption('model', 'sonnet'), true)
  assert.equal(option(h.acp.snapshot(), 'fast')?.currentValue, false, 'and come back with one that has it')
})

test('a boolean option is set with a boolean', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()
  assert.equal(await h.acp.setConfigOption('fast', true), true)
  assert.equal(option(h.acp.snapshot(), 'fast')?.currentValue, true)
})

// Only the user's own picks are reported for remembering. An option the agent
// moved on its own must not be, or a mode the agent downgraded would be pinned
// and carried into every later session.
test("a pick is reported, an agent's own change is not", async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()

  await h.acp.setConfigOption('model', 'sonnet')
  assert.deepEqual(h.configChanges, [{ configId: 'model', value: 'sonnet' }])

  await h.ask('CONFIGPUSH')
  assert.equal(option(h.acp.snapshot(), 'model')?.currentValue, 'haiku', 'the push has to land')
  assert.deepEqual(h.configChanges, [{ configId: 'model', value: 'sonnet' }], 'and not be remembered')
})

// The mode has its own notification as well as a place in the option list, and an
// agent is free to send only that one.
test('a bare mode notification updates the mode option', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()
  await h.ask('MODEPUSH')
  assert.equal(option(h.acp.snapshot(), 'mode')?.currentValue, 'plan')
})

test('setting an unknown option is refused without asking the agent', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()
  assert.equal(await h.acp.setConfigOption('nonesuch', 'x'), false)
  const report = JSON.parse((await h.ask('REPORT')).reply) as Report
  assert.ok(!report.log.some((l) => l.startsWith('set:nonesuch')), report.log.join(','))
})

test('an option cannot be set before the first session is up', async () => {
  const h = harness()
  after(() => h.acp.stop())
  assert.equal(h.acp.snapshot().state, 'starting')
  assert.equal(await h.acp.setConfigOption('model', 'sonnet'), false)
})

// Each session starts on the agent's defaults, so a remembered pick has to be
// re-asserted - otherwise /new and a daemon restart both hand the review back to
// a model the user switched away from.
test('a remembered pick is re-asserted on every session', async () => {
  const h = harness({ pinned: { model: 'sonnet' } })
  after(() => h.acp.stop())
  assert.equal(option(await h.idle(), 'model')?.currentValue, 'sonnet')

  assert.equal(h.acp.reopenSession(), true)
  await h.idle()
  assert.equal(option(h.acp.snapshot(), 'model')?.currentValue, 'sonnet', 'and again on the next one')
})

// The one that matters. Going idle is what the daemon turns into a delivery, so a
// pick re-asserted after the flag flips arrives one turn too late - and the first
// turn of a fresh session is exactly the one the model was chosen for.
test('a remembered pick lands before the first turn of the session', async () => {
  const h = harness({ pinned: { model: 'sonnet' }, deliver: ['first'] })
  after(() => h.acp.stop())
  await h.until('the delivered turn to end', () => h.turns.length > 0)

  assert.deepEqual(
    h.deliveredWith,
    [{ model: 'sonnet', mode: 'default', fast: false }],
    'the batch left on the agent default, so the pick arrived a turn too late',
  )
})

// And on the session a /new opens, which is the path that actually carries a
// waiting batch: feedback queued while the fresh session is still coming up is
// handed over the instant it is ready.
test('a remembered pick lands before the first turn of a session opened by /new', async () => {
  const h = harness({ pinned: { model: 'sonnet' } })
  after(() => h.acp.stop())
  await h.idle()

  assert.equal(h.acp.reopenSession(), true)
  assert.equal(h.acp.snapshot().state, 'starting')
  h.queue('after')
  await h.until('the turn on the fresh session to end', () => h.turns.length > 0)

  assert.deepEqual(h.deliveredWith, [{ model: 'sonnet', mode: 'default', fast: false }])
  assert.equal(h.turns[0]?.reply, 's2:after')
})

// A pick can stop being available - a model dropped from the account's list, an
// effort level the new default does not have. Losing the review over a preference
// would be the wrong trade.
test('a pick the agent will not take leaves the session open on its own choice', async () => {
  const h = harness({ pinned: { model: 'gone' } })
  after(() => h.acp.stop())
  const s = await h.idle()
  assert.equal(option(s, 'model')?.currentValue, 'opus')
  assert.equal(s.state, 'idle')
  assert.equal((await h.ask('after')).reply, 's1:after', 'and still takes turns')
})

// Mid-turn is when a switch is most wanted: watching a turn head the wrong way is
// what prompts one. The agent takes it and the turn in flight still ends.
test('an option can be set while a turn is in flight', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()
  h.acp.prompt('SLOW')
  await h.until('the turn to be under way', (s) => s.state === 'working')

  assert.equal(await h.acp.setConfigOption('model', 'haiku'), true)
  assert.equal(option(h.acp.snapshot(), 'model')?.currentValue, 'haiku')
  assert.equal(h.acp.snapshot().state, 'working', 'the turn is still the turn')

  h.acp.cancelTurn()
  await h.until('the turn to end', () => h.turns.length > 0)
})

// A request can succeed without the change landing - a PreModelSwitch hook
// declining a model is exactly that. Remembering it would re-offer the refused
// value to every later session, and put a switch in the thread that never
// happened.
test('a change the agent did not actually make is not remembered', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.ask('REFUSEHAIKU')

  assert.equal(await h.acp.setConfigOption('model', 'haiku'), false)
  assert.equal(option(h.acp.snapshot(), 'model')?.currentValue, 'opus')
  assert.deepEqual(h.configChanges, [])
})

// ------------------------------------------------------------ session resume

// The daemon-restart case: the review still knows which session it was having,
// and the agent still has it. Nothing is replayed and nothing is lost.
test('a session the review already had is picked back up', async () => {
  const env = sharedAgentState()
  const first = harness({ env })
  after(() => first.acp.stop())
  assert.equal((await first.ask('hello')).reply, 's1:hello')
  const sessionId = first.opens[0]!.sessionId
  assert.deepEqual(first.opens, [{ sessionId: 's1', how: 'new' }])
  first.acp.stop()

  // A second agent, as a restarted daemon would start one, pointed at that id.
  const next = harness({ resume: () => sessionId, env })
  after(() => next.acp.stop())
  await next.idle()
  assert.deepEqual(next.opens, [{ sessionId: 's1', how: 'resumed' }])
  assert.equal((await next.ask('again')).reply, 's1:again', 'the same session takes the turn')
})

// An agent with no resume at all. Asking would be a protocol error, so it is not
// asked; the review carries on in a fresh session and is told which it got.
test('an agent that cannot resume gets a fresh session instead', async () => {
  const h = harness({ resume: () => 'sX', env: { EZ_FAKE_NO_RESUME: '1' } })
  after(() => h.acp.stop())
  await h.idle()
  assert.deepEqual(h.opens, [{ sessionId: 's1', how: 'new' }])

  const report = JSON.parse((await h.ask('REPORT')).reply) as Report
  assert.ok(!report.log.some((l) => l.startsWith('resume:')), report.log.join(','))
})

// An agent that says it can and then cannot: a transcript deleted since. The
// failure is ordinary - the review opens a fresh session rather than losing the
// agent over a conversation that is gone.
test('a resume the agent refuses falls back to a fresh session', async () => {
  const h = harness({ resume: () => 'gone', env: { EZ_FAKE_REFUSE_RESUME: '1' } })
  after(() => h.acp.stop())
  await h.idle()
  assert.deepEqual(h.opens, [{ sessionId: 's1', how: 'new' }])
  assert.equal((await h.ask('after')).reply, 's1:after', 'and still takes turns')

  const report = JSON.parse((await h.ask('REPORT')).reply) as Report
  assert.ok(report.log.includes('resume:gone'), 'it was asked, once')
})

// Reopening reads the resume id afresh, which is how the same call serves both
// "start a new conversation" and "go back to that one".
test('reopening follows the resume id it is given at the time', async () => {
  let resume: string | undefined
  const h = harness({ resume: () => resume })
  after(() => h.acp.stop())
  assert.equal((await h.ask('first')).reply, 's1:first')

  // Nothing to resume: a fresh conversation.
  assert.equal(h.acp.reopenSession(), true)
  await h.idle()
  assert.equal((await h.ask('second')).reply, 's2:second')
  assert.deepEqual(h.opens.at(-1), { sessionId: 's2', how: 'new' })

  // Back to the first one.
  resume = 's1'
  assert.equal(h.acp.reopenSession(), true)
  await h.idle()
  assert.deepEqual(h.opens.at(-1), { sessionId: 's1', how: 'resumed' })
  assert.equal((await h.ask('third')).reply, 's1:third')
})

// Resume comes back on the agent's default, not on what the review was last
// running - so the pin has to be re-asserted on this path too, and before the
// first turn like everywhere else.
test('a remembered pick is re-asserted on a resumed session', async () => {
  const env = sharedAgentState()
  const first = harness({ pinned: { model: 'sonnet' }, env })
  after(() => first.acp.stop())
  await first.idle()
  const sessionId = first.opens[0]!.sessionId
  first.acp.stop()

  const next = harness({ pinned: { model: 'sonnet' }, resume: () => sessionId, env })
  after(() => next.acp.stop())
  next.queue('after')
  await next.until('the delivered turn to end', () => next.turns.length > 0)
  assert.deepEqual(next.opens, [{ sessionId: 's1', how: 'resumed' }])
  assert.deepEqual(next.deliveredWith, [{ model: 'sonnet', mode: 'default', fast: false }])
})

// A session that has said nothing has no transcript, so it cannot be resumed.
// Recording one against the chat at *open* time meant two restarts with nothing
// said in between replaced a resumable session with an unresumable one - which
// is every `npm run dev` save. The fix is the daemon's, but this pins the fact
// the fix rests on: a session's open and its first turn are separate events, and
// the second is the one worth recording.
test('a session reports its open and its turns as separate events', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()
  assert.equal(h.opens.length, 1, 'open is reported once')
  assert.equal(h.turns.length, 0, 'and no turn has happened yet')

  await h.ask('something')
  assert.equal(h.opens.length, 1, 'a turn does not reopen the session')
  assert.equal(h.turns.length, 1)
})

/** A `usage_update` carrying the vendor rate-limit bag, as the prompt describes it. */
function limitPrompt(meta: unknown): string {
  return `LIMIT ${JSON.stringify({ _meta: meta })}`
}

const RATE_LIMIT = (windows: unknown) => ({ '_claude/rateLimit': { unifiedWindows: windows } })

const WEEKLY: AcpLimit = { windows: [{ windowMinutes: 10080, remaining: 0.33 }] }

test('every window the bag names is reported, shortest first', async () => {
  const h = harness()
  await h.idle()
  await h.ask(
    limitPrompt(
      RATE_LIMIT({
        seven_day: { utilization: 0.12, resetsAt: 1758400000 },
        five_hour: { utilization: 0.38, resetsAt: 1757900000 },
      }),
    ),
  )
  assert.deepEqual(h.acp.snapshot().limit, {
    windows: [
      { windowMinutes: 300, remaining: 0.62, resetsAt: 1757900000 },
      { windowMinutes: 10080, remaining: 0.88, resetsAt: 1758400000 },
    ],
  })
  h.acp.stop()
})

test('an account with no five-hour window reports the weekly one alone', async () => {
  const h = harness()
  await h.idle()
  await h.ask(limitPrompt(RATE_LIMIT({ seven_day: { utilization: 0.25 } })))
  assert.deepEqual(h.acp.snapshot().limit, {
    windows: [{ windowMinutes: 10080, remaining: 0.75 }],
  })
  h.acp.stop()
})

// Utilization runs past 1 into an account's overage, and "剩 -4%" is not a figure
// to put in front of anyone.
test('a window past its limit reports nothing left rather than less than nothing', async () => {
  const h = harness()
  await h.idle()
  await h.ask(limitPrompt(RATE_LIMIT({ five_hour: { utilization: 1.04 } })))
  assert.equal(h.acp.snapshot().limit?.windows[0]?.remaining, 0)
  h.acp.stop()
})

// The figure is only ever pushed, never asked for, so the last one stands until a
// better one arrives. A plain usage update - which is most of them - must not
// blank a figure the user is reading.
test('a usage update with no limit on it leaves the last one standing', async () => {
  const h = harness()
  await h.idle()
  await h.ask(limitPrompt(RATE_LIMIT({ five_hour: { utilization: 0.5 } })))
  await h.ask(limitPrompt({ somethingElse: true }))
  assert.equal(h.acp.snapshot().limit?.windows[0]?.remaining, 0.5)
  h.acp.stop()
})

test('a bag shaped like nothing the client knows is not a limit', async () => {
  const h = harness()
  await h.idle()
  await h.ask(limitPrompt(RATE_LIMIT({ five_hour: { utilization: 'lots' } })))
  assert.equal(h.acp.snapshot().limit, undefined)
  h.acp.stop()
})

// The line is permanent once it has a number. Nothing here can ask for one, so a
// restart that started blank would show nothing until the review's next turn.
test('a figure from before the restart is on screen before the first turn', async () => {
  const h = harness({ rememberedLimit: WEEKLY })
  await h.idle()
  assert.deepEqual(h.acp.snapshot().limit, WEEKLY)
  h.acp.stop()
})

// Replaces the window it names; the one it says nothing about is still true.
test('what the agent reports replaces the window it names, and is handed back', async () => {
  const h = harness({ rememberedLimit: WEEKLY })
  await h.idle()
  await h.ask(limitPrompt(RATE_LIMIT({ five_hour: { utilization: 0.2 } })))
  const reported = {
    windows: [
      { windowMinutes: 300, remaining: 0.8 },
      { windowMinutes: 10080, remaining: 0.33 },
    ],
  }
  assert.deepEqual(h.acp.snapshot().limit, reported)
  assert.deepEqual(h.limitsReported, [reported])
  h.acp.stop()
})

// A read carries no reset time - only the push channel types one - so a read
// landing on top of a push must not cost the tooltip the time it already had.
test('a read keeps the reset time the push channel gave the same window', async () => {
  const h = harness()
  await h.idle()
  const resetsAt = Math.floor(Date.now() / 1000) + 3600
  await h.ask(limitPrompt(RATE_LIMIT({ five_hour: { utilization: 0.2, resetsAt } })))
  h.acp.seedLimit({ windows: [{ windowMinutes: 300, remaining: 0.7 }] })
  assert.deepEqual(h.acp.snapshot().limit, {
    windows: [{ windowMinutes: 300, remaining: 0.7, resetsAt }],
  })
  h.acp.stop()
})

// Once that window has rolled over the time describes a window nobody is in any
// more, and carrying it forward would date the new figure to the old one.
test('a reset time that has already passed is not carried forward', async () => {
  const h = harness()
  await h.idle()
  const resetsAt = Math.floor(Date.now() / 1000) - 1
  await h.ask(limitPrompt(RATE_LIMIT({ five_hour: { utilization: 0.2, resetsAt } })))
  h.acp.seedLimit({ windows: [{ windowMinutes: 300, remaining: 1 }] })
  assert.deepEqual(h.acp.snapshot().limit, { windows: [{ windowMinutes: 300, remaining: 1 }] })
  h.acp.stop()
})

// A different window is a different allowance, and its reset time is its own. The
// five-hour window it says nothing about is kept as it was, dated as it was.
test('a reset time is not carried across to another window', async () => {
  const h = harness()
  await h.idle()
  const resetsAt = Math.floor(Date.now() / 1000) + 3600
  await h.ask(limitPrompt(RATE_LIMIT({ five_hour: { utilization: 0.2, resetsAt } })))
  h.acp.seedLimit({ windows: [{ windowMinutes: 10080, remaining: 0.9 }] })
  assert.deepEqual(h.acp.snapshot().limit, {
    windows: [
      { windowMinutes: 300, remaining: 0.8, resetsAt },
      { windowMinutes: 10080, remaining: 0.9 },
    ],
  })
  h.acp.stop()
})

/** An elicitation form from the fake agent; the turn's reply is the response
 *  the agent was handed, so the assertion is on exactly what it got. */
const FORM = JSON.stringify({
  message: 'Tell me about it',
  requestedSchema: {
    type: 'object',
    properties: {
      style: { type: 'string', oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] },
      note: { type: 'string', title: 'Anything else' },
      count: { type: 'integer', minimum: 1 },
      confirm: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } },
    },
    required: ['style', 'count', 'confirm', 'tags'],
  },
})

test('an elicitation form reaches the shell with every field and is accepted with typed answers', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()
  h.acp.prompt(`ELICIT ${FORM}`)
  const asked = await h.until('the ask', (s) => !!s.ask)
  assert.equal(asked.ask!.kind, 'question')
  assert.equal(asked.ask!.title, 'Tell me about it')
  assert.deepEqual(
    asked.ask!.fields.map((f) => [f.key, f.kind, f.optional ?? false]),
    [
      ['style', 'select', false],
      ['note', 'text', true],
      ['count', 'number', false],
      ['confirm', 'boolean', false],
      ['tags', 'multiselect', false],
    ],
  )
  // A half-answer is refused and the ask stays up.
  assert.equal(h.acp.answer(asked.ask!.id, { style: 'a' }), false)
  assert.ok(h.acp.snapshot().ask)
  assert.equal(h.acp.answer(asked.ask!.id, { style: 'a', count: 2, confirm: true, tags: ['y'] }), true)
  assert.equal(h.acp.snapshot().ask, undefined)
  await h.until('the turn', () => h.turns.length === 1)
  assert.deepEqual(JSON.parse(h.turns[0]!.reply), {
    action: 'accept',
    content: { style: 'a', count: 2, confirm: true, tags: ['y'] },
  })
})

test('a declined form tells the agent so', async () => {
  const h = harness()
  after(() => h.acp.stop())
  await h.idle()
  h.acp.prompt(`ELICIT ${FORM}`)
  const asked = await h.until('the ask', (s) => !!s.ask)
  assert.equal(h.acp.decline(asked.ask!.id), true)
  assert.equal(h.acp.decline(asked.ask!.id), false)
  await h.until('the turn', () => h.turns.length === 1)
  assert.deepEqual(JSON.parse(h.turns[0]!.reply), { action: 'decline' })
})

test('a form with a required field the shell cannot draw is declined without asking', async () => {
  const h = harness()
  after(() => h.acp.stop())
  const form = JSON.stringify({
    message: 'x',
    requestedSchema: { properties: { blob: { type: 'object' } }, required: ['blob'] },
  })
  const turn = await h.ask(`ELICIT ${form}`)
  assert.deepEqual(JSON.parse(turn.reply), { action: 'decline' })
})

// ------------------------------------------------------------------ branching

/** One explore round's server, as `ExploreMcp.serverEntries` builds it. */
const EXPLORE_SERVERS: McpServerEntry[] = [
  { type: 'http', name: 'eztweak-explore-r1', url: 'http://127.0.0.1:1/x', headers: [] },
]

/** What a fork is for: the branch carries the parent's history, the parent never
 *  hears what was said in the branch, and the review can go back. These assert
 *  the mechanics of the copy - that the client forks the *live* session and then
 *  resumes the copy, in that order. Whether the agent really carried the
 *  transcript over is the agent's promise, measured against the real one. */
test('forking is refused when the agent cannot do it, and nothing moves', async () => {
  const h = harness({ env: { EZ_FAKE_NO_FORK: '1' } })
  after(() => h.acp.stop())
  await h.ask('one')
  assert.equal(h.acp.canBranch, false)
  assert.equal(await h.acp.forkSession(), null)
  assert.equal(h.opens.length, 1)
})

test('a fork the agent takes and then refuses leaves the review where it was', async () => {
  const h = harness({ env: { EZ_FAKE_REFUSE_FORK: '1' } })
  after(() => h.acp.stop())
  await h.ask('one')
  assert.equal(h.acp.canBranch, true)
  assert.equal(await h.acp.forkSession(), null)
  assert.equal(h.opens.length, 1)
})

test('a branch is resumed, not prompted - a forked session is not live until it is', async () => {
  let resume: string | undefined
  const h = harness({ resume: () => resume })
  after(() => h.acp.stop())
  await h.ask('one')

  const forked = (await h.acp.forkSession())!
  // The daemon's move: record the copy against a new chat, then reopen. If the
  // client prompted the fork without resuming it, the fake agent - like the real
  // one - answers "Session not found" and this turn never ends.
  resume = forked
  assert.equal(h.acp.reopenSession(), true)
  await h.until('the branch', (s) => s.state === 'idle')
  assert.deepEqual(h.opens.at(-1), { sessionId: forked, how: 'resumed' })
  assert.equal((await h.ask('on the branch')).reply, `${forked}:on the branch`)

  // Back to the parent, which is an ordinary resume of the session it was on.
  resume = h.opens[0]!.sessionId
  assert.equal(h.acp.reopenSession(), true)
  await h.until('the parent', (s) => s.state === 'idle')
  const report = JSON.parse((await h.ask('REPORT')).reply) as Report & {
    forkedFrom: Record<string, string>
  }
  assert.deepEqual(report.forkedFrom, { [forked]: h.opens[0]!.sessionId })
  assert.deepEqual(
    report.log.filter((l) => l.startsWith('fork:') || l.startsWith('resume:')),
    [`fork:${h.opens[0]!.sessionId}`, `resume:${forked}`, `resume:${h.opens[0]!.sessionId}`],
  )
})

test("a remembered pick is re-asserted on a branch, which comes back on the agent's default", async () => {
  let resume: string | undefined
  const h = harness({ resume: () => resume, pinned: { model: 'haiku' } })
  after(() => h.acp.stop())
  await h.idle()
  await h.until('the pick', (s) => option(s, 'model')?.currentValue === 'haiku')

  const forked = (await h.acp.forkSession())!
  resume = forked
  h.acp.reopenSession()
  await h.until('the branch', (s) => s.state === 'idle')
  assert.equal(option(h.acp.snapshot(), 'model')?.currentValue, 'haiku')
})

test('the explore servers reach every session, including a branch', async () => {
  let resume: string | undefined
  const h = harness({ resume: () => resume, mcpServers: () => EXPLORE_SERVERS })
  after(() => h.acp.stop())
  await h.ask('one')
  const forked = (await h.acp.forkSession())!
  resume = forked
  h.acp.reopenSession()
  await h.until('the branch', (s) => s.state === 'idle')
  const report = JSON.parse((await h.ask('REPORT')).reply) as Report & {
    mcpBySession: Record<string, string[]>
  }
  assert.deepEqual(report.mcpBySession[h.opens[0]!.sessionId], ['eztweak-explore-r1'])
  assert.deepEqual(report.mcpBySession[forked], ['eztweak-explore-r1'])
})

test('an agent that cannot reach an http mcp server is offered none', async () => {
  const h = harness({ env: { EZ_FAKE_NO_MCP: '1' }, mcpServers: () => EXPLORE_SERVERS })
  after(() => h.acp.stop())
  const report = JSON.parse((await h.ask('REPORT')).reply) as Report & {
    mcpBySession: Record<string, string[]>
  }
  assert.deepEqual(report.mcpBySession[h.opens[0]!.sessionId], [])
})

test("a tool that is not the daemon's own is put to the user as a permission card", async () => {
  const h = harness({ ownTool: isExploreTool })
  after(() => h.acp.stop())
  await h.idle()
  h.acp.prompt('PERMISSION')
  const asked = await h.until('the ask', (s) => !!s.ask)
  assert.equal(asked.ask!.kind, 'permission')
  assert.equal(asked.ask!.title, 'Bash')
  const field = asked.ask!.fields[0]!
  assert.deepEqual(
    field.kind === 'select' ? field.options.map((o) => [o.id, o.hint]) : field.kind,
    [
      ['allow-once', 'allow_once'],
      ['allow-always', 'allow_always'],
      ['reject', 'reject_once'],
    ],
  )
  assert.equal(h.acp.answer(asked.ask!.id, { option: 'reject' }), true)
  await h.until('the turn', () => h.turns.length === 1)
  assert.equal(h.turns[0]!.reply, 'Bash: reject')
})

test("the daemon's own tool is granted once, with no card and nothing to write down", async () => {
  // Named the way Claude Code names an MCP tool on one of our round servers.
  const tool = 'mcp__eztweak-explore-r1__explore_variant'
  const h = harness({ ownTool: isExploreTool, env: { EZ_FAKE_PERMISSION_TOOL: tool } })
  after(() => h.acp.stop())
  await h.idle()
  const turn = await h.ask('PERMISSION')
  // Granted as a one-off - `allow_once` - never as the "always" that would have
  // become a rule in the project's settings keyed by a round id, dead on arrival.
  assert.equal(turn.reply, `${tool}: allow-once`)
  assert.equal(h.acp.snapshot().ask, undefined)
})
