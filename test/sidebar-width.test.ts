import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  STAGE_MIN,
  clampSidebarWidth,
  maxSidebarWidth,
} from '../src/client/sidebar-width.js'

const ROOMY = SIDEBAR_MAX + STAGE_MIN + 200

test('the default sits inside the range it is clamped to', () => {
  assert.equal(clampSidebarWidth(SIDEBAR_DEFAULT, ROOMY), SIDEBAR_DEFAULT)
})

test('a drag past either end stops at the limit', () => {
  assert.equal(clampSidebarWidth(9999, ROOMY), SIDEBAR_MAX)
  assert.equal(clampSidebarWidth(0, ROOMY), SIDEBAR_MIN)
})

test('the stage keeps its share until the sidebar would go under its floor', () => {
  assert.equal(maxSidebarWidth(SIDEBAR_MAX + STAGE_MIN), SIDEBAR_MAX)
  assert.equal(maxSidebarWidth(SIDEBAR_MAX + STAGE_MIN - 100), SIDEBAR_MAX - 100)
  // Below this the two floors cannot both hold, and the sidebar's wins.
  assert.equal(maxSidebarWidth(SIDEBAR_MIN + STAGE_MIN - 100), SIDEBAR_MIN)
  assert.equal(maxSidebarWidth(0), SIDEBAR_MIN)
})

test('a narrow window clamps the chosen width and a roomy one returns it intact', () => {
  const narrow = SIDEBAR_MAX + STAGE_MIN - 120
  assert.equal(clampSidebarWidth(SIDEBAR_MAX, narrow), SIDEBAR_MAX - 120)
  assert.equal(clampSidebarWidth(SIDEBAR_MAX, ROOMY), SIDEBAR_MAX)
})

test('a fractional drag lands on a whole pixel', () => {
  assert.equal(clampSidebarWidth(400.4, ROOMY), 400)
  assert.equal(clampSidebarWidth(400.6, ROOMY), 401)
})
