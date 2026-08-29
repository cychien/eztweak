/** The devices the review shell previews at, and the rule for fitting one into
 *  the stage.
 *
 *  `width` and `height` are the page area a browser leaves on that device, not
 *  the screen it leaves it on. The point of a preview is that it stops showing
 *  the page where the real thing stops showing it, and the bars a browser puts
 *  above and below the page are most of the difference - a phone loses close to
 *  a quarter of its screen to them. */

export interface Device {
  id: string
  name: string
  width: number
  height: number
  /** Takes the stage's own size when it is the only device on screen: the
   *  user's monitor is the real desktop, so the size below is what the canvas
   *  needs to draw a card, not a box to put the single view in. */
  fluid?: boolean
}

/** Named for the shelf, sized from a machine - a MacBook Pro's 1440x900 screen,
 *  less the menu bar and the tab strip and toolbar above the page. */
export const DESKTOP: Device = {
  id: 'desktop',
  name: '電腦',
  width: 1440,
  height: 788,
  fluid: true,
}

/** Sized from an iPad Pro 10.5 on its side: 1112x834, less the status bar,
 *  Safari's own bars and the home indicator. Landscape because the portrait
 *  width is a hair over a phone's and tells you little a phone has not already;
 *  on its side it clears the desktop breakpoint most layouts switch on. */
export const TABLET: Device = { id: 'tablet', name: '平板', width: 1112, height: 740 }

/** The same tablet stood up: 834x1112, less the same bars. Off the canvas by
 *  default - it sits between the phone and the landscape tablet and usually only
 *  confirms what they already showed - and worth turning on for a layout with
 *  something specific to say in that band. */
export const TABLET_PORTRAIT: Device = {
  id: 'tablet-portrait',
  name: '直立平板',
  width: 834,
  height: 1018,
}

/** Phone widths run from 360 up past 430, so no name could claim more precision
 *  than the shelf's. 375 is the narrow end
 *  of what is still current, and a layout that survives here survives the phones
 *  above it - which is not true the other way round. */
export const MOBILE: Device = { id: 'mobile', name: '手機', width: 375, height: 629 }

/** The order of the picker, and of the number keys that go with it. Only the
 *  sizes a single preview is worth opening at: the portrait tablet is a canvas
 *  comparison rather than a size anyone reviews a page in on its own. */
export const DEVICES: Device[] = [MOBILE, TABLET, DESKTOP]

/** Everything the canvas can show, and the order its picker lists them in.
 *  Narrowest first, the way the canvas itself is stacked. */
export const CANVAS_DEVICES: Device[] = [MOBILE, TABLET_PORTRAIT, TABLET, DESKTOP]

/** What it starts with. The portrait tablet is left off - three sizes is the
 *  comparison most reviews are making, and a fourth is a choice worth making
 *  rather than one to be given. */
export const CANVAS_DEFAULT: string[] = [DESKTOP.id, TABLET.id, MOBILE.id]

/** The widest row the canvas will ever lay out: the widest card it can show,
 *  with the narrowest beside it.
 *
 *  Taken from every size the canvas offers, not from the ones currently on it -
 *  it is what the scale is set by, and a size has to be drawn the same whatever
 *  else is on the canvas beside it. Scaling to whichever row happens to be
 *  widest today would mean turning one size off resized all the others. */
export function canvasLimit(devices: Device[], gap: number): number {
  if (devices.length === 0) return 1
  const widths = devices.map((d) => d.width)
  return Math.max(...widths) + Math.min(...widths) + gap
}

/** The canvas laid out, narrowest first, one entry per row. A row takes another
 *  card only while it stays inside `limit` - which is also what the canvas is
 *  scaled to, so the widest row exactly fills the stage and no row can overflow
 *  it. A pairing saves a whole row of dragging and costs only the width the
 *  limit already allows for. */
export function canvasRows(devices: Device[], gap: number, limit: number): Device[][] {
  if (devices.length === 0) return []
  const order = [...devices].sort((a, b) => a.width - b.width)
  const rows: Device[][] = []
  for (const device of order) {
    const row = rows[rows.length - 1]
    const grown = row ? rowWidth([...row, device], gap) : 0
    if (row && grown <= limit) row.push(device)
    else rows.push([device])
  }
  return rows
}

export function rowWidth(row: Device[], gap: number): number {
  return row.reduce((w, d) => w + d.width, 0) + gap * Math.max(0, row.length - 1)
}

/** Between cards in a row. Lives here because the packing that pairs cards
 *  into rows has to account for it: the gap is drawn at its own size, not the
 *  cards'. */
export const CANVAS_GAP = 14

/** Between rows. Roomier than the card gap because the next row's labels live
 *  inside it, and a label flush against the row above reads as its caption. */
export const CANVAS_ROW_GAP = 26

export function deviceById(id: string): Device {
  return DEVICES.find((d) => d.id === id) ?? DESKTOP
}

export interface Size {
  width: number
  height: number
}

/** Below this the preview is a thumbnail rather than a page, and a stage that
 *  small is a window being dragged, not a size anyone is reviewing at. */
export const MIN_ZOOM = 0.2

/** A single preview is fitted on width alone and handed the stage's whole
 *  height: the device says how wide the page is laid out, the screen says how
 *  much of it you can see at once. Fitting the height too would cut the frame
 *  off at the device's own and leave the rest of the screen empty for no reason
 *  - the canvas is where cards stop where the device stops.
 *
 *  Never scales up: one device on its own is being previewed rather than laid
 *  out against anything, and at true size a pixel is a pixel. Floored to a
 *  hundredth rather than rounded, so it cannot round back into an overflow. */
export function fitWidth(width: number, boxWidth: number): number {
  if (!(boxWidth > 0) || !(width > 0)) return 1
  return scale(boxWidth / width, 1)
}

/** The canvas is drawn at true size, always.
 *
 *  Nothing about it answers to the stage or to what is on it: a 375 card is 375
 *  pixels whether it stands alone or with three others beside it, and a size you
 *  turn off does not resize the ones that are left. What does not fit is dragged
 *  to, which is what a canvas is for - shrinking the page to make a row fit
 *  would be measuring the layout at a size nobody is browsing at. */
export const CANVAS_ZOOM = 1

/** Floored to a hundredth, so a scale that only just fits cannot round back up
 *  into an overflow, and the number stays one a human could read out. */
function scale(raw: number, max: number): number {
  return Math.min(Math.max(Math.floor(raw * 100) / 100, MIN_ZOOM), max)
}

/** `手機 · 375×629`, for a card header or a tooltip. */
export function deviceLabel(device: Device): string {
  return `${device.name} · ${device.width}×${device.height}`
}
