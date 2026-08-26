/** The "/" command menu shared by both comment boxes. Typing a slash at the
 *  start of a word opens it; the rest of the word filters it.
 *
 *  Only the trigger and the keyboard belong here. What a command *does* is the
 *  caller's, because the useful ones act on the caller's own state - `/file`
 *  needs the upload pipeline that lives in attach.ts. */

import { type IconNode, icon } from './icon.js'

/** Narrow enough that the shell's generic `h` accepts it, wide enough for both. */
export type Make = (tag: 'div' | 'span' | 'input', className: string) => HTMLElement

export interface SlashCommand {
  /** What the user types after the slash, and what the filter matches first. */
  id: string
  /** The row's name, in the user's words. */
  label: string
  /** Optional muted note, set against the row's far edge. */
  hint?: string
  /** Extra words the filter should match, so `/圖片` finds the file command. */
  keywords: string[]
  icon: IconNode
  run(): void
}

export interface SlashController {
  /** True if a menu was open and is now closed, so a caller unwinding layers on
   *  Escape can tell whether this one took the press. */
  close(): boolean
}

/** A query this long stopped being a command name and started being prose. */
const MAX_QUERY = 24
const BREAK = /[\s ]/

/** Where the caret's own text run turns into a slash command, if it does.
 *  `before` is that run up to the caret.
 *
 *  The leading-boundary rule is what keeps `http://` and `src/client` quiet: a
 *  slash only counts at the start of a word. */
export function detectSlash(before: string): { start: number; query: string } | null {
  const start = before.lastIndexOf('/')
  if (start === -1) return null
  const prev = start === 0 ? '' : before[start - 1]
  if (prev && !BREAK.test(prev)) return null
  const query = before.slice(start + 1)
  if (query.length > MAX_QUERY || BREAK.test(query)) return null
  return { start, query }
}

export function filterCommands<T extends SlashCommand>(commands: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  return commands.filter((c) =>
    [c.id, c.label, ...c.keywords].some((term) => term.toLowerCase().includes(q)),
  )
}

interface Trigger {
  node: Text
  /** Offset of the "/" itself. */
  start: number
  query: string
}

export function attachSlashMenu(
  editable: HTMLElement,
  { mk, commands }: { mk: Make; commands: SlashCommand[] },
): SlashController {
  const doc = editable.ownerDocument
  const view = doc.defaultView

  let menu: HTMLElement | null = null
  let trigger: Trigger | null = null
  let shown: SlashCommand[] = []
  let active = 0

  function readTrigger(): Trigger | null {
    const selection = doc.getSelection()
    if (!selection?.isCollapsed || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0)
    const node = range.startContainer
    if (!editable.contains(node) || node.nodeType !== Node.TEXT_NODE) return null
    const text = node as Text
    const hit = detectSlash((text.nodeValue ?? '').slice(0, range.startOffset))
    return hit ? { node: text, start: hit.start, query: hit.query } : null
  }

  /** A range over the "/" itself. A collapsed range can measure to nothing, and
   *  the slash is always there while the menu is up. */
  function slashRect(): DOMRect | null {
    if (!trigger?.node.isConnected) return null
    const range = doc.createRange()
    range.setStart(trigger.node, trigger.start)
    range.setEnd(trigger.node, Math.min(trigger.node.length, trigger.start + 1))
    return range.getBoundingClientRect()
  }

  function place(): void {
    if (!menu || !view) return
    const at = slashRect()
    if (!at) return
    const box = menu.getBoundingClientRect()
    const left = Math.max(8, Math.min(at.left, view.innerWidth - box.width - 8))
    const below = at.bottom + 6
    const above = at.top - box.height - 6
    // Fitting inside the window is not the whole question: a composer parked at
    // the bottom has its own send button just below it, and a menu that merely
    // fits would open right on top of it. Low anchors open upward.
    const crowded = below + box.height > view.innerHeight - 8 || at.top > view.innerHeight * 0.6
    const top = crowded && above >= 8 ? above : Math.min(below, view.innerHeight - box.height - 8)
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }

  function paintActive(): void {
    const list = menu?.querySelector('.ez-slash-list')
    if (!list) return
    ;[...list.children].forEach((item, i) => {
      item.toggleAttribute('data-active', i === active)
      item.setAttribute('aria-selected', String(i === active))
    })
  }

  function render(): void {
    if (!menu) return
    menu.textContent = ''
    const head = mk('div', 'ez-slash-head')
    head.textContent = '指令'
    const list = mk('div', 'ez-slash-list')
    list.setAttribute('role', 'listbox')
    menu.append(head, list)
    shown.forEach((command, i) => {
      const item = mk('div', 'ez-slash-item')
      item.setAttribute('role', 'option')
      const label = mk('span', 'ez-slash-label')
      label.textContent = command.label
      item.append(icon(command.icon, 16), label)
      if (command.hint) {
        const hint = mk('span', 'ez-slash-hint')
        hint.textContent = command.hint
        item.append(hint)
      }
      // mousedown, not click: a click would land after the blur that closed the
      // menu, on an element that no longer exists.
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        choose(command)
      })
      item.addEventListener('mousemove', () => {
        if (active === i) return
        active = i
        paintActive()
      })
      list.appendChild(item)
    })
    paintActive()
  }

  function onSelectionChange(): void {
    // Only ever closes. Clicking back behind a slash the user has moved on from
    // should not bring the menu back uninvited.
    if (!readTrigger()) close()
  }

  function onBlur(): void {
    close()
  }

  function open(): void {
    menu = mk('div', 'ez-slash-menu')
    doc.body.appendChild(menu)
    doc.addEventListener('selectionchange', onSelectionChange)
    editable.addEventListener('blur', onBlur)
  }

  function close(): boolean {
    if (!menu) return false
    menu.remove()
    menu = null
    trigger = null
    doc.removeEventListener('selectionchange', onSelectionChange)
    editable.removeEventListener('blur', onBlur)
    return true
  }

  /** Takes the `/query` back out before handing over, so a command that inserts
   *  something lands where the user typed the slash. */
  function choose(command: SlashCommand): void {
    const at = trigger
    close()
    if (at?.node.isConnected) {
      const end = Math.min(at.node.length, at.start + 1 + at.query.length)
      const cut = doc.createRange()
      cut.setStart(at.node, at.start)
      cut.setEnd(at.node, end)
      cut.deleteContents()
      const caret = doc.createRange()
      caret.setStart(at.node, at.start)
      caret.collapse(true)
      const selection = doc.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(caret)
      // A Range edit fires nothing on its own, and the box's placeholder and its
      // host's submit state are both driven by `input`.
      editable.dispatchEvent(new InputEvent('input', { bubbles: true }))
    }
    editable.focus()
    command.run()
  }

  function sync(): void {
    const hit = readTrigger()
    if (!hit) {
      close()
      return
    }
    const matches = filterCommands(commands, hit.query)
    if (matches.length === 0) {
      // No "no results" row: closing lets the slash go back to being a character,
      // and a backspace brings the menu straight back.
      close()
      return
    }
    const queryChanged = trigger?.query !== hit.query
    trigger = hit
    shown = matches
    if (!menu) open()
    if (queryChanged) active = 0
    active = Math.min(active, shown.length - 1)
    render()
    place()
  }

  editable.addEventListener('input', (e) => {
    // Mid-composition an IME is still deciding what the characters are.
    if ((e as InputEvent).isComposing) return
    sync()
  })

  editable.addEventListener('keydown', (e) => {
    if (!menu) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      const step = e.key === 'ArrowDown' ? 1 : shown.length - 1
      active = (active + step) % shown.length
      paintActive()
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      // Cmd+Enter is the submit, and it outranks the menu.
      if (e.metaKey || e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      const command = shown[active]
      if (command) choose(command)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  })

  return { close }
}
