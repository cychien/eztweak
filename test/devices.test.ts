import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Device } from '../src/client/devices.js'
import {
  CANVAS_DEFAULT,
  CANVAS_DEVICES,
  CANVAS_GAP,
  CANVAS_ZOOM,
  DESKTOP,
  DEVICES,
  MIN_ZOOM,
  MOBILE,
  TABLET,
  canvasLimit,
  canvasRows,
  deviceById,
  deviceLabel,
  fitWidth,
  rowWidth,
} from '../src/client/devices.js'

test('a device the stage has room for is shown at true size', () => {
  assert.equal(fitWidth(375, 900), 1)
})

// Only the width. A single preview is handed the stage's height, so a device
// taller than the screen is no reason to shrink the page it is showing.
test('a single preview is fitted on width alone', () => {
  assert.equal(fitWidth(1440, 720), 0.5)
  assert.equal(fitWidth(1440, 2000), 1, 'and never scales up')
})

test('the scale is floored, so it never rounds back into an overflow', () => {
  const zoom = fitWidth(1000, 619)
  assert.equal(zoom, 0.61)
  assert.ok(1000 * zoom <= 619)
})

test('a stage with no room yet does not collapse the preview', () => {
  assert.equal(fitWidth(375, 0), 1)
  assert.equal(fitWidth(375, 10), MIN_ZOOM)
})

test('an unknown device id falls back to the first one rather than throwing', () => {
  assert.equal(deviceById('mobile').width, 375)
  // The desktop, which is what a shell opens on - not the first row of a list
  // that is ordered narrowest first for the eye, not for a default.
  assert.equal(deviceById('nope'), DESKTOP)
})

test('the label carries both the name and the size it stands for', () => {
  assert.equal(deviceLabel(deviceById('mobile')), '手機 · 375×629')
})

const ids = (rows: Device[][]) => rows.map((row) => row.map((d) => d.id))
const shown = (list: string[]) => CANVAS_DEVICES.filter((d) => list.includes(d.id))
const LIMIT = canvasLimit(CANVAS_DEVICES, CANVAS_GAP)
const defaultRows = () => canvasRows(shown(CANVAS_DEFAULT), CANVAS_GAP, LIMIT)

// Narrowest first, and a pairing that saves a whole row of dragging costs only
// width the limit already allows for.
test('the canvas pairs what fits and gives the rest their own row', () => {
  assert.deepEqual(ids(defaultRows()), [['mobile', 'tablet'], ['desktop']])
})

test('every size that is on is laid out, and nothing else is', () => {
  const rows = canvasRows(shown(['mobile', 'desktop']), CANVAS_GAP, LIMIT)
  assert.deepEqual(
    rows.flat().map((d) => d.id),
    ['mobile', 'desktop'],
  )
})

// The limit is what the arrangement answers to, and it is taken from every size
// the canvas offers - so turning one off cannot rearrange or resize the rest.
test('no row runs past the limit, whichever sizes are on', () => {
  for (const on of [CANVAS_DEVICES, shown(CANVAS_DEFAULT), shown(['tablet'])]) {
    const rows = canvasRows(on, CANVAS_GAP, LIMIT)
    for (const row of rows) {
      assert.ok(rowWidth(row, CANVAS_GAP) <= LIMIT, `${row.map((d) => d.id)} is too wide`)
    }
    assert.equal(rows.flat().length, on.length, 'and none is dropped')
  }
})

// Turning a size off must not resize the ones that are left, and nothing is
// shrunk to make a row fit either: a page measured at a size nobody browses at
// is not a measurement.
test('the canvas is drawn at true size, whatever is on it', () => {
  assert.equal(CANVAS_ZOOM, 1)
})

test('an empty canvas has no rows rather than a row of nothing', () => {
  assert.deepEqual(canvasRows([], CANVAS_GAP, LIMIT), [])
})

test('the picker lists the sizes narrowest first', () => {
  assert.deepEqual(
    CANVAS_DEVICES.map((d) => d.id),
    ['mobile', 'tablet-portrait', 'tablet', 'desktop'],
  )
  assert.deepEqual(
    DEVICES.map((d) => d.id),
    ['mobile', 'tablet', 'desktop'],
  )
})

// A preview earns its keep by folding where the real thing folds, so every
// preset is the page area a browser leaves - visibly less than any screen that
// width belongs to.
test('every device is the page area, not the screen it sits on', () => {
  assert.equal(MOBILE.height, 629)
  assert.equal(TABLET.height, 740)
  assert.equal(deviceById('desktop').height, 788)
})
