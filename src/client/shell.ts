/** Review shell (host page): iframe of the proxied app + feedback sidebar. */

import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import AlignSelectionIcon from '@hugeicons/core-free-icons/AlignSelectionIcon'
import CursorMagicSelection02Icon from '@hugeicons/core-free-icons/CursorMagicSelection02Icon'
import File02Icon from '@hugeicons/core-free-icons/File02Icon'
import KeyboardIcon from '@hugeicons/core-free-icons/KeyboardIcon'
import Location01Icon from '@hugeicons/core-free-icons/Location01Icon'
import Navigation03Icon from '@hugeicons/core-free-icons/Navigation03Icon'
import { attachify } from './attach.js'
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

type Mode = 'off' | 'element' | 'point'

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

const VIEWPORTS: { id: string; label: string; width: number | null }[] = [
  { id: 'desktop', label: '桌面', width: null },
  { id: 'tablet', label: '768', width: 768 },
  { id: 'mobile', label: '390', width: 390 },
]

const ANNOTATE_MODES: {
  id: Exclude<Mode, 'off'>
  label: string
  hint: string
  key: string
  svg: IconNode
}[] = [
  {
    id: 'element',
    label: '框選',
    hint: '圈選整個元素或反白文字',
    key: 'E',
    svg: CursorMagicSelection02Icon as IconNode,
  },
  {
    id: 'point',
    label: '點選',
    hint: '在頁面上點一下就留言，agent 會自己解析點到的是什麼',
    key: 'P',
    svg: Location01Icon as IconNode,
  },
]

/** Batches the user expanded past the collapse limit. Kept outside `render()`
 *  because every SSE snapshot rebuilds the thread's DOM from scratch. */
const expandedBatches = new Set<string>()
/** Collapse only when it actually saves more than one row. */
const ITEM_LIMIT = 3

let snapshot: SnapshotWire | null = null
let annotateMode: Mode = 'off'
let viewport = 'desktop'

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
const viewportName = (v: (typeof VIEWPORTS)[number]) => (v.width ? `${v.label} 寬度` : v.label)

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
  ...VIEWPORTS.map((v, i) => ({
    keys: String(i + 1),
    label: viewportName(v),
    match: plain(String(i + 1)),
    run: () => setViewport(v.id),
  })),
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

const viewportGroup = h('div', 'ez-viewports')
VIEWPORTS.forEach((v, i) => {
  const btn = h('button', 'ez-vp-btn', v.label)
  btn.title = `${viewportName(v)}（${i + 1}）`
  btn.dataset.vp = v.id
  if (v.id === viewport) btn.classList.add('ez-on')
  btn.onclick = () => setViewport(v.id)
  viewportGroup.appendChild(btn)
})

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
sideHead.append(headRow, target, viewportGroup, annotateGroup)

const banner = h('div', 'ez-banner')
banner.style.display = 'none'

const stage = h('div', 'ez-stage')
const frameWrap = h('div', 'ez-frame-wrap')
const iframe = h('iframe', 'ez-frame')
iframe.src = PAGE_PATH
frameWrap.appendChild(iframe)
stage.appendChild(frameWrap)

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
root.append(stage, sidebar)

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
addEventListener('resize', paintSidebarWidth)


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
  iframe.contentWindow?.postMessage({ type: 'ez:set-mode', mode }, location.origin)
}

// ---------------------------------------------------------------- picking

let pickState: PickState | null = null
let pickSeq = 0

function toFrame(message: Record<string, unknown>): void {
  iframe.contentWindow?.postMessage(message, location.origin)
}

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
      toFrame({
        type: 'ez:pick',
        pickId: effect.id,
        host: effect.host,
        ...(effect.returnTo ? { returnTo: effect.returnTo } : {}),
      })
      return
    case 'abort-overlay':
      toFrame({ type: 'ez:pick-abort', pickId: effect.id })
      return
    case 'restore':
      toFrame({ type: 'ez:restore', draft: effect.draft })
      return
    // `replace`, not `iframe.src`: assigning src pushes an entry onto the joint
    // session history and poisons the browser's own back button.
    case 'navigate':
      iframe.contentWindow?.location.replace(effect.page)
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

function setViewport(id: string): void {
  viewport = id
  const preset = VIEWPORTS.find((v) => v.id === id)
  frameWrap.style.width = preset?.width ? `${preset.width}px` : '100%'
  stage.classList.toggle('ez-constrained', Boolean(preset?.width))
  viewportGroup.querySelectorAll('.ez-vp-btn').forEach((b) => {
    b.classList.toggle('ez-on', (b as HTMLElement).dataset.vp === id)
  })
  iframe.contentWindow?.postMessage({ type: 'ez:viewport', preset: id }, location.origin)
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
      // An item can be a pasted file and nothing else, and an empty div would
      // still take a line.
      const rendered = commentEl(item.comment, item.references, item.attachments)
      if (item.comment || item.references?.length || item.attachments?.length) {
        body.append(rendered.box)
      }
      if (item.where) body.append(h('span', 'ez-bi-where', item.where))
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
    const row = h('div', 'ez-msg ez-msg-agent')
    const dots = h('div', 'ez-thinking')
    dots.setAttribute('role', 'status')
    dots.setAttribute('aria-label', 'Agent 修改中')
    for (let i = 0; i < 3; i++) dots.appendChild(h('span', 'ez-dot'))
    row.append(dots)
    convList.appendChild(row)
  }

  convList.scrollTop = convList.scrollHeight
  paintConvFades()
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.origin !== location.origin) return
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
  }
  if (data?.type === 'ez:mode') {
    annotateMode = data.mode ?? 'off'
    for (const { id, btn } of annotateBtns) btn.classList.toggle('ez-on', annotateMode === id)
  }
  if (data?.type === 'ez:ready') {
    // Straight to the frame, not through `sendMode`: this is a replay of state
    // the overlay lost, and `sendMode` calls off any pick that is still out -
    // which is exactly the pick this fresh overlay has to be handed back.
    toFrame({ type: 'ez:set-mode', mode: annotateMode })
    toFrame({ type: 'ez:viewport', preset: viewport })
    dispatchPick({ t: 'ready', page: data.page ?? '/', now: Date.now() })
  }
  if (data?.type === 'ez:pick-armed' && data.pickId) {
    dispatchPick({ t: 'armed', id: data.pickId, host: data.host ?? 'popup', now: Date.now() })
  }
  if (data?.type === 'ez:draft' && data.pickId && data.draft) {
    dispatchPick({ t: 'draft', id: data.pickId, draft: data.draft })
  }
  if (data?.type === 'ez:picked' && data.pickId && data.ref) {
    dispatchPick({ t: 'picked', id: data.pickId, ref: data.ref, page: data.page ?? '/' })
  }
  if (data?.type === 'ez:draft-done' && data.pickId) {
    dispatchPick({ t: 'draft-done', id: data.pickId })
  }
  if (data?.type === 'ez:draft-expired' && data.pickId) {
    dispatchPick({ t: 'expired', id: data.pickId })
  }
  if (data?.type === 'ez:pick-cancelled' && data.pickId) {
    dispatchPick({ t: 'cancelled', id: data.pickId, resumed: Boolean(data.resumed) })
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
  iframe.contentWindow?.postMessage({ type: 'ez:escape' }, location.origin)
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
