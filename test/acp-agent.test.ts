import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpAgent } from '../src/acp-agent.js'
import type { AcpSnapshot } from '../src/acp-agent.js'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-acp-agent.mjs')
/** Mirrors CHUNK_COUNT in the fake agent. */
const CHUNK_COUNT = 80

interface Turn {
  reply: string
  stopReason: string
}

/** One fake agent, driven the way the daemon drives a real one. `turns` is the
 *  record `onTurnEnd` would have written to the conversation. */
function harness() {
  const turns: Turn[] = []
  const waiters = new Set<() => void>()
  const wake = () => {
    for (const w of [...waiters]) w()
  }
  /** A feed item observed while the agent is idle - which can only mean it arrived
   *  after the turn it belonged to had already ended. The reply is built from the
   *  feed at that moment, so anything landing later is a word the user was told
   *  about and then never shown. This is the sharper edge of the same defect an
   *  incomplete reply reveals, and it catches strictly more of it. */
  const strays: unknown[] = []
  const acp = new AcpAgent({
    command: `node ${FAKE}`,
    cwd: process.cwd(),
    onChange: () => {
      const s = acp.snapshot()
      if (s.state === 'idle' && s.feed.length) strays.push(...s.feed)
      wake()
    },
    onTurnEnd: (reply, stopReason) => {
      turns.push({ reply, stopReason })
      wake()
    },
    onExit: wake,
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

  return { acp, turns, strays, until, idle, ask }
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
test('a new chat moves to a fresh session and closes the old one', async () => {
  const h = harness()
  after(() => h.acp.stop())
  assert.equal((await h.ask('first')).reply, 's1:first')

  assert.equal(h.acp.newChat(), true)
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

  assert.equal(h.acp.newChat(), true)
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

test('a new chat is refused before the first session is up', () => {
  const h = harness()
  after(() => h.acp.stop())
  assert.equal(h.acp.snapshot().state, 'starting')
  assert.equal(h.acp.newChat(), false, 'there is no context to clear yet')
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
