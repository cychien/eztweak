import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseInline, parseMarkdown } from '../src/client/markdown.js'

test('plain prose is one paragraph, blank lines split paragraphs', () => {
  const blocks = parseMarkdown('第一段。\n\n第二段。')
  assert.deepEqual(
    blocks.map((b) => b.t),
    ['p', 'p'],
  )
})

// Agent replies lean on single newlines ("#1 ...\n#2 ..."), and folding them
// into spaces loses the list they imply.
test('a single newline inside a paragraph stays a line break', () => {
  const p = parseMarkdown('第一行\n第二行')[0]!
  assert.equal(p.t, 'p')
  assert.deepEqual(p.t === 'p' && p.children.map((n) => n.t), ['text', 'break', 'text'])
})

test('bold, italic and inline code parse inside a sentence', () => {
  const nodes = parseInline('改了 **`.btn`** 的 *hover*，色碼 `#1b6b4a`')
  const kinds = nodes.map((n) => n.t)
  assert.deepEqual(kinds, ['text', 'strong', 'text', 'em', 'text', 'code'])
  const strong = nodes[1]
  assert.equal(strong?.t === 'strong' && strong.children[0]?.t, 'code')
})

test('a bare asterisk in prose is not emphasis', () => {
  const nodes = parseInline('2 * 3 = 6，*這才是斜體*')
  assert.equal(nodes[0]?.t, 'text')
  assert.equal(nodes[0]?.t === 'text' && nodes[0].text, '2 * 3 = 6，')
  assert.equal(nodes[1]?.t, 'em')
})

test('only http(s) links survive; anything else stays text', () => {
  const ok = parseInline('[docs](https://example.com)')
  assert.deepEqual(ok, [{ t: 'link', text: 'docs', href: 'https://example.com' }])
  const bad = parseInline('[x](javascript:alert(1))')
  assert.equal(bad.some((n) => n.t === 'link'), false)
})

test('bulleted and numbered lists collect their items', () => {
  const list = parseMarkdown('- 甲\n- 乙\n- 丙')[0]!
  assert.equal(list.t === 'list' && !list.ordered && list.items.length, 3)
  const numbered = parseMarkdown('1. 甲\n2. 乙')[0]!
  assert.equal(numbered.t === 'list' && numbered.ordered && numbered.items.length, 2)
})

test('a wrapped list item folds its indented continuation in', () => {
  const list = parseMarkdown('- 第一項很長\n  接在後面\n- 第二項')[0]!
  assert.equal(list.t, 'list')
  if (list.t !== 'list') return
  assert.equal(list.items.length, 2)
  const first = list.items[0]!.map((n) => (n.t === 'text' ? n.text : '')).join('')
  assert.equal(first, '第一項很長 接在後面')
})

test('fenced code keeps its body verbatim, markers and all', () => {
  const fence = parseMarkdown('```css\n.btn { color: **red**; }\n```')[0]!
  assert.equal(fence.t, 'fence')
  assert.equal(fence.t === 'fence' && fence.text, '.btn { color: **red**; }')
})

// The streaming reply is re-rendered on every chunk, so the parser sees
// half-finished markdown constantly.
test('an unclosed fence mid-stream parses instead of hanging or throwing', () => {
  const blocks = parseMarkdown('先講一句\n```ts\nconst a =')
  assert.deepEqual(
    blocks.map((b) => b.t),
    ['p', 'fence'],
  )
})

test('headings map to blocks with their level', () => {
  const head = parseMarkdown('## 修改摘要')[0]!
  assert.equal(head.t === 'heading' && head.level, 2)
})
