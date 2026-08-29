import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QUIET_MS, following, scrollRange, scrollRatio } from '../src/client/scroll-sync.js'

test('a page shorter than its frame has no position to share', () => {
  assert.equal(scrollRange(600, 844), 0)
  assert.equal(scrollRatio(0, scrollRange(600, 844)), null)
})

test('the ratio is measured against what there is left to scroll', () => {
  const range = scrollRange(2844, 844)
  assert.equal(range, 2000)
  assert.equal(scrollRatio(500, range), 0.25)
  assert.equal(scrollRatio(2000, range), 1)
})

// Momentum scrolling overshoots past both ends, and a ratio outside 0..1 would
// be handed to another frame as a scroll target beyond its own page.
test('overscroll is clamped rather than passed on', () => {
  const range = scrollRange(2844, 844)
  assert.equal(scrollRatio(-120, range), 0)
  assert.equal(scrollRatio(2400, range), 1)
})

// The echo of an applied scroll arrives a frame or two later and never carries
// exactly the ratio that went in, so it is recognised by when it happened.
test('a frame settling into a scroll it was told to make reports nothing', () => {
  assert.equal(following(1000, 1000), true, 'the move itself')
  assert.equal(following(1000 + QUIET_MS - 1, 1000), true, 'and its echo')
  assert.equal(following(1000 + QUIET_MS, 1000), false, 'then it may lead again')
  assert.equal(following(1000, null), false, 'nothing was applied, so nothing to wait out')
})
