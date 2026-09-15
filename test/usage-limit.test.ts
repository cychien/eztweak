import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.EZTWEAK_DATA_DIR = mkdtempSync(join(tmpdir(), 'eztweak-limits-'))
// The reset times below are rendered in this zone, and the reader only trusts a
// zone that is the machine's own - so the machine is made to be in it.
process.env.TZ = 'Asia/Taipei'

const { rememberLimit, rememberedLimit } = await import('../src/usage-limit.js')

const CLAUDE = 'npx -y @agentclientprotocol/claude-agent-acp'
const CODEX = 'npx -y @agentclientprotocol/codex-acp'
const HOUR = 3600

test('nothing is remembered before anything is reported', () => {
  assert.equal(rememberedLimit(CLAUDE), undefined)
})

// The point of the file: the figure arrives pushed and cannot be asked for, so a
// restart that forgot it would blank the line until the review's next turn.
test('a figure survives the daemon that was told it', () => {
  const now = Date.now()
  rememberLimit(CLAUDE, { windowMinutes: 300, remaining: 0.62, resetsAt: now / 1000 + HOUR })
  assert.equal(rememberedLimit(CLAUDE, now)?.remaining, 0.62)
})

// What an agent reports is its own vendor's allowance. Handing Claude's figure to
// codex would put a number on screen that describes someone else's account.
test('one agent is not shown another agent’s figure', () => {
  const now = Date.now()
  rememberLimit(CLAUDE, { windowMinutes: 300, remaining: 0.62, resetsAt: now / 1000 + HOUR })
  assert.equal(rememberedLimit(CODEX, now), undefined)
})

// A spent percentage from a window that has since rolled over is not stale, it is
// wrong: the allowance it describes was handed back.
test('a figure whose window has reset is dropped rather than shown', () => {
  const now = Date.now()
  rememberLimit(CLAUDE, { windowMinutes: 300, remaining: 0.1, resetsAt: now / 1000 - 1 })
  assert.equal(rememberedLimit(CLAUDE, now), undefined)
})

test('a later figure replaces the one before it', () => {
  const now = Date.now()
  rememberLimit(CLAUDE, { windowMinutes: 300, remaining: 0.62, resetsAt: now / 1000 + HOUR })
  rememberLimit(CLAUDE, { windowMinutes: 300, remaining: 0.41, resetsAt: now / 1000 + HOUR })
  assert.equal(rememberedLimit(CLAUDE, now)?.remaining, 0.41)
})

// A window with no reset time still describes an allowance, and dropping it would
// blank the line over a field the agent simply did not send.
test('a figure with no reset time is kept', () => {
  rememberLimit(CODEX, { windowMinutes: 10080, remaining: 0.9 })
  assert.equal(rememberedLimit(CODEX)?.remaining, 0.9)
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

// Codex names neither window, giving each a length instead - so the shorter one
// is picked rather than an order assumed.
test("codex's shorter window is the one read out", async () => {
  const { codexLimitFrom } = await import('../src/usage-limit.js')
  assert.deepEqual(
    codexLimitFrom({
      rateLimits: {
        primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1789465332 },
        secondary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: 1789910451 },
      },
    }),
    { windowMinutes: 300, remaining: 0.95, resetsAt: 1789465332 },
  )
})

test("codex's weekly window is used when it is the only one", async () => {
  const { codexLimitFrom } = await import('../src/usage-limit.js')
  assert.deepEqual(
    codexLimitFrom({ rateLimits: { secondary: { usedPercent: 35, windowDurationMins: 10080 } } }),
    {
      windowMinutes: 10080,
      remaining: 0.65,
    },
  )
  assert.equal(codexLimitFrom({ rateLimits: {} }), null)
  assert.equal(codexLimitFrom(undefined), null)
  // A window with no length cannot be compared against the other one, and its
  // length is what the line says out loud.
  assert.equal(codexLimitFrom({ rateLimits: { primary: { usedPercent: 5 } } }), null)
})

// Both readers of a vendor payload go through this, so it takes what it is given.
test('the window that empties first is the one read out', async () => {
  const { limitFrom } = await import('../src/usage-limit.js')
  assert.deepEqual(
    limitFrom({
      unifiedWindows: {
        five_hour: { utilization: 0.42, resetsAt: 1789461000 },
        seven_day: { utilization: 0.14 },
      },
    }),
    { windowMinutes: 300, remaining: 0.58, resetsAt: 1789461000 },
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

test("claude's session window is read out of /usage", async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  assert.deepEqual(claudeLimitFromUsageText(USAGE_TEXT, READ_AT), {
    windowMinutes: 300,
    remaining: 0.48,
    resetsAt: new Date('2026-09-15T16:30:00+08:00').getTime() / 1000,
  })
})

// The line the shell actually shows is the reset time, so an unread date is not
// a cosmetic loss - it is the half of the answer the reviewer came for.
test('the reset time comes back with it', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  const weekly = USAGE_TEXT.split('\n')
    .filter((l) => !l.startsWith('Current session:'))
    .join('\n')
  assert.equal(
    claudeLimitFromUsageText(weekly, READ_AT)?.resetsAt,
    new Date('2026-09-20T21:00:00+08:00').getTime() / 1000,
  )
})

// The CLI renders the clock of wherever it runs, so local is the right reading -
// and a zone saying otherwise means that no longer holds.
test('a reset rendered in another zone is left unread', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  const elsewhere = USAGE_TEXT.replaceAll('(Asia/Taipei)', '(America/New_York)')
  assert.deepEqual(claudeLimitFromUsageText(elsewhere, READ_AT), {
    windowMinutes: 300,
    remaining: 0.48,
  })
})

// December rolls into January, and the rendered date carries no year.
test('a reset past new year takes the coming one', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  const newYear = 'Current session: 10% used · resets Jan 2 at 12:15am (Asia/Taipei)'
  assert.equal(
    claudeLimitFromUsageText(newYear, new Date('2026-12-31T23:00:00+08:00').getTime())?.resetsAt,
    new Date('2027-01-02T00:15:00+08:00').getTime() / 1000,
  )
})

// The percentage and the date drift apart between CLI versions, and only one of
// them is the number.
test('an unreadable date still leaves a readable percentage', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  const odd = 'Current session: 48% used · resets in about 3 hours'
  assert.deepEqual(claudeLimitFromUsageText(odd, READ_AT), {
    windowMinutes: 300,
    remaining: 0.52,
  })
})

// The per-model weekly line sits directly below the account's and reads almost
// the same. Taking 3% for the account's weekly figure would be a wrong number
// shown confidently, which is worse than no number at all.
test("a per-model weekly line is not mistaken for the account's", async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  const weeklyOnly = USAGE_TEXT.split('\n')
    .filter((l) => !l.startsWith('Current session:'))
    .join('\n')
  assert.equal(claudeLimitFromUsageText(weeklyOnly, READ_AT)?.remaining, 0.84)
})

// Wording drifts between CLI versions. That costs a figure, never a wrong one -
// and the push channel still fills the line in on the next turn.
test('text this version cannot read is no figure rather than a guess', async () => {
  const { claudeLimitFromUsageText } = await import('../src/usage-limit.js')
  assert.equal(claudeLimitFromUsageText('Usage limits are not available for this account.'), null)
  assert.equal(claudeLimitFromUsageText(''), null)
})
