import assert from 'node:assert/strict'
import { test } from 'node:test'
import { referenceLabel, toConversationItem } from '../src/label.js'
import type { Annotation, Reference } from '../src/protocol.js'
import { agentItem } from './helpers/files.js'

const base: Annotation = {
  id: 'x',
  kind: 'element',
  comment: '字太小',
  createdAt: 1,
  anchor: {},
}

test('label leads with source, then components, section, text, viewport', () => {
  const item = agentItem({
    ...base,
    anchor: {
      source: 'src/pages/home.tsx:42',
      components: ['HeroSection', 'HomePage'],
      section: 'hero',
      text: '立即報名',
      viewport: { width: 390, height: 844, preset: 'mobile' },
    },
  })
  assert.equal(
    item.label,
    'src/pages/home.tsx:42 · <HeroSection ← HomePage> · [section: hero] · "立即報名" · @mobile 390x844',
  )
})

test('point annotations announce the pin and its position inside the element', () => {
  const item = agentItem({
    ...base,
    kind: 'point',
    anchor: {
      source: 'src/pages/home.tsx:42',
      text: '把想學的事',
      point: { x: 400, y: 220, rel: { x: 0.817, y: 0.35 } },
    },
  })
  assert.equal(item.label, '[pin 82%/35%] · src/pages/home.tsx:42 · "把想學的事"')
})

test('a point without coordinates still says it was a pin', () => {
  const item = agentItem({ ...base, kind: 'point', anchor: { section: 'hero' } })
  assert.equal(item.label, '[pin] · [section: hero]')
})

test('falls back to selector when nothing better exists', () => {
  const item = agentItem({ ...base, anchor: { selector: 'main > div:nth-of-type(2)' } })
  assert.equal(item.label, 'main > div:nth-of-type(2)')
})

test('page annotations are prefixed with the page path', () => {
  const item = agentItem({ ...base, kind: 'page', anchor: { page: '/pricing' } })
  assert.ok(item.label.startsWith('[page /pricing]'))
})

test('long text is truncated', () => {
  const item = agentItem({ ...base, kind: 'text', anchor: { text: 'a'.repeat(100) } })
  assert.ok(item.label.includes('…'))
  assert.ok(item.label.length < 80)
})

const file = (id: string, name: string) => ({
  id,
  name,
  mime: 'image/png',
  size: 1,
  createdAt: 1,
})

// Numbered one by one, not a comma-separated set: the comment carries `[file n]`
// where the user put it, so with two screenshots the agent can tell which one a
// sentence is talking about instead of guessing from a list.
test('attachments are numbered in the label and resolved to absolute paths', () => {
  const item = agentItem({
    ...base,
    anchor: { source: 'src/pages/home.tsx:42' },
    attachments: [file('aaa', 'shot.png'), file('bbb', 'notes.txt')],
  })
  assert.equal(
    item.label,
    'src/pages/home.tsx:42 · [file 1: shot.png] · [file 2: notes.txt]',
  )
  assert.deepEqual(
    item.attachments?.map((a) => a.path),
    ['/tmp/session/attachments/aaa-shot.png', '/tmp/session/attachments/bbb-notes.txt'],
  )
})

test('an item with no attachments does not carry the key at all', () => {
  const item = agentItem(base)
  assert.equal('attachments' in item, false)
})

test('the conversation log echoes attachment names', () => {
  assert.deepEqual(toConversationItem({ ...base, attachments: [file('aaa', 'shot.png')] }), {
    comment: '字太小',
    where: '',
    attachments: ['shot.png'],
  })
  assert.equal('attachments' in toConversationItem(base), false)
})

const ref = (anchor: Reference['anchor'], n = 1, label = 'x'): Reference => ({ n, anchor, label })

// References sit after the anchor - which says where the comment is - and before
// the files, because they are anchors too and the comment's own markers have to
// resolve against them.
test('references land after the viewport and before the files', () => {
  const item = agentItem({
    ...base,
    comment: '這裡的間距要跟 [ref 1] 一樣',
    anchor: { source: 'src/a.tsx:12', viewport: { width: 1440, height: 900 } },
    references: [ref({ source: 'src/b.tsx:88', components: ['Row'] })],
    attachments: [{ id: 'f1', name: 'shot.png', mime: 'image/png', size: 1, createdAt: 1 }],
  })
  assert.equal(
    item.label,
    'src/a.tsx:12 · @1440x900 · [ref 1: src/b.tsx:88 · <Row>] · [file 1: shot.png]',
  )
})

// The whole point of numbering: [ref 2] in the comment must name references[1].
test('marker numbers match the reference carrying them', () => {
  const item = agentItem({
    ...base,
    comment: '把 [ref 1] 的圓角套到 [ref 2]',
    references: [ref({ source: 'a.tsx:1' }, 1), ref({ source: 'b.tsx:2' }, 2)],
  })
  assert.equal(item.label, '[ref 1: a.tsx:1] · [ref 2: b.tsx:2]')
  assert.deepEqual(item.references?.map((r) => r.anchor.source), ['a.tsx:1', 'b.tsx:2'])
})

// The number is an identity, not a position. A user who deletes their first
// reference leaves a gap, and the label has to keep naming the survivor by the
// number its `[ref n]` marker uses.
test('a gap in the numbering survives to the agent', () => {
  const item = agentItem({
    ...base,
    comment: '照 [ref 2] 改',
    references: [ref({ source: 'b.tsx:2' }, 2)],
  })
  assert.equal(item.label, '[ref 2: b.tsx:2]')
})

// A reference's own anchor travels beside the label, so repeating the viewport
// inside a summary that sits inside another label only makes the line longer.
test('a reference label carries no viewport of its own', () => {
  assert.equal(
    referenceLabel(ref({ source: 'b.tsx:1', viewport: { width: 390, height: 844 } })),
    'b.tsx:1',
  )
})

test('a reference with nothing to summarise falls back to what the chip read', () => {
  assert.equal(referenceLabel(ref({}, 1, '主要按鈕')), '主要按鈕')
  assert.equal(referenceLabel(ref({ selector: 'main > div' })), 'main > div')
})

// Number and label, not the anchor: the sidebar needs to put the chip back where
// the comment's `[ref n]` marker stood, and nothing more.
test('the conversation log echoes the number and the label, not the anchor', () => {
  const entry = toConversationItem({
    ...base,
    references: [ref({ source: 'src/b.tsx:88' }, 2, '立即報名')],
  })
  assert.deepEqual(entry.references, [{ n: 2, label: '立即報名' }])
})

test('an annotation with no references says so by omission', () => {
  assert.equal(agentItem(base).references, undefined)
  assert.equal(toConversationItem(base).references, undefined)
})

// The reason the numbering exists: two screenshots in one comment, and the
// sentence saying which is which.
test('two files in one comment are each named by their own number', () => {
  const item = agentItem({
    ...base,
    comment: '這張 [file 1] 的間距要跟 [file 2] 一樣',
    attachments: [file('a', 'before.png'), file('b', 'after.png')],
  })
  assert.equal(item.label, '[file 1: before.png] · [file 2: after.png]')
  assert.deepEqual(
    item.attachments?.map((a) => a.name),
    ['before.png', 'after.png'],
    'and n is this array position, so [file 2] is attachments[1]',
  )
})

// Without this the agent reads the anchor - which resolves to the common
// ancestor - as the thing the user pointed at, rather than the box they drew.
test('a framed region says so, and names what it framed', () => {
  assert.equal(
    referenceLabel(
      ref({ source: 'src/pricing.tsx:8', contains: ['<Card> · src/card.tsx:3', '<Card> · src/card.tsx:3'] }),
    ),
    'src/pricing.tsx:8 · [framed 2: <Card> · src/card.tsx:3; <Card> · src/card.tsx:3]',
  )
})
