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
