/** The sidebar's resize rule, kept out of the shell so it can be tested. */

export const SIDEBAR_DEFAULT = 344
export const SIDEBAR_MIN = 344
/** The point past which the column is wider than anything it holds ever needs. */
export const SIDEBAR_MAX = 480
/** What the stage keeps for itself. A device wider than this is scaled down to
 *  fit rather than cut off, so this is not a width anything has to fit in - it is
 *  the point below which the preview is too small to review in, and a review
 *  shell whose sidebar has crowded out the app under review is useless. */
export const STAGE_MIN = 480

/** Two ceilings, and the drag stops at whichever is lower - but the floor
 *  outranks both, because a window too narrow for the pair is one where the
 *  sidebar staying usable matters more than the stage keeping its share. */
export function maxSidebarWidth(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewportWidth - STAGE_MIN))
}

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN), maxSidebarWidth(viewportWidth)))
}
