import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AcpLimit } from '../src/acp-agent.js'

process.env.EZTWEAK_DATA_DIR = mkdtempSync(join(tmpdir(), 'eztweak-limits-'))
// The reset times below are rendered in this zone, and the reader only trusts a
// zone that is the machine's own - so the machine is made to be in it.
process.env.TZ = 'Asia/Taipei'

const { mergeLimit, rememberLimit, rememberedLimit } = await import('../src/usage-limit.js')

const CLAUDE = 'npx -y @agentclientprotocol/claude-agent-acp'
const CODEX = 'npx -y @agentclientprotocol/codex-acp'
const HOUR = 3600

/** The five-hour window on its own, dated an hour out so it is still live. */
function session(remaining: number, now: number): AcpLimit {
  return { windows: [{ windowMinutes: 300, remaining, resetsAt: now / 1000 + HOUR }] }
}

test('nothing is remembered before anything is reported', () => {
  assert.equal(rememberedLimit(CLAUDE), undefined)
})

// The point of the file: the figure arrives pushed and cannot be asked for, so a
// restart that forgot it would blank the line until the review's next turn.
test('a figure survives the daemon that was told it', () => {
  const now = Date.now()
  rememberLimit(CLAUDE, session(0.62, now))
  assert.equal(rememberedLimit(CLAUDE, now)?.windows[0]?.remaining, 0.62)
})

// What an agent reports is its own vendor's allowance. Handing Claude's figure to
// codex would put a number on screen that describes someone else's account.
test('one agent is not shown another agent’s figure', () => {
  const now = Date.now()
  rememberLimit(CLAUDE, session(0.62, now))
  assert.equal(rememberedLimit(CODEX, now), undefined)
})

// A spent percentage from a window that has since rolled over is not stale, it is
// wrong: the allowance it describes was handed back.
test('a figure whose window has reset is dropped rather than shown', () => {
  const now = Date.now()
  rememberLimit(CLAUDE, { windows: [{ windowMinutes: 300, remaining: 0.1, resetsAt: now / 1000 - 1 }] })
  assert.equal(rememberedLimit(CLAUDE, now), undefined)
})

// A version that dated a spent window a year out wrote that date to this file,
// where it would have been held as live for the year it claims.
test('a figure dated further out than its window is long is dropped too', () => {
  const now = Date.now()
  const yearOut = 365 * 24 * HOUR
  rememberLimit(CLAUDE, {
    windows: [{ windowMinutes: 300, remaining: 1, resetsAt: now / 1000 + yearOut }],
  })
  assert.equal(rememberedLimit(CLAUDE, now), undefined)
})

// One window rolling over says nothing about the others - the weekly one outlives
// five of the session's in a morning.
test('only the window that reset is dropped', () => {
  const now = Date.now()
  rememberLimit(CLAUDE, {
    windows: [
      { windowMinutes: 300, remaining: 0.1, resetsAt: now / 1000 - 1 },
      { windowMinutes: 10080, remaining: 0.7, resetsAt: now / 1000 + HOUR },
    ],
  })
  assert.deepEqual(rememberedLimit(CLAUDE, now)?.windows, [
    { windowMinutes: 10080, remaining: 0.7, resetsAt: now / 1000 + HOUR },
  ])
})

test('a later figure replaces the one before it', () => {
  const now = Date.now()
  rememberLimit(CLAUDE, session(0.62, now))
  rememberLimit(CLAUDE, session(0.41, now))
  assert.equal(rememberedLimit(CLAUDE, now)?.windows[0]?.remaining, 0.41)
})

// A window with no reset time still describes an allowance, and dropping it would
// blank the line over a field the agent simply did not send.
test('a figure with no reset time is kept', () => {
  rememberLimit(CODEX, { windows: [{ windowMinutes: 10080, remaining: 0.9 }] })
  assert.equal(rememberedLimit(CODEX)?.windows[0]?.remaining, 0.9)
})

// An ACP server nobody here has a profile for has no command to ask and no RPC
// to call, so nothing is spawned on its behalf.
test('an agent nothing is known about is not asked for a figure', async () => {
  const { readLimit } = await import('../src/usage-limit.js')
  assert.equal(await readLimit('node some-custom-acp-server.mjs'), undefined)
})

// Reading is free, but it is a request against someone's backend, and a burst of
// short turns must not turn that into a loop. The CLI throttles its own
// rate-limit reporting on the same interval.
test('a second read too soon after the first is refused', async () => {
  const { readLimit } = await import('../src/usage-limit.js')
  const at = Date.now()
  // Unknown agent, so neither call spawns anything - what is under test is the
  // gate, and a real read would spend seconds to prove the same thing.
  await readLimit('node some-custom-acp-server.mjs', at)
  assert.equal(await readLimit('node some-custom-acp-server.mjs', at + 29_000), undefined)
})

// Codex names neither window, giving each a length instead - and reports the plan
// they belong to, which nothing else does.
test("codex's windows are read out shortest first, with the plan", async () => {
  const { codexLimitFrom } = await import('../src/usage-limit.js')
  assert.deepEqual(
    codexLimitFrom({
      rateLimits: {
        secondary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: 1789910451 },
        primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1789465332 },
        planType: 'plus',
      },
    }),
    {
      windows: [
        { windowMinutes: 300, remaining: 0.95, resetsAt: 1789465332 },
        { windowMinutes: 10080, remaining: 0.65, resetsAt: 1789910451 },
      ],
      plan: 'plus',
    },
  )
})

test("codex's weekly window is used when it is the only one", async () => {
  const { codexLimitFrom } = await import('../src/usage-limit.js')
  assert.deepEqual(
    codexLimitFrom({ rateLimits: { secondary: { usedPercent: 35, windowDurationMins: 10080 } } }),
    { windows: [{ windowMinutes: 10080, remaining: 0.65 }] },
  )
  assert.equal(codexLimitFrom({ rateLimits: {} }), null)
  assert.equal(codexLimitFrom(undefined), null)
  // A window with no length has nothing to be labelled with, and its length is
  // what names the row.
  assert.equal(codexLimitFrom({ rateLimits: { primary: { usedPercent: 5 } } }), null)
})

// Both readers of a vendor payload go through this, so it takes what it is given.
test("the pushed bag's windows are both read out", async () => {
  const { limitFrom } = await import('../src/usage-limit.js')
  assert.deepEqual(
    limitFrom({
      unifiedWindows: {
        five_hour: { utilization: 0.42, resetsAt: 1789461000 },
        seven_day: { utilization: 0.14 },
      },
    }),
    {
      windows: [
        { windowMinutes: 300, remaining: 0.58, resetsAt: 1789461000 },
        { windowMinutes: 10080, remaining: 0.86 },
      ],
    },
  )
  assert.equal(limitFrom(undefined), null)
  assert.equal(limitFrom({ unifiedWindows: {} }), null)
})

// The file outlives the version that wrote it. A figure in a shape this version
// no longer understands is no figure - reading it half-way would put a window
// with no length on screen.
test('a figure written by an older shape is not read back', async () => {
  const { DATA_DIR } = await import('../src/constants.js')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    join(DATA_DIR, 'usage-limits.json'),
    JSON.stringify({ [CLAUDE]: { window: 'five_hour', remaining: 0.58, resetsAt: 1789461000 } }),
  )
  assert.equal(rememberedLimit(CLAUDE), undefined)
})

// The one thing standing between the shell and Claude's figure is this text, so
// it is pinned exactly as the CLI renders it.
const USAGE_TEXT = `You are currently using your subscription to power your Claude Code usage

Current session: 52% used · resets Sep 15 at 4:30pm (Asia/Taipei)
Current week (all models): 16% used · resets Sep 20 at 9pm (Asia/Taipei)
Current week (Fable): 3% used · resets Sep 20 at 9pm (Asia/Taipei)

What's contributing to your limits usage?
Last 24h · 1696 requests · 23 sessions`

const READ_AT = new Date('2026-09-15T09:00:00+08:00').getTime()

// Every window on screen, in the order the card reads them: the account's own
// first, shortest first, and whatever a single model is separately capped at
// after them.
test('every window claude prints is read out of /usage', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  assert.deepEqual(claudeLimitFromUsageText(USAGE_TEXT, READ_AT), {
    windows: [
      {
        windowMinutes: 300,
        remaining: 0.48,
        resetsAt: new Date('2026-09-15T16:30:00+08:00').getTime() / 1000,
      },
      {
        windowMinutes: 10080,
        remaining: 0.84,
        resetsAt: new Date('2026-09-20T21:00:00+08:00').getTime() / 1000,
      },
      {
        windowMinutes: 10080,
        remaining: 0.97,
        resetsAt: new Date('2026-09-20T21:00:00+08:00').getTime() / 1000,
        model: 'Fable',
      },
    ],
  })
})

// The line the shell actually shows is the reset time, so an unread date is not
// a cosmetic loss - it is the half of the answer the reviewer came for.
test('the reset time comes back with it', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  assert.equal(
    claudeLimitFromUsageText(USAGE_TEXT, READ_AT)?.windows[0]?.resetsAt,
    new Date('2026-09-15T16:30:00+08:00').getTime() / 1000,
  )
})

// The CLI renders the clock of wherever it runs, so local is the right reading -
// and a zone saying otherwise means that no longer holds.
test('a reset rendered in another zone is left unread', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  const elsewhere = USAGE_TEXT.replaceAll('(Asia/Taipei)', '(America/New_York)')
  assert.deepEqual(claudeLimitFromUsageText(elsewhere, READ_AT)?.windows[0], {
    windowMinutes: 300,
    remaining: 0.48,
  })
})

// December rolls into January, and the rendered date carries no year.
test('a reset past new year takes the coming one', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  const newYear = 'Current session: 10% used · resets Jan 2 at 12:15am (Asia/Taipei)'
  assert.equal(
    claudeLimitFromUsageText(newYear, new Date('2026-12-31T23:00:00+08:00').getTime())?.windows[0]
      ?.resetsAt,
    new Date('2027-01-02T00:15:00+08:00').getTime() / 1000,
  )
})

// At 0% used there is no live window, so the CLI dates the line with the one that
// already ended. Reaching for a year that puts it ahead showed a spent window as
// "剩 100% 直到 9/17 19:20" on the 18th.
test('a window nobody has spent anything in yet is left undated', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  const fresh = 'Current session: 0% used · resets Sep 14 at 7:20pm (Asia/Taipei)'
  assert.deepEqual(claudeLimitFromUsageText(fresh, READ_AT)?.windows, [
    { windowMinutes: 300, remaining: 1 },
  ])
})

// The reverse of the new year case: on January 1st, "Dec 31" is last night, not
// eleven months out.
test('a reset rendered just before new year is not carried forward a year', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  const lastNight = 'Current session: 0% used · resets Dec 31 at 11:00pm (Asia/Taipei)'
  assert.deepEqual(
    claudeLimitFromUsageText(lastNight, new Date('2027-01-01T02:00:00+08:00').getTime())?.windows,
    [{ windowMinutes: 300, remaining: 1 }],
  )
})

// The percentage and the date drift apart between CLI versions, and only one of
// them is the number.
test('an unreadable date still leaves a readable percentage', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  const odd = 'Current session: 48% used · resets in about 3 hours'
  assert.deepEqual(claudeLimitFromUsageText(odd, READ_AT)?.windows, [
    { windowMinutes: 300, remaining: 0.52 },
  ])
})

// The per-model weekly line sits directly below the account's and reads almost
// the same. Showing 3% as the account's weekly figure would be a wrong number
// shown confidently, which is worse than no number at all - so a model's own
// share is carried as the model's, and labelled with it.
test("a per-model weekly line is not mistaken for the account's", async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  const windows = claudeLimitFromUsageText(USAGE_TEXT, READ_AT)?.windows ?? []
  assert.deepEqual(
    windows.filter((w) => !w.model).map((w) => [w.windowMinutes, w.remaining]),
    [
      [300, 0.48],
      [10080, 0.84],
    ],
  )
  assert.deepEqual(
    windows.filter((w) => w.model).map((w) => [w.model, w.remaining]),
    [['Fable', 0.97]],
  )
})

// The two channels see different things and each arrives on its own schedule.
// Whichever spoke last must not take the other's windows off the card with it.
test('a pushed report keeps the windows only the text read knows', async () => {
  const { claudeLimitFromUsageText, limitFrom } = await import('../src/usage-limit.js')
  const read = claudeLimitFromUsageText(USAGE_TEXT, READ_AT)!
  const pushed = limitFrom({
    unifiedWindows: {
      five_hour: { utilization: 0.6, resetsAt: 1820997000 },
      seven_day: { utilization: 0.2, resetsAt: 1821600000 },
    },
  })!
  assert.deepEqual(
    mergeLimit(read, pushed, READ_AT).windows.map((w) => [w.windowMinutes, w.remaining, w.model]),
    [
      [300, 0.4, undefined],
      [10080, 0.8, undefined],
      [10080, 0.97, 'Fable'],
    ],
  )
})

// The text read cannot always date a window, and a reset time already in hand
// beats a row that can only say a percentage.
test('a fresh window with no reset time keeps the one already held', () => {
  const now = Date.now()
  const held: AcpLimit = {
    windows: [{ windowMinutes: 300, remaining: 0.9, resetsAt: now / 1000 + HOUR }],
  }
  const merged = mergeLimit(held, { windows: [{ windowMinutes: 300, remaining: 0.5 }] }, now)
  assert.deepEqual(merged.windows, [
    { windowMinutes: 300, remaining: 0.5, resetsAt: now / 1000 + HOUR },
  ])
})

// A held window whose own reset has passed describes an allowance that was handed
// back, so it goes rather than lingering under the fresh ones.
test('a held window that has rolled over is not carried forward', () => {
  const now = Date.now()
  const held: AcpLimit = {
    windows: [{ windowMinutes: 10080, remaining: 0.2, resetsAt: now / 1000 - 1 }],
  }
  const merged = mergeLimit(held, { windows: [{ windowMinutes: 300, remaining: 0.5 }] }, now)
  assert.deepEqual(merged.windows, [{ windowMinutes: 300, remaining: 0.5 }])
})

// Wording drifts between CLI versions. That costs a figure, never a wrong one -
// and the push channel still fills the line in on the next turn.
test('text this version cannot read is no figure rather than a guess', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  assert.equal(claudeLimitFromUsageText('Usage limits are not available for this account.'), null)
  assert.equal(claudeLimitFromUsageText(''), null)
})
