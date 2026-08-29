/** Where a frame is scrolled to, as something another frame can act on.
 *
 *  The same page at three widths is three different heights, so an absolute
 *  offset would put the three previews in three different places. A fraction of
 *  what there is to scroll keeps them on the same part of the page - as close as
 *  anything can, when the content itself reflows between them. */

/** How long a frame stays quiet after being told where to scroll.
 *
 *  Not a comparison of positions: applying a ratio in a frame of a different
 *  height lands on a rounded pixel, so the ratio that comes back out is never
 *  quite the one that went in - and a frame that mistakes its own echo for a
 *  scroll of its own answers it, which is how three previews end up shoving each
 *  other to the top of the page. A window covers any rounding. It costs the user
 *  nothing: their scroll still moves the frame they are on, it just does not lead
 *  the others until whoever was leading has stopped. */
export const QUIET_MS = 250

export function scrollRange(scrollHeight: number, innerHeight: number): number {
  return Math.max(0, scrollHeight - innerHeight)
}

/** Null when there is nothing to scroll: a page shorter than its frame has no
 *  position to share, and would otherwise divide by zero to say so. */
export function scrollRatio(scrollY: number, range: number): number | null {
  if (range <= 0) return null
  return Math.min(1, Math.max(0, scrollY / range))
}

/** Whether this frame is still settling into a scroll it was asked to make, and
 *  so has nothing of its own to report. */
export function following(now: number, appliedAt: number | null): boolean {
  return appliedAt !== null && now - appliedAt < QUIET_MS
}
