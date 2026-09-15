import assert from 'node:assert/strict'
import { test } from 'node:test'
import { usageNote, windowName } from '../src/client/usage-note.js'

const FIVE_HOURS = 300
const ONE_WEEK = 7 * 24 * 60

/** Local-time fixtures, so the day arithmetic is read in the same zone the
 *  shell would read it in whatever zone the suite runs in. */
function at(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute)
}

function seconds(when: Date): number {
  return Math.floor(when.getTime() / 1000)
}

const NOW = at(2026, 9, 16, 9).getTime()

// The whole point of the line: a reviewer asks when the allowance comes back,
// not how long the window is.
test('the reset time is the line, not the window length', () => {
  const note = usageNote(
    { windowMinutes: FIVE_HOURS, remaining: 0.91, resetsAt: seconds(at(2026, 9, 16, 18, 30)) },
    NOW,
  )
  assert.equal(note.text, '剩 91% 直到 18:30')
})

test('the window length moves to the tooltip', () => {
  const note = usageNote(
    { windowMinutes: FIVE_HOURS, remaining: 0.91, resetsAt: seconds(at(2026, 9, 16, 18, 30)) },
    NOW,
  )
  assert.match(note.title, /5 小時用量/)
})

test('a reset tomorrow says so', () => {
  const note = usageNote(
    { windowMinutes: ONE_WEEK, remaining: 0.4, resetsAt: seconds(at(2026, 9, 17, 3)) },
    NOW,
  )
  assert.equal(note.text, '剩 40% 直到 明天 03:00')
})

// A weekly window lands days out, where a bare time would read as tonight.
test('a reset further out carries the date', () => {
  const note = usageNote(
    { windowMinutes: ONE_WEEK, remaining: 0.4, resetsAt: seconds(at(2026, 9, 20, 18, 30)) },
    NOW,
  )
  assert.equal(note.text, '剩 40% 直到 9/20 18:30')
})

test('no reset time leaves the percentage standing alone', () => {
  assert.equal(usageNote({ windowMinutes: FIVE_HOURS, remaining: 0.58 }, NOW).text, '剩 58%')
})

// Dating a figure into the past is worse than saying nothing about when.
test('a reset already behind us is no reset', () => {
  const note = usageNote(
    { windowMinutes: FIVE_HOURS, remaining: 0.58, resetsAt: seconds(at(2026, 9, 16, 8)) },
    NOW,
  )
  assert.equal(note.text, '剩 58%')
  assert.equal(note.title, '5 小時用量')
})

test('window names', () => {
  assert.equal(windowName(ONE_WEEK), '一週')
  assert.equal(windowName(FIVE_HOURS), '5 小時')
  assert.equal(windowName(2 * 24 * 60), '2 天')
  assert.equal(windowName(45), '45 分鐘')
})
