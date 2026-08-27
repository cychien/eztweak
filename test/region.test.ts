import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DRAG_SLOP,
  centerOf,
  containsRect,
  intersectsRect,
  isRegion,
  regionFrom,
} from '../src/client/region.js'

const box = { x: 100, y: 100, width: 200, height: 100 }

test('a box is the same box whichever corner the drag started from', () => {
  const down = regionFrom({ x: 100, y: 100 }, { x: 300, y: 200 })
  const up = regionFrom({ x: 300, y: 200 }, { x: 100, y: 100 })
  assert.deepEqual(down, box)
  assert.deepEqual(up, box)
})

test('coordinates land on whole pixels', () => {
  assert.deepEqual(regionFrom({ x: 10.4, y: 10.6 }, { x: 40.5, y: 30.2 }), {
    x: 10,
    y: 11,
    width: 30,
    height: 20,
  })
})

// The whole point of the slop: a click whose hand moved must still land the
// ordinary element pick, not a box containing nothing.
test('a press that barely moved is not a box', () => {
  assert.equal(isRegion(regionFrom({ x: 0, y: 0 }, { x: 0, y: 0 })), false)
  assert.equal(isRegion(regionFrom({ x: 0, y: 0 }, { x: DRAG_SLOP - 1, y: 3 })), false)
  assert.equal(isRegion(regionFrom({ x: 0, y: 0 }, { x: DRAG_SLOP, y: 0 })), true)
  assert.equal(isRegion(regionFrom({ x: 40, y: 40 }, { x: 40, y: 40 - DRAG_SLOP })), true)
})

test('an element counts only when the box holds all of it', () => {
  assert.equal(containsRect(box, { x: 120, y: 120, width: 40, height: 20 }), true)
  assert.equal(containsRect(box, box), true)
  assert.equal(containsRect(box, { x: 120, y: 120, width: 400, height: 20 }), false)
  assert.equal(containsRect(box, { x: 90, y: 120, width: 40, height: 20 }), false)
})

// Sub-pixel layout puts an element flush with the edge a hair outside the box
// drawn around it, and losing it there would read as the frame doing nothing.
test('an element flush with the edge is inside it', () => {
  assert.equal(containsRect(box, { x: 99.4, y: 100, width: 200, height: 100 }), true)
  assert.equal(containsRect(box, { x: 96, y: 100, width: 200, height: 100 }), false)
})

// What decides whether the walk descends: anything the box merely cuts through
// may still hold something it encloses whole.
test('a box that cuts through an element still reaches into it', () => {
  assert.equal(intersectsRect(box, { x: 0, y: 0, width: 1000, height: 1000 }), true)
  assert.equal(intersectsRect(box, { x: 0, y: 0, width: 100, height: 100 }), false, 'edge to edge')
  assert.equal(intersectsRect(box, { x: 301, y: 100, width: 50, height: 50 }), false)
})

test('the centre is where an empty box resolves its element', () => {
  assert.deepEqual(centerOf(box), { x: 200, y: 150 })
})
