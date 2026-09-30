import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HISTORY_BUDGET, historyBrief } from '../src/history.js'

test('nothing to hand over is nothing at all', () => {
  assert.deepEqual(historyBrief([]), [])
})

test('the brief carries the words and where they were said, and calls them handled', () => {
  const brief = historyBrief([{ where: 'Hero CTA', said: '太鬆了' }, { said: '整體再緊一點' }])
  assert.ok(brief[0]!.includes('earlier conversations that this session did not see'))
  assert.ok(brief.join('\n').includes('none of it is being asked again'))
  assert.ok(brief.join('\n').includes('recognised as one'))
  assert.deepEqual(brief.slice(-2), ['- Hero CTA: 太鬆了', '- 整體再緊一點'])
  assert.ok(!brief.join('\n').match(/\d+ times|次/), 'no count: the words are the signal')
})

test('a long line is cut to one line, and whitespace inside it is flattened', () => {
  const [line] = historyBrief([{ where: 'x', said: `a\n\n${'b'.repeat(300)}` }]).slice(-1)
  assert.ok(line!.length <= 120)
  assert.ok(!line!.includes('\n'))
  assert.ok(line!.endsWith('…'))
})

test('the budget drops the oldest lines and keeps the newest whole', () => {
  const said = Array.from({ length: 100 }, (_, i) => ({ where: `e${i}`, said: `request ${i}` }))
  const brief = historyBrief(said)
  const lines = brief.filter((l) => l.startsWith('- '))
  assert.ok(lines.length < said.length)
  assert.equal(lines[0], '- e0: request 0', 'newest first')
  assert.ok(lines.join('\n').length <= HISTORY_BUDGET)
  assert.ok(lines.every((l) => /^- e\d+: request \d+$/.test(l)))
})
