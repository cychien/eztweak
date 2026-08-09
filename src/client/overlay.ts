/** Annotation overlay injected into the proxied app (guest side). Framework-free. */

import Add01Icon from '@hugeicons/core-free-icons/Add01Icon'
import TextSelectIcon from '@hugeicons/core-free-icons/TextSelectIcon'
import { type IconNode, icon } from './icon.js'

type Mode = 'off' | 'element' | 'point'

interface AnchorWire {
  source?: string
  components?: string[]
  section?: string
  selector?: string
  text?: string
  point?: { x: number; y: number; rel: { x: number; y: number } }
  rect?: { x: number; y: number; width: number; height: number }
  viewport?: { width: number; height: number; preset?: string }
  page?: string
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
  popup: null as HTMLElement | null,
  selectionBubble: null as HTMLElement | null,
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

function paintHighlight(): void {
  if (!highlightTarget) {
    ui.highlight.style.display = 'none'
    ui.badge.style.display = 'none'
    return
  }
  const rect = highlightTarget.getBoundingClientRect()
  ui.highlight.classList.toggle('ez-highlight-soft', mode === 'point')
  Object.assign(ui.highlight.style, {
    display: 'block',
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
  ui.badge.textContent = describe(highlightTarget)
  Object.assign(ui.badge.style, {
    display: 'block',
    top: `${Math.max(4, rect.top - 26)}px`,
    left: `${Math.max(4, rect.left)}px`,
  })
}

function paintPin(): void {
  if (!pinPage) {
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

// ---------------------------------------------------------------- popup

/** Removes the popup only. The target highlight and pin stay put — they are what
 *  tells the user which thing they're commenting on. Use `dismiss()` to drop both. */
function closePopup(): void {
  ui.popup?.remove()
  ui.popup = null
  popupRect = null
}

function dismiss(): void {
  closePopup()
  hoverTarget = null
  moveHighlight(null)
  movePin(null)
}

/** `anchor` is re-evaluated on every repaint, so the popup tracks its subject
 *  through scrolls and reflows instead of freezing where it opened. */
function openPopup(anchor: () => DOMRect, onSave: (comment: string) => void): void {
  closePopup()
  const popup = el('div', 'ez-popup')

  const input = el('textarea', 'ez-input') as HTMLTextAreaElement
  input.placeholder = '想怎麼調整？（⌘+Enter 儲存）'
  input.rows = 3

  const actions = el('div', 'ez-actions')
  const save = el('button', 'ez-btn ez-btn-primary')
  save.append(icon(Add01Icon as IconNode, 14), document.createTextNode('加入待送清單'))
  const cancel = el('button', 'ez-btn')
  cancel.textContent = '取消'
  actions.append(cancel, save)

  const submit = () => {
    const comment = input.value.trim()
    if (!comment) {
      input.focus()
      return
    }
    onSave(comment)
    dismiss()
  }
  save.onclick = submit
  cancel.onclick = dismiss
  input.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
    if (e.key === 'Escape') dismiss()
    e.stopPropagation()
  }

  popup.append(input, actions)
  document.body.appendChild(popup)
  ui.popup = popup
  popupRect = anchor
  paintPopup()
  input.focus()
}

async function saveAnnotation(
  kind: AnnotationWire['kind'],
  element: Element,
  comment: string,
  extra?: { selectedText?: string; pin?: { x: number; y: number } },
): Promise<void> {
  await fetch(`${API}/annotations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind,
      comment,
      anchor: buildAnchor(element, extra?.selectedText, extra?.pin),
    }),
  })
}

// ---------------------------------------------------------------- markers

let markerRaf = 0

function renderMarkers(): void {
  ui.markers.textContent = ''
  const relevant = annotations.filter((a) => a.anchor.page === location.pathname)
  relevant.forEach((a, i) => {
    let at: { top: number; left: number } | null = null
    if (a.kind === 'point' && a.anchor.point) {
      at = { top: a.anchor.point.y, left: a.anchor.point.x }
    } else if (a.anchor.selector) {
      let target: Element | null = null
      try {
        target = document.querySelector(a.anchor.selector)
      } catch {
        /* selector no longer valid */
      }
      if (!target) return
      const rect = target.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return
      at = { top: rect.top + window.scrollY, left: rect.left + window.scrollX }
    }
    if (!at) return
    const marker = el('div', 'ez-marker')
    marker.textContent = String(i + 1)
    marker.title = a.comment
    Object.assign(marker.style, { top: `${at.top - 10}px`, left: `${at.left - 10}px` })
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
    paintPopup()
  })
}

// ---------------------------------------------------------------- mode

function setMode(next: Mode): void {
  if (ended && next !== 'off') return
  if (mode === next) return
  mode = next
  document.documentElement.classList.toggle('ez-annotating', next !== 'off')
  dismiss()
  ui.selectionBubble?.remove()
  ui.selectionBubble = null
  window.parent?.postMessage({ type: 'ez:mode', mode }, location.origin)
}

// ---------------------------------------------------------------- events

function onMouseMove(e: MouseEvent): void {
  if (mode === 'off' || ui.popup || isOwnUi(e.target)) return
  const target = e.target instanceof Element ? e.target : null
  if (target !== hoverTarget) {
    hoverTarget = target
    moveHighlight(target)
  }
}

function onClick(e: MouseEvent): void {
  if (mode === 'off' || isOwnUi(e.target)) return
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
    openPopup(atPin, (comment) => void saveAnnotation('point', target, comment, { pin }))
  } else {
    openPopup(() => target.getBoundingClientRect(), (comment) =>
      void saveAnnotation('element', target, comment),
    )
  }
}

function onMouseUp(): void {
  if (mode === 'off' || ui.popup) return
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
        () => range.getBoundingClientRect(),
        (comment) => void saveAnnotation('text', container, comment, { selectedText: text }),
      )
    }
    document.body.appendChild(bubble)
    ui.selectionBubble = bubble
  }, 0)
}

function onKeyDown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
    e.preventDefault()
    setMode(mode === 'off' ? 'element' : 'off')
  }
  if (e.key === 'Escape' && mode !== 'off') {
    if (ui.popup) dismiss()
    else setMode('off')
  }
}

// ---------------------------------------------------------------- boot

function boot(): void {
  document.body.append(ui.highlight, ui.badge, ui.pin, ui.markers)
  moveHighlight(null)
  movePin(null)

  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('scroll', scheduleRepaint, { passive: true, capture: true })
  window.addEventListener('resize', scheduleRepaint, { passive: true })
  new MutationObserver(scheduleRepaint).observe(document.body, {
    childList: true,
    subtree: true,
  })

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.origin !== location.origin) return
    const data = e.data as { type?: string; mode?: Mode; preset?: string }
    if (data?.type === 'ez:set-mode') setMode(data.mode ?? 'off')
    if (data?.type === 'ez:viewport') viewportPreset = data.preset
  })

  const events = new EventSource(`${API}/events`)
  events.onmessage = (e) => {
    const snapshot = JSON.parse(e.data) as SnapshotWire
    annotations = snapshot.annotations
    ended = snapshot.state === 'ended'
    if (ended) setMode('off')
    scheduleRepaint()
  }

  window.parent?.postMessage({ type: 'ez:ready' }, location.origin)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
