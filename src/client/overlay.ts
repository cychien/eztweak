/** Annotation overlay injected into the proxied app (guest side). Framework-free. */

import Add01Icon from '@hugeicons/core-free-icons/Add01Icon'
import AlignSelectionIcon from '@hugeicons/core-free-icons/AlignSelectionIcon'
import TextSelectIcon from '@hugeicons/core-free-icons/TextSelectIcon'
import { type AttachController, attachify } from './attach.js'
import { GRACE_MS, draftExpired, draftPendingNames, normalizeDraft } from './draft.js'
import type { AnchorWire, DraftSubject, DraftWire, RefWire } from './draft.js'
import { type IconNode, icon } from './icon.js'
import { modLabel } from './pick.js'
import {
  type Point,
  type Region,
  centerOf,
  containsRect,
  intersectsRect,
  isRegion,
  regionFrom,
} from './region.js'
import { shortAnchor } from '../label.js'

type Mode = 'off' | 'element' | 'point'

/** A pick in flight: the user typed `/element` and has gone off to point at
 *  something. Deliberately *not* a `Mode`. `setMode` dismisses the popup, which
 *  discards its uploads, and it echoes to the shell's toolbar - both wrong here.
 *  A pick also has to be possible with no mode armed at all, because the shell's
 *  note box can start one. So it is a second axis, mirrored onto the document as
 *  `data-ez-pick` beside `data-ez-mode`. */
interface Pick {
  id: string
  host: 'popup' | 'note'
  /** True while a popup of ours is hidden on this pick's behalf. */
  suspended: boolean
  /** The frame the popup's own subject had. Hovering during a pick moves the one
   *  highlight there is, so without this it would be left on whatever the mouse
   *  last crossed. */
  prevHighlight: Element | null
  /** Where the composer this pick answers into is waiting, when that is not the
   *  page we are on. Only the shell knows it after a navigation. */
  returnTo?: string
  /** Stamped once: the expiry a restore checks is measured from the moment the
   *  draft was taken, not from the last time an upload nudged it. */
  draftAt: number
  /** The view being suspended. Reaching the element to point at means scrolling
   *  away from the one the comment is about, so coming back has to put the page
   *  where it was - otherwise the popup returns anchored to something off screen
   *  and gets clamped into a corner, detached from its own subject. */
  scroll: { x: number; y: number }
}

interface AnnotationWire {
  id: string
  kind: 'element' | 'point' | 'text' | 'page'
  comment: string
  anchor: AnchorWire
}

interface SnapshotWire {
  state: 'active' | 'ended'
  annotations: AnnotationWire[]
}

const PREFIX = (() => {
  const script = document.currentScript as HTMLScriptElement | null
  try {
    return new URL(script!.src).pathname.replace(/\/overlay\.js$/, '')
  } catch {
    return '/__eztweak'
  }
})()
const API = `${PREFIX}/api`
const SOURCE_ATTR = 'data-ez-source'

let mode: Mode = 'off'
let ended = false
let viewportPreset: string | undefined
let annotations: AnnotationWire[] = []
let hoverTarget: Element | null = null
let pick: Pick | null = null
/** Last pointer position seen in this document, tracked unconditionally - even
 *  with no mode armed, because a pick from the shell's note box starts that way.
 *  Arming needs it: without it there is no frame until the user happens to move
 *  the mouse, and a pick whose target is already under the cursor would look
 *  like the command did nothing. */
let lastPointer: { x: number; y: number } | null = null
/** Whether the pick modifier is being held right now. The modifier is what turns
 *  a click into a pick, so it is also what turns the page into a picker: without
 *  it held, the page looks and behaves exactly like itself, which is what lets a
 *  plain click still follow a link. */
let modHeld = false
/** The box being dragged, in page coordinates, or null when the user is not
 *  drawing one. Page coordinates because the page can still be scrolled mid
 *  drag, and the box belongs to the document rather than to the viewport. */
let framing: { from: Point; to: Point } | null = null
/** A press that has not declared itself yet. Every press during a pick starts
 *  here and becomes a frame only past the slop - which is what lets a plain
 *  click stay the page's while a plain drag draws a box. */
let pendingFrame: Point | null = null
/** A completed drag ends with a `click`, aimed at whatever the release landed
 *  on. That click is part of the drag, not a pick of its own. */
let swallowClick = false
/** What the open popup is anchored to, as data. A live node cannot survive the
 *  navigation a cross-page pick invites, and a save still has to be precise. */
let popupSubject: DraftSubject | null = null
/** Live subjects of the overlay chrome. Kept so scrolling can repaint them
 *  against the element's *current* position instead of stranding them where
 *  the click happened. Pin and popup anchors are page coordinates. */
let highlightTarget: Element | null = null
let pinPage: { x: number; y: number } | null = null
let popupRect: (() => DOMRect) | null = null

const ui = {
  highlight: el('div', 'ez-highlight'),
  badge: el('div', 'ez-badge'),
  pin: el('div', 'ez-pin'),
  markers: el('div', 'ez-markers'),
  /** Shown only while picking: a wash at the edges of the viewport, and a pill
   *  saying what the modifier does. The page stays clickable underneath, so the
   *  chrome is the only thing telling the user this moment is different. */
  veil: el('div', 'ez-pick-veil'),
  banner: el('div', 'ez-pick-banner'),
  /** The box being dragged, with its size read out in the corner. */
  region: el('div', 'ez-pick-region'),
  regionSize: el('div', 'ez-pick-region-size'),
  popup: null as HTMLElement | null,
  /** Lives beside the popup: its uploads are only ever discarded with it. */
  popupAttach: null as AttachController | null,
  selectionBubble: null as HTMLElement | null,
}

/** True only when a popup is both open and *live*. Every existing "is a popup
 *  open" test meant this; a suspended one is open, on screen it is not, and
 *  treating it as open would swallow the very clicks the pick needs. */
function popupLive(): boolean {
  return Boolean(ui.popup) && !pick?.suspended
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  node.setAttribute('data-ez-ui', '')
  return node
}

function isOwnUi(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-ez-ui]') !== null
}

// ---------------------------------------------------------------- anchors

function fiberOf(node: Element): unknown {
  for (const key of Object.keys(node)) {
    if (key.startsWith('__reactFiber$')) return (node as unknown as Record<string, unknown>)[key]
  }
  return null
}

function componentChain(element: Element): string[] {
  let node: Element | null = element
  let fiber: unknown = null
  while (node && !fiber) {
    fiber = fiberOf(node)
    if (!fiber) node = node.parentElement
  }
  const names: string[] = []
  let current = fiber as { type?: unknown; return?: unknown } | null
  while (current && names.length < 3) {
    const type = current.type as
      | { displayName?: string; name?: string }
      | string
      | null
      | undefined
    if (type && typeof type !== 'string') {
      const name = type.displayName || type.name
      if (name && /^[A-Z]/.test(name) && !names.includes(name)) names.push(name)
    }
    current = current.return as typeof current
  }
  return names
}

function cssPath(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`
  const parts: string[] = []
  let node: Element | null = element
  while (node && node !== document.body && parts.length < 6) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`)
      break
    }
    const section = node.getAttribute('data-section')
    if (section) {
      parts.unshift(`[data-section="${CSS.escape(section)}"]`)
      break
    }
    let part = node.tagName.toLowerCase()
    const parent: Element | null = node.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
    }
    parts.unshift(part)
    node = parent
  }
  return parts.join(' > ')
}

/** `pin` is in page coordinates. */
function buildAnchor(
  element: Element,
  selectedText?: string,
  pin?: { x: number; y: number },
): AnchorWire {
  const rect = element.getBoundingClientRect()
  const sourceHost = element.closest(`[${SOURCE_ATTR}]`)
  const sectionHost = element.closest('[data-section]')
  const text = selectedText ?? (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return {
    source: sourceHost?.getAttribute(SOURCE_ATTR) ?? undefined,
    components: componentChain(element),
    section: sectionHost?.getAttribute('data-section') ?? undefined,
    selector: cssPath(element),
    text: text || undefined,
    point: pin
      ? {
          x: Math.round(pin.x),
          y: Math.round(pin.y),
          rel: {
            x: rect.width ? clamp01((pin.x - rect.left - window.scrollX) / rect.width) : 0,
            y: rect.height ? clamp01((pin.y - rect.top - window.scrollY) / rect.height) : 0,
          },
        }
      : undefined,
    rect: {
      x: Math.round(rect.x + window.scrollX),
      y: Math.round(rect.y + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    viewport: { width: window.innerWidth, height: window.innerHeight, preset: viewportPreset },
    page: location.pathname,
  }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

function describe(element: Element): string {
  const chain = componentChain(element)
  const source = element.closest(`[${SOURCE_ATTR}]`)?.getAttribute(SOURCE_ATTR)
  const tag = element.tagName.toLowerCase()
  const head = chain.length ? `<${chain[0]}>` : tag
  return source ? `${head} · ${source}` : head
}

// ---------------------------------------------------------------- highlight

const BADGE_GAP = 4
/** Width of the frame's outer white ring, which is drawn outside the box. */
const FRAME_RING = 1

/** An element flush against the viewport loses the side of the frame that falls
 *  outside it - the ring first, then the mark itself. Holding the frame a ring's
 *  width inside instead costs a pixel of accuracy on that edge only, and unlike
 *  the pin the frame is a derived outline, not the annotation's coordinate. */
function insetToViewport(rect: DOMRect): {
  top: number
  left: number
  width: number
  height: number
} {
  const top = Math.max(FRAME_RING, rect.top)
  const left = Math.max(FRAME_RING, rect.left)
  const right = Math.min(window.innerWidth - FRAME_RING, rect.right)
  const bottom = Math.min(window.innerHeight - FRAME_RING, rect.bottom)
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/** Point mode keeps resolving an element — the anchor is built from it — but draws
 *  nothing for it: the pin is the subject, and a frame plus a label would only
 *  compete with it. */
function paintHighlight(): void {
  // A pick is always framing an element, even from point mode: what it is about
  // to hand over is the element, not a coordinate.
  if (!highlightTarget || (mode === 'point' && !pick)) {
    ui.highlight.style.display = 'none'
    ui.badge.style.display = 'none'
    return
  }
  const rect = highlightTarget.getBoundingClientRect()
  const frame = insetToViewport(rect)
  Object.assign(ui.highlight.style, {
    display: 'block',
    top: `${frame.top}px`,
    left: `${frame.left}px`,
    width: `${frame.width}px`,
    height: `${frame.height}px`,
  })
  // With a popup open the panel is the subject. The frame keeps repainting - it
  // still says which element the panel belongs to, and a scroll has to keep it
  // there - but the label would only sit behind the panel.
  if (popupLive()) {
    ui.badge.style.display = 'none'
    return
  }
  ui.badge.textContent = describe(highlightTarget)
  // Measured, not assumed: the label wraps to no fixed height and its width
  // depends on the source path, so both edges have to be resolved before it can
  // be placed.
  ui.badge.style.display = 'block'
  placeBadge(rect, ui.badge.offsetWidth, ui.badge.offsetHeight)
}

/** Above the frame by preference, flipped below it when the element sits against
 *  the top of the viewport. Clamping into the frame instead — which is what a
 *  plain `Math.max` does — buries the label in the element it is describing. */
function placeBadge(rect: DOMRect, width: number, height: number): void {
  const above = rect.top - height - BADGE_GAP
  const below = rect.bottom + BADGE_GAP
  const floor = BADGE_GAP
  const ceiling = Math.max(floor, window.innerHeight - height - BADGE_GAP)
  const top =
    above >= floor
      ? above
      : below <= ceiling
        ? below
        : Math.min(Math.max(rect.top + BADGE_GAP, floor), ceiling)
  const right = Math.max(floor, window.innerWidth - width - BADGE_GAP)
  Object.assign(ui.badge.style, {
    top: `${top}px`,
    left: `${Math.min(Math.max(rect.left, floor), right)}px`,
  })
}

function paintPin(): void {
  // Hidden outright while picking, not just left unpainted: the pin belongs to
  // the annotation being composed, and the page underneath is now the subject.
  if (!pinPage || pick) {
    ui.pin.style.display = 'none'
    return
  }
  Object.assign(ui.pin.style, {
    display: 'block',
    top: `${pinPage.y - window.scrollY}px`,
    left: `${pinPage.x - window.scrollX}px`,
  })
}

function paintPopup(): void {
  const popup = ui.popup
  if (!popup || !popupRect) return
  const rect = popupRect()
  const top = Math.min(rect.bottom + 8, window.innerHeight - popup.offsetHeight - 12)
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - popup.offsetWidth - 12)
  Object.assign(popup.style, { top: `${Math.max(8, top)}px`, left: `${left}px` })
}

/** `at` is in page coordinates so it survives scrolling between click and save. */
function movePin(at: { x: number; y: number } | null): void {
  pinPage = at
  paintPin()
}

function moveHighlight(element: Element | null): void {
  highlightTarget = element
  paintHighlight()
}

/** The popup's subject as data, taken when it opens. A live node cannot survive
 *  the navigation a cross-page pick invites, and a save has to stay precise even
 *  when the node it named is gone.
 *
 *  Deliberately a second `buildAnchor` call rather than one shared with the save:
 *  they answer at different moments. This records where the thing was when the
 *  user pointed at it; the save records where it is when they commit. */
function subjectOf(
  kind: DraftSubject['kind'],
  element: Element,
  extra?: { selectedText?: string; pin?: { x: number; y: number } },
): DraftSubject {
  return {
    kind,
    page: location.pathname,
    anchor: buildAnchor(element, extra?.selectedText, extra?.pin),
    ...(extra?.selectedText ? { selectedText: extra.selectedText } : {}),
    ...(extra?.pin ? { pin: extra.pin } : {}),
  }
}

// ---------------------------------------------------------------- popup

/** Removes the popup only. The target highlight and pin stay put — they are what
 *  tells the user which thing they're commenting on. Use `dismiss()` to drop both. */
function closePopup(): void {
  // Only ever reached with the popup being abandoned: a save hands its files to
  // the annotation and clears this first, so nothing here can delete them.
  ui.popupAttach?.discard()
  ui.popupAttach = null
  ui.popup?.remove()
  ui.popup = null
  popupRect = null
  popupSubject = null
}

function dismiss(): void {
  closePopup()
  hoverTarget = null
  moveHighlight(null)
  movePin(null)
}

/** Leaving the mode as well as the popup. Staying armed with nothing open would
 *  let the next ordinary click on the page start another annotation.
 *  `dismiss()` runs first because `setMode` short-circuits when the mode is
 *  already what it is being set to, and would then close nothing. */
function exitToIdle(): void {
  dismiss()
  setMode('off')
}

/** Escape unwinds one layer per press: the popup is a layer above the mode, so a
 *  press with one open only takes that back and leaves the user still armed to
 *  mark the next thing. This lives here, not in the shell, because only the
 *  overlay knows whether a popup is open - the shell forwards the key instead of
 *  deciding, or it would drop the mode whenever focus happened to be in the
 *  sidebar with a popup still up. */
function escape(): void {
  // The slash menu is a layer above the popup, and this runs from the document's
  // capture phase - ahead of the composer's own key handling - so it has to take
  // the press here or the popup would close out from under an open menu.
  if (ui.popupAttach?.closeSlash()) return
  // A pick is a layer above the popup: taking it back hands the composer straight
  // back, still holding everything typed into it. Checked ahead of the mode
  // because a pick from the note box runs with no mode armed.
  if (pick) {
    cancelPick('escape')
    return
  }
  if (mode === 'off') return
  if (ui.popup) dismiss()
  else exitToIdle()
}

/** `anchor` is re-evaluated on every repaint, so the popup tracks its subject
 *  through scrolls and reflows instead of freezing where it opened. */
function openPopup(
  subject: DraftSubject,
  anchor: () => DOMRect,
  onSave: (comment: string, attachments: string[], references: RefWire[]) => Promise<void>,
): void {
  closePopup()
  popupSubject = subject
  const popup = el('div', 'ez-popup')

  const actions = el('div', 'ez-actions')
  const save = el('button', 'ez-btn ez-btn-primary') as HTMLButtonElement
  save.append(icon(Add01Icon as IconNode, 14), document.createTextNode('加入待送清單'))
  const cancel = el('button', 'ez-btn')
  cancel.textContent = '取消'
  actions.append(cancel, save)

  // The button's disabled state cannot carry this: ⌘+Enter never consults it,
  // and an upload settling repaints it from `pending()` mid-request.
  let saving = false

  const attach = attachify({
    api: API,
    mk: el,
    className: 'ez-input',
    placeholder: '想怎麼調整？輸入 / 用指令 (⌘+Enter 儲存)',
    onChange: () => {
      save.disabled = saving || attach.pending() > 0
      // The shell is holding a copy of this box in case the page it sits on goes
      // away. An upload landing is the only thing that can change a suspended
      // one, so this is where that copy is refreshed.
      if (pick?.suspended) postDraft()
    },
    commands: [
      {
        id: 'element',
        label: 'Element',
        hint: `選取頁面元素或範圍`,
        keywords: ['element', 'pick', 'ref', 'reference', '元素', '指定', '參考', '框選'],
        icon: AlignSelectionIcon as IconNode,
        run: () => void armPick('popup', newPickId()),
      },
    ],
  })
  const input = attach.editable
  ui.popupAttach = attach

  const submit = async () => {
    if (saving || attach.pending() > 0) return
    const comment = attach.text()
    const attachments = attach.ids()
    const references = attach.refs()
    // A pasted screenshot, or an element pointed at, can be the whole remark, so
    // text is only required when nothing came with it.
    if (!comment && attachments.length === 0 && references.length === 0) {
      input.focus()
      return
    }
    // Handed off before the request, not after: the annotation names these files
    // the moment it lands, and a dismiss arriving mid-flight would delete them.
    ui.popupAttach = null
    save.disabled = true
    saving = true
    try {
      await onSave(comment, attachments, references)
    } catch {
      // Nothing was recorded, so the composer is taken back whole - text, files
      // and references still in it - rather than the remark being lost in silence.
      if (ui.popup !== popup) return
      ui.popupAttach = attach
      save.disabled = false
      showPopupNotice(['沒有送出成功，請再試一次'])
      return
    } finally {
      saving = false
    }
    // A dismiss during the request already took this popup down, and whatever is
    // open now is not this submit's to close.
    if (ui.popup !== popup) return
    // Stays in the current mode: the next annotation is usually right there.
    dismiss()
  }
  save.onclick = () => void submit()
  cancel.onclick = dismiss
  input.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit()
    // No Escape branch: the document listener captures keydown, so it has already
    // unwound one layer by the time this runs. Handling it here too spent both
    // layers - popup and mode - on a single press.
    e.stopPropagation()
  }

  popup.append(attach.wrap, actions)
  popup.setAttribute('data-ez-subject', subject.kind)
  document.body.appendChild(popup)
  ui.popup = popup
  popupRect = anchor
  paintPopup()
  // The click painted the highlight before this popup existed, so the label is
  // still up; repaint now that `ui.popup` can be seen.
  paintHighlight()
  input.focus()
}

async function saveAnnotation(
  kind: AnnotationWire['kind'],
  element: Element | null,
  comment: string,
  attachments: string[],
  references: RefWire[],
  extra?: {
    selectedText?: string
    pin?: { x: number; y: number }
    /** Used verbatim when the element is gone. Keeping what was recorded beats
     *  both guessing and giving up: `source`, `components` and `text` are still
     *  exactly as precise as they were when the user pointed at the thing. */
    anchor?: AnchorWire
  },
): Promise<void> {
  const anchor =
    extra?.anchor ?? (element ? buildAnchor(element, extra?.selectedText, extra?.pin) : null)
  if (!anchor) throw new Error('no anchor to save against')
  const res = await fetch(`${API}/annotations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, comment, attachments, references, anchor }),
  })
  if (!res.ok) throw new Error(`annotation rejected (${res.status})`)
}

// ---------------------------------------------------------------- restore

/** Only when the anchor recorded a `source` does a selector hit have to prove
 *  itself, and only against that. Never against the text: the agent may have
 *  changed exactly the words the user was commenting on, which is the likeliest
 *  reason the comment exists. */
function corroborates(hit: Element, anchor: AnchorWire): boolean {
  if (!anchor.source) return true
  return hit.closest(`[${SOURCE_ATTR}]`)?.getAttribute(SOURCE_ATTR) === anchor.source
}

function bySource(source: string): Element | null {
  // Walked and compared rather than built into an attribute selector: the value
  // is a file path from a build plugin, not something to interpolate into CSS.
  for (const node of document.querySelectorAll(`[${SOURCE_ATTR}]`)) {
    if (node.getAttribute(SOURCE_ATTR) === source) return node
  }
  return null
}

/** The tightest element that still contains the text - the smallest container is
 *  the most specific one that can be said to hold it. */
function byText(needle: string): Element | null {
  let best: Element | null = null
  let bestLength = Number.POSITIVE_INFINITY
  for (const node of document.body.querySelectorAll('*')) {
    if (isOwnUi(node)) continue
    const text = (node.textContent ?? '').replace(/\s+/g, ' ')
    if (!text.includes(needle) || text.length >= bestLength) continue
    best = node
    bestLength = text.length
  }
  return best
}

/** The live node a recorded subject names, or null when the page has moved on.
 *  `cssPath` is positional, so an edit between leaving and coming back can
 *  invalidate it - which is why the recorded `source` gets a second try. */
function resolveSubject(subject: DraftSubject): Element | null {
  const anchor = subject.anchor
  const hit = resolveSelector(anchor.selector)
  if (hit && corroborates(hit, anchor)) return hit
  if (anchor.source) {
    const found = bySource(anchor.source)
    if (found) return found
  }
  if (subject.selectedText) {
    const found = byText(subject.selectedText)
    if (found) return found
  }
  // A selector hit that failed to corroborate is still a better guess than
  // nothing: the positional path is a fallback layer, not a peer of `source`.
  return hit
}

function staleRect(rect: AnchorWire['rect']): DOMRect {
  if (!rect) {
    return new DOMRect(window.innerWidth / 2 - 6, window.innerHeight / 2 - 6, 12, 12)
  }
  return new DOMRect(rect.x - window.scrollX, rect.y - window.scrollY, rect.width, rect.height)
}

function showPopupNotice(lines: string[]): void {
  if (!ui.popup || lines.length === 0) return
  ui.popup.querySelector('.ez-popup-notice')?.remove()
  const notice = el('div', 'ez-popup-notice')
  notice.textContent = lines.join('　')
  ui.popup.prepend(notice)
  paintPopup()
}

/** How long to keep looking for the subject before calling it gone.
 *
 *  The overlay announces itself at `DOMContentLoaded`, and a client-rendered app
 *  has nothing but an empty root div at that point - so the first look for the
 *  subject usually happens before the page it lives on exists. Waiting a few
 *  frames is the difference between restoring onto the real element and telling
 *  the user their element is gone while they are looking straight at it. */
const SETTLE_MS = 800

/** Resolve as soon as the subject appears, or give up once the page has had long
 *  enough to render. Polled on frames rather than watched: the observer would
 *  have to be torn down on every exit path, and this answers on the first frame
 *  in the case that is not a client-rendered mount. */
function whenSubjectSettles(subject: DraftSubject, done: (target: Element | null) => void): void {
  const deadline = Date.now() + SETTLE_MS
  const attempt = (): void => {
    const target = resolveSubject(subject)
    if (target || Date.now() >= deadline) {
      done(target)
      return
    }
    requestAnimationFrame(attempt)
  }
  attempt()
}

/** Rebuild a popup that did not survive the navigation its own pick invited. */
function restoreDraft(draft: DraftWire): void {
  const subject = draft.subject
  if (!subject) return
  // Past the grace window the sweep has taken the files these chips name, so a
  // restore would only build a composer whose save is certain to be rejected.
  if (draftExpired(draft, Date.now(), GRACE_MS)) {
    post({ type: 'ez:draft-expired', pickId: draft.id })
    return
  }
  whenSubjectSettles(subject, (target) => rebuildPopup(draft, subject, target))
}

function rebuildPopup(draft: DraftWire, subject: DraftSubject, target: Element | null): void {
  restoreView(subject.scroll, target)
  const lines: string[] = []
  if (!target) lines.push('原本的元素已經不在頁面上，這則標註會用當時的位置送出')
  const lost = draftPendingNames(draft.body)
  if (lost.length) lines.push(`上傳中的檔案（${lost.join('、')}）沒有跟著回來，請重新貼一次`)

  moveHighlight(target)
  if (subject.pin) movePin(subject.pin)
  openPopup(
    subject,
    target ? () => target.getBoundingClientRect() : () => staleRect(subject.anchor.rect),
    (comment, files, refs) =>
      saveAnnotation(subject.kind, target, comment, files, refs, {
        selectedText: subject.selectedText,
        pin: subject.pin,
        // Keeps the recorded viewport too: it says what the user was actually
        // looking at when they framed this, which a repaint would overwrite.
        ...(target ? {} : { anchor: subject.anchor }),
      }),
  )
  ui.popupAttach?.restore(draft.body)
  showPopupNotice(lines)
}

// ---------------------------------------------------------------- markers

let markerRaf = 0
const MARKER_SIZE = 20

function resolveSelector(selector: string | undefined): Element | null {
  if (!selector) return null
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}

/** Viewport coordinates for a marker. A point annotation re-derives its spot from
 *  the anchored element's *current* rect via the stored fractional offset, so the
 *  marker follows the layout across viewports; the absolute page coordinate is
 *  only trusted when the element is gone, and only inside the layout it was
 *  recorded in. */
function markerPosition(a: AnnotationWire): { top: number; left: number } | null {
  const target = resolveSelector(a.anchor.selector)
  const rect = target?.getBoundingClientRect()
  const live = rect && (rect.width > 0 || rect.height > 0) ? rect : null
  if (a.kind === 'point' && a.anchor.point) {
    if (live) {
      return {
        top: live.top + a.anchor.point.rel.y * live.height,
        left: live.left + a.anchor.point.rel.x * live.width,
      }
    }
    if (a.anchor.viewport && window.innerWidth !== a.anchor.viewport.width) return null
    return { top: a.anchor.point.y - window.scrollY, left: a.anchor.point.x - window.scrollX }
  }
  return live ? { top: live.top, left: live.left } : null
}

function renderMarkers(): void {
  ui.markers.textContent = ''
  if (pick) return
  const relevant = annotations.filter((a) => a.anchor.page === location.pathname)
  relevant.forEach((a, i) => {
    const at = markerPosition(a)
    if (!at) return
    const marker = el('div', 'ez-marker')
    marker.textContent = String(i + 1)
    marker.title = a.comment
    // Centred on its anchor, so an anchor on a viewport edge would leave half the
    // dot outside. Nudge it whole only while the anchor itself is on screen - an
    // anchor scrolled away takes its marker with it, clamping would pin every
    // off-screen marker to the edges instead.
    const r = MARKER_SIZE / 2
    let top = at.top - r
    let left = at.left - r
    const onScreen =
      at.top >= 0 && at.top <= window.innerHeight && at.left >= 0 && at.left <= window.innerWidth
    if (onScreen) {
      top = Math.min(Math.max(top, 2), window.innerHeight - MARKER_SIZE - 2)
      left = Math.min(Math.max(left, 2), window.innerWidth - MARKER_SIZE - 2)
    }
    Object.assign(marker.style, { top: `${top}px`, left: `${left}px` })
    ui.markers.appendChild(marker)
  })
}

/** Everything anchored to the page repaints together, rAF-throttled, so a scroll
 *  can't strand the highlight, badge, pin or popup where the click happened. */
function scheduleRepaint(): void {
  cancelAnimationFrame(markerRaf)
  markerRaf = requestAnimationFrame(() => {
    renderMarkers()
    paintHighlight()
    paintPin()
    paintRegion()
    paintPopup()
  })
}

// ---------------------------------------------------------------- picking

/** Every modifier a browser reads on a link is already spoken for - new tab,
 *  download, new window - so a pick cannot borrow one to *pass a click through*.
 *  It takes the modifier for itself instead: the plain click stays the page's, and
 *  the modified one never reaches the browser's own handling because we cancel it. */
const MOD_LABEL = modLabel(navigator.userAgent)
const PICKING_LABEL = '選取中…'

let pickSeq = 0
const newPickId = (): string => `p${++pickSeq}-${Date.now().toString(36)}`

function post(message: Record<string, unknown>): void {
  window.parent?.postMessage(message, location.origin)
}

/** The popup goes inert: hidden, blurred, unpainted. Everything it owns - its
 *  controller, its uploads, its anchor closure - stays exactly where it is.
 *
 *  Hidden rather than rebuilt, and hidden while staying *in* the document. A
 *  rebuild would produce new chip nodes, and `attachify`'s upload deletes its own
 *  file when it lands to find its chip detached - so serialising here would throw
 *  away the screenshot the user pasted a second ago. */
function suspendPopup(): boolean {
  if (!ui.popup) return false
  ui.popup.setAttribute('data-ez-hidden', '')
  return true
}

/** Puts the viewport back, then makes sure the subject is actually on screen - the
 *  recorded offset can stop holding it if the page reflowed while the user was
 *  away.
 *
 *  `instant` is not decoration: plenty of pages set `scroll-behavior: smooth`,
 *  and a scroll still animating when the popup is placed puts it somewhere its
 *  subject is not. */
function restoreView(scroll: { x: number; y: number } | undefined, target: Element | null): void {
  if (scroll) window.scrollTo({ left: scroll.x, top: scroll.y, behavior: 'instant' })
  if (!target) return
  const rect = target.getBoundingClientRect()
  if (rect.bottom > 0 && rect.top < window.innerHeight) return
  target.scrollIntoView({ block: 'center', behavior: 'instant' })
}

function resumePopup(view?: Pick): void {
  if (!ui.popup) return
  // Before the paint, so the popup is placed against where its subject now is.
  if (view) restoreView(view.scroll, view.prevHighlight)
  ui.popup.removeAttribute('data-ez-hidden')
  paintPopup()
  paintHighlight()
  // Focus before the caret is placed, or the browser puts it back at the start.
  ui.popupAttach?.editable.focus()
}

function paintPickChrome(): void {
  const on = Boolean(pick)
  ui.veil.style.display = on ? 'block' : 'none'
  ui.banner.style.display = on ? 'flex' : 'none'
  if (!pick) return
  const back = pick.returnTo && pick.returnTo !== location.pathname ? pick.returnTo : null
  ui.banner.textContent = ''
  const text = el('span', 'ez-pick-text')
  text.textContent = back
    ? `${MOD_LABEL} + 點擊元素或直接拖曳框選・完成後回到 ${back}`
    : `${MOD_LABEL} + 點擊元素，或拖曳框選範圍`
  const cancel = el('button', 'ez-pick-cancel')
  cancel.textContent = '取消'
  cancel.onclick = () => cancelPick('escape')
  ui.banner.append(icon(AlignSelectionIcon as IconNode, 14), text, cancel)
}

function currentDraft(): DraftWire | null {
  if (!pick || pick.host !== 'popup' || !ui.popupAttach || !popupSubject) return null
  return {
    id: pick.id,
    host: 'popup',
    createdAt: pick.draftAt,
    // Read now rather than at popup-open: this is the view the user is leaving.
    subject: { ...popupSubject, scroll: { x: window.scrollX, y: window.scrollY } },
    body: normalizeDraft(ui.popupAttach.snapshot()),
  }
}

/** "If I do not survive this navigation, rebuild me from here." Re-sent whenever
 *  the suspended box changes, which is only ever an upload landing. */
function postDraft(): void {
  const draft = currentDraft()
  if (draft) post({ type: 'ez:draft', pickId: draft.id, draft })
}

function armPick(host: 'popup' | 'note', id: string, returnTo?: string): boolean {
  if (ended || pick) return false
  // A popup-host pick does *not* require a popup here. On a re-arm after the app
  // navigated, this document never saw one - the shell is holding it - and the
  // pick still has to run so its answer can be posted back. That case is the
  // whole reason the shell owns the draft, so refusing it would defeat the point.
  const attach = host === 'popup' ? ui.popupAttach : null
  pick = {
    id,
    host,
    suspended: false,
    prevHighlight: highlightTarget,
    returnTo,
    draftAt: Date.now(),
    scroll: { x: window.scrollX, y: window.scrollY },
  }
  // Announced before anything is sent about it. The shell adopts a pick it did
  // not start when it hears this, and until it has, a draft would arrive for a
  // transaction it knows nothing about and be dropped as stale.
  post({ type: 'ez:pick-armed', pickId: id, host })
  if (attach) {
    // While the box is still focused and the caret is still where the slash was.
    attach.beginRef(PICKING_LABEL)
    pick.suspended = suspendPopup()
    postDraft()
  }
  document.documentElement.setAttribute('data-ez-pick', '')
  // Nothing is framed yet: until the modifier goes down the page is still just a
  // page, and drawing on it would promise a pick that a plain click will not make.
  hoverTarget = null
  moveHighlight(null)
  paintPickChrome()
  scheduleRepaint()
  return true
}

/** Frames whatever the cursor is already over. The affordance cannot wait for a
 *  `mousemove` that may never come: pressing the modifier while already hovering
 *  the thing you want is the normal way to use this. */
function frameUnderPointer(): void {
  const at = lastPointer
  const target = at ? document.elementFromPoint(at.x, at.y) : null
  hoverTarget = target && !isOwnUi(target) ? target : null
  moveHighlight(hoverTarget)
}

/** Held or released. Drives both the frame and the cursor, so the two can never
 *  disagree about whether the next click would pick something. */
function setModHeld(next: boolean): void {
  if (modHeld === next) return
  modHeld = next
  if (!pick) return
  document.documentElement.toggleAttribute('data-ez-pick-hot', next)
  if (next) {
    frameUnderPointer()
    return
  }
  hoverTarget = null
  moveHighlight(null)
}

const isModKey = (key: string): boolean => key === 'Meta' || key === 'Control'

/** Clears the state and puts back what picking borrowed. Does not touch the
 *  composer - the callers differ on what should happen to it. */
function endPick(): Pick {
  const done = pick!
  pick = null
  endFraming()
  document.documentElement.removeAttribute('data-ez-pick')
  document.documentElement.removeAttribute('data-ez-pick-hot')
  hoverTarget = null
  moveHighlight(done.prevHighlight)
  paintPickChrome()
  scheduleRepaint()
  return done
}

function refFor(element: Element): RefWire {
  const anchor = buildAnchor(element)
  return { anchor, label: shortAnchor(anchor) || describe(element) }
}

function landPick(e: MouseEvent): void {
  if (!pick) return
  // `e.target`, the way the hover frame resolves it - not `elementFromPoint`,
  // which point mode needs because a pin is a coordinate. What the user gets has
  // to be the element the frame was drawn around; anything else hands over
  // something they were not looking at.
  const target =
    e.target instanceof Element ? e.target : document.elementFromPoint(e.clientX, e.clientY)
  if (!target || isOwnUi(target)) return
  deliverPick(refFor(target))
}

/** Both gestures end here: the answer goes to whichever composer is waiting for
 *  it, and that is decided by the pick, not by how the user pointed. */
function deliverPick(ref: RefWire): void {
  const done = endPick()
  // The live composer is right here, hidden: nothing has to cross a boundary and
  // the shell's copy of the draft is discarded unused.
  if (done.host === 'popup' && done.suspended) {
    resumePopup(done)
    ui.popupAttach?.resolveRef(ref)
    post({ type: 'ez:draft-done', pickId: done.id })
    return
  }
  // The composer is elsewhere - the shell's note box, or a popup stranded on the
  // page this pick started from. The shell owns the answer from here.
  post({ type: 'ez:picked', pickId: done.id, ref, page: location.pathname })
}

// ---------------------------------------------------------------- framing

/** Page coordinates, so a box survives a scroll taken mid drag. */
function pagePoint(e: MouseEvent): Point {
  return { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY }
}

function pageRect(rect: DOMRect): Region {
  return {
    x: rect.x + window.scrollX,
    y: rect.y + window.scrollY,
    width: rect.width,
    height: rect.height,
  }
}

function paintRegion(): void {
  if (!framing) {
    ui.region.style.display = 'none'
    return
  }
  const box = regionFrom(framing.from, framing.to)
  Object.assign(ui.region.style, {
    display: 'block',
    top: `${box.y - window.scrollY}px`,
    left: `${box.x - window.scrollX}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  })
  ui.regionSize.textContent = `${box.width} × ${box.height}`
  // A box dragged to the bottom of the viewport would push the readout off it.
  // Moved inside only then: outside is where it covers nothing.
  const bottom = box.y - window.scrollY + box.height
  ui.regionSize.toggleAttribute('data-ez-inside', bottom > window.innerHeight - 24)
}

function startFraming(at: Point): void {
  framing = { from: at, to: at }
  pendingFrame = null
  document.documentElement.setAttribute('data-ez-framing', '')
  // A plain press is not preventDefault-ed - the sub-slop tail of it must stay a
  // real click for the page - so the browser had a few pixels to start selecting
  // text. The gesture has declared itself now; take that paint back.
  document.getSelection()?.removeAllRanges()
  // The hover frame belongs to the click gesture. Two boxes growing out of one
  // drag would leave the user guessing which one they are about to hand over.
  moveHighlight(null)
  paintRegion()
}

function endFraming(): void {
  pendingFrame = null
  if (!framing) return
  framing = null
  document.documentElement.removeAttribute('data-ez-framing')
  paintRegion()
}

/** How many framed elements are worth naming. Past this the frame is about an
 *  area rather than a set, and the common ancestor and the box already say so -
 *  an inventory of everything inside would be read by nobody. */
const MAX_FRAMED = 16

/** The outermost elements the box encloses whole.
 *
 *  Descends only into what the box cuts through, so the cost is the boundary
 *  rather than the document, and stops at the first element that fits: framing a
 *  card means the card, not the card and every span inside it. */
function elementsIn(box: Region): Element[] {
  const found: Element[] = []
  const walk = (parent: Element): void => {
    for (const child of parent.children) {
      if (found.length >= MAX_FRAMED) return
      if (child.hasAttribute('data-ez-ui')) continue
      const rect = pageRect(child.getBoundingClientRect())
      // A `display: contents` wrapper measures as nothing and lays its children
      // out in its own place: not a candidate itself, but they are.
      if (!rect.width || !rect.height) {
        walk(child)
        continue
      }
      if (containsRect(box, rect)) {
        found.push(child)
        continue
      }
      if (intersectsRect(box, rect)) walk(child)
    }
  }
  walk(document.body)
  return found
}

function commonAncestor(elements: Element[]): Element | null {
  let node: Element | null = elements[0] ?? null
  while (node && !elements.every((e) => node!.contains(e))) node = node.parentElement
  return node
}

function hostAt(page: Point): Element | null {
  const at = document.elementFromPoint(page.x - window.scrollX, page.y - window.scrollY)
  return at && !isOwnUi(at) ? at : null
}

/** What the box covers, rather than everything the ancestor holds. */
function framedText(elements: Element[]): string {
  return elements
    .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ')
    .slice(0, 80)
}

/** One line per framed element. `describe()` alone cannot say *which* one when
 *  the frame holds two instances of the same component - same component name,
 *  same file:line - so each line carries a snippet of the element's own text,
 *  which is the part that differs between instances. */
function framedLabel(element: Element): string {
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
  return text ? `${describe(element)} · "${text}"` : describe(element)
}

/** A box hands over the elements inside it, described through their common
 *  ancestor: that is where the file:line and the component chain come from, and
 *  `contains` is what stops the agent reading the ancestor as the pick. */
function regionRef(box: Region): RefWire {
  const framed = elementsIn(box)
  // One element, or none at all: the box was a coarse way of pointing at
  // something, and an element pick is what that means. Its own rect is the
  // precise one, and `rect` then keeps a single meaning - the box the user drew
  // is only ever what `contains` comes with.
  if (framed.length <= 1) {
    const host = framed[0] ?? hostAt(centerOf(box))
    if (host) return refFor(host)
  }
  const host = commonAncestor(framed) ?? document.body
  const text = framedText(framed)
  const anchor: AnchorWire = {
    ...buildAnchor(host),
    // The box the user drew, not the ancestor's: the ancestor is only how the box
    // gets a file:line, and its own rect is usually far larger than the area.
    rect: box,
    ...(framed.length ? { contains: framed.map(framedLabel), text: text || undefined } : {}),
  }
  return { anchor, label: shortAnchor(anchor) || describe(host) }
}

/** `abort` means the shell asked, so it is not told again. */
function cancelPick(reason: 'escape' | 'mode' | 'ended' | 'abort'): void {
  if (!pick) return
  const done = endPick()
  if (done.host === 'popup') {
    ui.popupAttach?.cancelRef()
    if (done.suspended) resumePopup(done)
  }
  // `resumed` is what tells the shell whether its copy of the draft is stale: a
  // popup handed back here is the real one, and the shell must not try to rebuild
  // it somewhere else.
  if (reason !== 'abort') {
    post({ type: 'ez:pick-cancelled', pickId: done.id, reason, resumed: done.suspended })
  }
}

// ---------------------------------------------------------------- mode

function setMode(next: Mode): void {
  if (ended && next !== 'off') return
  // Before the cancel, not after: the shell replays the current mode on every
  // `ez:ready`, and a set that changes nothing must not disturb a live pick.
  if (mode === next) return
  // Belt. `dismiss()` below discards the popup's uploads, and a suspended popup
  // is one the user is still composing in - it must be handed back first, so what
  // gets dropped is a popup they can see.
  cancelPick('mode')
  mode = next
  const root = document.documentElement
  if (next === 'off') root.removeAttribute('data-ez-mode')
  else root.setAttribute('data-ez-mode', next)
  dismiss()
  ui.selectionBubble?.remove()
  ui.selectionBubble = null
  window.parent?.postMessage({ type: 'ez:mode', mode }, location.origin)
}

// ---------------------------------------------------------------- events

function onMouseMove(e: MouseEvent): void {
  lastPointer = { x: e.clientX, y: e.clientY }
  if (framing) {
    // The button came up somewhere this document never heard about - over the
    // shell's chrome, or outside the window entirely. Nothing landed, so the box
    // goes rather than following the cursor around unpressed.
    if (!(e.buttons & 1)) {
      endFraming()
      return
    }
    framing.to = pagePoint(e)
    paintRegion()
    return
  }
  if (pendingFrame) {
    if (!(e.buttons & 1)) {
      pendingFrame = null
    } else {
      const at = pagePoint(e)
      if (!isRegion(regionFrom(pendingFrame, at))) return
      startFraming(pendingFrame)
      framing!.to = at
      paintRegion()
      return
    }
  }
  // Read off the move, not only off key events: a keyup lost to a focus change
  // would otherwise leave the page stuck looking like a picker.
  if (pick) setModHeld(e.metaKey || e.ctrlKey)
  if (isOwnUi(e.target)) return
  if (pick && !modHeld) return
  if (!pick && (mode === 'off' || ui.popup)) return
  const target = e.target instanceof Element ? e.target : null
  if (target !== hoverTarget) {
    hoverTarget = target
    moveHighlight(target)
  }
}

/** Any left press during a pick may become a box; whether it *is* one is settled
 *  by movement. Under the slop it stays a click - the page's for a plain press,
 *  an element pick for a modified one - so the box costs no click semantics. */
function onMouseDown(e: MouseEvent): void {
  if (!pick || e.button !== 0 || isOwnUi(e.target)) return
  const modified = e.metaKey || e.ctrlKey
  // A plain press in a typing surface stays the page's whole gesture: dragging
  // there selects a value to copy. The modifier still frames anywhere.
  if (!modified && isTyping(e.target)) return
  // A press on the page's own scrollbar. During a pick scrolling is the way to
  // reach the element, and a frame growing out of the scrollbar would take it.
  const doc = document.documentElement
  if (e.clientX >= doc.clientWidth || e.clientY >= doc.clientHeight) return
  // Only the modified press is ours from the very first pixel; a plain one must
  // keep its default so the sub-slop tail still clicks, focuses, selects.
  if (modified) e.preventDefault()
  pendingFrame = pagePoint(e)
}

function onClick(e: MouseEvent): void {
  if (isOwnUi(e.target)) return
  // The tail of a drag, aimed at whatever was under the release. Taken here so
  // it can reach neither the page nor a pick of its own.
  if (swallowClick) {
    swallowClick = false
    e.preventDefault()
    e.stopPropagation()
    return
  }
  // Checked before the mode, because a pick started from the shell's note box
  // runs with no mode armed at all.
  if (pick) {
    // The plain click belongs to the page: reaching the element to point at can
    // mean following a link, opening a menu, filling something in. Only the
    // modified click is ours, and cancelling it here is what keeps the browser
    // from acting on it too.
    if (!e.metaKey && !e.ctrlKey) return
    e.preventDefault()
    e.stopPropagation()
    landPick(e)
    return
  }
  if (mode === 'off') return
  if (ui.popup) return
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed) return // handled by selection bubble

  // In point mode the pin, not the cursor's event target, decides the element:
  // it is the deepest node actually under the dropped pin.
  const target =
    mode === 'point'
      ? document.elementFromPoint(e.clientX, e.clientY)
      : e.target instanceof Element
        ? e.target
        : null
  if (!target || isOwnUi(target)) return
  e.preventDefault()
  e.stopPropagation()

  moveHighlight(target)
  if (mode === 'point') {
    const pin = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY }
    movePin(pin)
    // A pin annotation is about that spot, so the popup hangs off the dot
    // rather than off the (possibly page-wide) element it resolved to.
    const atPin = () =>
      new DOMRect(pin.x - window.scrollX - 6, pin.y - window.scrollY - 6, 12, 12)
    openPopup(subjectOf('point', target, { pin }), atPin, (comment, files, refs) =>
      saveAnnotation('point', target, comment, files, refs, { pin }),
    )
  } else {
    openPopup(
      subjectOf('element', target),
      () => target.getBoundingClientRect(),
      (comment, files, refs) => saveAnnotation('element', target, comment, files, refs),
    )
  }
}

function onMouseUp(e: MouseEvent): void {
  pendingFrame = null
  if (framing) {
    const box = regionFrom(framing.from, pagePoint(e))
    endFraming()
    // A press that never became a drag is a click, and the click event right
    // behind this one is what lands it.
    if (!isRegion(box)) return
    swallowClick = true
    if (pick) deliverPick(regionRef(box))
    return
  }
  // Suppressed for the duration of a pick: a plain drag now selects text in the
  // host page, and offering to annotate it would answer a question nobody asked.
  if (pick || mode === 'off' || ui.popup) return
  setTimeout(() => {
    ui.selectionBubble?.remove()
    ui.selectionBubble = null
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    const text = selection.toString().trim()
    if (!text) return
    const container =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
    if (!container || isOwnUi(container)) return
    const rect = range.getBoundingClientRect()
    const bubble = el('button', 'ez-select-btn')
    bubble.append(icon(TextSelectIcon as IconNode, 14), document.createTextNode('標註選取文字'))
    Object.assign(bubble.style, {
      top: `${Math.max(4, rect.bottom + window.scrollY + 6)}px`,
      left: `${Math.max(4, rect.left + window.scrollX)}px`,
    })
    bubble.onclick = () => {
      bubble.remove()
      ui.selectionBubble = null
      openPopup(
        subjectOf('text', container, { selectedText: text }),
        () => range.getBoundingClientRect(),
        (comment, files, refs) =>
          saveAnnotation('text', container, comment, files, refs, { selectedText: text }),
      )
    }
    document.body.appendChild(bubble)
    ui.selectionBubble = bubble
  }, 0)
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  )
}

/** Only while the popup is open, not for the whole mode: with a mode armed and
 *  nothing chosen yet, scrolling is exactly how the user reaches the thing they
 *  want to mark. Once the popup is up they are composing in a text field, and a
 *  page sliding underneath drags the panel and its subject along with it.
 *
 *  The events are blocked rather than the host's `overflow` or body position
 *  being rewritten: this overlay is a guest in someone else's document, and a
 *  teardown mid-scroll would strand those styles on their page. Our own chrome
 *  is exempt so a long comment can still be scrolled inside the field. */
function onScrollAttempt(e: Event): void {
  // Never during a pick: reaching the element being pointed at is the entire
  // task, and a pick from the note box leaves a live popup on the page.
  if (pick || !popupLive() || isOwnUi(e.target)) return
  e.preventDefault()
}

function onKeyDown(e: KeyboardEvent): void {
  if (isModKey(e.key)) {
    setModHeld(true)
    return
  }
  if (e.key === 'Escape') {
    escape()
    return
  }
  // Everything else belongs to the shell's shortcut table, so it is forwarded
  // rather than duplicated here - one list, working from either document.
  // Screened first: with a popup open its own keys win (Cmd+Enter must save the
  // annotation, not send the batch), and a field on the host page means the user
  // is typing into their own app.
  // A pick swallows everything else. Forwarded, a bare `E` would reach the
  // shell's table, toggle the mode, and take the suspended popup - and its
  // uploads - down with it.
  if (pick || ui.popup || isTyping(e.target)) return
  post({ type: 'ez:key', chord: { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey } })
}

// ---------------------------------------------------------------- boot

function boot(): void {
  ui.region.append(ui.regionSize)
  document.body.append(
    ui.highlight,
    ui.badge,
    ui.pin,
    ui.markers,
    ui.veil,
    ui.region,
    ui.banner,
  )
  moveHighlight(null)
  movePin(null)
  paintPickChrome()

  document.addEventListener('mousedown', onMouseDown, true)
  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('keyup', (e) => {
    if (isModKey(e.key)) setModHeld(false)
  }, true)
  // A window that loses focus mid-hold never delivers the keyup.
  window.addEventListener('blur', () => {
    setModHeld(false)
    // The release will be delivered to whatever took the focus, so this document
    // would never hear the drag end.
    endFraming()
  })
  // `passive: false` is the point - a passive listener may not preventDefault.
  document.addEventListener('wheel', onScrollAttempt, { passive: false, capture: true })
  document.addEventListener('touchmove', onScrollAttempt, { passive: false, capture: true })
  window.addEventListener('scroll', scheduleRepaint, { passive: true, capture: true })
  window.addEventListener('resize', scheduleRepaint, { passive: true })
  new MutationObserver(scheduleRepaint).observe(document.body, {
    childList: true,
    subtree: true,
  })

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== location.origin) return
    const data = e.data as {
      type?: string
      mode?: Mode
      preset?: string
      pickId?: string
      host?: 'popup' | 'note'
      returnTo?: string
      draft?: DraftWire
    }
    if (data?.type === 'ez:set-mode') setMode(data.mode ?? 'off')
    if (data?.type === 'ez:escape') escape()
    if (data?.type === 'ez:viewport') viewportPreset = data.preset
    if (data?.type === 'ez:pick' && data.pickId) {
      armPick(data.host ?? 'note', data.pickId, data.returnTo)
    }
    if (data?.type === 'ez:pick-abort') cancelPick('abort')
    if (data?.type === 'ez:restore' && data.draft) restoreDraft(data.draft)
  })

  const events = new EventSource(`${API}/events`)
  events.onmessage = (e) => {
    const snapshot = JSON.parse(e.data) as SnapshotWire
    annotations = snapshot.annotations
    ended = snapshot.state === 'ended'
    // Explicit, not left to `setMode`: a pick from the note box runs with the mode
    // already off, so the set would change nothing and cancel nothing.
    if (ended) {
      cancelPick('ended')
      setMode('off')
    }
    scheduleRepaint()
  }

  // The page comes with it: the shell only knows the path it was opened on, which
  // goes stale the moment the app navigates, and a pick has to be re-armed and a
  // draft restored against where the iframe actually is.
  post({ type: 'ez:ready', page: location.pathname })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
