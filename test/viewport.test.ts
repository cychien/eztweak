import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shortAnchor, toAgentItem, viewportTag } from '../src/label.js'
import type { Annotation } from '../src/protocol.js'

const base: Annotation = { id: 'x', kind: 'element', comment: 'c', createdAt: 1, anchor: {} }

test('the agent payload always carries the viewport it was annotated at', () => {
  const item = toAgentItem({
    ...base,
    anchor: { text: '立即報名', viewport: { width: 390, height: 844, preset: 'mobile' } },
  })
  assert.ok(item.label.includes('@mobile 390x844'))
  assert.equal(item.anchor.viewport?.width, 390)
})

test('viewportTag surfaces narrow widths and stays quiet on desktop', () => {
  assert.equal(viewportTag({ viewport: { width: 390, height: 844, preset: 'mobile' } }), '390px')
  assert.equal(viewportTag({ viewport: { width: 1256, height: 900, preset: 'desktop' } }), '')
  assert.equal(viewportTag({}), '')
})

test('the conversation hint appends the width only when it is not desktop', () => {
  assert.equal(
    shortAnchor({ text: '立即報名', viewport: { width: 390, height: 844, preset: 'mobile' } }),
    '立即報名 · 390px',
  )
  assert.equal(
    shortAnchor({ text: '立即報名', viewport: { width: 1256, height: 900, preset: 'desktop' } }),
    '立即報名',
  )
})
