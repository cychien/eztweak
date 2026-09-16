/** Review shell (host page): iframe of the proxied app + feedback sidebar. */

import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import AlignSelectionIcon from '@hugeicons/core-free-icons/AlignSelectionIcon'
import ChevronDownIcon from '@hugeicons/core-free-icons/ChevronDownIcon'
import ChevronRightIcon from '@hugeicons/core-free-icons/ChevronRightIcon'
import MagicWand01Icon from '@hugeicons/core-free-icons/MagicWand01Icon'
import ArrowRight02Icon from '@hugeicons/core-free-icons/ArrowRight02Icon'
import Grid02Icon from '@hugeicons/core-free-icons/Grid02Icon'
import ChatGptIcon from '@hugeicons/core-free-icons/ChatGptIcon'
import CheckIcon from '@hugeicons/core-free-icons/CheckIcon'
import ClaudeIcon from '@hugeicons/core-free-icons/ClaudeIcon'
import CursorMagicSelection02Icon from '@hugeicons/core-free-icons/CursorMagicSelection02Icon'
import File02Icon from '@hugeicons/core-free-icons/File02Icon'
import KeyboardIcon from '@hugeicons/core-free-icons/KeyboardIcon'
import Select01Icon from '@hugeicons/core-free-icons/Select01Icon'
import Navigation03Icon from '@hugeicons/core-free-icons/Navigation03Icon'
import BubbleChatAddIcon from '@hugeicons/core-free-icons/BubbleChatAddIcon'
import BubbleChatOutcomeIcon from '@hugeicons/core-free-icons/BubbleChatOutcomeIcon'
import Edit02Icon from '@hugeicons/core-free-icons/Edit02Icon'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AcpAskAnswer, AcpAskField, AcpAskOption } from '../acp-ask.js'
import { AGENT_PROFILES, type AgentBrand, agentBrandFor, agentProfileFor } from '../agents.js'
import {
  type AcpConfigValue,
  configLabel,
  configValueName,
  configValues,
  shortConfigValueName,
} from '../acp-config.js'
import { attachify } from './attach.js'
import { confirmSkipped, rememberConfirm } from './confirm-skip.js'
import { type Usage, planName, usageNote, usageRows } from './usage-note.js'
import type { SlashCommand } from './slash.js'
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
import type { DraftWire, NumberedRef, RefWire } from './draft.js'
import {
  bodyFromComment,
  fileMarker,
  refChipText,
  refMarker,
  skillMarker,
  splitComment,
} from './draft.js'
import { markdownEl } from './markdown.js'
import { reduceNav } from './nav.js'
import { threadOrder } from './thread.js'
import type { NavEffect, NavEvent, NavState } from './nav.js'
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
  /** Full records, not echoes: the queue holds the annotation itself, and the
   *  editor has to be able to hand every field back unchanged. */
  attachments?: { id: string; name: string }[]
  references?: NumberedRef[]
}

/** A bare string is what logs written before references carried a number hold.
 *  It has no marker to sit in, so it is appended rather than inlined. */
type RefEcho = string | { n: number; label: string }

interface ConversationWire {
  role: 'user' | 'agent' | 'system'
  text: string
  ts: number
  batchId?: string
  /** The skills this batch named, in the order they were written. `[skill n]`
   *  in the text is `skills[n-1]`. */
  skills?: string[]
  items?: {
    comment: string
    where: string
    attachments?: string[]
    references?: RefEcho[]
  }[]
  attachments?: string[]
  references?: RefEcho[]
}

/** One explore round as the strip draws it. */
interface ExploreWire {
  id: string
  chatId: string
  label: string
  anchor: unknown
  direction?: string
  status: 'generating' | 'done' | 'cancelled' | 'dismissed'
  variants: { id: string; name: string; html: string; note?: string }[]
  selected: string | null
  adopted?: string
  startedAt: number
}

interface SnapshotWire {
  version: string
  state: 'active' | 'ended'
  /** The batch the agent is answering right now. */
  activeBatchId?: string
  endedBy?: 'user' | 'agent'
  targetOrigin: string
  annotations: AnnotationWire[]
  conversation: ConversationWire[]
  agentOnline: boolean
  agentBusy: boolean
  agentProgress?: string
  acp?: AcpWire
  /** The conversations this review has had, newest first. ACP mode only. */
  chats?: ChatWire[]
  update?: UpdateWire
  explores?: ExploreWire[]
  canExplore?: true
}

interface ChatWire {
  id: string
  startedAt: number
  entries: number
  current: boolean
  /** The conversation this one branched off, when it did. */
  parentChatId?: string
  /** The agent's own name for it, when it has one. */
  title?: string
  /** What it was opened about, for a branch. */
  detail?: string
}

/** A newer daemon on the registry, and how far the update has got once the user
 *  took it up. */
interface UpdateWire {
  latest: string
  phase: 'available' | 'installing' | 'handing-over' | 'failed'
  error?: string
}

/** SPIKE: the session drives its agent over ACP - live activity and questions. */
interface AcpWire {
  agent: string
  state: 'starting' | 'idle' | 'working' | 'exited'
  feed: (
    | { kind: 'say'; text: string }
    | { kind: 'thought'; text: string }
    | { kind: 'tool'; toolCallId: string; title: string; status: string }
    | { kind: 'plan'; entries: { content: string; status: string }[] }
  )[]
  ask?: AcpAskWire
  /** What this agent lets the session be configured with. The protocol's own
   *  type rather than a mirror of it: the shell draws whatever is in the list
   *  without naming the options, so a hand-written copy would only be a second
   *  place for the shape to drift. */
  configOptions?: SessionConfigOption[]
  /** The usage window this review will reach first, when the agent has said so.
   *  Absent until then, which can be for a whole session. */
  limit?: Usage
  /** A cancel is out and the turn has not ended yet. */
  cancelling?: true
  error?: string
}

interface AcpAskWire {
  id: string
  kind: 'permission' | 'question'
  title: string
  fields: AcpAskField[]
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
/** Hoisted: the shortcut table is built while this module is still initialising,
 *  so it cannot live down with the rest of the pick code. */
const MOD_LABEL = modLabel(navigator.userAgent)
/** The path the shell was opened on. Only ever the starting point: where the
 *  previews actually are is `nav.url`, which moves with the app. */
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
/** Both sized against the 13px cross they sit beside, because `size` alone does
 *  not settle how big a glyph looks - each uses a different share of its 24-unit
 *  box. The cross's ink is 12x12 of it, the pencil's 20x20, and the tick's 14x11:
 *  at one nominal size the pencil comes out two thirds larger than the cross and
 *  the tick a third shorter. These are the two sizes at which all three stop
 *  looking different. (Matching the pencil's ink exactly would take it to 8px,
 *  where its stroke falls below half a pixel and washes out.) */
const EDIT_ICON = 10
const TICK_ICON = 14

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
const canvasDevice = (id: string): Device => CANVAS_DEVICES.find((d) => d.id === id) ?? DESKTOP

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
    localStorage.setItem(VIEW_KEY, JSON.stringify({ device: deviceId, multi, layout }))
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

const brand = h('div', 'ez-brand', 'eztweak')
const version = h('span', 'ez-version')
/** The way back to an update the user put off: the card is gone, this is not.
 *  Opens a one-item menu rather than bringing the card back - by this point the
 *  card has already been read and dismissed, so what is wanted is the action, not
 *  the explanation again. */
const updatePill = h('button', 'ez-update-flag')
updatePill.setAttribute('aria-haspopup', 'menu')
updatePill.setAttribute('aria-expanded', 'false')

const updateMenu = h('div', 'ez-menu')
updateMenu.setAttribute('role', 'menu')
const updateNow = h('button', 'ez-menu-item')
updateNow.setAttribute('role', 'menuitem')
updateMenu.append(updateNow)

const updateHint = h('div', 'ez-update-hint')
updateHint.hidden = true
updateHint.append(updatePill, updateMenu)

let updateMenuOpen = false

function paintUpdateMenu(): void {
  updateHint.toggleAttribute('data-open', updateMenuOpen)
  updatePill.setAttribute('aria-expanded', String(updateMenuOpen))
}

updatePill.onclick = () => {
  updateMenuOpen = !updateMenuOpen
  paintUpdateMenu()
}

updateNow.onclick = () => {
  updateMenuOpen = false
  paintUpdateMenu()
  void startUpdate()
}

document.addEventListener('click', (e) => {
  if (updateMenuOpen && e.target instanceof Node && !updateHint.contains(e.target)) {
    updateMenuOpen = false
    paintUpdateMenu()
  }
})
const target = h('span', 'ez-target')
const agentStatus = h('div', 'ez-badge')

/** Which agent is driving this review, and the way to another.
 *
 *  Left of the model, because the two answer one question between them - what is
 *  about to read this feedback - and reading them as a pair only works if they
 *  sit as a pair. The agent goes first: the model is a choice *within* it, and
 *  changing the agent replaces the list the model was chosen from. */
const agentPill = h('button', 'ez-agent-pill')
agentPill.setAttribute('aria-haspopup', 'menu')
agentPill.setAttribute('aria-expanded', 'false')
const agentMenu = h('div', 'ez-menu ez-menu-up')
agentMenu.setAttribute('role', 'menu')
agentMenu.setAttribute('aria-label', 'Agent')
const agentWrap = h('div', 'ez-agent')
agentWrap.hidden = true
agentWrap.append(agentPill, agentMenu)

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
    keys: `${MOD_LABEL} .`,
    label: '中止 agent 這一輪',
    match: cmd('.'),
    run: () => void cancelTurn(),
    /** The reason to stop the agent usually arrives while the next batch is being
     *  typed - watching it head the wrong way is what prompts it. */
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
headRow.append(brand, version, updateHint, h('div', 'ez-spacer'), keysWrap, agentStatus)

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
deviceCaret.append(icon(ChevronDownIcon as IconNode, 12))
deviceCaret.setAttribute('aria-haspopup', 'menu')
deviceCaret.setAttribute('aria-expanded', 'false')

/** Built here rather than as a native `select`: a select's menu is the platform's
 *  - its own type, its own metrics, its own highlight - and this one has to sit
 *  in a 12px header beside a segmented control and be read as part of it. */
const deviceMenu = h('div', 'ez-menu')
deviceMenu.setAttribute('role', 'menu')
deviceMenu.setAttribute('aria-label', '預覽尺寸')

const deviceItems = DEVICES.map((d) => {
  const item = h('button', 'ez-menu-item')
  item.setAttribute('role', 'menuitemradio')
  item.dataset.device = d.id
  // The size belongs on the card that is showing it, not in the list of names:
  // here it is a number nobody is choosing by.
  //
  // Marked the way the agent and model menus mark theirs - a tick at the right
  // edge of the row that is on. This is the same kind of control as those, one
  // of a short list is current, and three selects in one sidebar wearing three
  // different marks would make the reader learn each of them separately. The
  // number keys that also pick a size are not printed here: a shortcut belongs
  // where it is learned once, which is the control's own tooltip and the
  // keyboard card, not down the side of every row forever.
  item.title = deviceLabel(d)
  item.append(h('span', 'ez-menu-name', d.name), menuCheck())
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
    const on = !multi && item.dataset.device === deviceId
    item.setAttribute('aria-checked', String(on))
    item.toggleAttribute('data-current', on)
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
// `hidden`, not `style.display`: the notice stack tells an empty stack from a
// full one with `:has(> *:not([hidden]))`, so a card that hides itself another
// way is still counted and the stack casts a shadow over nothing.
banner.hidden = true

// ---------------------------------------------------------------- update card

const updateCard = h('section', 'ez-update')
updateCard.hidden = true

const UPDATE_DISMISSED_KEY = 'ez-update-dismissed'

/** What "later" was said to. A different version is a different offer and comes
 *  back; the same one stays put off until the pill in the header is clicked. */
function updateOfferKey(u: UpdateWire): string {
  return `v${u.latest}`
}

function readUpdateDismissed(): string | null {
  try {
    return localStorage.getItem(UPDATE_DISMISSED_KEY)
  } catch {
    return null
  }
}

function setUpdateDismissed(key: string | null): void {
  try {
    if (key) localStorage.setItem(UPDATE_DISMISSED_KEY, key)
    else localStorage.removeItem(UPDATE_DISMISSED_KEY)
  } catch {
    /* storage unavailable: the card simply stays */
  }
  render()
}

let updating = false

async function startUpdate(): Promise<void> {
  if (updating) return
  updating = true
  // Asking for the update revokes any "later" it was put off with. Otherwise a
  // retry launched from the flag's menu runs with the card still suppressed, and
  // a second failure of the same version is never shown - the dismissal was
  // about the offer, not about the outcome of acting on it.
  setUpdateDismissed(null)
  try {
    await api('/update', { method: 'POST' })
  } finally {
    // A refused request (nothing to update, or one already running) never moves
    // the daemon, so nothing would arrive to repaint the borrowed `installing`
    // view this leaves behind.
    updating = false
    render()
  }
}

function updateTitle(u: UpdateWire): string {
  switch (u.phase) {
    case 'installing':
      return `正在更新到 v${u.latest}`
    case 'handing-over':
      return `正在切換到 v${u.latest}`
    case 'failed':
      return '更新失敗'
    default:
      return `有新版本 v${u.latest}`
  }
}

/** What the card should be showing, which is not always what the last snapshot
 *  says. Between the click and the daemon's first broadcast the snapshot still
 *  describes the state the click is leaving - so a retry would paint the failure
 *  it is retrying, and its error, for that gap. Local intent outranks the
 *  snapshot there, and installing is where the daemon is about to be. */
function updateView(u: UpdateWire): UpdateWire {
  if (!updating || (u.phase !== 'available' && u.phase !== 'failed')) return u
  const { error: _error, ...rest } = u
  return { ...rest, phase: 'installing' }
}

function paintUpdate(s: SnapshotWire): void {
  const u = s.update && updateView(s.update)
  // A failure is as dismissible as the offer it came from: the close button is
  // drawn in both, and the retry lives on in the flag's menu either way. The
  // phases in between are not - an update in flight has no "later".
  const dismissible = u?.phase === 'available' || u?.phase === 'failed'
  const dismissed = !!u && dismissible && readUpdateDismissed() === updateOfferKey(u)
  updateHint.hidden = !dismissed
  if (dismissed) {
    updatePill.textContent = `v${u.latest} 可更新`
    updateNow.textContent = `更新到 v${u.latest}`
    updateNow.disabled = updating
  } else if (updateMenuOpen) {
    updateMenuOpen = false
  }
  paintUpdateMenu()
  updateCard.hidden = !u || !!dismissed
  updateCard.textContent = ''
  if (!u || dismissed) return

  updateCard.append(h('div', 'ez-update-title', updateTitle(u)))

  const busy = u.phase !== 'available' && u.phase !== 'failed'
  const lines = h('ul', 'ez-update-lines')
  const line = (text: string, cls = '') => lines.append(h('li', cls || undefined, text))
  const working = s.acp?.state === 'working'
  if (busy) {
    if (u.phase === 'installing') line('下載並安裝新版本…')
    if (u.phase === 'handing-over') line('新的 daemon 接手中，畫面會自動重新載入')
  } else {
    // The one thing the update changes that outlives it. What gets installed,
    // restarted and overwritten is the update itself - listing that buries the
    // only line the user has to decide about.
    if (s.acp) line('更新完成後，會開啟新 session')
    if (u.phase === 'failed' && u.error) line(u.error, 'ez-update-error')
  }
  // Only when it has something in it: an offer with nothing to warn about is a
  // title and two buttons, and an empty list still holds its top margin open.
  if (lines.childElementCount) updateCard.append(lines)

  if (!busy) {
    const actions = h('div', 'ez-update-actions')
    const go = h('button', 'ez-update-go')
    go.append(
      h(
        'span',
        'ez-update-label',
        u.phase === 'failed' ? '重試' : working ? '仍要更新' : '立即更新',
      ),
    )
    go.disabled = updating
    go.onclick = () => void startUpdate()
    actions.append(go)
    updateCard.append(actions)

    const dismiss = h('button', 'ez-update-x')
    dismiss.append(icon(Cancel01Icon as IconNode, 13))
    dismiss.title = '稍後再說（版號旁的提示會留著）'
    dismiss.setAttribute('aria-label', dismiss.title)
    dismiss.onclick = () => setUpdateDismissed(updateOfferKey(u))
    updateCard.append(dismiss)
  }
}

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

/** The variant strip: what the agent produced for one element, across the bottom
 *  of the stage.
 *
 *  Across the stage rather than in the sidebar because it is about the *page* -
 *  every preview on the canvas shows the selected variant at once, and the thing
 *  you are comparing is what you are looking at, not what you are reading.
 *
 *  One round at a time, with a switcher when there is more than one. Rounds on
 *  different elements all stand on the page together; the strip is only about
 *  which of them you are currently choosing within. */
const strip = h('div', 'ez-strip')
strip.hidden = true
const stripRounds = h('div', 'ez-strip-rounds')
const stripChips = h('div', 'ez-strip-chips')
const stripActions = h('div', 'ez-strip-actions')
strip.append(stripRounds, stripChips, stripActions)

/** Say something went wrong where the strip would have appeared. Its own line
 *  rather than the thread's: an explore that never started wrote nothing to the
 *  conversation, so there is nowhere else for this to be. */
function stripNotice(text: string): void {
  strip.hidden = false
  stripRounds.replaceChildren()
  stripChips.replaceChildren(h('div', 'ez-strip-pending', text))
  stripActions.replaceChildren()
  setTimeout(() => {
    if (!liveExplores().length) strip.hidden = true
  }, 4000)
}

/** Which round the strip is showing. Null means "the newest", which is what the
 *  user just started; it only becomes a real id once they pick another, so a new
 *  round does not have to fight a stale selection to be seen. */
let stripRound: string | null = null

/** What each frame currently has standing in it, so a repaint only posts the
 *  swaps that actually changed. Without it every snapshot - and they arrive on
 *  every keystroke the agent streams - would re-swap the page under the user. */
const posted = new Map<string, string | null>()

function liveExplores(): ExploreWire[] {
  return snapshot?.explores ?? []
}

function shownRound(): ExploreWire | undefined {
  const rounds = liveExplores()
  return rounds.find((r) => r.id === stripRound) ?? rounds[rounds.length - 1]
}

/** Push every round's selection into every preview, and only what moved. */
function paintVariants(): void {
  const rounds = liveExplores()
  for (const round of rounds) {
    const variant = round.variants.find((v) => v.id === round.selected)
    const html = variant?.html ?? null
    if (posted.get(round.id) === (variant?.id ?? null)) continue
    posted.set(round.id, variant?.id ?? null)
    broadcast({ type: 'ez:variant', exploreId: round.id, anchor: round.anchor, html })
  }
  // A round that is gone - dismissed, or the session moved on - takes its markup
  // off the page with it.
  for (const id of [...posted.keys()]) {
    if (rounds.some((r) => r.id === id)) continue
    posted.delete(id)
    broadcast({ type: 'ez:variant', exploreId: id, anchor: null, html: null })
  }
}

/** A newly mounted frame has none of this yet. */
function seedVariants(id: string): void {
  for (const round of liveExplores()) {
    const variant = round.variants.find((v) => v.id === round.selected)
    toFrame(id, {
      type: 'ez:variant',
      exploreId: round.id,
      anchor: round.anchor,
      html: variant?.html ?? null,
    })
  }
}

function select(round: ExploreWire, variantId: string | null): void {
  void api('/explore/select', {
    method: 'POST',
    body: JSON.stringify({ id: round.id, variantId }),
  })
}

function paintStrip(): void {
  const rounds = liveExplores()
  strip.hidden = rounds.length === 0
  if (!rounds.length) {
    stripRound = null
    return
  }
  const round = shownRound()!
  stripRound = round.id

  stripRounds.replaceChildren()
  stripRounds.hidden = rounds.length < 2
  for (const one of rounds) {
    const tab = h('button', `ez-strip-round${one.id === round.id ? ' ez-on' : ''}`, one.label)
    tab.title = one.direction ? `${one.label}：${one.direction}` : one.label
    tab.onclick = () => {
      stripRound = one.id
      paintStrip()
    }
    stripRounds.append(tab)
  }

  stripChips.replaceChildren()
  const original = h('button', `ez-strip-chip${round.selected === null ? ' ez-on' : ''}`, '原本')
  original.onclick = () => select(round, null)
  stripChips.append(original)
  for (const variant of round.variants) {
    const chip = h('button', `ez-strip-chip${variant.id === round.selected ? ' ez-on' : ''}`)
    chip.append(h('span', undefined, variant.name))
    if (variant.note) chip.append(h('span', 'ez-strip-note', variant.note))
    chip.title = variant.note ?? variant.name
    chip.onclick = () => select(round, variant.id)
    stripChips.append(chip)
  }
  if (round.status === 'generating') {
    stripChips.append(h('div', 'ez-strip-pending', round.variants.length ? '還在想…' : '正在產生…'))
  }

  stripActions.replaceChildren()
  const onBranch = snapshot?.chats?.find((c) => c.current)?.id === round.chatId
  if (onBranch) {
    const parent = snapshot?.chats?.find((c) => c.id === round.chatId)?.parentChatId
    if (parent) {
      const back = h('button', 'ez-strip-action', '回主線')
      back.title = '回到開始探索前的對話'
      // Mid-turn the agent is still on this branch, and moving would abandon a
      // turn the user can see running. The cancel chord is the way out of that.
      back.disabled = !!snapshot?.agentBusy
      back.onclick = () =>
        void api('/acp/chat', { method: 'POST', body: JSON.stringify({ id: parent }) })
      stripActions.append(back)
    }
  }
  const close = h('button', 'ez-strip-action', '關閉')
  close.title = '結束這一輪探索，頁面回到原本的樣子'
  close.onclick = () =>
    void api('/explore/dismiss', { method: 'POST', body: JSON.stringify({ id: round.id }) })
  stripActions.append(close)
}

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
  tick.append(icon(CheckIcon as IconNode, 14))
  item.append(tick, h('span', 'ez-menu-name', d.name))
  item.onclick = () => toggleShown(d.id)
  shownMenu.appendChild(item)
  return item
})

const shownWrap = h('div', 'ez-shown')
shownWrap.append(shownBtn, shownMenu)
stageWrap.append(stage, shownWrap, strip)

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

/** Where the previews actually are, and where a frame mounted later has to
 *  start. The path the shell was opened on goes stale the moment the app
 *  navigates; this moves with it. */
let nav: NavState = { url: PAGE_PATH }

/** The review's history is the shell's own, entry for entry - see `nav.ts` for
 *  why it cannot be the previews'. Everything that moves the review goes through
 *  here, so there is exactly one place that pushes, one that repaints, and one
 *  that points the frames at a page. */
function dispatchNav(e: NavEvent): void {
  const { state, effects } = reduceNav(nav, e)
  const moved = state.url !== nav.url
  nav = state
  for (const effect of effects) applyNavEffect(effect)
  // Painted off the state rather than off an effect: a traversal produces no
  // entry to write, and the header and the tab still have to follow.
  if (moved) paintPage()
}

function applyNavEffect(effect: NavEffect): void {
  switch (effect.do) {
    // The address bar carries the live page, not the one the session started
    // on: the shell mounts its frames from the query string, so a reload three
    // pages deep has to come back to the third page and not the first. The
    // state carries it too, because on the way back that is all there is - the
    // frames that were on those pages are long gone.
    case 'push':
      history.pushState({ ezUrl: effect.url }, '', shellUrl(effect.url))
      return
    case 'replace':
      history.replaceState({ ezUrl: effect.url }, '', shellUrl(effect.url))
      return
    case 'navigate':
      for (const f of frames.values()) {
        if (f.id !== effect.except) navigateFrame(f, effect.url)
      }
      return
  }
}

function shellUrl(page: string): URL {
  const url = new URL(location.href)
  url.searchParams.set('path', page)
  return url
}

/** The entry the shell was opened on, so that a back into it is answerable the
 *  same way every later one is. */
history.replaceState({ ezUrl: nav.url }, '', shellUrl(nav.url))

/** Back and forward, for a review whose previews hold no history of their own.
 *  The page comes off the entry rather than off any frame, which is what makes
 *  this work at all after the stage has been rebuilt: the documents that were
 *  on those pages are gone, and the entry is the only record left. */
window.addEventListener('popstate', (e) => {
  const state = e.state as { ezUrl?: string } | null
  const path = new URLSearchParams(location.search).get('path')
  dispatchNav({ t: 'pop', url: state?.ezUrl ?? path ?? '/' })
})

/** The page as it reads in the header and the tab. Driven from `nav.url`
 *  rather than from the opening path, and painted here rather than only in
 *  `render()`: a navigation is not a snapshot, so nothing else would repaint. */
function paintPage(): void {
  const origin = snapshot?.targetOrigin.replace(/^https?:\/\//, '') ?? ''
  target.textContent = `${origin}${nav.url}`
  document.title = `eztweak · ${nav.url}`
}

function mountFrame(id: string, device: Device, into: ParentNode, label: string): Frame {
  const card = h('div', 'ez-card')
  const head = h('div', 'ez-card-head', label)
  head.title = '拖曳調整排列'
  const box = h('div', 'ez-screen')
  const wrap = h('div', 'ez-frame-wrap')
  const iframe = h('iframe', 'ez-frame')
  iframe.src = nav.url
  iframe.title = label
  wrap.appendChild(iframe)
  box.appendChild(wrap)
  card.append(head, box)
  into.appendChild(card)
  // Zoom starts at 0 rather than 1 so the first paint always announces itself
  // to the overlay, whatever it settles on.
  const frame: Frame = { id, card, box, wrap, iframe, device, zoom: 0 }
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
 *  session history, and every entry a preview owns is one the shell cannot
 *  answer for once that preview has been thrown away. */
function navigateFrame(frame: Frame, page: string): void {
  frame.iframe.contentWindow?.location.replace(page)
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
    toFrame(frame.id, {
      type: 'ez:viewport',
      preset: device.id,
      zoom: applied,
      scoped: multi,
    })
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
      hint: '選取頁面元素或範圍',
      keywords: ['element', 'pick', 'ref', 'reference', '元素', '指定', '參考', '框選'],
      icon: AlignSelectionIcon as IconNode,
      // The pointer is in the other document, so this can only ask. The answer
      // comes back as a message and lands here via the pick reducer.
      run: () => startPick('note'),
    },
    {
      id: 'new',
      label: 'New chat',
      hint: '開啟新對話',
      keywords: ['new', 'chat', 'clear', 'reset', 'context', '新對話', '清除', '重設'],
      icon: BubbleChatAddIcon as IconNode,
      // Only ACP mode has a context this can throw away. A CLI-driven agent owns
      // its own session, and clearing it is a thing the user does in the terminal.
      enabled: () => !!snapshot?.acp,
      // The note being typed survives: the slash menu takes only the `/new` out,
      // and the draft is what the fresh session is about to be asked.
      run: () => void newChat(),
    },
    {
      id: 'resume',
      label: 'Resume',
      hint: '回到之前的對話',
      keywords: ['resume', 'chat', 'history', 'past', '對話', '紀錄', '之前', '回到'],
      icon: BubbleChatOutcomeIcon as IconNode,
      // Nothing to resume onto without an agent, and nothing to resume *to*
      // while this review has only ever had the one conversation.
      enabled: () => !!snapshot?.acp && (snapshot.chats?.length ?? 0) > 1,
      run: () => void openResume(),
    },
  ],
  skills: () => fetchSkills(),
})
const note = noteAttach.editable
note.title = '寫補充說明（N）'

/** What the batch about to be sent will be answered by: the model, and whatever
 *  else the agent lets a session be set to.
 *
 *  One pill rather than a pill per option, and it names the model, because the
 *  model is the one of them worth a permanent line - and because the set is not
 *  a fixed size. Selecting a model with no effort levels and no Fast mode drops
 *  two options from the list, so a row of siblings would change height as the
 *  user picked through it, moving the composer under the cursor that was doing
 *  the picking. The rest live in the menu this opens, where a list that grows
 *  and shrinks costs nothing.
 *
 *  Built once, outside `render()`, for the same reason the note box is: a turn
 *  broadcasts a snapshot per streamed chunk, and a control rebuilt with each of
 *  them would swap the row being clicked out from under the pointer. */
const configPill = h('button', 'ez-config-pill')
configPill.setAttribute('aria-haspopup', 'menu')
configPill.setAttribute('aria-expanded', 'false')
const configMenu = h('div', 'ez-menu ez-menu-up')
configMenu.setAttribute('role', 'menu')
const configWrap = h('div', 'ez-config')
configWrap.hidden = true
configWrap.append(configPill, configMenu)

/** How much of the subscription is left, at the end of the row the agent and the
 *  model are on.
 *
 *  One window on the line, because there is room for one: whichever the review
 *  runs into first - see `tightestWindow`. Everything the agent reported is a
 *  hover away, the way `/usage` and `/status` print it, because "剩 88%" invites
 *  exactly one follow-up question and the answer is already in hand.
 *
 *  A hover card, not a menu: there is nothing in it to choose, so it opens on the
 *  pointer and on focus rather than on a click - which is also why the pill has no
 *  `title`. A native tooltip would open on top of the card that replaced it. */
const limitPill = h('button', 'ez-limit')
limitPill.type = 'button'
limitPill.setAttribute('aria-describedby', 'ez-usage-card')
const limitCard = h('div', 'ez-usage-card')
limitCard.id = 'ez-usage-card'
limitCard.setAttribute('role', 'tooltip')
const limitWrap = h('div', 'ez-usage')
limitWrap.hidden = true
limitWrap.append(limitPill, limitCard)

/** An answer the review needs before it does something it cannot undo.
 *
 *  In the sidebar rather than in a `confirm()`. A native dialog is the browser's,
 *  not this tool's: it cannot say which review it belongs to, it steals focus
 *  from the page being reviewed, and it cannot carry the one control that makes a
 *  recurring question bearable - a way to stop asking.
 *
 *  Built once and reused, like the composer: a card rebuilt under the pointer
 *  would move the button being clicked.
 *
 *  The checkbox only ever remembers a yes - see `confirm-skip.ts`. */
const confirmTitle = h('div', 'ez-notice-title')
const confirmBody = h('div', 'ez-notice-body')
const confirmSkip = h('input') as HTMLInputElement
confirmSkip.type = 'checkbox'
confirmSkip.id = 'ez-confirm-skip'
const confirmSkipLabel = h('label', 'ez-notice-skip')
confirmSkipLabel.htmlFor = confirmSkip.id
confirmSkipLabel.append(confirmSkip, h('span', '', '以後不再提醒'))
const confirmGo = h('button', 'ez-notice-go')
const confirmNo = h('button', 'ez-notice-no', '取消')
const confirmActions = h('div', 'ez-notice-actions')
confirmActions.append(confirmGo, confirmNo)
const confirmCard = h('section', 'ez-notice ez-confirm')
confirmCard.hidden = true
// The checkbox on its own line under the buttons, not beside them: it is a
// footnote to the whole question rather than a third answer to it, and at this
// width a row of three wraps anyway - into a checkbox floating off to the right,
// attached to nothing.
confirmCard.append(confirmTitle, confirmBody, confirmActions, confirmSkipLabel)

/** The conversations this review has had, to pick one to carry on from.
 *
 *  The same card as the one that asks before switching agent, in the same place
 *  and the same shape: both are the review stopping to put something in front of
 *  the user, and a second look for the second one would be a second thing to
 *  learn. Only the contents differ - a question there, a list here.
 *
 *  Opened by `/resume` rather than by a control kept on screen. A review normally
 *  has one conversation and stays on it; a permanent picker would be chrome that
 *  answers a question almost nobody is asking, in a sidebar where the room is
 *  wanted for the conversation itself. */
const resumeTitle = h('div', 'ez-notice-title', '回到之前的對話')
const resumeList = h('div', 'ez-notice-list')
resumeList.setAttribute('role', 'menu')
const resumeClose = h('button', 'ez-notice-x')
resumeClose.title = '關閉'
resumeClose.setAttribute('aria-label', '關閉')
resumeClose.append(icon(Cancel01Icon as IconNode, 13))
const resumeCard = h('section', 'ez-notice ez-resume')
resumeCard.hidden = true
resumeCard.append(resumeClose, resumeTitle, resumeList)

interface ChatListWire {
  id: string
  startedAt: number
  entries: number
  current: boolean
  title?: string
}

let resumeRows: HTMLElement[] = []

/** Which row the arrow is on. Exactly one, always: the arrow is not decoration
 *  on every line, it is the pointer that says which line the keyboard is about
 *  to open. */
function pointAtResumeRow(row: HTMLElement): void {
  for (const other of resumeRows) other.toggleAttribute('data-active', other === row)
}

function closeResume(): void {
  resumeCard.hidden = true
}

async function openResume(): Promise<void> {
  // Drawn from what is known before the request lands, so the card appears with
  // the keypress rather than after a round trip to the filesystem and back.
  resumeList.textContent = ''
  resumeCard.hidden = false
  const res = await api('/acp/chats')
  if (!res.ok) {
    closeResume()
    return
  }
  const { chats } = (await res.json()) as { chats: ChatListWire[] }
  resumeList.textContent = ''
  resumeRows = chats.map((chat) => {
    const row = h('button', 'ez-notice-row')
    row.setAttribute('role', 'menuitemradio')
    row.setAttribute('aria-checked', String(chat.current))
    if (chat.current) row.dataset.current = ''
    // The title leads and the time follows it, because the title is what is
    // being read and the time is what tells two alike ones apart. A conversation
    // with neither a name nor anything said in it has only its time, which is
    // then the whole row rather than a caption under a blank.
    row.append(
      icon(ArrowRight02Icon as IconNode, 12),
      h('span', 'ez-notice-row-name', chat.title || chatTime(chat.startedAt)),
      h('span', 'ez-notice-row-when', chat.title ? chatTime(chat.startedAt) : ''),
    )
    // Pointer and keyboard write the same state, which is what keeps the arrow
    // single: hover alone would leave a second one behind wherever focus sits.
    row.addEventListener('pointerenter', () => pointAtResumeRow(row))
    row.addEventListener('focus', () => pointAtResumeRow(row))
    row.title = chat.entries ? `${chat.entries} 則` : '尚無內容'
    row.onclick = () => {
      closeResume()
      if (!chat.current) void switchChat(chat.id)
    }
    resumeList.append(row)
    return row
  })
  resumeCard.hidden = chats.length === 0
  // Arrow keys walk the list from wherever focus is, so it has to start in it -
  // which is also what puts the arrow on the first row.
  resumeRows[0]?.focus()
}

resumeCard.onkeydown = (e) => {
  if (walkMenu(e, resumeRows)) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    closeResume()
  }
}
resumeClose.onclick = () => closeResume()

/** Every notice the review raises, in one place: floating at the foot of the
 *  thread, hard against the rule above the composer.
 *
 *  It overlaps the thread rather than pushing it, which is the point - a notice
 *  is momentary and the conversation under it is not, so nothing below it moves
 *  when one arrives or goes, and the composer never jumps out from under the
 *  cursor. Covering the last message or two is the price, and it is the right
 *  way round: the notice is what wants reading now. */
const notices = h('div', 'ez-notices')
notices.append(banner, updateCard, resumeCard, confirmCard)

interface ConfirmOffer {
  /** What is being asked, not what it says: the answer is remembered under this,
   *  so a reworded question keeps the answer the user already gave. */
  key: string
  title: string
  body: string
  go: string
}

let answerConfirm: ((ok: boolean) => void) | null = null

function closeConfirm(ok: boolean, offer?: ConfirmOffer): void {
  const answer = answerConfirm
  answerConfirm = null
  confirmCard.hidden = true
  if (offer) rememberConfirm(localStorage, offer.key, { ok, skip: confirmSkip.checked })
  answer?.(ok)
}

function askConfirm(offer: ConfirmOffer): Promise<boolean> {
  if (confirmSkipped(localStorage, offer.key)) return Promise.resolve(true)
  // A second question replaces the first, which is answered no: the card is one
  // card, and leaving a caller waiting on a card nobody can see would hang it.
  answerConfirm?.(false)
  answerConfirm = null
  confirmTitle.textContent = offer.title
  confirmBody.textContent = offer.body
  confirmGo.textContent = offer.go
  confirmSkip.checked = false
  confirmCard.hidden = false
  confirmGo.onclick = () => closeConfirm(true, offer)
  confirmNo.onclick = () => closeConfirm(false, offer)
  confirmCard.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeConfirm(false, offer)
    }
  }
  confirmGo.focus()
  return new Promise<boolean>((resolve) => {
    answerConfirm = resolve
  })
}

/** The agent and its model, on one line above the composer. */
const controlRow = h('div', 'ez-control-row')
controlRow.hidden = true
controlRow.append(agentWrap, configWrap, limitWrap)

queueSection.append(queueScroll, controlRow, noteAttach.wrap, sendBtn)

/** The editor for a queued annotation: the row's own comment, in place. One
 *  composer, built once and moved into whichever row is open - nothing else on
 *  screen, because the row already says which annotation this is and which number
 *  it holds.
 *
 *  It can live in a row now because `paintQueue` only rebuilds the queue when the
 *  annotations themselves change. A rebuild still moves this between parents,
 *  which costs the caret but not the text - it is the same element either way -
 *  and the only thing that triggers one mid-edit is annotating something new,
 *  which takes the focus into the page regardless. */
const editAttach = attachify({
  api: API,
  mk: h,
  className: 'ez-qi-input',
  // Worded as the page popup's, which asks the same question of the same kind of
  // text, and puts the keys in the field rather than on a line of their own.
  placeholder: `想怎麼調整？輸入 / 用指令（${MOD_LABEL}+Enter 儲存）`,
  // The box grows with what is typed into it, and the queue's height budget is
  // what decides whether the row it grew into is still whole on screen.
  onChange: () => {
    paintEditState()
    capQueue()
  },
})

/** Capture on the composer's wrapper, so this outranks both the slash menu inside
 *  it and the shell's own table outside: while a comment is being edited,
 *  Cmd+Enter is this save rather than the batch send, and Escape is this cancel
 *  rather than a blur. The slash menu is a layer within this one, so it goes
 *  first. */
editAttach.wrap.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (!editAttach.closeSlash()) closeEdit('cancelled')
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      void saveEdit()
    }
  },
  true,
)

// ------------------------------------------------------------------- fork chip

/** Where the review is, when it is not on the main line.
 *
 *  A branch and the conversation it came from are the same shape - same thread,
 *  same composer - and the only thing that told them apart was which messages
 *  happened to be in view. That is not a signal, it is a coincidence. So a
 *  branch says so: a breadcrumb held in the top corner of the thread, and a way
 *  back through it.
 *
 *  Absolute rather than a bar of its own. A permanent row would cost the thread
 *  a strip of height on every review, to say something that is true on almost
 *  none of them; floating in the corner costs nothing until there is something
 *  to say. The thread scrolls under it, which is why it carries a ground. */
const forkBar = h('nav', 'ez-fork-bar')
forkBar.hidden = true
forkBar.setAttribute('aria-label', '目前的對話位置')
/** The way back to the review itself. A branch's most likely exit by far, so it
 *  is a click rather than a click-then-choose. */
const forkRoot = h('button', 'ez-fork-root')
/** The conversation being read, and the trigger for everything else it could
 *  be. The current crumb is the natural place for it: a breadcrumb's last item
 *  is where you are, so opening a list of the others from it needs no second
 *  control. */
const forkChip = h('button', 'ez-fork-here')
forkChip.setAttribute('aria-haspopup', 'menu')
forkChip.setAttribute('aria-expanded', 'false')
const forkName = h('span', 'ez-fork-name')
forkChip.append(icon(MagicWand01Icon as IconNode, 13), forkName)

const forkMenu = h('div', 'ez-menu ez-fork-menu')
forkMenu.setAttribute('role', 'menu')
forkMenu.setAttribute('aria-label', '回到某個對話')
forkMenu.hidden = true

let forkRows: HTMLElement[] = []
let forkOpen = false

/** Which row the arrow is on. The same single-pointer rule the resume card has:
 *  hover and the arrow keys write one piece of state between them, so the list
 *  never shows two answers to "which row is the keyboard about to open". */
function pointAtForkRow(row: HTMLElement): void {
  for (const other of forkRows) other.toggleAttribute('data-active', other === row)
}

function closeFork(focusChip = false): void {
  forkOpen = false
  forkMenu.hidden = true
  forkChip.setAttribute('aria-expanded', 'false')
  if (focusChip) forkChip.focus()
}

/** The top of the tree this conversation belongs to: walk up until a chat has
 *  no parent. A review can have several - `/new` starts one each time - and a
 *  branch belongs to exactly one of them. Bounded, because a parent chain read
 *  off the wire is not this code's to trust with an unbounded walk. */
function rootOf(chat: ChatWire, chats: ChatWire[]): ChatWire {
  let at = chat
  for (let hops = 0; at.parentChatId && hops < 32; hops += 1) {
    const parent = chats.find((c) => c.id === at.parentChatId)
    if (!parent) break
    at = parent
  }
  return at
}

/** The name a conversation goes by here. A branch is named by what it was opened
 *  to do, because that is what the user will be looking for when they come back
 *  to it; the line it came off is the main one.
 *
 *  `isRoot` means "the top of the tree being shown", not "the review's first
 *  conversation". Everything this control draws is scoped to one tree, so there
 *  is only ever one of these on screen and 主對話 is unambiguous - while inside
 *  a branch, the line you came off *is* the main conversation, whether or not
 *  the review happened to start there. */
function chatName(chat: ChatWire, isRoot: boolean): string {
  if (chat.parentChatId) return chat.title ?? '分支對話'
  return isRoot ? '主對話' : (chat.title ?? '對話')
}

/** What the branch was about - the element, for an explore - which is what tells
 *  two of them apart when both are called 探索樣式. */
function chatDetail(chat: ChatWire): string {
  return chat.detail ?? chatTime(chat.startedAt)
}

function openFork(): void {
  const s = snapshot
  if (!s?.chats) return
  // Oldest first, so the line this branch came off is at the top and the
  // branches read as having come off it in the order they were opened. The
  // picker's own order, not the header's - this is a tree being read, not a
  // history being scrolled.
  const all = [...s.chats].reverse()
  const current = all.find((c) => c.current)
  // One tree only. `/new` starts a separate conversation with branches of its
  // own, and stepping from inside this branch into one of those is not going
  // back - it is going somewhere else entirely, which `/resume` is for. What
  // this control offers is where you are and what you came from.
  const here = current ? rootOf(current, all) : undefined
  // The branches that came off this line, and only those. Two exclusions.
  //
  // The line itself, because it already has a crumb a few pixels to the left and
  // offering the same destination twice is not a choice.
  //
  // And branches of branches. `/explore` forks from wherever the review is, so
  // exploring from inside an explore goes a level deeper - real reviews reach
  // five - but those are somewhere the user went *from* a fork rather than
  // somewhere to go *to* from here. The breadcrumb still names whichever one is
  // current, however deep it sits; this list stays one level so it reads as a
  // set of siblings rather than a tree to navigate.
  const chats = all.filter((c) => c.parentChatId && (here ? c.parentChatId === here.id : false))
  forkMenu.textContent = ''
  forkRows = chats.map((chat) => {
    const row = h('button', 'ez-notice-row ez-fork-row')
    row.setAttribute('role', 'menuitemradio')
    row.setAttribute('aria-checked', String(chat.current))
    if (chat.current) row.dataset.current = ''

    row.append(
      icon(ArrowRight02Icon as IconNode, 12),
      h('span', 'ez-notice-row-name', chatName(chat, false)),
      h('span', 'ez-notice-row-when', chatDetail(chat)),
    )
    row.addEventListener('pointerenter', () => pointAtForkRow(row))
    row.addEventListener('focus', () => pointAtForkRow(row))
    row.onclick = () => {
      closeFork()
      if (!chat.current) void switchChat(chat.id)
    }
    forkMenu.append(row)
    return row
  })
  forkOpen = true
  forkMenu.hidden = false
  forkChip.setAttribute('aria-expanded', 'true')
  // Into the list, which is also what puts the arrow on a row: the keyboard is
  // the point of this control, the same as the resume card's.
  ;(forkRows.find((r) => 'current' in r.dataset) ?? forkRows[0])?.focus()
}

forkChip.onclick = () => (forkOpen ? closeFork() : openFork())
forkRoot.onclick = () => {
  const chats = [...(snapshot?.chats ?? [])].reverse()
  const current = chats.find((c) => c.current)
  if (!current) return
  const root = rootOf(current, chats)
  if (!root.current) void switchChat(root.id)
}
forkMenu.onkeydown = (e) => {
  if (walkMenu(e, forkRows)) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    closeFork(true)
  }
}
forkMenu.addEventListener('focusout', () => {
  // The whole control is one focus scope: leaving it closes it, but moving
  // between its own rows must not.
  queueMicrotask(() => {
    if (
      forkOpen &&
      !forkMenu.contains(document.activeElement) &&
      document.activeElement !== forkChip
    ) {
      closeFork()
    }
  })
})

/** Which chat the thread is drawing, so the next render can tell whether the
 *  review went deeper, came back, or merely got another message. */
let shownChatId: string | null = null

function paintFork(s: SnapshotWire): void {
  const chats = s.chats ?? []
  const current = chats.find((c) => c.current)
  const onBranch = !!current?.parentChatId
  forkBar.hidden = !onBranch
  if (!onBranch) {
    if (forkOpen) closeFork()
    shownChatId = current?.id ?? null
    return
  }
  // The crumb always starts at the review itself, not at the immediate parent:
  // branches can nest, and "探索樣式 › 探索樣式" says nothing about where the
  // user is being offered a way back to. Nothing stands for the levels in
  // between - there is no rung to step onto there, and an ellipsis that opens
  // nothing is a control that lies. The popover lists them.
  //
  // Named by what kind of session it is. The element it was opened on is more
  // identifying, and was tried - but it is long, it carries the viewport tag,
  // and one crumb's worth of it crowds a line whose job is to say "you are one
  // level down". The element is a keystroke away in the popover.
  const here = chatName(current, false)
  const root = rootOf(current, chats)
  const rootName = chatName(root, true)
  forkRoot.textContent = rootName
  forkRoot.title = `回到${rootName}`
  forkName.textContent = here
  forkChip.title = `${here} · 點一下切換對話`
}

/** The thread moved between conversations. Push it sideways, in the direction
 *  the review actually went: into a branch it enters from the right, back out of
 *  one it enters from the left. Exit the way it entered, which is what makes the
 *  gesture legible rather than decorative.
 *
 *  An animation rather than a transition: this is a view arriving whole, not a
 *  value being retargeted, and it has to stay smooth across the re-render and
 *  the round trip that caused it. Retriggered by taking the attribute off and
 *  putting it back, so two switches in a row both play. */
function pushThread(s: SnapshotWire): void {
  const chats = s.chats ?? []
  const current = chats.find((c) => c.current)
  if (!current || current.id === shownChatId) return
  const was = shownChatId
  shownChatId = current.id
  if (!was) return
  const deeper = current.parentChatId === was
  const back = chats.find((c) => c.id === was)?.parentChatId === current.id
  convScroll.removeAttribute('data-enter')
  void convScroll.offsetWidth
  convScroll.dataset.enter = deeper ? 'deeper' : back ? 'back' : 'swap'
}

const convSection = h('section', 'ez-section ez-conv-section')
const convList = h('div', 'ez-conv')
const convScroll = h('div', 'ez-fade ez-conv-scroll')
convScroll.appendChild(convList)

const forkSep = h('span', 'ez-fork-sep')
forkSep.append(icon(ChevronRightIcon as IconNode, 10))
forkBar.append(forkRoot, forkSep, forkChip, forkMenu)
// Above the thread and in the flow, so the conversation starts below it rather
// than under it: a breadcrumb is where you *are*, which is part of the page
// rather than something floating over it.
convSection.append(forkBar, convScroll, notices)

const resizer = h('div', 'ez-resizer')
resizer.tabIndex = 0
resizer.setAttribute('role', 'separator')
resizer.setAttribute('aria-orientation', 'vertical')
resizer.setAttribute('aria-valuemin', String(SIDEBAR_MIN))
resizer.setAttribute('aria-label', '調整側邊欄寬度')
resizer.title = '拖曳調整寬度，雙擊還原'

sidebar.append(resizer, sideHead, convSection, queueSection)
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
    else if (clientY > stageEdge.bottom - PAN_EDGE)
      dy = creep(clientY - stageEdge.bottom + PAN_EDGE)
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

/** A narrower sidebar rewraps every queued comment, so the two rows the queue's
 *  height budget is measured from are no longer the height they were. `paintQueue`
 *  only measures when the rows themselves change, which a resize is not.
 *
 *  Kept out of `paintSidebarWidth` because that also runs once at module init,
 *  before the fade painters `capQueue` reaches for have been assigned. */
function resizeSidebar(width: number): void {
  preferredWidth = clampSidebar(width)
  paintSidebarWidth()
  capQueue()
}

/** Left out of `resizeSidebar`: a drag calls that on every pointer move, and
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
  capQueue()
})

resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  const startX = e.clientX
  const startWidth = sidebar.getBoundingClientRect().width
  // Capture rather than a document-level listener: the pointer spends most of
  // the drag over the iframe, which would otherwise swallow every move.
  resizer.setPointerCapture(e.pointerId)
  document.body.classList.add('ez-resizing')
  const move = (ev: PointerEvent) => resizeSidebar(startWidth + startX - ev.clientX)
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
  resizeSidebar(SIDEBAR_DEFAULT)
  persistSidebarWidth()
})

resizer.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 48 : 16
  if (e.key === 'ArrowLeft') resizeSidebar(sidebar.getBoundingClientRect().width + step)
  else if (e.key === 'ArrowRight') resizeSidebar(sidebar.getBoundingClientRect().width - step)
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
  dispatchPick({
    t: 'arm',
    id: `s${++pickSeq}-${Date.now().toString(36)}`,
    host,
    now: Date.now(),
  })
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
  return fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
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

/** Keep the usage figure honest.
 *
 *  It goes stale for a reason the review cannot see: the allowance is the
 *  account's, and a terminal session in another window spends it just as fast as
 *  a turn here does. So the moments to ask are the moments the number is about
 *  to be read - the window coming back to the front, and the tab becoming
 *  visible again - plus a slow beat for a window left open and watched.
 *
 *  Only while visible: a sidebar behind another window is not being read, and
 *  waking a process every minute to update a figure nobody is looking at is the
 *  kind of thing that costs a laptop its afternoon. The daemon throttles anyway,
 *  so asking twice in a second is free.
 *
 *  Nothing here waits on the answer: it arrives as a new snapshot, the same way
 *  every other change does. */
const LIMIT_BEAT_MS = 120_000

function refreshLimit(): void {
  if (document.visibilityState !== 'visible' || !snapshot?.acp) return
  void api('/acp/limit', { method: 'POST' }).catch(() => {})
}

window.addEventListener('focus', refreshLimit)
document.addEventListener('visibilitychange', refreshLimit)
setInterval(refreshLimit, LIMIT_BEAT_MS)

async function sendBatch(): Promise<void> {
  if (sending || noteAttach.pending() > 0) return
  const count = snapshot?.annotations.length ?? 0
  const attachments = noteAttach.ids()
  const references = noteAttach.refs()
  const text = noteAttach.text()
  const skills = noteAttach.skills()
  // A skill on its own is a request: "run this over what you can see" needs no
  // annotation and no note.
  if (
    count === 0 &&
    !text &&
    attachments.length === 0 &&
    references.length === 0 &&
    !skills.length
  ) {
    return
  }
  // Called off before the box is emptied: an answer arriving after the reset
  // would land in a composer that no longer holds the comment it belonged to.
  abortPick('sent')
  sending = true
  sendBtn.disabled = true
  try {
    const res = await api('/send', {
      method: 'POST',
      body: JSON.stringify({
        note: text,
        attachments,
        references,
        ...(skills.length ? { skills } : {}),
      }),
    })
    // Reset, not discard: the batch owns these files now. The skill chip goes
    // with the rest of the box - it was this batch's, and a later one that wants
    // it can say so.
    if (res.ok) noteAttach.reset()
  } finally {
    // Restored even when the request threw: the note and its chips are still
    // there, so the send has to stay retryable.
    sending = false
    paintSendState()
  }
}

/** Which row is open for editing. One at a time - there is one composer, and it
 *  is wherever it is. */
let editing: {
  id: string
  /** Files the annotation already had when the edit opened. What is chipped in the
   *  box and *not* in this set was uploaded during the edit, so a cancel owns
   *  it. */
  owned: Set<string>
} | null = null
let editSaving = false
/** The open row's tick, which `paintQueue` rebuilds - so it is re-pointed there
 *  rather than held. Null whenever no row is open. */
let editSave: HTMLButtonElement | null = null

function paintEditState(): void {
  if (!editing || !editSave) return
  const empty = !editAttach.text() && !editAttach.ids().length && !editAttach.refs().length
  editSave.disabled = editSaving || empty || editAttach.pending() > 0
}

/** Turn a queued row's comment into a box, seeded with exactly what it was
 *  showing - chips where the sentence had them. */
function openEdit(a: AnnotationWire): void {
  if (editing?.id === a.id) return
  closeEdit('switched')
  editing = {
    id: a.id,
    owned: new Set((a.attachments ?? []).map((f) => f.id)),
  }
  // Draws the row around the composer, which is what puts it in the document.
  render()
  // Focused before the seeding, and both only once it is on screen: `restore`
  // leaves the caret past the last node, and a selection set on a detached
  // element is silently dropped - the box would then open with the caret at
  // offset 0 and typing would land in front of the comment.
  editAttach.editable.focus()
  editAttach.restore(bodyFromComment(a.comment, a.references ?? [], a.attachments ?? []))
  paintEditState()
}

/** Tear the editor down. `reason` decides who owns the files chipped in it: a
 *  cancelled edit never happened, so anything uploaded during it belongs to
 *  nobody and goes now rather than waiting a day for the sweep. A saved or
 *  vanished one has already handed them over. */
function closeEdit(reason: 'cancelled' | 'saved' | 'switched' | 'gone'): void {
  const at = editing
  if (!at) return
  editing = null
  editSaving = false
  if (reason === 'cancelled' || reason === 'switched') {
    for (const id of editAttach.ids()) {
      if (!at.owned.has(id)) void api(`/attachments/${id}`, { method: 'DELETE' })
    }
  }
  // `reset`, not `discard`: the files this box still holds belong to the
  // annotation, and only the ones the edit itself added were just collected.
  editAttach.reset()
  editSave = null
  // A vanished annotation is already being redrawn by the render that noticed it.
  if (reason !== 'gone') render()
}

/** Saves the whole comment - text, files and picked elements - because all three
 *  are one walk of the box and cannot be sent separately without going out of
 *  step. The editor stays open if the request fails: the user's words are in it
 *  and nowhere else. */
async function saveEdit(): Promise<void> {
  const at = editing
  if (!at || editSaving || editSave?.disabled !== false) return
  editSaving = true
  paintEditState()
  try {
    const res = await api(`/annotations/${at.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        comment: editAttach.text(),
        attachments: editAttach.ids(),
        references: editAttach.refs(),
      }),
    })
    if (!res.ok) return
    closeEdit('saved')
  } finally {
    editSaving = false
    paintEditState()
  }
}

/** Stop the turn the agent is in the middle of. A 409 means the turn ended
 *  between the click and the request, which is the outcome asked for anyway - the
 *  snapshot that follows says what actually happened, so nothing is reported. */
async function cancelTurn(): Promise<void> {
  const acp = snapshot?.acp
  if (acp?.state !== 'working' || acp.cancelling) return
  await api('/acp/cancel', { method: 'POST' })
}

/** Throw away the agent's context and carry on in a fresh session. No
 *  confirmation: the thread keeps every word of the review either way, and what
 *  is being dropped is the agent's memory of it - which is what the user just
 *  asked to drop. */
async function newChat(): Promise<void> {
  if (!snapshot?.acp) return
  await api('/acp/new', { method: 'POST' })
}

// ---------------------------------------------------------------- menu keys

/** Whose agent this is, as a mark before its name.
 *
 *  Nothing at all for one this does not recognise: a custom ACP command is a
 *  real thing to be running, and a wrong badge would be worse than none. */
function brandMark(brand: AgentBrand | undefined, size: number): HTMLElement[] {
  if (!brand) return []
  const mark = h('span', 'ez-brand-mark')
  mark.append(icon((brand === 'claude' ? ClaudeIcon : ChatGptIcon) as IconNode, size))
  return [mark]
}

/** The mark on the chosen row, at its right edge. Always built, never
 *  conditionally: the space it takes is what stops the names stepping sideways
 *  as the choice moves, and CSS shows it only on the row that is on. */
function menuCheck(): HTMLElement {
  const check = h('span', 'ez-menu-check')
  check.append(icon(CheckIcon as IconNode, 14))
  return check
}

/** Line a menu up under the control that opened it, without letting it leave the
 *  sidebar.
 *
 *  CSS alone can do one or the other. Anchored to its own control a menu sits
 *  where it belongs but `width: max-content` carries it off the right edge;
 *  anchored to the row it is bounded but sits under whichever control happens to
 *  be first. The row stays the containing block - that is what makes the bound
 *  statable - and the offset is measured, which is the one number CSS cannot
 *  know. */
function placeMenu(pill: HTMLElement, menu: HTMLElement): void {
  const row = pill.offsetParent as HTMLElement | null
  if (!row) return
  const rightmost = Math.max(0, row.clientWidth - menu.offsetWidth)
  menu.style.left = `${Math.min(pill.offsetLeft, rightmost)}px`
}

/** Arrows walk the rows. True when the press was taken.
 *
 *  A menu opens with nothing focused: the chosen row is marked by its tick, and
 *  focusing it on open would paint it with the focus fill - which is the very
 *  background the chosen row is meant not to have. So the first press enters the
 *  list from whichever end it came from. */
function walkMenu(e: KeyboardEvent, rows: HTMLElement[]): boolean {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false
  if (!rows.length) return false
  const down = e.key === 'ArrowDown'
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const next =
    at === -1 ? (down ? 0 : rows.length - 1) : (at + (down ? 1 : -1) + rows.length) % rows.length
  rows[next]?.focus()
  e.preventDefault()
  return true
}

// -------------------------------------------------------------- agent picker

interface AgentWire {
  id: string
  name: string
  installed: boolean
  current: boolean
}

let agentMenuOpen = false
let agentsDrawn: string | null = null
let agents: AgentWire[] = []
let agentRows: HTMLElement[] = []

function paintAgentMenuState(): void {
  agentWrap.toggleAttribute('data-open', agentMenuOpen)
  agentPill.setAttribute('aria-expanded', String(agentMenuOpen))
}

function closeAgentMenu(): void {
  if (!agentMenuOpen) return
  agentMenuOpen = false
  paintAgentMenuState()
}

agentPill.onclick = () => {
  agentMenuOpen = !agentMenuOpen
  paintAgentMenuState()
  if (!agentMenuOpen) return
  placeMenu(agentPill, agentMenu)
  // Again once the list is in: its width is what the placement is clamped to.
  void loadAgents().then(() => placeMenu(agentPill, agentMenu))
}

document.addEventListener('click', (e) => {
  if (e.target instanceof Node && !agentWrap.contains(e.target)) closeAgentMenu()
})

agentMenu.addEventListener('keydown', (e) => {
  if (walkMenu(e, agentRows)) return
  if (e.key !== 'Escape') return
  closeAgentMenu()
  agentPill.focus()
  e.preventDefault()
})

/** Which agent the review is on, read off the snapshot rather than off the list
 *  fetched from `/acp/agents`.
 *
 *  The list says which agents exist and which are installed - facts that change
 *  when the machine changes, not when the review does. Which one is *running* is
 *  the snapshot's to say, and taking it from the list instead left the name stale
 *  until something happened to refetch it: switching agent repainted from a
 *  cached `current` that still named the old one. */
function runningAgentId(): string | undefined {
  return agentProfileFor(snapshot?.acp?.agent ?? '')?.id
}

async function loadAgents(): Promise<void> {
  const res = await api('/acp/agents')
  if (!res.ok) return
  agents = ((await res.json()) as { agents: AgentWire[] }).agents
  paintAgents()
}

/** Confirmed, and this is the one control here that asks. Changing agent cannot
 *  carry the conversation: a session id belongs to the agent that issued it, and
 *  no protocol hands a conversation from one to another - so the new agent
 *  starts knowing nothing, and that is worth saying before it happens rather
 *  than reporting afterwards. */
async function switchAgent(agent: AgentWire): Promise<void> {
  closeAgentMenu()
  if (agent.id === runningAgentId()) return
  const ok = await askConfirm({
    // Keyed on the act, not on which agent: the reason is the same whichever
    // way the switch goes, so answering it once answers it for all of them.
    key: 'switch-agent',
    title: `確定要改用 ${agent.name}？`,
    body: '切換 Agent 會開啟新對話，遺失現有上下文。',
    go: `改用 ${agent.name}`,
  })
  if (!ok) return
  await api('/acp/agent', {
    method: 'POST',
    body: JSON.stringify({ id: agent.id }),
  })
}

function paintAgents(): void {
  const command = snapshot?.acp?.agent ?? ''
  const runningId = runningAgentId()
  // Only what is actually on this machine, plus whatever is running: an agent
  // that is not installed is not a choice, but one the review is already on has
  // to be in the list it is ticked in.
  const shown = agents.filter((a) => a.installed || a.id === runningId)

  const signature = JSON.stringify([shown, command])
  if (signature === agentsDrawn) return
  agentsDrawn = signature

  agentPill.textContent = ''
  agentPill.append(
    ...brandMark(agentBrandFor(command), 14),
    h('span', 'ez-agent-name', agentProfileFor(command)?.name ?? 'Agent'),
    icon(ChevronDownIcon as IconNode, 12),
  )

  agentMenu.textContent = ''
  agentRows = shown.map((agent) => {
    const on = agent.id === runningId
    const row = h('button', 'ez-menu-item')
    row.setAttribute('role', 'menuitemradio')
    row.setAttribute('aria-checked', String(on))
    if (on) row.dataset.current = ''
    // This row's own brand, not the running one's: the whole point of the menu
    // is the agents it is not on.
    const brand = AGENT_PROFILES.find((p) => p.id === agent.id)?.brand
    row.append(...brandMark(brand, 15), h('span', 'ez-menu-name', agent.name), menuCheck())
    row.onclick = () => void switchAgent(agent)
    agentMenu.append(row)
    return row
  })
}

// ------------------------------------------------------------------- skills

interface SkillWire {
  name: string
  description: string
  source: 'project' | 'user' | 'plugin'
}

async function fetchSkills(): Promise<SlashCommand[]> {
  // Only ACP mode has an agent to hand a skill to; a poll-mode agent is running
  // somebody else's loop and a slash command means nothing to it.
  if (!snapshot?.acp) return []
  const res = await api('/acp/skills')
  if (!res.ok) return []
  const { skills } = (await res.json()) as { skills: SkillWire[] }
  // No glyph and no source label. The row is the name the user is about to type,
  // and a column of identical lightning bolts beside a list of skills says only
  // that they are all skills, which the `$` already said. Where a skill came from
  // is not what anyone is choosing on - it stays searchable through `keywords`,
  // which is where the description lives too.
  //
  // The one already chosen is marked, because this is a list of which skill the
  // batch runs and not a list of skills to collect: a batch runs one, so picking
  // a second is changing the answer. Saying so here is what makes the swap in the
  // box read as a swap.
  return skills.map((skill) => ({
    id: skill.name,
    label: skill.name,
    keywords: [skill.description],
    run: () => noteAttach.insertSkill(skill.name),
  }))
}

// --------------------------------------------------------------- chat picker

/** When a conversation happened, in as few characters as say which one it is.
 *  A date only once the day stops being today - the time alone is what tells two
 *  of this afternoon's apart, and the date would be the same on both. */
function chatTime(at: number): string {
  const when = new Date(at)
  const clock = `${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate()
  return sameDay ? clock : `${when.getMonth() + 1}/${when.getDate()} ${clock}`
}

async function switchChat(id: string): Promise<void> {
  await api('/acp/chat', { method: 'POST', body: JSON.stringify({ id }) })
}

// -------------------------------------------------------------- agent config

let configMenuOpen = false
/** What the control currently draws. `render()` runs on every snapshot, and the
 *  option list is unchanged across almost all of them - so without this the rows
 *  are rebuilt under a pointer that is on its way to one of them. */
let configDrawn: string | null = null

function paintConfigMenuState(): void {
  configWrap.toggleAttribute('data-open', configMenuOpen)
  configPill.setAttribute('aria-expanded', String(configMenuOpen))
}

function closeConfigMenu(): void {
  if (!configMenuOpen) return
  configMenuOpen = false
  paintConfigMenuState()
}

configPill.onclick = () => {
  configMenuOpen = !configMenuOpen
  paintConfigMenuState()
  if (configMenuOpen) placeMenu(configPill, configMenu)
}

document.addEventListener('click', (e) => {
  if (e.target instanceof Node && !configWrap.contains(e.target)) closeConfigMenu()
})

configWrap.addEventListener('focusout', (e) => {
  const to = e.relatedTarget
  if (to instanceof Node && configWrap.contains(to)) return
  closeConfigMenu()
})

configMenu.addEventListener('keydown', (e) => {
  if (walkMenu(e, [...configMenu.querySelectorAll<HTMLElement>('.ez-menu-item')])) return
  if (e.key !== 'Escape') return
  closeConfigMenu()
  configPill.focus()
  e.preventDefault()
})

/** Set one option. The menu closes on the click rather than on the answer: the
 *  request is a round trip to a child process, and a menu that sat open through
 *  it would read as a click that did not land. What actually changed arrives in
 *  the next snapshot, which is the only thing the control draws from - so a
 *  refusal simply leaves the value where it was. */
async function setConfig(configId: string, value: AcpConfigValue): Promise<void> {
  closeConfigMenu()
  await api('/acp/config', {
    method: 'POST',
    body: JSON.stringify({ configId, value }),
  })
}

/** The option the pill names. The model, when the agent offers one - it is the
 *  choice with consequences the user is tracking. Falling back to the first
 *  option rather than to nothing keeps the control meaningful on an agent whose
 *  options we have never seen. */
function pillOption(options: SessionConfigOption[]): SessionConfigOption | undefined {
  return options.find((o) => o.category === 'model') ?? options[0]
}

/** The line, and the card behind it. Rebuilt whole on every snapshot: it is four
 *  rows of text with nothing to preserve between paints - no focus, no scroll, no
 *  selection - and the figures on it move on their own. */
function paintLimit(acp: AcpWire | undefined): void {
  const limit = acp?.limit
  const line = usageNote(limit)
  limitWrap.hidden = !line
  if (!line) return
  limitPill.textContent = line

  const plan = planName(limit?.plan)
  const head = h('div', 'ez-usage-head')
  head.append(h('span', 'ez-usage-title', '用量'))
  if (plan) head.append(h('span', 'ez-usage-plan', plan))

  limitCard.replaceChildren(head)
  for (const row of usageRows(limit)) {
    const top = h('div', 'ez-usage-line')
    top.append(
      h('span', 'ez-usage-label', row.label),
      h('span', 'ez-usage-left', `剩 ${row.percent}%`),
    )
    const fill = h('i')
    fill.style.width = `${row.used}%`
    const bar = h('div', 'ez-usage-bar')
    bar.append(fill)
    const item = h('div', 'ez-usage-row')
    if (row.low) item.dataset.low = ''
    item.append(top, bar)
    if (row.when) item.append(h('div', 'ez-usage-when', row.when))
    limitCard.append(item)
  }
}

function paintConfig(acp: AcpWire | undefined): void {
  const options = (acp?.configOptions ?? []).filter((o) => !HIDDEN_CATEGORIES.has(o.category ?? ''))
  // Nothing offered, or no ACP agent at all: no control. An empty panel above the
  // composer would be permanent chrome that answers no question.
  configWrap.hidden = options.length === 0
  if (options.length === 0) {
    closeConfigMenu()
    configDrawn = null
    return
  }
  // Between sessions - `/new`, or an agent still starting - there is no session
  // to set anything on. The pill keeps its label rather than emptying: it is
  // about to be the same one, and a control that blanks reads as a failure.
  const settable = acp?.state === 'idle' || acp?.state === 'working'
  configPill.disabled = !settable
  if (!settable) closeConfigMenu()

  const signature = JSON.stringify([options, settable])
  if (signature === configDrawn) return
  configDrawn = signature

  const named = pillOption(options)
  const label =
    named && named.type === 'select'
      ? shortConfigValueName(configValueName(named, named.currentValue))
      : (named && configLabel(named)) || ''
  configPill.textContent = ''
  configPill.append(h('span', 'ez-config-name', label), icon(ChevronDownIcon as IconNode, 12))
  // The qualifier the label dropped, plus the agent's own description of the
  // value - which is where "Best for everyday, complex tasks" lives.
  const full = named && named.type === 'select' ? configValueName(named, named.currentValue) : ''
  const detail =
    named && named.type === 'select'
      ? configValues(named).find((o) => o.value === named.currentValue)?.description
      : undefined
  configPill.title = [named ? configLabel(named) : '', full, detail].filter(Boolean).join(' · ')

  configMenu.textContent = ''
  for (const option of [...options].sort(byCategory)) {
    // A group per option, so the rule that separates one from the next is the
    // grouping itself rather than a mark placed on whichever row happens to come
    // first - and so a screen reader is told which option a row belongs to. A
    // heading alone would be neither: it is a div in a menu, announced to nobody.
    const group = h('div', 'ez-menu-group')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', configLabel(option))
    // A boolean is one row that is either on or off, so its own name is the row's
    // - a heading above a single row would say the same word twice. It still needs
    // the group's rule above it, or "Fast mode" sitting under six effort levels
    // reads as a seventh.
    if (option.type === 'boolean') {
      group.append(
        configRow(option, !option.currentValue, configLabel(option), option, option.currentValue),
      )
    } else {
      group.append(h('div', 'ez-menu-label', configLabel(option)))
      for (const value of configValues(option)) {
        group.append(
          configRow(option, value.value, value.name, value, value.value === option.currentValue),
        )
      }
    }
    configMenu.append(group)
  }
  if (configMenuOpen) placeMenu(configPill, configMenu)
}

/** Categories this picker does not offer.
 *
 *  The permission mode and the fast-mode toggle are the agent's own business:
 *  they are set where the agent is configured, and a review is not the place to
 *  be deciding them. A mode the *agent* changes is still reported - see
 *  `paintModeChange` - because silence was the actual problem with it, not the
 *  absence of a control. */
const HIDDEN_CATEGORIES = new Set(['mode', 'model_config'])

/** The order the rest are offered in. Sorting by category is what the spec says
 *  the field is for - "keyboard shortcuts, icons, placement" - and anything
 *  uncategorised keeps its place at the end, in the order the agent gave. */
const CATEGORY_ORDER = ['model', 'thought_level']

function byCategory(a: SessionConfigOption, b: SessionConfigOption): number {
  const rank = (o: SessionConfigOption) => {
    const at = CATEGORY_ORDER.indexOf(o.category ?? '')
    return at === -1 ? CATEGORY_ORDER.length : at
  }
  return rank(a) - rank(b)
}

/** A row named "Default" is the only one in a list whose own name does not say
 *  what it is. Where the agent reports what it resolves to, that answer replaces
 *  the qualifier the name came with - "Default (recommended)" becomes "Default
 *  (Opus · 1M context)", which is what the reader wanted the brackets to hold.
 *
 *  The agent's own text is kept whole; only its brackets are flattened, because
 *  nesting them inside ours reads worse than the separator this shell already
 *  uses for exactly this kind of qualifier.
 *
 *  Matched on the name as well as the value, because `default` is elsewhere a
 *  real and self-explaining choice - it is what the permission mode calls
 *  "Manual", and that needs no expanding. */
function resolvedName(
  option: SessionConfigOption,
  value: AcpConfigValue,
  name: string,
  describes: { description?: string | null },
): string {
  const resolved = describes.description
  if (option.type !== 'select' || value !== 'default' || !/default/i.test(name) || !resolved) {
    return name
  }
  return `${name.replace(/\s*\([^)]*\)\s*$/, '')} (${resolved.replace(/\s*\(([^)]*)\)/g, ' · $1')})`
}

/** One settable row, in the vocabulary the header's menus already use: a tick
 *  column that holds its width whether or not there is a tick in it, so the
 *  names do not step sideways as the choice moves.
 *
 *  `describes` is whichever of the option or the value carries the sentence worth
 *  showing - for a select that is the value ("Sonnet 5 · Efficient for routine
 *  tasks"), for a boolean the option itself. */
function configRow(
  option: SessionConfigOption,
  value: AcpConfigValue,
  name: string,
  describes: { description?: string | null },
  on: boolean,
): HTMLElement {
  const row = h('button', 'ez-menu-item')
  row.setAttribute('role', option.type === 'boolean' ? 'menuitemcheckbox' : 'menuitemradio')
  row.setAttribute('aria-checked', String(on))
  if (on) row.dataset.current = ''
  row.append(h('span', 'ez-menu-name', resolvedName(option, value, name, describes)), menuCheck())
  if (describes.description) row.title = describes.description
  row.onclick = () => void setConfig(option.id, value)
  return row
}

/** Signature of what the queue currently draws. `render()` runs on every
 *  snapshot - an ACP turn broadcasts one per streamed chunk - and the queue is
 *  rebuilt from scratch, so without this a delete button is swapped out from under
 *  the pointer between mousedown and mouseup, and the row being edited loses the
 *  caret in it. The list is a handful of small objects, so stringifying it is
 *  cheaper than the DOM work it avoids. */
let queueDrawn: string | null = null

function paintQueue(annotations: AnnotationWire[]): void {
  // An annotation edited into a batch that has now been sent takes its editor
  // with it - there is nothing left to save it to.
  if (editing && !annotations.some((a) => a.id === editing?.id)) closeEdit('gone')
  const signature = JSON.stringify([editing?.id ?? null, annotations])
  if (signature === queueDrawn) return
  queueDrawn = signature

  queueList.textContent = ''
  annotations.forEach((a, i) => {
    const li = h('li', 'ez-queue-item')
    const head = h('div', 'ez-qi-head')
    head.append(h('span', 'ez-qi-num', String(i + 1)), h('span', 'ez-qi-label', annotationLabel(a)))
    // A chip, not part of the label: the label ellipsizes, and the width is the
    // one detail that must never be the thing that gets cut off.
    const vp = a.anchor.viewport
    if (vp?.width && vp.preset !== 'desktop') {
      head.append(h('span', 'ez-qi-vp', `${vp.width}px`))
    }
    // Their own group, so the space between the two is theirs to set and the
    // head's gap only has to hold them off the label.
    const acts = h('div', 'ez-qi-acts')
    // Editing borrows the two buttons the row already has rather than adding any:
    // the pencil becomes the tick that commits, and the cross - which dismisses
    // either way - becomes the one that backs out. Nothing appears or moves, so
    // there is no second place to look.
    const open = editing?.id === a.id
    const primary = h('button', `ez-qi-act ${open ? 'ez-qi-tick' : 'ez-qi-edit'}`)
    primary.append(
      open ? icon(CheckIcon as IconNode, TICK_ICON) : icon(Edit02Icon as IconNode, EDIT_ICON),
    )
    primary.title = open ? `儲存（${MOD_LABEL}+Enter）` : '改這則標註（送出前都還能改）'
    primary.onclick = open ? () => void saveEdit() : () => openEdit(a)
    const dismiss = h('button', 'ez-qi-act ez-qi-del')
    dismiss.append(icon(Cancel01Icon as IconNode, 13))
    dismiss.title = open ? '取消（Esc）' : '移除這則標註'
    dismiss.onclick = open
      ? () => closeEdit('cancelled')
      : () => void api(`/annotations/${a.id}`, { method: 'DELETE' })
    acts.append(primary, dismiss)
    head.append(acts)
    if (open) {
      li.dataset.editing = ''
      editSave = primary
      li.append(head, editAttach.wrap)
      queueList.appendChild(li)
      paintEditState()
      return
    }
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
      const rendered = commentEl(
        item.comment,
        item.references,
        item.attachments,
        undefined,
        entry.skills,
      )
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

  // The agent writes markdown; the user's own text goes through the
  // marker-aware plain path, where [ref n] and [file n] become chips.
  if (!isUser && entry.text) {
    said.appendChild(markdownEl(entry.text, 'ez-md'))
    return said
  }
  const note = commentEl(
    entry.text,
    entry.references,
    entry.attachments,
    items.length ? 'ez-bubble-note' : undefined,
    entry.skills,
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
function chipEl(
  name: string,
  glyph: IconNode | null,
  kind?: 'ref' | 'skill',
  title?: string,
): HTMLElement {
  const chip = h('span', kind ? `ez-chip ez-chip-${kind}` : 'ez-chip')
  if (glyph) chip.append(icon(glyph, 11))
  chip.append(h('span', 'ez-chip-name', name))
  if (title) chip.title = title
  return chip
}

const refChipEl = (n: number, label: string) =>
  chipEl(refChipText(n), AlignSelectionIcon as IconNode, 'ref', label)

/** The same token the composer writes into the box, read back. No glyph, because
 *  it is the same thing it was when it was typed - and the `$` is what says so. */
const skillChipEl = (name: string) => chipEl(`$${name}`, null, 'skill')

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
  skills?: string[],
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
    if (part.t === 'skill') {
      const named = skills?.[part.n - 1]
      // Like every other marker here: one naming nothing stays as it was
      // written rather than vanishing, because the user put it there.
      box.appendChild(
        named === undefined ? document.createTextNode(skillMarker(part.n)) : skillChipEl(named),
      )
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
  return {
    box,
    unplacedFiles: names.filter((_, i) => !placedFiles.has(i + 1)),
  }
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
    // The open row has to fit whole: the budget is measured from collapsed rows,
    // and a box clipped into a scroller of its own is the thing editing in place
    // is meant to avoid.
    const open = items.find((li) => li.dataset.editing !== undefined)
    queueList.style.maxHeight = `${Math.max(budget, open?.offsetHeight ?? 0)}px`
  } else {
    queueList.style.maxHeight = ''
  }
  if (editing) {
    queueList.querySelector<HTMLElement>('[data-editing]')?.scrollIntoView({ block: 'nearest' })
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
  // Nothing here about being on an earlier conversation. The thread on screen is
  // that conversation - its messages, its times - which says it better than a
  // line above the composer can, and the picker marks the one being viewed. A
  // standing label for a state the user chose is not a notice; this strip is for
  // what needs answering.
  return pickNotice
}

function paintBanner(): void {
  const text = bannerText()
  banner.hidden = !text
  if (text) banner.textContent = text
}

function render(): void {
  if (!snapshot) return
  const s = snapshot

  paintPage()

  const ended = s.state === 'ended'
  // Explicitly, rather than leaving it to the overlay: a pick from the note box
  // runs with no mode armed, so the overlay's `setMode('off')` cancels nothing.
  if (ended) abortPick('ended')
  paintBanner()
  paintUpdate(s)
  for (const { btn } of annotateBtns) btn.disabled = ended
  paintSendState()
  paintConfig(s.acp)
  paintLimit(s.acp)
  paintStrip()
  paintVariants()
  paintFork(s)
  pushThread(s)
  broadcast({ type: 'ez:can-explore', on: s.canExplore === true })
  agentWrap.hidden = !s.acp
  // The row carries the gap below it, so it has to go when both of its controls
  // do - otherwise a poll-mode review keeps six pixels of nothing.
  controlRow.hidden = agentWrap.hidden && configWrap.hidden
  if (s.acp && !agents.length) void loadAgents()
  paintAgents()

  if (s.acp?.cancelling) {
    // The cancel is out and the agent has not answered yet. With no button to grey
    // out, this is the only thing that says the keypress landed.
    agentStatus.className = 'ez-badge ez-working'
    agentStatus.textContent = '正在中止'
  } else if (s.agentBusy) {
    agentStatus.className = 'ez-badge ez-working'
    agentStatus.textContent = 'Agent 修改中'
  } else if (s.agentOnline) {
    agentStatus.className = 'ez-badge ez-online'
    agentStatus.textContent = 'Agent 已連線'
  } else {
    agentStatus.className = 'ez-badge'
    agentStatus.textContent = 'Agent 未連線'
  }

  paintQueue(s.annotations)

  convList.textContent = ''
  let prevRole: string | null = null
  // Placed where the log says, except that an answer goes under its own question -
  // see `threadOrder`. The live turn follows the same rule, which is what keeps a
  // reply from jumping down the thread the instant it stops streaming.
  let livePlaced = false
  for (const entry of threadOrder(s.conversation)) {
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
    if (s.agentBusy && isUser && entry.batchId && entry.batchId === s.activeBatchId) {
      convList.appendChild(liveTurnEl(s, prevRole))
      livePlaced = true
      // The next entry follows a turn, not a question, whatever the log order is.
      prevRole = 'agent'
    }
  }
  // Nothing in the thread claimed it: a turn with no batch behind it, or one whose
  // question is not in the log. It still has to be visible, so it goes last.
  if (s.agentBusy && !livePlaced) convList.appendChild(liveTurnEl(s, prevRole))
  if (s.acp?.ask) convList.appendChild(acpAskEl(s.acp.ask))
  if (s.acp?.state === 'exited' && s.acp.error) {
    convList.appendChild(
      h('div', 'ez-msg-system ez-msg-system-plain', `agent 已離線：${s.acp.error}`),
    )
  }

  convList.scrollTop = convList.scrollHeight
  paintConvFades()
}

/** The turn in flight, drawn where its finished reply will be - so the reply does
 *  not move when it lands. */
function liveTurnEl(s: SnapshotWire, prevRole: string | null): HTMLElement {
  // Grouped on the same rule a real turn would use: this row is a placeholder for
  // the reply that replaces it, and a different margin here would make the thread
  // step sideways at the moment it lands.
  const row = h('div', `ez-msg ez-msg-agent${prevRole === 'agent' ? ' ez-msg-cont' : ''}`)
  const dots = h('div', 'ez-thinking')
  dots.setAttribute('role', 'status')
  dots.setAttribute('aria-label', s.agentProgress ?? 'Agent 修改中')
  for (let i = 0; i < 3; i++) dots.appendChild(h('span', 'ez-dot'))
  // The agent's own words on what it is doing, when it sends any - rendered where
  // the reply will land, because it is the reply, mid-formation.
  if (s.agentProgress) dots.appendChild(h('span', 'ez-progress', s.agentProgress))
  // A column of its own: `.ez-msg` is a flex row, and the dots sitting beside the
  // feed reads as two columns of unrelated text.
  const turn = h('div', 'ez-acp-turn')
  // SPIKE, ACP mode: the live turn - tools, thoughts, plan, and the reply as it
  // streams. The dots go last: the feed reads top-down as what already happened,
  // and the pulse marks where the next line will appear.
  if (s.acp && s.acp.state === 'working') turn.append(acpFeedEl(s.acp))
  turn.append(dots)
  row.append(turn)
  return row
}

/** SPIKE: the live turn, in the order it happened - the agent says a sentence,
 *  runs a tool, says another, and the feed keeps that interleaving. Only the
 *  newest thought is shown, and only while it is the latest thing happening:
 *  thinking is scaffolding, not narration. */
function acpFeedEl(acp: AcpWire): HTMLElement {
  const box = h('div', 'ez-acp-feed')
  const latest = acp.feed.at(-1)
  for (const item of acp.feed) {
    switch (item.kind) {
      case 'say':
        box.appendChild(markdownEl(item.text, 'ez-md ez-acp-say'))
        break
      case 'thought':
        if (item === latest) box.appendChild(h('div', 'ez-acp-thought', item.text.slice(-160)))
        break
      case 'tool': {
        const line = h('div', `ez-acp-tool ez-acp-tool-${item.status}`)
        line.append(h('span', 'ez-acp-dot'), h('span', 'ez-acp-text', item.title))
        box.appendChild(line)
        break
      }
      case 'plan':
        for (const entry of item.entries) {
          const line = h('div', `ez-acp-plan ez-acp-plan-${entry.status}`)
          line.append(h('span', 'ez-acp-tick'), h('span', 'ez-acp-text', entry.content))
          box.appendChild(line)
        }
        break
    }
  }
  return box
}

/** A decision routed out of the agent - a permission prompt, AskUserQuestion, an
 *  elicitation form - answered here instead of in a terminal.
 *
 *  Two tempos. A card that is nothing but choices sends itself the moment an
 *  option is picked for the last of them, which is how permission prompts have
 *  always felt and how a one-question multiple choice should. Anything with a
 *  typed field gets a 送出 button instead: a value someone is still writing must
 *  not leave on its own, and one button for the whole card beats guessing which
 *  field was last. Typing into a choice's own "Other" box moves that card to the
 *  second tempo too, for the same reason. A question (not a permission) can also
 *  be declined, which the protocol models and the agent knows how to carry on
 *  from. */
function acpAskEl(ask: AcpAskWire): HTMLElement {
  const card = h('div', 'ez-acp-ask')
  card.append(h('div', 'ez-acp-ask-title', ask.title))
  const values = new Map<string, AcpAskAnswer>()
  const choicesOnly = ask.fields.every((f) => f.kind === 'select')
  const customKeys = new Set(
    ask.fields.flatMap((f) =>
      (f.kind === 'select' || f.kind === 'multiselect') && f.custom ? [f.custom.key] : [],
    ),
  )
  const typedCustom = (): boolean => [...values.keys()].some((k) => customKeys.has(k))
  let settled = false
  const send = (body: Record<string, unknown>): void => {
    if (settled) return
    settled = true
    for (const c of card.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
    >('button, input, textarea')) {
      c.disabled = true
    }
    void api('/acp/answer', { method: 'POST', body: JSON.stringify({ id: ask.id, ...body }) })
  }
  // A choice answered by its Other box counts as answered; a card with nothing
  // in it is not sent - that is what 略過 is for.
  const complete = (): boolean =>
    values.size > 0 &&
    ask.fields.every(
      (f) =>
        f.optional ||
        values.has(f.key) ||
        ((f.kind === 'select' || f.kind === 'multiselect') &&
          !!f.custom &&
          values.has(f.custom.key)),
    )
  const submit = (): void => {
    if (complete()) send({ answers: Object.fromEntries(values) })
  }
  const submitBtn = h('button', 'ez-acp-opt ez-acp-opt-primary', '送出')
  submitBtn.onclick = submit
  const refresh = (): void => {
    const instant = choicesOnly && !typedCustom()
    submitBtn.hidden = instant
    submitBtn.disabled = !complete()
  }
  const changed = (how: 'pick' | 'edit'): void => {
    if (how === 'pick' && choicesOnly && !typedCustom()) submit()
    else refresh()
  }
  // Every field says 選填 only when the card also has ones that are not: a
  // form where nothing is required (Claude's AskUserQuestion) would otherwise
  // say it on every line and mean nothing by it.
  const mixed = ask.fields.some((f) => f.optional) && ask.fields.some((f) => !f.optional)
  ask.fields.forEach((field, i) => {
    let labelId: string | undefined
    if (field.text || (mixed && field.optional)) {
      const label = h(
        'div',
        'ez-acp-ask-q',
        `${field.text ?? ''}${mixed && field.optional ? '（選填）' : ''}`,
      )
      labelId = `${ask.id}-q${i}`
      label.id = labelId
      card.append(label)
    }
    card.append(acpFieldEl(field, values, changed, submit, labelId))
  })
  if (ask.kind === 'question' || !choicesOnly) {
    const actions = h('div', 'ez-acp-ask-actions')
    if (ask.kind === 'question') {
      const skip = h('button', 'ez-acp-opt', '略過')
      skip.onclick = () => send({ decline: true })
      actions.append(skip)
    }
    actions.append(submitBtn)
    card.append(actions)
  }
  refresh()
  return card
}

/** One field of an ask, drawn for its kind. `values` is the card's answer so far;
 *  `changed` is told after every edit whether it was a pick or typing, `submit`
 *  is ⌘/Ctrl+Enter in a typed field - the composer's own chord for "this is
 *  done". A default is shown as the current value, never sent on its own: the
 *  user still confirms. */
function acpFieldEl(
  field: AcpAskField,
  values: Map<string, AcpAskAnswer>,
  changed: (how: 'pick' | 'edit') => void,
  submit: () => void,
  labelId?: string,
): HTMLElement {
  const labelled = <T extends HTMLElement>(el: T, role?: string): T => {
    if (role) el.setAttribute('role', role)
    if (labelId) el.setAttribute('aria-labelledby', labelId)
    return el
  }
  const optionButton = (option: AcpAskOption): HTMLButtonElement => {
    const btn = h('button', `ez-acp-opt${option.hint ? ` ez-acp-opt-${option.hint}` : ''}`)
    btn.append(h('span', undefined, option.name))
    if (option.description) btn.append(h('span', 'ez-acp-opt-desc', option.description))
    btn.title = option.description ?? ''
    return btn
  }
  const chord = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }
  const textField = (
    key: string,
    opts: { max?: number; placeholder?: string; initial?: string; onInput?: () => void },
  ): HTMLTextAreaElement => {
    const area = h('textarea', 'ez-acp-field')
    area.rows = 1
    if (opts.max !== undefined) area.maxLength = opts.max
    if (opts.placeholder) area.placeholder = opts.placeholder
    const grow = (): void => {
      area.style.height = 'auto'
      area.style.height = `${area.scrollHeight}px`
    }
    if (opts.initial !== undefined) {
      area.value = opts.initial
      values.set(key, opts.initial)
    }
    area.oninput = () => {
      if (area.value) values.set(key, area.value)
      else values.delete(key)
      grow()
      opts.onInput?.()
      changed('edit')
    }
    area.onkeydown = chord
    queueMicrotask(grow)
    return area
  }
  /** The choice's own "Other" box, when it has one. Typing into it un-picks a
   *  single-select - the agent reads a typed answer as replacing the pick, so
   *  the card should not show both - and leaves a multi-select alone, where the
   *  two add up. Picking clears the box the same way. */
  const withCustom = (row: HTMLElement, clearPick: () => void): HTMLElement => {
    if (field.kind !== 'select' && field.kind !== 'multiselect') return row
    const custom = field.custom
    if (!custom) return row
    const group = h('div', 'ez-acp-group')
    const box = textField(custom.key, {
      placeholder: custom.text ?? '其他',
      onInput: () => {
        if (field.kind === 'select' && box.value) clearPick()
      },
    })
    group.append(row, box)
    return group
  }
  switch (field.kind) {
    case 'select': {
      const row = labelled(h('div', 'ez-acp-ask-options'), 'radiogroup')
      const clearPick = (): void => {
        values.delete(field.key)
        for (const b of row.querySelectorAll('button')) b.classList.remove('ez-on')
      }
      const group = withCustom(row, clearPick)
      for (const option of field.options) {
        const btn = optionButton(option)
        if (option.id === field.default) {
          values.set(field.key, option.id)
          btn.classList.add('ez-on')
        }
        btn.onclick = () => {
          clearPick()
          values.set(field.key, option.id)
          btn.classList.add('ez-on')
          if (field.custom) {
            const box = group.querySelector('textarea')
            if (box) box.value = ''
            values.delete(field.custom.key)
          }
          changed('pick')
        }
        row.append(btn)
      }
      return group
    }
    case 'multiselect': {
      const row = labelled(h('div', 'ez-acp-ask-options'), 'group')
      const picked = new Set<string>(field.default ?? [])
      const sync = (): void => {
        if (picked.size) values.set(field.key, [...picked])
        else values.delete(field.key)
        const full = field.max !== undefined && picked.size >= field.max
        for (const b of row.querySelectorAll('button')) {
          const on = picked.has(b.dataset.id ?? '')
          b.classList.toggle('ez-on', on)
          b.setAttribute('aria-pressed', String(on))
          b.disabled = full && !on
        }
      }
      for (const option of field.options) {
        const btn = optionButton(option)
        btn.dataset.id = option.id
        btn.onclick = () => {
          if (picked.has(option.id)) picked.delete(option.id)
          else picked.add(option.id)
          sync()
          changed('pick')
        }
        row.append(btn)
      }
      sync()
      return withCustom(row, () => {})
    }
    case 'boolean': {
      const row = labelled(h('div', 'ez-acp-ask-options'), 'radiogroup')
      for (const [value, name] of [
        [true, '是'],
        [false, '否'],
      ] as const) {
        const btn = optionButton({ id: String(value), name })
        if (field.default === value) {
          values.set(field.key, value)
          btn.classList.add('ez-on')
        }
        btn.onclick = () => {
          values.set(field.key, value)
          for (const b of row.querySelectorAll('button')) b.classList.remove('ez-on')
          btn.classList.add('ez-on')
          changed('pick')
        }
        row.append(btn)
      }
      return row
    }
    case 'number': {
      const input = labelled(h('input', 'ez-acp-field ez-acp-field-number'))
      input.type = 'number'
      if (field.min !== undefined) input.min = String(field.min)
      if (field.max !== undefined) input.max = String(field.max)
      input.step = field.integer ? '1' : 'any'
      if (field.default !== undefined) {
        input.value = String(field.default)
        values.set(field.key, field.default)
      }
      input.oninput = () => {
        const n = input.value === '' ? NaN : Number(input.value)
        if (Number.isFinite(n)) values.set(field.key, n)
        else values.delete(field.key)
        changed('edit')
      }
      input.onkeydown = chord
      return input
    }
    case 'text':
      return labelled(
        textField(field.key, {
          ...(field.max !== undefined ? { max: field.max } : {}),
          ...(field.format ? { placeholder: field.format } : {}),
          ...(field.default !== undefined ? { initial: field.default } : {}),
        }),
      )
  }
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
    url?: string
    pickId?: string
    host?: 'popup' | 'note'
    draft?: DraftWire
    ref?: RefWire
    anchor?: unknown
    capture?: unknown
    direction?: string
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
  // A link the overlay took off the page before the browser could follow it.
  // The navigation has not happened yet: this is the one moment the shell can
  // own the entry for it, which is the whole reason the overlay intercepts.
  if (data?.type === 'ez:navigate' && data.url) {
    dispatchNav({ t: 'request', url: data.url })
  }
  // A route change with no document load behind it - an SPA moving between
  // pages. Nothing about the overlay was lost, so unlike `ez:ready` this only
  // says where the frame now is.
  if (data?.type === 'ez:page' && data.url) {
    dispatchNav({ t: 'moved', url: data.url, from })
  }
  // The user typed a direction into an element's composer and asked for
  // variants. The shell owns the request because it is the one holding the
  // session's api - and the one that can say why it was refused.
  if (data?.type === 'ez:explore' && data.anchor && data.capture) {
    void (async () => {
      const res = await api('/explore/start', {
        method: 'POST',
        body: JSON.stringify({
          anchor: data.anchor,
          capture: data.capture,
          direction: data.direction ?? '',
        }),
      })
      if (!res.ok) stripNotice('這個 agent 現在無法執行探索')
    })()
  }
  if (data?.type === 'ez:ready') {
    dispatchNav({ t: 'loaded', url: data.url ?? data.page ?? '/', from })
    // Straight to the frame, not through `sendMode`: this is a replay of state
    // the overlay lost, and `sendMode` calls off any pick that is still out -
    // which is exactly the pick this fresh overlay has to be handed back.
    toFrame(from, { type: 'ez:set-mode', mode: annotateMode })
    // A fresh page has none of this: whether it may offer the command, and what
    // is meant to be standing in place of what.
    toFrame(from, { type: 'ez:can-explore', on: snapshot?.canExplore === true })
    seedVariants(from)
    const frame = frames.get(from)
    if (frame) {
      toFrame(from, {
        type: 'ez:viewport',
        preset: frame.device.id,
        zoom: frame.zoom,
        scoped: multi,
      })
    }
    // A frame that (re)booted while an annotation is being composed elsewhere
    // starts held; its own popup died with the page it was on.
    if (popupFrame && popupFrame !== from) toFrame(from, { type: 'ez:hold', held: true })
    else if (popupFrame === from) setPopupFrame(null)
    dispatchPick({
      t: 'ready',
      page: data.page ?? '/',
      now: Date.now(),
      frame: from,
    })
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
    dispatchPick({
      t: 'draft',
      id: data.pickId,
      draft: data.draft,
      frame: from,
    })
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

/** The version of the daemon this page's scripts came from. The shell's assets
 *  are the daemon's, so a snapshot from another version means the port changed
 *  hands - a daemon restart onto a new build - and only a reload catches up. */
let servedBy: string | null = null

const events = new EventSource(`${API}/events`)
events.onmessage = (e) => {
  snapshot = JSON.parse(e.data) as SnapshotWire
  servedBy ??= snapshot.version
  if (snapshot.version !== servedBy) {
    location.reload()
    return
  }
  version.textContent = `v${snapshot.version}`
  render()
}

paintPage()
