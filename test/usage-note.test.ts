import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Usage } from '../src/client/usage-note.js'
import { planName, usageNote, usageRows, windowName } from '../src/client/usage-note.js'

const FIVE_HOURS = 300
const ONE_WEEK = 7 * 24 * 60

/** Local-time fixtures, so the day arithmetic is read in the same zone the shell
 *  would read it in whatever zone the suite runs in. */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Math.floor(new Date(year, month - 1, day, hour, minute).getTime() / 1000)
}

const NOW = new Date(2026, 8, 16, 9).getTime()

const FULL: Usage = {
  windows: [
    { windowMinutes: FIVE_HOURS, remaining: 0.91, resetsAt: at(2026, 9, 16, 18, 30) },
    { windowMinutes: ONE_WEEK, remaining: 0.4, resetsAt: at(2026, 9, 20, 21) },
    { windowMinutes: ONE_WEEK, remaining: 0.08, resetsAt: at(2026, 9, 20, 21), model: 'Fable' },
  ],
  plan: 'plus',
}

// The whole point of the line: a reviewer asks when the allowance comes back, not
// how long the window is.
test('the line is the reset time, not the window length', () => {
  assert.equal(usageNote(FULL, NOW), '剩 91% 直到 18:30')
})

// One model's weekly share is an allowance the reviewer can walk away from by
// switching models, so it never speaks for the account.
test('the line speaks for the account, not for one model', () => {
  const modelOnly: Usage = { windows: [FULL.windows[2]!] }
  assert.equal(usageNote(modelOnly, NOW), '剩 8% 直到 9/20 21:00')
  assert.equal(usageNote(FULL, NOW), '剩 91% 直到 18:30')
})

test('no reset time leaves the percentage standing alone', () => {
  assert.equal(usageNote({ windows: [{ windowMinutes: FIVE_HOURS, remaining: 0.58 }] }), '剩 58%')
})

// Dating a figure into the past is worse than saying nothing about when.
test('a reset already behind us is no reset', () => {
  const stale: Usage = {
    windows: [{ windowMinutes: FIVE_HOURS, remaining: 0.58, resetsAt: at(2026, 9, 16, 8) }],
  }
  assert.equal(usageNote(stale, NOW), '剩 58%')
})

test('nothing reported is no line at all', () => {
  assert.equal(usageNote(undefined), '')
  assert.equal(usageNote({ windows: [] }), '')
})

// What the card is for: every window the agent would print, the way `/usage` and
// `/status` print them.
test('the card carries every window, labelled', () => {
  assert.deepEqual(usageRows(FULL, NOW), [
    { label: '5 小時', percent: 91, when: '18:30 重置', low: false },
    { label: '一週', percent: 40, when: '9/20 21:00 重置', low: false },
    { label: '一週 · Fable', percent: 8, when: '9/20 21:00 重置', low: true },
  ])
})

// A weekly window lands days out, where a bare time would read as tonight.
test('a reset tomorrow says so', () => {
  const soon: Usage = {
    windows: [{ windowMinutes: ONE_WEEK, remaining: 0.4, resetsAt: at(2026, 9, 17, 3) }],
  }
  assert.equal(usageRows(soon, NOW)[0]?.when, '明天 03:00 重置')
})

test('a window the agent never dated says only what it knows', () => {
  const undated: Usage = { windows: [{ windowMinutes: ONE_WEEK, remaining: 0.4 }] }
  assert.equal(usageRows(undated, NOW)[0]?.when, '')
})

test('window names', () => {
  assert.equal(windowName(ONE_WEEK), '一週')
  assert.equal(windowName(FIVE_HOURS), '5 小時')
  assert.equal(windowName(2 * 24 * 60), '2 天')
  assert.equal(windowName(45), '45 分鐘')
})

test('the plan is shown the way its owner would write it', () => {
  assert.equal(planName('plus'), 'Plus')
  assert.equal(planName(undefined), '')
})
