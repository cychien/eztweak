import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectSlash, filterCommands } from '../src/client/slash.js'
import type { SlashCommand } from '../src/client/slash.js'

test('a slash opens the menu at the start of a word', () => {
  assert.deepEqual(detectSlash('/'), { start: 0, query: '' })
  assert.deepEqual(detectSlash('/fi'), { start: 0, query: 'fi' })
  assert.deepEqual(detectSlash('看這裡 /file'), { start: 4, query: 'file' })
  // The spacer after a chip is a non-breaking space, so it has to count as one.
  assert.deepEqual(detectSlash(' /f'), { start: 1, query: 'f' })
})

// The rule that keeps the menu out of the way of ordinary text. Without it every
// url and path in a comment would open it.
test('a slash inside a word is just a character', () => {
  assert.equal(detectSlash('http://localhost:5173'), null)
  assert.equal(detectSlash('src/client'), null)
  assert.equal(detectSlash('a/b'), null)
})

test('the query ends where the command name would', () => {
  assert.equal(detectSlash('/file 之後'), null, 'a space closes it')
  assert.equal(detectSlash(`/${'x'.repeat(30)}`), null, 'prose is not a command name')
  assert.equal(detectSlash('no slash here'), null)
})

test('the last slash is the live one', () => {
  assert.deepEqual(detectSlash('/a /b'), { start: 3, query: 'b' })
})

const command = (id: string, label: string, keywords: string[]): SlashCommand => ({
  id,
  label,
  keywords,
  icon: [],
  run: () => {},
})

const COMMANDS = [
  command('file', '附加檔案', ['attach', 'upload', '圖片']),
  command('viewport', '切換寬度', ['size', 'mobile']),
]

test('an empty query offers everything', () => {
  assert.deepEqual(filterCommands(COMMANDS, '').length, 2)
})

test('filtering matches the id, the label or a keyword', () => {
  assert.deepEqual(
    filterCommands(COMMANDS, 'fi').map((c) => c.id),
    ['file'],
  )
  assert.deepEqual(
    filterCommands(COMMANDS, '圖片').map((c) => c.id),
    ['file'],
    'keywords carry the terms the label does not use',
  )
  assert.deepEqual(
    filterCommands(COMMANDS, '寬度').map((c) => c.id),
    ['viewport'],
  )
  assert.deepEqual(filterCommands(COMMANDS, 'zzz'), [])
})

test('filtering ignores case and surrounding space', () => {
  assert.deepEqual(
    filterCommands(COMMANDS, ' UPLOAD ').map((c) => c.id),
    ['file'],
  )
})

