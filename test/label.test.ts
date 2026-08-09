import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toAgentItem } from '../src/label.js'
import type { Annotation } from '../src/protocol.js'

const base: Annotation = {
  id: 'x',
  kind: 'element',
  comment: '字太小',
  createdAt: 1,
  anchor: {},
}

test('label leads with source, then components, section, text, viewport', () => {
  const item = toAgentItem({
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
  const item = toAgentItem({
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
  const item = toAgentItem({ ...base, kind: 'point', anchor: { section: 'hero' } })
  assert.equal(item.label, '[pin] · [section: hero]')
})

test('falls back to selector when nothing better exists', () => {
  const item = toAgentItem({ ...base, anchor: { selector: 'main > div:nth-of-type(2)' } })
  assert.equal(item.label, 'main > div:nth-of-type(2)')
})

test('page annotations are prefixed with the page path', () => {
  const item = toAgentItem({ ...base, kind: 'page', anchor: { page: '/pricing' } })
  assert.ok(item.label.startsWith('[page /pricing]'))
})

test('long text is truncated', () => {
  const item = toAgentItem({ ...base, kind: 'text', anchor: { text: 'a'.repeat(100) } })
  assert.ok(item.label.includes('…'))
  assert.ok(item.label.length < 80)
})
