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
  assert.ok(offer.includes('這個專案還沒有 DESIGN.md。要先建立一份，作為設計統一標準嗎？'))
  assert.ok(offer.includes('「建立 DESIGN.md（推薦）」'))
  assert.ok(offer.includes('「這次先不要」'))
  assert.ok(offer.indexOf('ask the user') < offer.indexOf('If they choose to create it'))
  assert.ok(offer.includes('designmd spec'))
  assert.ok(offer.includes('designmd lint DESIGN.md'))
})

// The spec already tells the agent what the document must contain, and it reads the
// spec. So the brief carries only what the spec cannot know: that there is a page
// running, and that a stylesheet read alone cannot say which of its rules the page
// actually leans on - which is what every design-token extractor uses a browser for.
test('the offer says only what the format cannot, and points at the running page', () => {
  const offer = designMdBrief('missing').join('\n')
  assert.ok(offer.includes('none of that is repeated here'), 'it defers to the spec')
  assert.ok(offer.includes('the `url` in the batch below'), 'and points at the live page')
  assert.ok(offer.includes('computed styles off the rendered'), 'read the DOM, not the stylesheet')
  assert.ok(offer.includes('Frequency'), 'and count, which is what separates system from exception')
})

// A brief long enough to skim is a brief the agent skims. This is not a style rule:
// the whole thing rides in front of a batch the user is waiting on.
test('the briefs stay short enough to be read', () => {
  assert.ok(designMdBrief('missing').join('\n').length < 2200, 'the offer is one screen')
  assert.ok(designMdBrief('present').join('\n').length < 350, 'the standing rule is three lines')
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
  assert.ok(bound.includes('tokens and prose'))
})
