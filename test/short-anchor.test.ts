import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shortAnchor } from '../src/label.js'

test('prefers the text the user actually clicked', () => {
  assert.equal(
    shortAnchor({ text: '立即報名', section: 'hero', components: ['Hero'], source: 'a/b.tsx:1' }),
    '立即報名',
  )
})

test('falls back section → component → filename', () => {
  assert.equal(shortAnchor({ section: 'hero', components: ['Hero'] }), 'hero')
  assert.equal(shortAnchor({ components: ['Hero', 'Page'] }), 'Hero')
  assert.equal(shortAnchor({ source: 'src/pages/home.tsx:42' }), 'home.tsx:42')
})

test('truncates long text and returns empty for a bare anchor', () => {
  const long = shortAnchor({ text: 'a'.repeat(60) })
  assert.ok(long.endsWith('…'))
  assert.ok(long.length <= 23)
  assert.equal(shortAnchor({ selector: 'div > p' }), '')
})

// A framed region resolves to the common ancestor of what it enclosed, so
// leading with that ancestor's own name would read as a pick of it.
test('a framed region leads with what it framed', () => {
  assert.equal(
    shortAnchor({ contains: ['<Card>', '<Card>', '<Card>'], text: '方案 A / 方案 B' }),
    '框選 3 項 · 方案 A / 方案 B',
  )
  assert.equal(shortAnchor({ contains: ['<Card>'], source: 'src/pricing.tsx:12' }), '框選 1 項 · pricing.tsx:12')
  assert.equal(shortAnchor({ contains: [] }), '', 'an empty list is not a region')
})
