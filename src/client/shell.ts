/** Review shell (host page): iframe of the proxied app + feedback sidebar. */

import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import CursorMagicSelection02Icon from '@hugeicons/core-free-icons/CursorMagicSelection02Icon'
import Location01Icon from '@hugeicons/core-free-icons/Location01Icon'
import Logout03Icon from '@hugeicons/core-free-icons/Logout03Icon'
import Navigation03Icon from '@hugeicons/core-free-icons/Navigation03Icon'
import Robot02Icon from '@hugeicons/core-free-icons/Robot02Icon'
import UserIcon from '@hugeicons/core-free-icons/UserIcon'
import { type IconNode, icon } from './icon.js'

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
}

interface ConversationWire {
  role: 'user' | 'agent' | 'system'
  text: string
  ts: number
  batchId?: string
  items?: { comment: string; where: string }[]
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
const PAGE_PATH = new URLSearchParams(location.search).get('path') || '/'

const VIEWPORTS: { id: string; label: string; width: number | null }[] = [
  { id: 'desktop', label: '桌面', width: null },
  { id: 'tablet', label: '768', width: 768 },
  { id: 'mobile', label: '390', width: 390 },
]

const ANNOTATE_MODES: { id: Exclude<Mode, 'off'>; label: string; hint: string; svg: IconNode }[] = [
  {
    id: 'element',
    label: '框選',
    hint: '圈選整個元素或反白文字（⌘/Ctrl + I）',
    svg: CursorMagicSelection02Icon as IconNode,
  },
  {
    id: 'point',
    label: '點選',
    hint: '在頁面上點一下就留言，agent 會自己解析點到的是什麼',
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

const endBtn = h('button', 'ez-end-btn')
endBtn.append(icon(Logout03Icon as IconNode, 14), h('span', undefined, '結束'))
endBtn.title = '結束這次 review'
endBtn.onclick = () => void endSession()

const headRow = h('div', 'ez-head-row')
headRow.append(brand, h('div', 'ez-spacer'), agentStatus, endBtn)

const viewportGroup = h('div', 'ez-viewports')
for (const v of VIEWPORTS) {
  const btn = h('button', 'ez-vp-btn', v.label)
  btn.dataset.vp = v.id
  if (v.id === viewport) btn.classList.add('ez-on')
  btn.onclick = () => setViewport(v.id)
  viewportGroup.appendChild(btn)
}

const annotateGroup = h('div', 'ez-annotate-group')
const annotateBtns = ANNOTATE_MODES.map((m) => {
  const btn = h('button', `ez-tool-btn ez-mode-${m.id}`)
  btn.append(icon(m.svg, 15), h('span', undefined, m.label))
  btn.title = `${m.hint}・Esc 離開`
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
const note = h('textarea', 'ez-note') as HTMLTextAreaElement
note.placeholder = '整體想法或補充說明（選填）'
note.rows = 2
const sendBtn = h('button', 'ez-send')
const sendLabel = h('span', undefined, '送出給 agent')
sendBtn.append(icon(Navigation03Icon as IconNode, 15), sendLabel)
sendBtn.onclick = () => void sendBatch()
queueSection.append(queueList, note, sendBtn)

const convSection = h('section', 'ez-section ez-conv-section')
const convList = h('div', 'ez-conv')
convSection.append(convList)

sidebar.append(sideHead, banner, convSection, queueSection)
root.append(stage, sidebar)

// ---------------------------------------------------------------- behavior

function sendMode(mode: Mode): void {
  iframe.contentWindow?.postMessage({ type: 'ez:set-mode', mode }, location.origin)
}

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

async function sendBatch(): Promise<void> {
  const count = snapshot?.annotations.length ?? 0
  if (count === 0 && !note.value.trim()) return
  sendBtn.disabled = true
  const res = await api('/send', { method: 'POST', body: JSON.stringify({ note: note.value }) })
  sendBtn.disabled = false
  if (res.ok) note.value = ''
}

async function endSession(): Promise<void> {
  const pending = snapshot?.annotations.length ?? 0
  if (pending > 0) {
    if (confirm(`還有 ${pending} 則標註未送出，一併送出後結束？`)) {
      await api('/send', { method: 'POST', body: JSON.stringify({ note: note.value }) })
    } else if (!confirm('直接結束，放棄未送出的標註？')) {
      return
    }
  }
  await api('/end', { method: 'POST', body: JSON.stringify({ by: 'user' }) })
  // The CLI opens the shell in a fresh window, so its history has a single
  // entry and the browser lets the page close itself. If it ever refuses, the
  // "Review 已結束" banner is what the user is left with.
  window.close()
}

function annotationLabel(a: AnnotationWire): string {
  const parts: string[] = []
  if (a.anchor.source) parts.push(a.anchor.source)
  else if (a.anchor.components?.length) parts.push(`<${a.anchor.components[0]}>`)
  if (a.anchor.section) parts.push(a.anchor.section)
  if (a.anchor.text) parts.push(`"${a.anchor.text.slice(0, 32)}"`)
  return parts.join(' · ') || a.anchor.page || ''
}

function buildBubble(entry: ConversationWire): HTMLElement {
  const bubble = h('div', 'ez-bubble')
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
      body.append(h('div', undefined, item.comment))
      if (item.where) body.append(h('span', 'ez-bi-where', item.where))
      li.append(h('span', 'ez-bi-num', `${i + 1}.`), body)
      list.appendChild(li)
    })
    bubble.appendChild(list)

    if (collapsed) {
      const more = h('button', 'ez-bubble-more', `還有 ${items.length - ITEM_LIMIT} 則`)
      more.onclick = () => {
        expandedBatches.add(key)
        render()
      }
      bubble.appendChild(more)
    }
  }

  if (entry.text) {
    bubble.appendChild(h('div', items.length ? 'ez-bubble-note' : undefined, entry.text))
  }
  return bubble
}

function render(): void {
  if (!snapshot) return
  const s = snapshot

  target.textContent = `${s.targetOrigin.replace(/^https?:\/\//, '')}${PAGE_PATH}`

  const ended = s.state === 'ended'
  banner.style.display = ended ? 'block' : 'none'
  if (ended) {
    banner.textContent =
      s.endedBy === 'agent'
        ? 'Agent 已結束這次 review。要繼續的話，請 agent 重新開啟 session'
        : 'Review 已結束'
  }
  for (const { btn } of annotateBtns) btn.disabled = ended
  sendBtn.disabled = ended
  endBtn.style.display = ended ? 'none' : ''

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
    li.append(head, h('div', 'ez-qi-comment', a.comment))
    queueList.appendChild(li)
  })

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
    const avatar = h('div', 'ez-avatar')
    avatar.append(icon((isUser ? UserIcon : Robot02Icon) as IconNode, 16))
    avatar.title = isUser ? '你' : 'Agent'
    item.append(avatar, buildBubble(entry))
    convList.appendChild(item)
    prevRole = entry.role
  }

  if (s.agentBusy) {
    const row = h('div', 'ez-msg ez-msg-agent')
    const avatar = h('div', 'ez-avatar')
    avatar.append(icon(Robot02Icon as IconNode, 16))
    const dots = h('div', 'ez-bubble ez-thinking')
    dots.setAttribute('role', 'status')
    dots.setAttribute('aria-label', 'Agent 修改中')
    for (let i = 0; i < 3; i++) dots.appendChild(h('span', 'ez-dot'))
    row.append(avatar, dots)
    convList.appendChild(row)
  }

  convList.scrollTop = convList.scrollHeight
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.origin !== location.origin) return
  const data = e.data as { type?: string; mode?: Mode }
  if (data?.type === 'ez:mode') {
    annotateMode = data.mode ?? 'off'
    for (const { id, btn } of annotateBtns) btn.classList.toggle('ez-on', annotateMode === id)
  }
  if (data?.type === 'ez:ready') {
    sendMode(annotateMode)
    iframe.contentWindow?.postMessage({ type: 'ez:viewport', preset: viewport }, location.origin)
  }
})

const events = new EventSource(`${API}/events`)
events.onmessage = (e) => {
  snapshot = JSON.parse(e.data) as SnapshotWire
  render()
}

document.title = `Review · ${PAGE_PATH}`
