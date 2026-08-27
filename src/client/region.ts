/** The framed-region half of a pick: the same `/element` command, answered with
 *  a drag instead of a click.
 *
 *  Geometry only, so the parts that are easy to get subtly wrong - a drag that
 *  runs right-to-left, a click that wobbled, an element that is *nearly* inside
 *  the box - are testable without a page. */

export interface Point {
  x: number
  y: number
}

/** Page coordinates, like every other rect that crosses the wire. */
export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/** Under this the drag is a click whose hand moved, and the pick it lands has to
 *  be the ordinary element one - not a 3px box containing nothing. */
export const DRAG_SLOP = 8

/** Sub-pixel layout means an element flush with the edge of a box the user drew
 *  around it can measure a hair outside it. Forgiving by a pixel is the
 *  difference between "framed the card" and "framed nothing". */
const EDGE_SLACK = 1

/** Normalised, so a drag that ran up and to the left is the same box as the one
 *  that ran down and to the right. */
export function regionFrom(from: Point, to: Point): Region {
  return {
    x: Math.round(Math.min(from.x, to.x)),
    y: Math.round(Math.min(from.y, to.y)),
    width: Math.round(Math.abs(to.x - from.x)),
    height: Math.round(Math.abs(to.y - from.y)),
  }
}

export function isRegion(region: Region): boolean {
  return region.width >= DRAG_SLOP || region.height >= DRAG_SLOP
}

export function centerOf(region: Region): Point {
  return { x: region.x + region.width / 2, y: region.y + region.height / 2 }
}

/** Fully inside, which is what a marquee means: framing half a card is not
 *  choosing it, and the walk that collects these descends into anything that
 *  merely overlaps. */
export function containsRect(region: Region, rect: Region): boolean {
  return (
    rect.x >= region.x - EDGE_SLACK &&
    rect.y >= region.y - EDGE_SLACK &&
    rect.x + rect.width <= region.x + region.width + EDGE_SLACK &&
    rect.y + rect.height <= region.y + region.height + EDGE_SLACK
  )
}

export function intersectsRect(region: Region, rect: Region): boolean {
  return (
    rect.x < region.x + region.width &&
    rect.x + rect.width > region.x &&
    rect.y < region.y + region.height &&
    rect.y + rect.height > region.y
  )
}
