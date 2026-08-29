/** The canvas arranged by hand: rows of device ids the user dragged into
 *  shape, and the rules for hit-testing a drag against them.
 *
 *  A card cannot stop just anywhere. It lands top-aligned in an existing row,
 *  or it becomes a row of its own - free positions would make the canvas a
 *  window manager, and what is being compared here are sizes, not places. */

import {
  CANVAS_DEVICES,
  CANVAS_GAP,
  canvasLimit,
  canvasRows,
  rowWidth,
  type Device,
} from './devices.js'

/** Rows of device ids, top to bottom, left to right. Never holds an empty row,
 *  and never holds an id twice. */
export type Layout = string[][]

/** Where a drag would land: a slot inside a row (drawn as an upright line in
 *  the gap it names), or a whole new row (a flat line across the seam).
 *  Both index the layout as it stands, dragged card still in place. */
export type DropTarget =
  | { kind: 'slot'; row: number; index: number }
  | { kind: 'row'; at: number }

export interface Point {
  x: number
  y: number
}

/** One dimension is always 0 - the line's own axis. The caller gives it
 *  thickness. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface CardPlace {
  id: string
  x: number
  y: number
}

export interface CanvasPlan {
  cards: CardPlace[]
  width: number
  height: number
}

/** The spacing the geometry is drawn with: between cards in a row, between
 *  rows, and the label above every screen. One bundle, because every function
 *  below needs all of it and the numbers only mean anything together. */
export interface CanvasMetrics {
  gap: number
  rowGap: number
  head: number
}

/** What a canvas shows before anyone has dragged it: the packing the automatic
 *  layout always used, narrowest first, paired where the fixed limit allows. */
export function defaultLayout(devices: Device[]): Layout {
  const limit = canvasLimit(CANVAS_DEVICES, CANVAS_GAP)
  return canvasRows(devices, CANVAS_GAP, limit).map((row) => row.map((d) => d.id))
}

/** A stored arrangement, believed only as far as it goes: unknown ids and
 *  repeats are dropped, rows that end up empty with them. Null when nothing
 *  usable is left, so the caller can fall back to the default. */
export function sanitizeLayout(raw: unknown, known: string[]): Layout | null {
  if (!Array.isArray(raw)) return null
  const seen = new Set<string>()
  const rows: Layout = []
  for (const entry of raw) {
    if (!Array.isArray(entry)) continue
    const row: string[] = []
    for (const id of entry) {
      if (typeof id !== 'string' || !known.includes(id) || seen.has(id)) continue
      seen.add(id)
      row.push(id)
    }
    if (row.length) rows.push(row)
  }
  return rows.length ? rows : null
}

/** A size turned on joins as its own row at the bottom rather than being
 *  packed in: the arrangement is the user's, and a toggle must not shuffle it.
 *  The last size on cannot be turned off - an empty canvas is not a view of
 *  anything - and the unchanged reference says the toggle was refused. */
export function toggleDevice(layout: Layout, id: string): Layout {
  const on = layout.some((row) => row.includes(id))
  if (!on) return [...layout, [id]]
  if (layout.reduce((n, row) => n + row.length, 0) === 1) return layout
  return layout.map((row) => row.filter((x) => x !== id)).filter((row) => row.length)
}

interface RowGeometry {
  tops: number[]
  heights: number[]
  width: number
  height: number
}

/** Rows are as tall as their tallest card plus the label above it; cards in a
 *  row share their top edge. */
function rowGeometry(rows: Device[][], m: CanvasMetrics): RowGeometry {
  const heights = rows.map((row) => m.head + Math.max(...row.map((d) => d.height)))
  const tops: number[] = []
  let y = 0
  for (const h of heights) {
    tops.push(y)
    y += h + m.rowGap
  }
  return {
    tops,
    heights,
    width: rows.reduce((w, row) => Math.max(w, rowWidth(row, m.gap)), 0),
    height: rows.length ? y - m.rowGap : 0,
  }
}

/** Where every card sits, and how much canvas the arrangement needs. */
export function planCanvas(rows: Device[][], m: CanvasMetrics): CanvasPlan {
  const geo = rowGeometry(rows, m)
  const cards: CardPlace[] = []
  rows.forEach((row, i) => {
    let x = 0
    for (const d of row) {
      cards.push({ id: d.id, x, y: geo.tops[i]! })
      x += d.width + m.gap
    }
  })
  return { cards, width: geo.width, height: geo.height }
}

/** The seam above row k - the top and bottom edges of the canvas for the
 *  outermost two, the middle of the gap between the rows for the rest. */
function seamY(geo: RowGeometry, rowGap: number, k: number): number {
  if (k === 0) return geo.tops[0] ?? 0
  if (k === geo.tops.length) return geo.height
  return geo.tops[k]! - rowGap / 2
}

interface ColumnHit {
  device: Device
  x: number
}

/** The card a pointer is over, by x alone: the gaps split half-and-half, and
 *  past either end of the row it is the nearest card. */
function columnCard(row: Device[], gap: number, x: number): ColumnHit {
  let cx = 0
  for (let i = 0; i < row.length; i++) {
    const d = row[i]!
    if (i === row.length - 1 || x < cx + d.width + gap / 2) return { device: d, x: cx }
    cx += d.width + gap
  }
  return { device: row[0]!, x: 0 }
}

/** What a pointer at `point` (canvas pixels) is asking for. Within `snap` of a
 *  seam it is a new row there - the gap alone would be a needle to thread with
 *  a card in hand - otherwise it is a slot in the row it is over, split at the
 *  cards' centers. */
export function dropTarget(
  rows: Device[][],
  m: CanvasMetrics,
  point: Point,
  snap: number,
): DropTarget {
  if (rows.length === 0) return { kind: 'row', at: 0 }
  const geo = rowGeometry(rows, m)
  let at = 0
  let nearest = Infinity
  for (let k = 0; k <= rows.length; k++) {
    const dist = Math.abs(point.y - seamY(geo, m.rowGap, k))
    if (dist < nearest) {
      at = k
      nearest = dist
    }
  }
  if (nearest <= snap) return { kind: 'row', at }
  const row = geo.tops.findIndex((top, i) => point.y >= top && point.y <= top + geo.heights[i]!)
  if (row < 0) return { kind: 'row', at: point.y < 0 ? 0 : rows.length }
  // The row band is as tall as its tallest card, but a pointer under a shorter
  // card's own bottom edge is asking for a row below it, not a slot beside it.
  const col = columnCard(rows[row]!, m.gap, point.x)
  if (point.y > geo.tops[row]! + m.head + col.device.height) return { kind: 'row', at: row + 1 }
  let x = 0
  let index = 0
  for (const d of rows[row]!) {
    if (point.x > x + d.width / 2) index++
    x += d.width + m.gap
  }
  return { kind: 'slot', row, index }
}

/** The layout after dropping `id` on `target`. The same reference comes back
 *  when the drop would change nothing - a card put back beside itself - which
 *  is also how the caller knows not to draw a hint for it. */
export function applyMove(layout: Layout, id: string, target: DropTarget): Layout {
  const fromRow = layout.findIndex((row) => row.includes(id))
  if (fromRow < 0) return layout
  const fromIndex = layout[fromRow]!.indexOf(id)
  const next = layout.map((row) => row.filter((x) => x !== id))
  if (target.kind === 'slot') {
    const row = next[target.row]
    if (!row) return layout
    // The target counts slots with the card still in place, the splice happens
    // with it gone: everything past its old slot in its own row is one left.
    const index = target.row === fromRow && target.index > fromIndex ? target.index - 1 : target.index
    row.splice(Math.min(index, row.length), 0, id)
  } else {
    next.splice(Math.min(target.at, next.length), 0, [id])
  }
  const moved = next.filter((row) => row.length)
  return sameLayout(moved, layout) ? layout : moved
}

function sameLayout(a: Layout, b: Layout): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => row.length === b[i]!.length && row.every((id, j) => id === b[i]![j]))
  )
}

/** The line that marks `target`: upright in the gap a slot names, spanning its
 *  row - flat under the card the pointer is over, spanning that card.
 *
 *  Flat lines anchor to the pointed-at card rather than to the row's own seam:
 *  in a row of mixed heights the seam sits below the tallest card, and a line
 *  there reads as belonging to that card instead of the frame being pointed
 *  at. */
export function indicatorRect(
  rows: Device[][],
  m: CanvasMetrics,
  target: DropTarget,
  point: Point,
): Rect {
  const geo = rowGeometry(rows, m)
  if (rows.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  if (target.kind === 'row') {
    if (target.at === 0) {
      const col = columnCard(rows[0]!, m.gap, point.x)
      return { x: col.x, y: 0, width: col.device.width, height: 0 }
    }
    const i = Math.min(target.at, rows.length) - 1
    const col = columnCard(rows[i]!, m.gap, point.x)
    return {
      x: col.x,
      y: geo.tops[i]! + m.head + col.device.height + m.rowGap / 2,
      width: col.device.width,
      height: 0,
    }
  }
  let x = 0
  for (const d of rows[target.row]!.slice(0, target.index)) x += d.width + m.gap
  return {
    x: x - m.gap / 2,
    y: geo.tops[target.row]!,
    width: 0,
    height: geo.heights[target.row]!,
  }
}
