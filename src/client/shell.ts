/** Review shell (host page): iframe of the proxied app + feedback sidebar. */

import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import AlignSelectionIcon from '@hugeicons/core-free-icons/AlignSelectionIcon'
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import Grid02Icon from '@hugeicons/core-free-icons/Grid02Icon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import CursorMagicSelection02Icon from '@hugeicons/core-free-icons/CursorMagicSelection02Icon'
import File02Icon from '@hugeicons/core-free-icons/File02Icon'
import KeyboardIcon from '@hugeicons/core-free-icons/KeyboardIcon'
import Select01Icon from '@hugeicons/core-free-icons/Select01Icon'
import Navigation03Icon from '@hugeicons/core-free-icons/Navigation03Icon'
import { attachify } from './attach.js'
import type { Device, Size } from './devices.js'
import {
  CANVAS_GAP,
  CANVAS_ROW_GAP,
  CANVAS_DEFAULT,
  CANVAS_DEVICES,
  DESKTOP,
  DEVICES,
  CANVAS_ZOOM,
  deviceById,
  deviceLabel,
  fitWidth,
} from './devices.js'
import {
  applyMove,
  defaultLayout,
  dropTarget,
  indicatorRect,
  planCanvas,
  sanitizeLayout,
  toggleDevice,
} from './canvas-layout.js'
import type { CanvasMetrics, Layout } from './canvas-layout.js'
import type { DraftWire, RefWire } from './draft.js'
import { fileMarker, refChipText, refMarker, splitComment } from './draft.js'
import { modLabel, reducePick } from './pick.js'
import type { PickEffect, PickEvent, PickState } from './pick.js'
import { type IconNode, icon } from './icon.js'
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  clampSidebarWidth,
  maxSidebarWidth,
} from './sidebar-width.js'

type Mode = 'off' | 'element' | 'region'

interface AnnotationWire {
  id: string
  kind: string
  comment: string
  anchor: {
    source?: string
    components?: string[]
    section?: string
    text?: string
    page?: string
    viewport?: { width?: number; preset?: string }
  }
  attachments?: { name: string }[]
  references?: RefEcho[]
}

/** A bare string is what logs written before references carried a number hold.
 *  It has no marker to sit in, so it is appended rather than inlined. */
type RefEcho = string | { n: number; label: string }

interface ConversationWire {
  role: 'user' | 'agent' | 'system'
  text: string
  ts: number
  batchId?: string
  items?: {
    comment: string
    where: string
    attachments?: string[]
    references?: RefEcho[]
  }[]
  attachments?: string[]
  references?: RefEcho[]
}

interface SnapshotWire {
  state: 'active' | 'ended'
  endedBy?: 'user' | 'agent'
  targetOrigin: string
  annotations: AnnotationWire[]
  conversation: ConversationWire[]
  agentOnline: boolean
  agentBusy: boolean
  agentProgress?: string
}

const PREFIX = (() => {
  const script = document.currentScript as HTMLScriptElement | null
  try {
    return new URL(script!.src).pathname.replace(/\/shell\.js$/, '')
  } catch {
    return '/__eztweak'
  }
})()
const API = `${PREFIX}/api`
/** Hoisted above the composer: the command's hint is built while this module is
 *  still initialising, so it cannot live down with the rest of the pick code. */
const MOD_LABEL = modLabel(navigator.userAgent)
const PAGE_PATH = new URLSearchParams(location.search).get('path') || '/'


const ANNOTATE_MODES: {
  id: Exclude<Mode, 'off'>
  label: string
  hint: string
  key: string
  svg: IconNode
}[] = [
  {
    id: 'element',
    label: '元素',
    hint: '點一下元素或反白文字來留言',
    key: 'E',
    svg: CursorMagicSelection02Icon as IconNode,
  },
  {
    id: 'region',
    label: '範圍',
    hint: '拖曳框出一塊範圍來留言，框到的元素都會帶給 agent',
    key: 'R',
    svg: Select01Icon as IconNode,
  },
]

/** Batches the user expanded past the collapse limit. Kept outside `render()`
 *  because every SSE snapshot rebuilds the thread's DOM from scratch. */
const expandedBatches = new Set<string>()
/** Collapse only when it actually saves more than one row. */
const ITEM_LIMIT = 3

let snapshot: SnapshotWire | null = null
let annotateMode: Mode = 'off'
let deviceId = DESKTOP.id
/** Every device on one canvas instead of one at a time. */
let multi = false
/** Which sizes the canvas shows and where each one sits: rows of device ids,
 *  top to bottom. Dragged into shape by the user, so it is state of its own
 *  rather than something the sizes imply. */
let layout: Layout = defaultLayout(CANVAS_DEVICES.filter((d) => CANVAS_DEFAULT.includes(d.id)))

/** Never empty - the canvas has to be a canvas of something - and in the
 *  table's own order for the picker; where they sit on the canvas is `layout`'s
 *  to say. */
function shownDevices(): Device[] {
  const on = CANVAS_DEVICES.filter((d) => layout.some((row) => row.includes(d.id)))
  return on.length ? on : [CANVAS_DEVICES[0]!]
}

/** Unlike `deviceById`, drawn from everything the canvas can show - the
 *  portrait tablet is not in the single-view table. */
const canvasDevice = (id: string): Device =>
  CANVAS_DEVICES.find((d) => d.id === id) ?? DESKTOP

const canvasLayout = (): Device[][] => layout.map((row) => row.map(canvasDevice))

const VIEW_KEY = 'eztweak:view'

/** The arrangement the shell was left in. A preference only - a stored device
 *  that no longer exists falls back the way any unknown id does. */
function loadView(): void {
  try {
    const stored = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') as {
      device?: unknown
      multi?: unknown
      shown?: unknown
      layout?: unknown
    } | null
    if (typeof stored?.device === 'string') deviceId = deviceById(stored.device).id
    multi = Boolean(stored?.multi)
    const arranged = sanitizeLayout(
      stored?.layout,
      CANVAS_DEVICES.map((d) => d.id),
    )
    if (arranged) layout = arranged
    // Sessions from before the canvas could be arranged stored only which
    // sizes were on; they start on the default packing of those sizes.
    else if (Array.isArray(stored?.shown)) {
      const kept = CANVAS_DEVICES.filter((d) => (stored.shown as unknown[]).includes(d.id))
      if (kept.length) layout = defaultLayout(kept)
    }
  } catch {}
}

function saveView(): void {
  try {
    localStorage.setItem(
      VIEW_KEY,
      JSON.stringify({ device: deviceId, multi, layout }),
    )
  } catch {}
}

loadView()

const root = document.getElementById('ez-shell')!

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// ---------------------------------------------------------------- static layout

const brand = h('div', 'ez-brand', 'Review')
const target = h('span', 'ez-target')
const agentStatus = h('div', 'ez-badge')

// ---------------------------------------------------------------- shortcuts

/** Matched against real key events and against ones the overlay forwards from
 *  inside the page, so only the fields both can supply. */
interface KeyChord {
  key: string
  metaKey: boolean
  ctrlKey: boolean
}

interface Shortcut {
  /** As printed in the panel and in the control's own tooltip. */
  keys: string
  label: string
  match: (e: KeyChord) => boolean
  run: () => void
  /** Whether it still fires while focus is in a text field. Only the two that
   *  act on what is being typed are. */
  whileTyping?: boolean
}

/** Modifier-free letters and digits, because the browser has claimed most of the
 *  useful combinations - Chrome's Cmd+1..9 switch tabs, and Cmd+T/W/R/L/N are
 *  gone. That means guarding against typing rather than leaning on a modifier. */
const plain = (key: string) => (e: KeyChord) =>
  !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === key.toLowerCase()
const cmd = (key: string) => (e: KeyChord) => (e.metaKey || e.ctrlKey) && e.key === key

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  )
}

/** The one place shortcuts are declared: the key handler, the hover panel and
 *  every tooltip are all generated from this, so the panel cannot come to
 *  disagree with what the keys actually do. */
const SHORTCUTS: Shortcut[] = [
  ...ANNOTATE_MODES.map((m) => ({
    keys: m.key,
    label: m.label,
    match: plain(m.key),
    run: () => sendMode(annotateMode === m.id ? 'off' : m.id),
  })),
  ...DEVICES.map((d, i) => ({
    keys: String(i + 1),
    label: deviceLabel(d),
    match: plain(String(i + 1)),
    run: () => setDevice(d.id),
  })),
  {
    keys: '4',
    label: '所有尺寸排成一張畫布',
    match: plain('4'),
    run: () => setMulti(!multi),
  },
  {
    keys: 'N',
    label: '寫補充說明',
    match: plain('n'),
    run: () => note.focus(),
  },
  {
    keys: '⌘ ↵',
    label: '送出給 agent',
    match: cmd('Enter'),
    run: () => void sendBatch(),
    whileTyping: true,
  },
  {
    keys: 'Esc',
    label: '關掉輸入框，再一次離開標註模式',
    match: plain('Escape'),
    /** Blurring first is what makes the rest of the table reachable again: every
     *  modifier-free key is withheld while a field has focus, so without this the
     *  keyboard has no way back out of the composer. */
    run: () => {
      if (keysPinned) {
        pinKeys(false)
        return
      }
      // Above the typing check: a pick started from the note box leaves focus in
      // it, so without this Escape would only blur and the pick would stay out.
      if (abortPick('escape')) return
      const active = document.activeElement
      if (isTyping(active)) {
        if (active instanceof HTMLElement) active.blur()
        return
      }
      escapeAnnotating()
    },
    whileTyping: true,
  },
]

function runShortcut(e: KeyChord, typing: boolean): boolean {
  for (const s of SHORTCUTS) {
    if (typing && !s.whileTyping) continue
    if (!s.match(e)) continue
    s.run()
    return true
  }
  return false
}

const keysBtn = h('button', 'ez-keys')
keysBtn.append(icon(KeyboardIcon as IconNode, 14))
keysBtn.title = '快捷鍵'
keysBtn.setAttribute('aria-label', '快捷鍵')
keysBtn.setAttribute('aria-expanded', 'false')

/** Hover is enough to peek; a click pins the card so it can be read without
 *  holding the pointer still, and it then stays until Escape or a click
 *  elsewhere - the same contract as any other menu. */
let keysPinned = false
let keysHover = false
let keysCloseTimer = 0

/** Closing on a delay rather than on a bare `:hover`: the card is anchored to the
 *  header row, so there is a gap between it and the button, and crossing that gap
 *  leaves the wrapper. A grace period covers the gap and also a fast diagonal,
 *  which a fixed bridge element between the two would miss. */
const KEYS_CLOSE_MS = 140

function paintKeys(): void {
  const open = keysPinned || keysHover
  keysWrap.toggleAttribute('data-open', open)
  keysBtn.setAttribute('aria-expanded', String(open))
}

function pinKeys(next: boolean): void {
  keysPinned = next
  paintKeys()
}

keysBtn.onclick = () => pinKeys(!keysPinned)

const keysPanel = h('div', 'ez-keys-panel')
for (const s of SHORTCUTS) {
  const row = h('div', 'ez-keys-row')
  row.append(h('kbd', 'ez-kbd', s.keys), h('span', 'ez-keys-label', s.label))
  keysPanel.appendChild(row)
}

const keysWrap = h('div', 'ez-keys-wrap')
keysWrap.append(keysBtn, keysPanel)

keysWrap.addEventListener('pointerenter', () => {
  window.clearTimeout(keysCloseTimer)
  keysHover = true
  paintKeys()
})

keysWrap.addEventListener('pointerleave', () => {
  window.clearTimeout(keysCloseTimer)
  keysCloseTimer = window.setTimeout(() => {
    keysHover = false
    paintKeys()
  }, KEYS_CLOSE_MS)
})

/** The button's own click is inside the wrap, so pinning it open never trips this
 *  on the way back up the tree. */
document.addEventListener('click', (e) => {
  if (keysPinned && e.target instanceof Node && !keysWrap.contains(e.target)) pinKeys(false)
})

const headRow = h('div', 'ez-head-row')
headRow.append(brand, h('div', 'ez-spacer'), keysWrap, agentStatus)

/** A menu rather than three buttons in a row: one size is on at a time, and the
 *  other two only matter at the moment of switching. It leaves the header a
 *  control and a toggle - which size, and whether to see them all at once. */
/** The name is the segment; the chevron beside it opens the menu. Split, because
 *  they answer different questions - one says "show a single size", the other
 *  "which one" - and a menu that opens on the whole segment leaves no way to say
 *  the first without being asked the second. */
const deviceName = h('button', 'ez-seg-label')
deviceName.onclick = () => setDevice(deviceId)

const deviceCaret = h('button', 'ez-seg-caret')
deviceCaret.append(icon(ArrowDown01Icon as IconNode, 11))
deviceCaret.setAttribute('aria-haspopup', 'menu')
deviceCaret.setAttribute('aria-expanded', 'false')

/** Built here rather than as a native `select`: a select's menu is the platform's
 *  - its own type, its own metrics, its own highlight - and this one has to sit
 *  in a 12px header beside a segmented control and be read as part of it. */
const deviceMenu = h('div', 'ez-menu')
deviceMenu.setAttribute('role', 'menu')
deviceMenu.setAttribute('aria-label', '預覽尺寸')

const deviceItems = DEVICES.map((d, i) => {
  const item = h('button', 'ez-menu-item')
  item.setAttribute('role', 'menuitemradio')
  item.dataset.device = d.id
  // The size belongs on the card that is showing it, not in the list of names:
  // here it is a number nobody is choosing by.
  // No tick column here, unlike the canvas picker: this is a list of three where
  // one is on, and the menu opens with that one already under the cursor - a
  // column of blanks to say so would only push the names off the edge.
  item.title = deviceLabel(d)
  item.append(h('span', 'ez-menu-name', d.name), h('kbd', 'ez-kbd', String(i + 1)))
  item.onclick = () => {
    closeDeviceMenu()
    setDevice(d.id)
  }
  deviceMenu.appendChild(item)
  return item
})

const deviceGroup = h('div', 'ez-seg-item ez-seg-device')
deviceGroup.append(deviceName, deviceCaret, deviceMenu)

let deviceMenuOpen = false

function paintDeviceMenu(): void {
  deviceGroup.toggleAttribute('data-open', deviceMenuOpen)
  deviceCaret.setAttribute('aria-expanded', String(deviceMenuOpen))
}

function closeDeviceMenu(): void {
  if (!deviceMenuOpen) return
  deviceMenuOpen = false
  paintDeviceMenu()
}

function openDeviceMenu(): void {
  if (deviceMenuOpen) return
  deviceMenuOpen = true
  paintDeviceMenu()
  // The one already on, so the arrow keys start from where the user is rather
  // than from the top of a list they did not choose.
  deviceItems.find((i) => i.dataset.device === deviceId)?.focus()
}

// Opening the menu decides nothing - looking at the sizes on offer is not
// choosing one. Picking a row is, and `setDevice` leaves the canvas whichever
// row it is, so the size already named still gets you back.
deviceCaret.onclick = () => {
  if (deviceMenuOpen) closeDeviceMenu()
  else openDeviceMenu()
}

/** Arrows walk the list, Escape puts it away and hands focus back to the button
 *  that opened it. Held on the menu, so it only applies while one is open. */
deviceMenu.addEventListener('keydown', (e) => {
  const at = deviceItems.indexOf(document.activeElement as HTMLButtonElement)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const step = e.key === 'ArrowDown' ? 1 : -1
    deviceItems[(at + step + deviceItems.length) % deviceItems.length]?.focus()
    e.preventDefault()
    return
  }
  if (e.key === 'Escape') {
    closeDeviceMenu()
    deviceCaret.focus()
    e.preventDefault()
  }
})

/** A click anywhere else, and a move of focus out of the group - a menu that
 *  outlives either is one the user has already left. */
document.addEventListener('click', (e) => {
  if (e.target instanceof Node && !deviceGroup.contains(e.target)) closeDeviceMenu()
})

deviceGroup.addEventListener('focusout', (e) => {
  const to = e.relatedTarget
  if (to instanceof Node && deviceGroup.contains(to)) return
  closeDeviceMenu()
})

const multiBtn = h('button', 'ez-seg-item ez-seg-multi', '全部尺寸')
multiBtn.title = '所有尺寸排成一張畫布，拖曳背景移動（4）'
multiBtn.onclick = () => setMulti(!multi)

/** One control, two ways to be: at a size, or at all of them. A group rather
 *  than a menu with a button beside it, because those are the two states of one
 *  question - and which of them is on has to be readable without going looking
 *  for a pressed button. */
const deviceRow = h('div', 'ez-seg')
deviceRow.append(deviceGroup, multiBtn)

function paintControls(): void {
  const device = deviceById(deviceId)
  deviceName.textContent = device.name
  deviceName.title = `${deviceLabel(device)}（1 / 2 / 3）`
  deviceCaret.title = '換一個尺寸'
  for (const item of deviceItems) {
    item.setAttribute('aria-checked', String(!multi && item.dataset.device === deviceId))
    item.classList.toggle('ez-on', !multi && item.dataset.device === deviceId)
  }
  deviceGroup.classList.toggle('ez-on', !multi)
  multiBtn.classList.toggle('ez-on', multi)
  multiBtn.setAttribute('aria-pressed', String(multi))
  paintShown()
}

const annotateGroup = h('div', 'ez-annotate-group')
const annotateBtns = ANNOTATE_MODES.map((m) => {
  const btn = h('button', `ez-tool-btn ez-mode-${m.id}`)
  btn.append(icon(m.svg, 15), h('span', undefined, m.label))
  btn.title = `${m.hint}（${m.key}）・Esc 離開`
  btn.onclick = () => sendMode(annotateMode === m.id ? 'off' : m.id)
  annotateGroup.appendChild(btn)
  return { id: m.id, btn }
})

const sideHead = h('div', 'ez-side-head')
sideHead.append(headRow, target, deviceRow, annotateGroup)

const banner = h('div', 'ez-banner')
banner.style.display = 'none'

/** The stage and what floats over it. The picker cannot live inside the stage:
 *  that scrolls, and a control that scrolls away with the canvas is one you have
 *  to drag back to before you can use it. */
const stageWrap = h('div', 'ez-stage-wrap')
const stage = h('div', 'ez-stage')
/** What the frames sit on, and what the stage scrolls. Its own element rather
 *  than the stage itself: it is sized to its contents and centred, so a canvas
 *  wider than the stage overflows in the one direction the stage can scroll to
 *  reach, instead of being centred half-way out of view. */
const canvas = h('div', 'ez-canvas')
stage.appendChild(canvas)

/** Which sizes the canvas shows. Its own control, in the corner of the thing it
 *  changes rather than up in the header: what is on the canvas is a property of
 *  the canvas, and the header is already carrying the one question of whether to
 *  be on it at all. */
const shownBtn = h('button', 'ez-shown-btn')
shownBtn.append(icon(Grid02Icon as IconNode, 14))
shownBtn.title = '選擇畫布上要顯示的尺寸'
shownBtn.setAttribute('aria-label', '選擇畫布上要顯示的尺寸')
shownBtn.setAttribute('aria-haspopup', 'menu')
shownBtn.setAttribute('aria-expanded', 'false')

const shownMenu = h('div', 'ez-menu ez-menu-right')
shownMenu.setAttribute('role', 'menu')
shownMenu.setAttribute('aria-label', '畫布上的尺寸')

const shownItems = CANVAS_DEVICES.map((d) => {
  const item = h('button', 'ez-menu-item')
  item.setAttribute('role', 'menuitemcheckbox')
  item.dataset.device = d.id
  item.title = deviceLabel(d)
  const tick = h('span', 'ez-menu-tick')
  tick.append(icon(Tick02Icon as IconNode, 14))
  item.append(tick, h('span', 'ez-menu-name', d.name))
  item.onclick = () => toggleShown(d.id)
  shownMenu.appendChild(item)
  return item
})

const shownWrap = h('div', 'ez-shown')
shownWrap.append(shownBtn, shownMenu)
stageWrap.append(stage, shownWrap)

let shownMenuOpen = false

function paintShown(): void {
  shownWrap.toggleAttribute('data-open', shownMenuOpen)
  shownWrap.toggleAttribute('data-hidden', !multi)
  shownBtn.setAttribute('aria-expanded', String(shownMenuOpen))
  const on = shownDevices()
  for (const item of shownItems) {
    const checked = on.some((d) => d.id === item.dataset.device)
    item.setAttribute('aria-checked', String(checked))
    item.classList.toggle('ez-on', checked)
    // The last one on cannot be turned off: an empty canvas is not a view of
    // anything, and the way back from one is not obvious.
    item.toggleAttribute('disabled', checked && on.length === 1)
  }
}

/** Adds or removes just the one frame rather than rebuilding the stage: the
 *  other previews are live pages, and remounting an iframe reloads it. */
function toggleShown(id: string): void {
  const next = toggleDevice(layout, id)
  if (next === layout) return
  layout = next
  saveView()
  paintShown()
  if (!multi) return
  const mounted = frames.get(id)
  if (mounted) {
    // A pick could be armed in the frame about to go; adding one cannot strand
    // anything, so only removal calls it off.
    abortPick('mode')
    mounted.card.remove()
    frames.delete(id)
    if (popupFrame === id) setPopupFrame(null)
  } else {
    const device = canvasDevice(id)
    // Assembled off the document and dressed before it joins: an absolutely
    // positioned card with no left/top yet sits at the canvas origin, and a
    // paint slipping in there would flash a blank frame over the first card.
    const holder = document.createDocumentFragment()
    const frame = mountFrame(id, device, holder, deviceLabel(device))
    const placed = planCanvas(canvasLayout(), canvasMetrics()).cards.find((c) => c.id === id)
    if (placed) {
      frame.card.style.left = `${placed.x}px`
      frame.card.style.top = `${placed.y}px`
    }
    paintFrame(frame, device, device.height, CANVAS_ZOOM, false)
    canvas.appendChild(holder)
  }
  settleFrames()
}

shownBtn.onclick = () => {
  shownMenuOpen = !shownMenuOpen
  paintShown()
}

document.addEventListener('click', (e) => {
  if (e.target instanceof Node && !shownWrap.contains(e.target) && shownMenuOpen) {
    shownMenuOpen = false
    paintShown()
  }
})

shownWrap.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !shownMenuOpen) return
  shownMenuOpen = false
  paintShown()
  shownBtn.focus()
  e.preventDefault()
})

/** One mounted preview of the app. Single mode holds one of these; showing
 *  several sizes at once holds one per device. Everything the shell says to a
 *  preview goes through the registry, so neither arrangement gets a code path
 *  of its own. */
interface Frame {
  id: string
  /** Label and screen together - what the canvas lays out as one item. */
  card: HTMLElement
  /** Laid out at the scaled size, so the stage lays frames out in the space
   *  they actually occupy. Everything the scale would blur - the card's shadow,
   *  its rounded corners - belongs on this one, not on the wrap it scales. */
  box: HTMLElement
  /** Sized at the device's true pixels and scaled as a whole, which is what
   *  keeps a scaled 390 still 390 to a media query inside. */
  wrap: HTMLElement
  iframe: HTMLIFrameElement
  device: Device
  zoom: number
  /** Last page this frame reported being on, so the sync can tell which frames
   *  have somewhere to go and which are already there. */
  page: string
}

const SINGLE = 'single'
const frames = new Map<string, Frame>()

/** The frame with an annotation popup open, if any. One annotation is composed
 *  at a time across the whole canvas: while it is open every other frame is
 *  held - no highlight, no selection bubble, no second popup. */
let popupFrame: string | null = null

function setPopupFrame(next: string | null): void {
  popupFrame = next
  for (const f of frames.values()) {
    if (f.id !== next) toFrame(f.id, { type: 'ez:hold', held: next !== null })
  }
}

/** Where the previews actually are. The path the shell was opened on goes stale
 *  the moment the app navigates, and a frame mounted after that has to start
 *  where the others already are. */
let currentPage = PAGE_PATH

function mountFrame(id: string, device: Device, into: ParentNode, label: string): Frame {
  const card = h('div', 'ez-card')
  const head = h('div', 'ez-card-head', label)
  head.title = '拖曳調整排列'
  const box = h('div', 'ez-screen')
  const wrap = h('div', 'ez-frame-wrap')
  const iframe = h('iframe', 'ez-frame')
  iframe.src = currentPage
  iframe.title = label
  wrap.appendChild(iframe)
  box.appendChild(wrap)
  card.append(head, box)
  into.appendChild(card)
  // Zoom starts at 0 rather than 1 so the first paint always announces itself
  // to the overlay, whatever it settles on.
  const frame: Frame = { id, card, box, wrap, iframe, device, zoom: 0, page: currentPage }
  frames.set(id, frame)
  head.addEventListener('pointerdown', (e) => beginCardDrag(e, frame))
  return frame
}

/** The frame a message came from, or null for anything else that posted at us -
 *  an iframe of the app's own, most of the time. */
function frameIdOf(source: MessageEventSource | null): string | null {
  if (!source) return null
  for (const f of frames.values()) if (f.iframe.contentWindow === source) return f.id
  return null
}

function toFrame(id: string, message: Record<string, unknown>): void {
  frames.get(id)?.iframe.contentWindow?.postMessage(message, location.origin)
}

function broadcast(message: Record<string, unknown>): void {
  for (const f of frames.values()) f.iframe.contentWindow?.postMessage(message, location.origin)
}

/** `replace`, not `iframe.src`: assigning src pushes an entry onto the joint
 *  session history and poisons the browser's own back button. */
function navigateFrame(frame: Frame, page: string): void {
  frame.page = page
  frame.iframe.contentWindow?.location.replace(page)
}

/** Every preview shows the same page. Annotations are filtered by path, so
 *  frames left on different pages would be three separate reviews wearing one
 *  set of controls. Recording the destination before asking for it is what
 *  stops the answering `ez:ready` from bouncing the navigation back. */
function syncPages(from: string): void {
  const page = frames.get(from)?.page
  if (!page || page === currentPage) return
  currentPage = page
  for (const f of frames.values()) {
    if (f.id === from || f.page === page) continue
    navigateFrame(f, page)
  }
}

/** What the stage has to give a frame, inside its own padding. */
function stageBox(): Size {
  const cs = getComputedStyle(stage)
  return {
    width: stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    height: stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
  }
}

/** `fluid` is the single desktop view, which has no device box to draw: the
 *  user's own monitor is the desktop, so the frame simply takes the stage. */
function paintFrame(
  frame: Frame,
  device: Device,
  height: number,
  zoom: number,
  fluid: boolean,
): void {
  const { card, box, wrap } = frame
  card.style.width = fluid ? '100%' : ''
  card.style.height = fluid ? '100%' : ''
  box.style.width = fluid ? '100%' : `${Math.round(device.width * zoom)}px`
  box.style.height = fluid ? '100%' : `${Math.round(height * zoom)}px`
  wrap.style.width = fluid ? '100%' : `${device.width}px`
  wrap.style.height = fluid ? '100%' : `${height}px`
  wrap.style.transform = fluid || zoom === 1 ? '' : `scale(${zoom})`
  const applied = fluid ? 1 : zoom
  // Only on a real change: this runs on every pointer move of a sidebar drag,
  // and the overlay counter-scales its own chrome off the back of it.
  if (frame.device.id !== device.id || frame.zoom !== applied) {
    frame.device = device
    frame.zoom = applied
    toFrame(frame.id, { type: 'ez:viewport', preset: device.id, zoom: applied, scoped: multi })
  }
}

function paintFrames(): void {
  if (multi) {
    const plan = planCanvas(canvasLayout(), canvasMetrics())
    canvas.style.width = `${plan.width}px`
    canvas.style.height = `${plan.height}px`
    for (const placed of plan.cards) {
      const frame = frames.get(placed.id)
      if (!frame) continue
      frame.card.style.left = `${placed.x}px`
      frame.card.style.top = `${placed.y}px`
      const d = canvasDevice(placed.id)
      paintFrame(frame, d, d.height, CANVAS_ZOOM, false)
    }
    return
  }
  const frame = frames.get(SINGLE)
  if (!frame) return
  const device = deviceById(deviceId)
  const fluid = Boolean(device.fluid)
  // The single desktop view has no card to centre - it is the stage - so the
  // canvas gets out of the way and hands the whole box to the frame.
  canvas.style.width = fluid ? '100%' : ''
  canvas.style.height = fluid ? '100%' : ''
  const box = stageBox()
  const zoom = fluid ? 1 : fitWidth(device.width, box.width)
  // The stage's height, in the frame's own pixels: one size on its own gets the
  // whole screen to show the page in, and only the width is the device's.
  paintFrame(frame, device, zoom > 0 ? box.height / zoom : device.height, zoom, fluid)
}

/** A repaint the cards glide through instead of jumping to.
 *
 *  Measured in screen coordinates, not the canvas's own: the repaint can shrink
 *  the canvas, and a stage scrolled near its end then clamps, shifting every
 *  card on screen at once. Transitioning left/top would start the glide from
 *  where the card used to be in the canvas, not where the user last saw it -
 *  so each card is measured before and after, pinned back on its old screen
 *  position with a transform, and released. The timer restarts with each call
 *  so an early one cannot cut a later glide short. */
let settleTimer = 0
function settleFrames(): void {
  clearTimeout(settleTimer)
  canvas.removeAttribute('data-settle')
  const before = new Map<string, DOMRect>()
  for (const f of frames.values()) before.set(f.id, f.card.getBoundingClientRect())
  for (const f of frames.values()) f.card.style.transform = ''
  paintFrames()
  const moved: Frame[] = []
  for (const f of frames.values()) {
    const was = before.get(f.id)
    if (!was) continue
    const now = f.card.getBoundingClientRect()
    const dx = was.x - now.x
    const dy = was.y - now.y
    if (!dx && !dy) continue
    f.card.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
    moved.push(f)
  }
  if (!moved.length) return
  // The reflow between pinning and releasing, so the glide has a start to run
  // from rather than both writes collapsing into one.
  void canvas.offsetWidth
  canvas.setAttribute('data-settle', '')
  for (const f of moved) f.card.style.transform = ''
  settleTimer = window.setTimeout(() => canvas.removeAttribute('data-settle'), 240)
}

/** `ez-framed` is device chrome on show - a card with an edge, and room around
 *  it for that edge to be seen. The single desktop view has neither: there is no
 *  boundary to draw when the frame is the whole stage. */
function paintStageClasses(): void {
  stage.classList.toggle('ez-multi', multi)
  stage.classList.toggle('ez-framed', multi || !deviceById(deviceId).fluid)
}

/** Switching between one device and all of them replaces the frames, so a pick
 *  still out is called off first: the overlay holding it is about to go. */
function rebuildStage(): void {
  abortPick('mode')
  popupFrame = null
  canvas.replaceChildren()
  frames.clear()
  if (multi) {
    for (const row of canvasLayout()) {
      for (const d of row) mountFrame(d.id, d, canvas, deviceLabel(d))
    }
  } else {
    const device = deviceById(deviceId)
    mountFrame(SINGLE, device, canvas, deviceLabel(device))
  }
  paintFrames()
}

paintControls()
paintStageClasses()
rebuildStage()

const sidebar = h('aside', 'ez-sidebar')
const queueSection = h('section', 'ez-section ez-queue-section')
const queueList = h('ul', 'ez-queue')
const queueScroll = h('div', 'ez-fade ez-queue-scroll')
queueScroll.appendChild(queueList)
const sendBtn = h('button', 'ez-send')
const sendLabel = h('span', undefined, '送出給 agent')
sendBtn.title = '送出給 agent（⌘/Ctrl + Enter）'
sendBtn.append(icon(Navigation03Icon as IconNode, 15), sendLabel)
sendBtn.onclick = () => void sendBatch()
/** Built once, outside `render()`: every snapshot rebuilds the queue and the
 *  thread from scratch, and what the user is part-way through typing - chips
 *  included - must not go with them. */
const noteAttach = attachify({
  api: API,
  mk: h,
  className: 'ez-note',
  placeholder: '整體想法或補充說明，輸入 / 用指令（選填）',
  onChange: () => paintSendState(),
  commands: [
    {
      id: 'element',
      label: 'Element',
      hint: `${MOD_LABEL} 點一下元素，或拖曳框選範圍`,
      keywords: ['element', 'pick', 'ref', 'reference', '元素', '指定', '參考', '框選'],
      icon: AlignSelectionIcon as IconNode,
      // The pointer is in the other document, so this can only ask. The answer
      // comes back as a message and lands here via the pick reducer.
      run: () => startPick('note'),
    },
  ],
})
const note = noteAttach.editable
note.title = '寫補充說明（N）'
queueSection.append(queueScroll, noteAttach.wrap, sendBtn)

const convSection = h('section', 'ez-section ez-conv-section')
const convList = h('div', 'ez-conv')
const convScroll = h('div', 'ez-fade ez-conv-scroll')
convScroll.appendChild(convList)
convSection.append(convScroll)

const resizer = h('div', 'ez-resizer')
resizer.tabIndex = 0
resizer.setAttribute('role', 'separator')
resizer.setAttribute('aria-orientation', 'vertical')
resizer.setAttribute('aria-valuemin', String(SIDEBAR_MIN))
resizer.setAttribute('aria-label', '調整側邊欄寬度')
resizer.title = '拖曳調整寬度，雙擊還原'

sidebar.append(resizer, sideHead, banner, convSection, queueSection)
root.append(stageWrap, sidebar)

// ---------------------------------------------------------------- panning

/** Dragged by its background, because the frames are the app under review: a
 *  press inside one is the page's own and never reaches this document at all.
 *  What is left - the backdrop, the gaps, the card labels - is the canvas, and
 *  dragging any of it moves the view.
 *
 *  Scroll position rather than a transform of its own: the wheel, the trackpad
 *  and the scrollbars then all move the same thing, and nothing can be dragged
 *  somewhere it cannot be dragged back from. */
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  const panX = stage.scrollWidth - stage.clientWidth
  const panY = stage.scrollHeight - stage.clientHeight
  if (panX <= 0 && panY <= 0) return
  const startX = e.clientX
  const startY = e.clientY
  const startLeft = stage.scrollLeft
  const startTop = stage.scrollTop
  // Capture, so the drag survives the pointer crossing a frame - which is most
  // of the canvas, and which would otherwise swallow every move.
  stage.setPointerCapture(e.pointerId)
  document.body.classList.add('ez-panning')
  const move = (ev: PointerEvent) => {
    stage.scrollLeft = startLeft - (ev.clientX - startX)
    stage.scrollTop = startTop - (ev.clientY - startY)
  }
  stage.addEventListener('pointermove', move)
  stage.addEventListener(
    'lostpointercapture',
    () => {
      stage.removeEventListener('pointermove', move)
      document.body.classList.remove('ez-panning')
    },
    { once: true },
  )
})

// ---------------------------------------------------------------- arranging

/** The label's share of a card - what the row geometry has to add above every
 *  screen. Measured off a mounted card, because it is the label's line height
 *  plus the card's own gap and neither belongs in two places; before anything
 *  is on screen the number only has to be close, and the first real paint
 *  corrects it. */
function cardHead(): number {
  for (const f of frames.values()) {
    const head = f.box.offsetTop
    if (head > 0) return head
  }
  return 19
}

function canvasMetrics(): CanvasMetrics {
  return { gap: CANVAS_GAP, rowGap: CANVAS_ROW_GAP, head: cardHead() }
}

/** Where a dragged card would land: an upright bar in the gap between two
 *  cards, a flat one across the seam between two rows. Appended for the drag
 *  and taken out after, so `rebuildStage` never has to know about it. */
const dropHint = h('div', 'ez-drop-hint')

/** A press is a drag only once it has moved this far, so a slipped click on a
 *  label does not twitch the card. */
const DRAG_SLOP = 4
/** How close to a seam still counts as "a new row here" rather than a slot in
 *  the row beside it. Wider than the gap itself, which would be a needle to
 *  thread with a card in hand. */
const ROW_SNAP = 30
/** The stage scrolls itself while a drag leans on its edge: the canvas is
 *  routinely taller than the window, and the far rows have to be reachable
 *  without putting the card down to scroll. The speed ramps with how far into
 *  the band the pointer is, so the scroll eases in instead of lurching. */
const PAN_EDGE = 44
const PAN_SPEED = 18

/** Cards are dragged by their labels - a press inside the screen belongs to
 *  the page - and land in the slots the canvas offers: top-aligned in a row,
 *  or as a row of their own. The card is moved with a transform and the drop
 *  only rewrites `layout`, so the iframe is never re-mounted and the page
 *  inside keeps whatever it was doing. */
function beginCardDrag(e: PointerEvent, frame: Frame): void {
  if (!multi || e.button !== 0) return
  e.preventDefault()
  // The stage would otherwise read the same press as the start of a pan.
  e.stopPropagation()
  const handle = e.currentTarget as HTMLElement
  handle.setPointerCapture(e.pointerId)
  const startX = e.clientX
  const startY = e.clientY
  let clientX = startX
  let clientY = startY
  // Where inside the card it was picked up, so it can be glued back under the
  // pointer whatever the stage scrolls to underneath.
  const grabbed = frame.card.getBoundingClientRect()
  const grabX = startX - grabbed.left
  const grabY = startY - grabbed.top
  let dragging = false
  let cancelled = false
  let landing: Layout | null = null
  let raf = 0

  // Everything the per-frame work needs, read once at lift: nothing here can
  // change under a drag, and reading it back out of the DOM sixty times a
  // second buys nothing but reflows. The canvas's client position is the one
  // thing that does move - by exactly what the stage scrolls - so it is
  // carried forward from the scroll offsets instead of remeasured.
  const rows = canvasLayout()
  const metrics = canvasMetrics()
  let homeX = 0
  let homeY = 0
  let originX = 0
  let originY = 0
  let scrollX = 0
  let scrollY = 0
  let stageEdge: DOMRect
  // The hint only rewrites its styles when the target actually changes;
  // repainting the same line every frame is churn the compositor notices.
  let drawn = ''

  const follow = () => {
    const x = clientX - (originX - (stage.scrollLeft - scrollX))
    const y = clientY - (originY - (stage.scrollTop - scrollY))
    // translate3d, so the card gets a compositor layer of its own and the
    // iframe inside is not repainted on every move.
    frame.card.style.transform = `translate3d(${x - grabX - homeX}px, ${y - grabY - homeY}px, 0)`
    const target = dropTarget(rows, metrics, { x, y }, ROW_SNAP)
    const next = applyMove(layout, frame.id, target)
    if (next === layout) {
      // A drop that changes nothing gets no hint: the line is a promise.
      landing = null
      drawn = ''
      dropHint.removeAttribute('data-on')
      return
    }
    landing = next
    const line = indicatorRect(rows, metrics, target, { x, y })
    // A flat line follows the pointer between columns, so the key is the line
    // itself rather than the target.
    const key = `${line.x}:${line.y}:${line.width}:${line.height}`
    if (key === drawn) return
    drawn = key
    dropHint.setAttribute('data-on', '')
    dropHint.toggleAttribute('data-flat', line.height === 0)
    dropHint.style.left = `${line.x}px`
    dropHint.style.top = `${line.y}px`
    dropHint.style.width = line.width ? `${line.width}px` : ''
    dropHint.style.height = line.height ? `${line.height}px` : ''
  }

  /** Full speed only at the band's outer edge, a crawl at its inner one. */
  const creep = (depth: number) => Math.round(PAN_SPEED * Math.min(1, depth / PAN_EDGE))

  const tick = () => {
    let dx = 0
    let dy = 0
    if (clientX < stageEdge.left + PAN_EDGE) dx = -creep(stageEdge.left + PAN_EDGE - clientX)
    else if (clientX > stageEdge.right - PAN_EDGE) dx = creep(clientX - stageEdge.right + PAN_EDGE)
    if (clientY < stageEdge.top + PAN_EDGE) dy = -creep(stageEdge.top + PAN_EDGE - clientY)
    else if (clientY > stageEdge.bottom - PAN_EDGE) dy = creep(clientY - stageEdge.bottom + PAN_EDGE)
    if (dx) stage.scrollLeft += dx
    if (dy) stage.scrollTop += dy
    // Every frame, not just after a move: edge-scrolling and the wheel both
    // slide the canvas under a pointer that is standing still.
    follow()
    raf = requestAnimationFrame(tick)
  }

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    ev.stopPropagation()
    cancelled = true
    // Releasing the capture is the one exit: putting down runs off its loss.
    handle.releasePointerCapture(e.pointerId)
  }

  const lift = () => {
    dragging = true
    homeX = frame.card.offsetLeft
    homeY = frame.card.offsetTop
    const origin = canvas.getBoundingClientRect()
    originX = origin.left
    originY = origin.top
    scrollX = stage.scrollLeft
    scrollY = stage.scrollTop
    stageEdge = stage.getBoundingClientRect()
    document.body.classList.add('ez-arranging')
    frame.card.classList.add('ez-card-drag')
    canvas.appendChild(dropHint)
    document.addEventListener('keydown', onKey, true)
    raf = requestAnimationFrame(tick)
  }

  const putDown = () => {
    cancelAnimationFrame(raf)
    // One last look with the final coordinates: a flick can land its pointerup
    // before the frame that would have caught up with it.
    if (!cancelled) follow()
    document.removeEventListener('keydown', onKey, true)
    document.body.classList.remove('ez-arranging')
    frame.card.classList.remove('ez-card-drag')
    dropHint.removeAttribute('data-on')
    dropHint.remove()
    if (!cancelled && landing) {
      layout = landing
      saveView()
    }
    // The card glides from wherever it was let go into its slot - the old one
    // when the drop changed nothing. Its drag transform is left standing: it is
    // the screen position the glide has to start from.
    settleFrames()
  }

  // Only records where the pointer is; the work runs once per frame in `tick`,
  // however many moves the frame collected.
  const move = (ev: PointerEvent) => {
    clientX = ev.clientX
    clientY = ev.clientY
    if (!dragging && Math.hypot(clientX - startX, clientY - startY) >= DRAG_SLOP) lift()
  }

  handle.addEventListener('pointermove', move)
  handle.addEventListener(
    'lostpointercapture',
    () => {
      handle.removeEventListener('pointermove', move)
      if (dragging) putDown()
    },
    { once: true },
  )
}

// ---------------------------------------------------------------- sidebar width

const WIDTH_KEY = 'eztweak:sidebar-width'

const maxSidebar = () => maxSidebarWidth(innerWidth)
const clampSidebar = (w: number) => clampSidebarWidth(w, innerWidth)

/** What the user asked for, which is not always what fits: a narrow window
 *  clamps the applied width without spending the preference, so widening the
 *  window brings the chosen size back. */
let preferredWidth = SIDEBAR_DEFAULT
try {
  const stored = Number(localStorage.getItem(WIDTH_KEY))
  if (Number.isFinite(stored) && stored > 0) preferredWidth = stored
} catch {}

function paintSidebarWidth(): void {
  const width = clampSidebar(preferredWidth)
  sidebar.style.width = `${width}px`
  resizer.setAttribute('aria-valuenow', String(width))
  resizer.setAttribute('aria-valuemax', String(maxSidebar()))
  // The stage is what is left over, so its share - and the scale a device has to
  // be shown at to fit in it - moves with every one of these.
  paintFrames()
}

function setSidebarWidth(width: number): void {
  preferredWidth = clampSidebar(width)
  paintSidebarWidth()
}

/** Left out of `setSidebarWidth`: a drag calls that on every pointer move, and
 *  the width it settles on is the only one worth a synchronous write. */
function persistSidebarWidth(): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(preferredWidth))
  } catch {}
}

paintSidebarWidth()
addEventListener('resize', () => {
  paintSidebarWidth()
  paintFrames()
})


resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  const startX = e.clientX
  const startWidth = sidebar.getBoundingClientRect().width
  // Capture rather than a document-level listener: the pointer spends most of
  // the drag over the iframe, which would otherwise swallow every move.
  resizer.setPointerCapture(e.pointerId)
  document.body.classList.add('ez-resizing')
  const move = (ev: PointerEvent) => setSidebarWidth(startWidth + startX - ev.clientX)
  resizer.addEventListener('pointermove', move)
  resizer.addEventListener(
    'lostpointercapture',
    () => {
      resizer.removeEventListener('pointermove', move)
      document.body.classList.remove('ez-resizing')
      persistSidebarWidth()
    },
    { once: true },
  )
})

resizer.addEventListener('dblclick', () => {
  setSidebarWidth(SIDEBAR_DEFAULT)
  persistSidebarWidth()
})

resizer.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 48 : 16
  if (e.key === 'ArrowLeft') setSidebarWidth(sidebar.getBoundingClientRect().width + step)
  else if (e.key === 'ArrowRight') setSidebarWidth(sidebar.getBoundingClientRect().width - step)
  else return
  persistSidebarWidth()
  e.preventDefault()
})

// ---------------------------------------------------------------- behavior

function sendMode(mode: Mode): void {
  // A pick and a mode change cannot both be in flight: `setMode` in the overlay
  // tears the popup down, and the pick is what would be answering into it.
  abortPick('mode')
  broadcast({ type: 'ez:set-mode', mode })
}

// ---------------------------------------------------------------- picking

let pickState: PickState | null = null
let pickSeq = 0

/** What the note box shows while the user is off pointing at something. */
const PICKING_LABEL = '選取中…'

function dispatchPick(e: PickEvent): void {
  const was = pickState
  const out = reducePick(pickState, e)
  pickState = out.state
  for (const effect of out.effects) applyPickEffect(effect)
  // One place for every way a pick can end without an answer - aborted, timed
  // out, called off from the page - so none of them can leave a placeholder
  // stranded in the note box. A no-op when there is none, which is every
  // popup-host pick: that placeholder lives in the overlay's own composer.
  if (was && !pickState && !out.effects.some((x) => x.do === 'insert-note')) {
    noteAttach.cancelRef()
    paintSendState()
  }
}

/** The frames an effect is aimed at: the one it names, or all of them. */
function pickFrames(frame?: string): Frame[] {
  if (!frame) return [...frames.values()]
  const one = frames.get(frame)
  return one ? [one] : []
}

function applyPickEffect(effect: PickEffect): void {
  switch (effect.do) {
    case 'arm-overlay':
      // Holds the spot the answer will land in, the same way the overlay's popup
      // does for its own. Idempotent, so a re-arm after a navigation does not
      // stack a second one.
      if (effect.host === 'note') {
        noteAttach.beginRef(PICKING_LABEL)
        paintSendState()
      }
      for (const f of pickFrames(effect.frame)) {
        toFrame(f.id, {
          type: 'ez:pick',
          pickId: effect.id,
          host: effect.host,
          ...(effect.returnTo ? { returnTo: effect.returnTo } : {}),
        })
      }
      return
    case 'abort-overlay':
      for (const f of pickFrames(effect.frame)) {
        toFrame(f.id, { type: 'ez:pick-abort', pickId: effect.id })
      }
      return
    case 'disarm-others':
      for (const f of frames.values()) {
        if (f.id !== effect.keep) toFrame(f.id, { type: 'ez:pick-abort', pickId: effect.id })
      }
      return
    case 'restore':
      for (const f of pickFrames(effect.frame)) {
        toFrame(f.id, { type: 'ez:restore', draft: effect.draft })
      }
      return
    case 'navigate':
      for (const f of pickFrames(effect.frame)) navigateFrame(f, effect.page)
      return
    case 'insert-note':
      noteAttach.resolveRef(effect.ref)
      note.focus()
      paintSendState()
      return
    case 'banner':
      pickNotice = effect.text
      paintBanner()
      return
  }
}

function startPick(host: 'note'): void {
  dispatchPick({ t: 'arm', id: `s${++pickSeq}-${Date.now().toString(36)}`, host, now: Date.now() })
}

function abortPick(reason: 'escape' | 'mode' | 'sent' | 'ended'): boolean {
  if (!pickState) return false
  dispatchPick({ t: 'abort', reason })
  return true
}

/** Only ever fires the arm timeout, which is why it can be this slow. */
setInterval(() => {
  if (pickState) dispatchPick({ t: 'tick', now: Date.now() })
}, 500)

function setDevice(id: string): void {
  if (!multi && id === deviceId) return
  // Only leaving the canvas replaces the frame. Switching device inside single
  // view resizes the one that is there, which is what keeps whatever the app is
  // part-way through - a form, a menu, a route - alive across the switch.
  const remount = multi
  deviceId = id
  multi = false
  saveView()
  paintControls()
  paintStageClasses()
  if (remount) rebuildStage()
  else paintFrames()
}

function setMulti(next: boolean): void {
  if (multi === next) return
  multi = next
  saveView()
  paintControls()
  paintStageClasses()
  rebuildStage()
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, { headers: { 'content-type': 'application/json' }, ...init })
}

/** Not the button's disabled state: ⌘+Enter reaches `sendBatch` without it, and
 *  every repaint would otherwise clear it while the request is in flight - a
 *  second send would name the same files as the first. */
let sending = false

/** The one owner of the button's state: `render()` runs on every snapshot, and
 *  an upload settling has to be able to repaint it between two of them. */
function paintSendState(): void {
  sendBtn.disabled = sending || snapshot?.state === 'ended' || noteAttach.pending() > 0
}

async function sendBatch(): Promise<void> {
  if (sending || noteAttach.pending() > 0) return
  const count = snapshot?.annotations.length ?? 0
  const attachments = noteAttach.ids()
  const references = noteAttach.refs()
  const text = noteAttach.text()
  if (count === 0 && !text && attachments.length === 0 && references.length === 0) return
  // Called off before the box is emptied: an answer arriving after the reset
  // would land in a composer that no longer holds the comment it belonged to.
  abortPick('sent')
  sending = true
  sendBtn.disabled = true
  try {
    const res = await api('/send', {
      method: 'POST',
      body: JSON.stringify({ note: text, attachments, references }),
    })
    // Reset, not discard: the batch owns these files now.
    if (res.ok) noteAttach.reset()
  } finally {
    // Restored even when the request threw: the note and its chips are still
    // there, so the send has to stay retryable.
    sending = false
    paintSendState()
  }
}

function annotationLabel(a: AnnotationWire): string {
  const parts: string[] = []
  if (a.anchor.source) parts.push(a.anchor.source)
  else if (a.anchor.components?.length) parts.push(`<${a.anchor.components[0]}>`)
  if (a.anchor.section) parts.push(a.anchor.section)
  if (a.anchor.text) parts.push(`"${a.anchor.text.slice(0, 32)}"`)
  return parts.join(' · ') || a.anchor.page || ''
}

/** Only the user's turns are boxed. The agent's are plain text, so the sender
 *  is the only thing that has to say who is speaking. */
function buildSaid(entry: ConversationWire, isUser: boolean): HTMLElement {
  const said = h('div', isUser ? 'ez-bubble' : 'ez-said')
  const items = entry.items ?? []

  if (items.length) {
    const key = entry.batchId ?? String(entry.ts)
    const expanded = expandedBatches.has(key)
    const collapsed = items.length > ITEM_LIMIT + 1 && !expanded
    const shown = collapsed ? items.slice(0, ITEM_LIMIT) : items

    const list = h('ol', 'ez-bubble-list')
    shown.forEach((item, i) => {
      const li = h('li', 'ez-bubble-item')
      const body = h('div', 'ez-bi-body')
      const rendered = commentEl(item.comment, item.references, item.attachments)
      // The anchor stays off the screen: within a session the author remembers
      // what they pointed at, and the agent's reply echoes it anyway. The rare
      // lookup is a hover away.
      if (item.where) li.title = item.where
      // An item can be a pasted file and nothing else, and an empty div would
      // still take a line.
      if (rendered.box.childNodes.length) body.append(rendered.box)
      const files = fileChips(rendered.unplacedFiles)
      if (files) body.append(files)
      li.append(h('span', 'ez-bi-num', `${i + 1}.`), body)
      list.appendChild(li)
    })
    said.appendChild(list)

    if (collapsed) {
      const more = h('button', 'ez-bubble-more', `還有 ${items.length - ITEM_LIMIT} 則`)
      more.onclick = () => {
        expandedBatches.add(key)
        render()
      }
      said.appendChild(more)
    }
  }

  const note = commentEl(
    entry.text,
    entry.references,
    entry.attachments,
    items.length ? 'ez-bubble-note' : undefined,
  )
  if (entry.text || entry.references?.length || entry.attachments?.length) {
    said.appendChild(note.box)
  }
  const noteFiles = fileChips(note.unplacedFiles)
  if (noteFiles) said.appendChild(noteFiles)
  return said
}

/** Read-only echo of a chip. Names only: the shell is where the user recognises
 *  their own file or the element they pointed at, and the agent is who needs the
 *  path and the anchor. */
function chipEl(name: string, glyph: IconNode, kind?: 'ref', title?: string): HTMLElement {
  const chip = h('span', kind === 'ref' ? 'ez-chip ez-chip-ref' : 'ez-chip')
  chip.append(icon(glyph, 11), h('span', 'ez-chip-name', name))
  if (title) chip.title = title
  return chip
}

const refChipEl = (n: number, label: string) =>
  chipEl(refChipText(n), AlignSelectionIcon as IconNode, 'ref', label)

/** Only for files the comment did not place - see `commentEl`. */
function fileChips(names: string[]): HTMLElement | null {
  if (!names.length) return null
  const row = h('div', 'ez-file-chips')
  for (const name of names) row.appendChild(chipEl(name, File02Icon as IconNode))
  return row
}

/** The comment, with each reference rendered where its marker stood. A reference
 *  *is* a position in the sentence - "make this match that one" - so showing the
 *  raw `[ref 1]` and the chip somewhere else asks the reader to do the joining
 *  the marker was carrying for them. */
/** The comment, with every chip rendered where its marker stood. A reference and
 *  an attachment are both positions in a sentence - "make this match that one",
 *  "check this csv against that screenshot" - so showing the raw marker and the
 *  chip somewhere else asks the reader to do the joining the marker was carrying
 *  for them.
 *
 *  Returns the file names it could not place, for the caller to show as a row:
 *  older logs and older annotations have no `[file n]` markers at all. */
function commentEl(
  text: string,
  refs: RefEcho[] | undefined,
  files: string[] | undefined,
  className?: string,
): { box: HTMLElement; unplacedFiles: string[] } {
  const box = h('div', className)
  const numbered = new Map(
    (refs ?? []).flatMap((r) => (typeof r === 'string' ? [] : [[r.n, r.label] as const])),
  )
  const names = files ?? []
  const placedRefs = new Set<number>()
  const placedFiles = new Set<number>()
  for (const part of splitComment(text)) {
    if (part.t === 'text') {
      box.appendChild(document.createTextNode(part.v))
      continue
    }
    if (part.t === 'file') {
      const name = names[part.n - 1]
      if (name === undefined) {
        box.appendChild(document.createTextNode(fileMarker(part.n)))
        continue
      }
      placedFiles.add(part.n)
      box.appendChild(chipEl(name, File02Icon as IconNode))
      continue
    }
    const label = numbered.get(part.n)
    // A marker naming nothing stays as it was written: silently dropping it
    // would lose the fact that the user pointed at something here.
    if (label === undefined) {
      box.appendChild(document.createTextNode(refMarker(part.n)))
      continue
    }
    placedRefs.add(part.n)
    box.appendChild(refChipEl(part.n, label))
  }
  // Anything the text did not name still has to be seen. A legacy echo has no
  // number to read, so it falls back to the label it does have.
  for (const r of refs ?? []) {
    if (typeof r === 'string') {
      box.appendChild(chipEl(r, AlignSelectionIcon as IconNode, 'ref'))
    } else if (!placedRefs.has(r.n)) {
      box.appendChild(refChipEl(r.n, r.label))
    }
  }
  return { box, unplacedFiles: names.filter((_, i) => !placedFiles.has(i + 1)) }
}

const QUEUE_VISIBLE = 2

/** A pixel cap would be wrong: an item is as tall as its comment. Measure the
 *  first `QUEUE_VISIBLE` instead, so exactly that many show whatever they hold. */
function capQueue(): void {
  const items = [...queueList.children] as HTMLElement[]
  queueScroll.toggleAttribute('data-filled', items.length > 0)
  if (items.length > QUEUE_VISIBLE) {
    const gap = parseFloat(getComputedStyle(queueList).rowGap) || 0
    const budget =
      items.slice(0, QUEUE_VISIBLE).reduce((sum, li) => sum + li.offsetHeight, 0) +
      gap * (QUEUE_VISIBLE - 1)
    queueList.style.maxHeight = `${budget}px`
  } else {
    queueList.style.maxHeight = ''
  }
  paintQueueFades()
}

/** Marks which direction still has content, so `.ez-fade` can show that edge.
 *  Returns the painter so the caller can also run it after a re-render, when no
 *  scroll event fires but the overflow has changed. */
function watchFades(wrapper: HTMLElement, scroller: HTMLElement): () => void {
  const paint = () => {
    const slack = scroller.scrollHeight - scroller.clientHeight
    wrapper.toggleAttribute('data-more-above', scroller.scrollTop > 1)
    wrapper.toggleAttribute('data-more-below', scroller.scrollTop < slack - 1)
  }
  scroller.addEventListener('scroll', paint)
  return paint
}

const paintQueueFades = watchFades(queueScroll, queueList)
const paintConvFades = watchFades(convScroll, convList)

/** The one owner of the banner. `render()` runs on every snapshot, so anything
 *  that writes here from outside it would be wiped by the next one. A pick's
 *  notice has to survive that, and the session notice outranks it. */
let pickNotice: string | null = null

function bannerText(): string | null {
  if (snapshot?.state === 'ended') {
    return snapshot.endedBy === 'agent'
      ? 'Agent 已結束這次 review。要繼續的話，請 agent 重新開啟 session'
      : 'Review 已結束'
  }
  return pickNotice
}

function paintBanner(): void {
  const text = bannerText()
  banner.style.display = text ? 'block' : 'none'
  if (text) banner.textContent = text
}

function render(): void {
  if (!snapshot) return
  const s = snapshot

  target.textContent = `${s.targetOrigin.replace(/^https?:\/\//, '')}${PAGE_PATH}`

  const ended = s.state === 'ended'
  // Explicitly, rather than leaving it to the overlay: a pick from the note box
  // runs with no mode armed, so the overlay's `setMode('off')` cancels nothing.
  if (ended) abortPick('ended')
  paintBanner()
  for (const { btn } of annotateBtns) btn.disabled = ended
  paintSendState()

  if (s.agentBusy) {
    agentStatus.className = 'ez-badge ez-working'
    agentStatus.textContent = 'Agent 修改中'
  } else if (s.agentOnline) {
    agentStatus.className = 'ez-badge ez-online'
    agentStatus.textContent = 'Agent 已連線'
  } else {
    agentStatus.className = 'ez-badge'
    agentStatus.textContent = 'Agent 未連線'
  }

  queueList.textContent = ''
  s.annotations.forEach((a, i) => {
    const li = h('li', 'ez-queue-item')
    const head = h('div', 'ez-qi-head')
    head.append(h('span', 'ez-qi-num', String(i + 1)), h('span', 'ez-qi-label', annotationLabel(a)))
    // A chip, not part of the label: the label ellipsizes, and the width is the
    // one detail that must never be the thing that gets cut off.
    const vp = a.anchor.viewport
    if (vp?.width && vp.preset !== 'desktop') {
      head.append(h('span', 'ez-qi-vp', `${vp.width}px`))
    }
    const del = h('button', 'ez-qi-del')
    del.append(icon(Cancel01Icon as IconNode, 13))
    del.title = '移除這則標註'
    del.onclick = () => void api(`/annotations/${a.id}`, { method: 'DELETE' })
    head.append(del)
    li.append(head)
    const row = commentEl(
      a.comment,
      a.references,
      a.attachments?.map((f) => f.name),
      'ez-qi-comment',
    )
    if (a.comment || a.references?.length || a.attachments?.length) li.append(row.box)
    const files = fileChips(row.unplacedFiles)
    if (files) li.append(files)
    queueList.appendChild(li)
  })
  capQueue()

  convList.textContent = ''
  let prevRole: string | null = null
  for (const entry of s.conversation) {
    if (entry.role === 'system') {
      convList.appendChild(h('div', 'ez-msg-system', entry.text))
      prevRole = null
      continue
    }
    const grouped = entry.role === prevRole
    const item = h('div', `ez-msg ez-msg-${entry.role}${grouped ? ' ez-msg-cont' : ''}`)
    const isUser = entry.role === 'user'
    item.append(buildSaid(entry, isUser))
    convList.appendChild(item)
    prevRole = entry.role
  }

  if (s.agentBusy) {
    // Grouped on the same rule a real turn would use: this row is a placeholder
    // for the reply that replaces it, and a different margin here would make the
    // thread step sideways at the moment it lands.
    const row = h('div', `ez-msg ez-msg-agent${prevRole === 'agent' ? ' ez-msg-cont' : ''}`)
    const dots = h('div', 'ez-thinking')
    dots.setAttribute('role', 'status')
    dots.setAttribute('aria-label', s.agentProgress ?? 'Agent 修改中')
    for (let i = 0; i < 3; i++) dots.appendChild(h('span', 'ez-dot'))
    // The agent's own words on what it is doing, when it sends any - rendered
    // where the reply will land, because it is the reply, mid-formation.
    if (s.agentProgress) dots.appendChild(h('span', 'ez-progress', s.agentProgress))
    row.append(dots)
    convList.appendChild(row)
  }

  convList.scrollTop = convList.scrollHeight
  paintConvFades()
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.origin !== location.origin) return
  // Also the guard against an iframe of the app's own posting up here: a message
  // is only ours if it came from a frame we mounted.
  const from = frameIdOf(e.source)
  if (!from) return
  const data = e.data as {
    type?: string
    mode?: Mode
    chord?: KeyChord
    page?: string
    pickId?: string
    host?: 'popup' | 'note'
    draft?: DraftWire
    ref?: RefWire
    resumed?: boolean
    ratio?: number
    dx?: number
    dy?: number
    open?: boolean
  }
  // A mod+wheel caught inside a preview: the page under the pointer stays put
  // and the stage moves instead - panning the canvas without having to aim for
  // the gaps between the frames.
  if (data?.type === 'ez:wheel') {
    stage.scrollLeft += data.dx ?? 0
    stage.scrollTop += data.dy ?? 0
  }
  // Where one preview is scrolled to is where all of them should be: the canvas
  // exists to compare the same part of the page at three widths, and three
  // frames scrolled apart is three unrelated screenshots.
  // While an annotation popup is open, only its own frame may lead: anything
  // else that slips a scroll through would be relayed straight under the popup.
  if (
    data?.type === 'ez:scroll' &&
    typeof data.ratio === 'number' &&
    multi &&
    (!popupFrame || from === popupFrame)
  ) {
    for (const f of frames.values()) {
      if (f.id !== from) toFrame(f.id, { type: 'ez:scroll-to', ratio: data.ratio })
    }
  }
  if (data?.type === 'ez:popup') {
    // A close only counts from the frame holding it: opening a popup closes
    // nothing else by design, so a stray close must not lift the hold.
    if (data.open) setPopupFrame(from)
    else if (from === popupFrame) setPopupFrame(null)
  }
  if (data?.type === 'ez:mode') {
    annotateMode = data.mode ?? 'off'
    for (const { id, btn } of annotateBtns) btn.classList.toggle('ez-on', annotateMode === id)
    // A change born inside one frame - Escape, mostly - has to reach the rest:
    // left armed, they keep offering highlights for a mode the shell has
    // already put away. No echo risk: a frame already in this mode stays quiet.
    for (const f of frames.values()) {
      if (f.id !== from) toFrame(f.id, { type: 'ez:set-mode', mode: annotateMode })
    }
  }
  if (data?.type === 'ez:ready') {
    const f = frames.get(from)
    if (f) f.page = data.page ?? '/'
    syncPages(from)
    // Straight to the frame, not through `sendMode`: this is a replay of state
    // the overlay lost, and `sendMode` calls off any pick that is still out -
    // which is exactly the pick this fresh overlay has to be handed back.
    toFrame(from, { type: 'ez:set-mode', mode: annotateMode })
    if (f) {
      toFrame(from, { type: 'ez:viewport', preset: f.device.id, zoom: f.zoom, scoped: multi })
    }
    // A frame that (re)booted while an annotation is being composed elsewhere
    // starts held; its own popup died with the page it was on.
    if (popupFrame && popupFrame !== from) toFrame(from, { type: 'ez:hold', held: true })
    else if (popupFrame === from) setPopupFrame(null)
    dispatchPick({ t: 'ready', page: data.page ?? '/', now: Date.now(), frame: from })
  }
  if (data?.type === 'ez:pick-armed' && data.pickId) {
    dispatchPick({
      t: 'armed',
      id: data.pickId,
      host: data.host ?? 'popup',
      now: Date.now(),
      frame: from,
    })
  }
  if (data?.type === 'ez:draft' && data.pickId && data.draft) {
    dispatchPick({ t: 'draft', id: data.pickId, draft: data.draft, frame: from })
  }
  if (data?.type === 'ez:picked' && data.pickId && data.ref) {
    dispatchPick({
      t: 'picked',
      id: data.pickId,
      ref: data.ref,
      page: data.page ?? '/',
      frame: from,
    })
  }
  if (data?.type === 'ez:draft-done' && data.pickId) {
    dispatchPick({ t: 'draft-done', id: data.pickId })
  }
  if (data?.type === 'ez:draft-expired' && data.pickId) {
    dispatchPick({ t: 'expired', id: data.pickId, frame: from })
  }
  if (data?.type === 'ez:pick-cancelled' && data.pickId) {
    dispatchPick({
      t: 'cancelled',
      id: data.pickId,
      resumed: Boolean(data.resumed),
      frame: from,
    })
  }
  if (data?.type === 'ez:key') {
    // Already screened by the overlay for its own popup and the host page's
    // fields, so nothing here is being typed into.
    if (data.chord) runShortcut(data.chord, false)
  }
})

/** Forwarded, not decided here: whether Escape takes back a popup or the whole
 *  mode is the overlay's call, and only it can see whether a popup is open. */
function escapeAnnotating(): void {
  if (annotateMode === 'off') return
  broadcast({ type: 'ez:escape' })
}

/** The shell is the only listener for the table, and the overlay forwards keys it
 *  did not consume - so a shortcut works whether focus is in the sidebar or out
 *  on the page, without the two documents keeping separate lists. */
document.addEventListener('keydown', (e) => {
  if (runShortcut(e, isTyping(e.target))) e.preventDefault()
})

const events = new EventSource(`${API}/events`)
events.onmessage = (e) => {
  snapshot = JSON.parse(e.data) as SnapshotWire
  render()
}

document.title = `Review · ${PAGE_PATH}`
