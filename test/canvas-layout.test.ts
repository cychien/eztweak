import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyMove,
  defaultLayout,
  dropTarget,
  indicatorRect,
  planCanvas,
  sanitizeLayout,
  toggleDevice,
} from '../src/client/canvas-layout.js'
import type { Layout } from '../src/client/canvas-layout.js'
import { CANVAS_DEVICES, DESKTOP, MOBILE, TABLET } from '../src/client/devices.js'

const M = { gap: 14, rowGap: 26, head: 19 }
const SNAP = 30

/** The default arrangement: hand-helds sharing the top row, desktop below.
 *  mobile 375×629 at (0,0), tablet 1112×740 at (389,0), desktop 1440×788 on
 *  the second row - geometry the tests below lean on. */
const rows = () => [[MOBILE, TABLET], [DESKTOP]]
const layout = (): Layout => [['mobile', 'tablet'], ['desktop']]

test('an untouched canvas starts on the automatic packing', () => {
  assert.deepEqual(defaultLayout([MOBILE, TABLET, DESKTOP]), [['mobile', 'tablet'], ['desktop']])
})

// ------------------------------------------------------------------ storage

const KNOWN = CANVAS_DEVICES.map((d) => d.id)

test('a stored arrangement is believed as far as it goes', () => {
  assert.deepEqual(sanitizeLayout([['desktop'], ['mobile', 'tablet']], KNOWN), [
    ['desktop'],
    ['mobile', 'tablet'],
  ])
})

test('unknown ids and repeats are dropped, empty rows with them', () => {
  assert.deepEqual(sanitizeLayout([['mobile', 'gameboy'], ['mobile'], ['tablet']], KNOWN), [
    ['mobile'],
    ['tablet'],
  ])
})

test('an arrangement with nothing usable left falls back rather than emptying', () => {
  assert.equal(sanitizeLayout([['gameboy']], KNOWN), null)
  assert.equal(sanitizeLayout('rows', KNOWN), null)
  assert.equal(sanitizeLayout(null, KNOWN), null)
})

// ------------------------------------------------------------------ toggling

test('a size turned on joins as its own row at the bottom', () => {
  assert.deepEqual(toggleDevice(layout(), 'tablet-portrait'), [
    ['mobile', 'tablet'],
    ['desktop'],
    ['tablet-portrait'],
  ])
})

test('a size turned off leaves the rest where they were', () => {
  assert.deepEqual(toggleDevice(layout(), 'tablet'), [['mobile'], ['desktop']])
  assert.deepEqual(toggleDevice(layout(), 'desktop'), [['mobile', 'tablet']])
})

test('the last size on cannot be turned off', () => {
  const solo: Layout = [['mobile']]
  assert.equal(toggleDevice(solo, 'mobile'), solo)
})

// ------------------------------------------------------------------ geometry

test('cards share their row top and rows stack with the row gap between', () => {
  const plan = planCanvas(rows(), M)
  assert.deepEqual(plan.cards, [
    { id: 'mobile', x: 0, y: 0 },
    { id: 'tablet', x: 389, y: 0 },
    { id: 'desktop', x: 0, y: 785 },
  ])
})

test('the canvas is as wide as its widest row and as tall as the stack', () => {
  const plan = planCanvas(rows(), M)
  assert.equal(plan.width, 1501)
  assert.equal(plan.height, 785 + M.head + DESKTOP.height)
})

test('an empty arrangement needs no canvas', () => {
  assert.deepEqual(planCanvas([], M), { cards: [], width: 0, height: 0 })
})

// ------------------------------------------------------------------ hit-testing

const hit = (x: number, y: number) => dropTarget(rows(), M, { x, y }, SNAP)

test('inside a row the drop is a slot, split at the cards centers', () => {
  assert.deepEqual(hit(100, 300), { kind: 'slot', row: 0, index: 0 })
  assert.deepEqual(hit(500, 300), { kind: 'slot', row: 0, index: 1 })
  assert.deepEqual(hit(1400, 300), { kind: 'slot', row: 0, index: 2 })
})

// The row band is as tall as the tablet, but the phone beside it ends at 648:
// under its bottom edge the pointer is asking for a row below, not a slot.
test('below a shorter cards own bottom the drop is a new row', () => {
  assert.deepEqual(hit(100, 700), { kind: 'row', at: 1 })
  assert.deepEqual(hit(500, 700), { kind: 'slot', row: 0, index: 1 })
})

test('the seam between rows is a new row, and it is wider than the gap it sits in', () => {
  // The seam center is 772; the snap band reaches into the rows beside it.
  assert.deepEqual(hit(100, 772), { kind: 'row', at: 1 })
  assert.deepEqual(hit(100, 772 - SNAP), { kind: 'row', at: 1 })
  assert.deepEqual(hit(100, 772 + SNAP), { kind: 'row', at: 1 })
})

test('the canvas edges are seams too, above everything and below it', () => {
  assert.deepEqual(hit(100, 4), { kind: 'row', at: 0 })
  assert.deepEqual(hit(100, -80), { kind: 'row', at: 0 })
  assert.deepEqual(hit(100, 1592 - 4), { kind: 'row', at: 2 })
  assert.deepEqual(hit(100, 2000), { kind: 'row', at: 2 })
})

// ------------------------------------------------------------------ the move

test('a card dropped on a slot lands in it', () => {
  assert.deepEqual(applyMove(layout(), 'mobile', { kind: 'slot', row: 0, index: 2 }), [
    ['tablet', 'mobile'],
    ['desktop'],
  ])
  assert.deepEqual(applyMove(layout(), 'mobile', { kind: 'slot', row: 1, index: 0 }), [
    ['tablet'],
    ['mobile', 'desktop'],
  ])
})

test('slots count the dragged card where it still stands', () => {
  const wide: Layout = [['mobile', 'tablet', 'desktop']]
  assert.deepEqual(applyMove(wide, 'mobile', { kind: 'slot', row: 0, index: 3 }), [
    ['tablet', 'desktop', 'mobile'],
  ])
})

test('a card dropped on a seam becomes a row of its own', () => {
  assert.deepEqual(applyMove(layout(), 'mobile', { kind: 'row', at: 1 }), [
    ['tablet'],
    ['mobile'],
    ['desktop'],
  ])
  assert.deepEqual(applyMove(layout(), 'desktop', { kind: 'row', at: 0 }), [
    ['desktop'],
    ['mobile', 'tablet'],
  ])
})

test('a drop that changes nothing returns the layout it was handed', () => {
  const arranged = layout()
  // Back beside itself, either side.
  assert.equal(applyMove(arranged, 'mobile', { kind: 'slot', row: 0, index: 0 }), arranged)
  assert.equal(applyMove(arranged, 'mobile', { kind: 'slot', row: 0, index: 1 }), arranged)
  // A card alone in a row, dropped on its own seams.
  assert.equal(applyMove(arranged, 'desktop', { kind: 'row', at: 1 }), arranged)
  assert.equal(applyMove(arranged, 'desktop', { kind: 'row', at: 2 }), arranged)
})

// ------------------------------------------------------------------ the hint

test('a slot is an upright line in the gap it names, spanning its row', () => {
  assert.deepEqual(indicatorRect(rows(), M, { kind: 'slot', row: 0, index: 1 }, { x: 385, y: 300 }), {
    x: 382,
    y: 0,
    width: 0,
    height: M.head + TABLET.height,
  })
  assert.deepEqual(indicatorRect(rows(), M, { kind: 'slot', row: 0, index: 0 }, { x: 5, y: 300 }), {
    x: -7,
    y: 0,
    width: 0,
    height: M.head + TABLET.height,
  })
})

// Anchored under the card the pointer is over, not the row's own seam: in a
// row of mixed heights the seam sits below the tallest card, and a line there
// reads as that card's rather than the pointed-at frame's.
test('a seam is a flat line under the frame the pointer is over', () => {
  assert.deepEqual(indicatorRect(rows(), M, { kind: 'row', at: 1 }, { x: 100, y: 700 }), {
    x: 0,
    y: M.head + MOBILE.height + M.rowGap / 2,
    width: MOBILE.width,
    height: 0,
  })
  assert.deepEqual(indicatorRect(rows(), M, { kind: 'row', at: 1 }, { x: 500, y: 772 }), {
    x: 389,
    y: M.head + TABLET.height + M.rowGap / 2,
    width: TABLET.width,
    height: 0,
  })
  assert.deepEqual(indicatorRect(rows(), M, { kind: 'row', at: 0 }, { x: 100, y: 0 }).y, 0)
  assert.deepEqual(indicatorRect(rows(), M, { kind: 'row', at: 2 }, { x: 100, y: 1650 }), {
    x: 0,
    y: 785 + M.head + DESKTOP.height + M.rowGap / 2,
    width: DESKTOP.width,
    height: 0,
  })
})
