import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { designMdBrief, designMdExploreRule, designMdState } from '../src/design-md.js'

const project = () => mkdtempSync(join(tmpdir(), 'eztweak-design-md-'))

test('a project without the file is offered one, and only until it has been', () => {
  const dir = project()
  assert.equal(designMdState(dir, {}), 'missing')
  assert.equal(designMdState(dir, { designMdOfferedAt: 1 }), 'quiet')
})

test('a project with the file is never offered one, whatever the chat remembers', () => {
  const dir = project()
  writeFileSync(join(dir, 'DESIGN.md'), '---\nname: Fixture\n---\n')
  assert.equal(designMdState(dir, {}), 'present')
  assert.equal(designMdState(dir, { designMdOfferedAt: 1 }), 'present')
})

// The question is the user's to answer before anything is spent on it, so the
// brief has to put the asking ahead of the looking, and the looking behind a yes.
test('the offer asks first, in the words the user will read, and looks second', () => {
  const offer = designMdBrief('missing').join('\n')
  assert.ok(
    offer.includes(
      '這個專案還沒有 DESIGN.md。要先建立一份，作為設計的 single source of truth 嗎？',
    ),
  )
  assert.ok(offer.includes('「建立 DESIGN.md（推薦）」'))
  assert.ok(offer.includes('「這次先不要」'))
  assert.ok(offer.indexOf('ask the user') < offer.indexOf('If they choose to create it'))
  assert.ok(offer.includes('designmd spec'))
  assert.ok(offer.includes('designmd lint DESIGN.md'))
})

test('once offered, nothing more is said; once present, the file is the rule', () => {
  assert.deepEqual(designMdBrief('quiet'), [])
  assert.ok(designMdBrief('present').join('\n').includes('source of truth'))
})

test('an explore is never offered the file, and is bound by it when it exists', () => {
  for (const state of ['missing', 'quiet'] as const) {
    const rule = designMdExploreRule(state).join('\n')
    assert.ok(!rule.includes('DESIGN.md'), `${state} says nothing about the file`)
    assert.ok(rule.includes("the element's anchor"))
  }
  const bound = designMdExploreRule('present').join('\n')
  assert.ok(bound.includes('DESIGN.md'))
  assert.ok(bound.includes('every variant'))
})
