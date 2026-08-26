/** Attachments for the two comment boxes. Files arrive by paste or drop and
 *  become inline chips in the text itself, so a comment can point at a file mid
 *  sentence. That is why the box is a contenteditable and not a textarea: a
 *  textarea can hold characters, and a chip is an element.
 *
 *  The DOM is the whole state. Which files are attached, and in what order, is
 *  read back off the chips currently in the box - so backspace, cut, select-all
 *  and undo all work without this module hearing about any of them. */

import AlignSelectionIcon from '@hugeicons/core-free-icons/AlignSelectionIcon'
import File02Icon from '@hugeicons/core-free-icons/File02Icon'
import {
  NBSP,
  draftFileIds,
  draftPendingNames,
  draftRefs,
  draftText,
  hasPendingRef,
  nextRefNumber,
  refChipText,
  restorableBody,
} from './draft.js'
import type { DraftNode, NumberedRef, RefWire } from './draft.js'
import { type IconNode, icon } from './icon.js'
import { type Make, type SlashCommand, attachSlashMenu } from './slash.js'

/** Mirrors MAX_ATTACHMENT_BYTES in src/constants.ts, which is node-only. */
const MAX_BYTES = 8 * 1024 * 1024

interface Options {
  api: string
  mk: Make
  /** Class for the editable itself, so each host keeps its own field styling. */
  className: string
  placeholder: string
  /** Fires whenever the text, the chips or the pending count change, so a caller
   *  can re-decide whether its submit button should be live. Never during
   *  `attachify` itself - callers close over the controller it returns. */
  onChange?: () => void
  /** Commands offered after the built-in `/file`. The host owns what they do,
   *  because the useful ones act on state only it has - picking an element needs
   *  the overlay's pointer, which the shell's note box can only ask for. */
  commands?: SlashCommand[]
}

export interface AttachController {
  /** Insert this where the composer goes. */
  wrap: HTMLElement
  /** The editable box, for `focus()` and the host's own key handling. */
  editable: HTMLElement
  /** What the user typed, chips excluded. */
  text(): string
  /** Attachment ids, in the order the chips appear. */
  ids(): string[]
  /** Picked-element references, in the order the chips appear, each carrying the
   *  number the comment refers to it by. */
  refs(): NumberedRef[]
  pending(): number
  /** Names of the uploads still in flight - what a snapshot cannot carry. */
  pendingNames(): string[]
  /** Empty the box without deleting anything: after a send the files belong to
   *  the batch. */
  reset(): void
  /** True if the slash menu was open and took the press. Lets a host unwinding
   *  Escape layers know this one is spoken for. */
  closeSlash(): boolean
  /** Delete every file still chipped here. For a composer being abandoned. */
  discard(): void
  /** Drop a placeholder chip at the caret and hold the spot while the user goes
   *  off to choose an element. False if one is already outstanding. */
  beginRef(label: string): boolean
  /** Fill the placeholder in and leave the caret past it. */
  resolveRef(ref: RefWire): void
  /** Take the placeholder back out, caret where it stood. */
  cancelRef(): void
  /** This box as data, in document order. The one DOM walk in this module: text,
   *  ids and refs are all pure functions of it, and it is what crosses a
   *  document boundary when a popup has to survive a navigation. */
  snapshot(): DraftNode[]
  /** Rebuild from a snapshot. Only ever called on a fresh, unfocused box. */
  restore(body: DraftNode[]): void
}

const CHIP_ATTR = 'data-ez-chip'
/** Holds the picked element's reference as JSON. Deliberately a *different*
 *  attribute rather than another `CHIP_ATTR` value: `ids()`, `pending()` and -
 *  the one that matters - `discard()`'s delete loop all key off `CHIP_ATTR`, so
 *  a reference chip can never be mistaken for a file and handed to `del()`. */
const REF_ATTR = 'data-ez-ref'

export function attachify({
  api,
  mk,
  className,
  placeholder,
  onChange,
  commands,
}: Options): AttachController {
  const editable = mk('div', className)
  editable.setAttribute('contenteditable', 'plaintext-only')
  editable.setAttribute('role', 'textbox')
  editable.setAttribute('aria-multiline', 'true')
  editable.setAttribute('aria-label', placeholder)
  editable.dataset.placeholder = placeholder

  const field = mk('div', 'ez-attach-field')
  const error = mk('div', 'ez-attach-error')
  const wrap = mk('div', 'ez-attach')
  error.hidden = true
  field.append(editable)

  /** The only way to a native file dialog. Opening it needs a user gesture, and
   *  choosing a command from the menu is one. */
  const picker = mk('input', 'ez-file-picker') as HTMLInputElement
  picker.type = 'file'
  picker.multiple = true
  picker.hidden = true
  picker.addEventListener('change', () => {
    for (const file of take(picker.files ?? undefined)) add(file)
    // Cleared so picking the same file twice in a row still fires `change`.
    picker.value = ''
  })

  wrap.append(field, error, picker)

  const slash = attachSlashMenu(editable, {
    mk,
    commands: [
      {
        id: 'file',
        label: 'File',
        hint: '附加檔案',
        keywords: ['file', 'attach', 'upload', '檔案', '附件', '圖片'],
        icon: File02Icon as IconNode,
        run: () => picker.click(),
      },
      ...(commands ?? []),
    ],
  })

  /** Chips with an upload still in flight. Membership plus "still in the DOM" is
   *  what `pending` asks, so a chip deleted mid-upload stops blocking the send
   *  the moment it is gone. */
  const uploading = new Set<HTMLElement>()
  let errorTimer = 0

  const chips = () => [...editable.querySelectorAll<HTMLElement>(`[${CHIP_ATTR}]`)]

  function showError(message: string): void {
    error.textContent = message
    error.hidden = false
    clearTimeout(errorTimer)
    errorTimer = setTimeout(() => {
      error.hidden = true
    }, 6000) as unknown as number
  }

  function paintEmpty(): void {
    const empty = !editable.textContent?.trim() && chips().length === 0
    editable.toggleAttribute('data-empty', empty)
  }

  function changed(): void {
    paintEmpty()
    onChange?.()
  }

  /** Unawaited: the chip is already gone from the box, and a delete that never
   *  lands leaves a file the daemon's sweep collects anyway. */
  function del(id: string): void {
    fetch(`${api}/attachments/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  function makeChip(name: string, attr: string, value: string, glyph: IconNode): HTMLElement {
    const chip = mk('span', 'ez-chip')
    // Atomic to the caret: one backspace takes the whole chip, which is why
    // there is no close button on it.
    chip.setAttribute('contenteditable', 'false')
    chip.setAttribute(attr, value)
    chip.append(icon(glyph, 11), mk('span', 'ez-chip-name'))
    chip.querySelector('.ez-chip-name')!.textContent = name
    if (attr === REF_ATTR) chip.classList.add('ez-chip-ref')
    if (!value) chip.classList.add('ez-chip-pending')
    return chip
  }

  const fileChip = (name: string, id = '') =>
    makeChip(name, CHIP_ATTR, id, File02Icon as IconNode)
  /** A settled reference reads its number; a placeholder reads whatever the host
   *  gave it, because it does not have one yet. */
  const refChip = (ref: NumberedRef | null, placeholder: string) => {
    const chip = makeChip(
      ref ? refChipText(ref.n) : placeholder,
      REF_ATTR,
      ref ? JSON.stringify(ref) : '',
      AlignSelectionIcon as IconNode,
    )
    if (ref?.label) chip.title = ref.label
    return chip
  }

  const pendingRef = () => editable.querySelector<HTMLElement>(`[${REF_ATTR}=""]`)

  function placeCaretAfter(node: Node): void {
    const caret = document.createRange()
    caret.setStartAfter(node)
    caret.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(caret)
  }

  function insertAtCaret(node: Node): void {
    const selection = document.getSelection()
    const live = selection?.rangeCount ? selection.getRangeAt(0) : null
    const range = live && editable.contains(live.commonAncestorContainer) ? live : null
    if (range) {
      range.deleteContents()
      range.insertNode(node)
    } else {
      editable.appendChild(node)
    }
    // A space after the chip is what lets the caret sit past it when the chip
    // ends the box, and it reads correctly when the sentence continues.
    const after = document.createTextNode(NBSP)
    node.parentNode?.insertBefore(after, node.nextSibling)
    placeCaretAfter(after)
  }

  function add(file: File): void {
    if (file.size > MAX_BYTES) {
      showError(`${file.name || '這個檔案'} 超過單檔 8 MB 上限`)
      return
    }
    const chip = fileChip(file.name || '貼上的圖片')
    insertAtCaret(chip)
    uploading.add(chip)
    changed()
    void upload(chip, file)
  }

  async function upload(chip: HTMLElement, file: File): Promise<void> {
    try {
      const res = await fetch(`${api}/attachments`, {
        method: 'POST',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          // A filename is free to hold bytes no header may carry.
          'x-ez-name': encodeURIComponent(file.name || 'image.png'),
        },
        body: file,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const saved = (await res.json()) as { id: string; name: string }
      // Deleted while it was uploading. The id never reached anything that could
      // reference it, so the file can go now rather than waiting for the sweep.
      if (!editable.contains(chip)) {
        del(saved.id)
        return
      }
      chip.setAttribute(CHIP_ATTR, saved.id)
      chip.querySelector('.ez-chip-name')!.textContent = saved.name
      chip.classList.remove('ez-chip-pending')
    } catch (err) {
      chip.remove()
      showError(`「${file.name || '檔案'}」上傳失敗：${(err as Error).message}`)
    } finally {
      uploading.delete(chip)
      changed()
    }
  }

  function take(list: FileList | undefined): File[] {
    return list ? [...list] : []
  }

  /** A pick can outlive this whole document, so it cannot hold a caret offset -
   *  the nodes it would name may not exist by the time the answer arrives. It
   *  holds the *spot* instead, as a chip that is already in the box, and the
   *  answer fills that chip in. A cross-page restore rebuilds the placeholder
   *  along with everything else, so the answer still lands where the user typed
   *  the slash, in a document that never saw them type it. */
  function beginRef(label: string): boolean {
    if (hasPendingRef(snapshot())) return false
    insertAtCaret(refChip(null, label))
    changed()
    return true
  }

  function resolveRef(ref: RefWire): void {
    const chip = pendingRef()
    if (!chip) return
    const numbered: NumberedRef = { ...ref, n: nextRefNumber(snapshot()) }
    chip.setAttribute(REF_ATTR, JSON.stringify(numbered))
    chip.querySelector('.ez-chip-name')!.textContent = refChipText(numbered.n)
    if (numbered.label) chip.title = numbered.label
    chip.classList.remove('ez-chip-pending')
    // Past the spacer, not past the chip: the caret has to land somewhere it can
    // sit, and a chip that ends the box has nothing after it but that space.
    if (chip.nextSibling) placeCaretAfter(chip.nextSibling)
    changed()
  }

  function cancelRef(): void {
    const chip = pendingRef()
    if (!chip) return
    const after = chip.nextSibling
    chip.remove()
    // Take the spacer this chip brought with it, but only that one character -
    // anything the user typed after it is theirs.
    if (after?.nodeType === Node.TEXT_NODE && after.nodeValue?.startsWith(NBSP)) {
      after.nodeValue = after.nodeValue.slice(1)
      if (!after.nodeValue) after.parentNode?.removeChild(after)
    }
    changed()
  }

  function snapshot(): DraftNode[] {
    const out: DraftNode[] = []
    collectNodes(editable, out)
    return out
  }

  function restore(body: DraftNode[]): void {
    editable.textContent = ''
    const nodes = restorableBody(body)
    for (const node of nodes) {
      if (node.t === 'text') editable.appendChild(document.createTextNode(node.v))
      else if (node.t === 'file') editable.appendChild(fileChip(node.name, node.id))
      else {
        const ref = node.anchor ? { n: node.n, anchor: node.anchor, label: node.label } : null
        editable.appendChild(refChip(ref, node.label))
      }
    }
    // A box that ends on a chip leaves the caret nowhere to sit. Snapshots
    // normally carry the spacer in a text run, but a dropped upload can strip it.
    if (nodes[nodes.length - 1]?.t !== 'text') {
      editable.appendChild(document.createTextNode(NBSP))
    }
    // At the end, which is where the user was: the placeholder a pick leaves sits
    // where they typed the slash, and they carry on typing after it.
    if (editable.lastChild) placeCaretAfter(editable.lastChild)
    changed()
  }

  editable.addEventListener('paste', (e) => {
    const data = (e as ClipboardEvent).clipboardData
    const files = take(data?.files)
    if (files.length === 0) return
    // Text pasted alongside the files still belongs at the caret; only a paste
    // with nothing but files leaves the box with nothing of its own to do.
    if (!data?.getData('text/plain')) e.preventDefault()
    // The overlay's popup sits in the host page's document, which is free to
    // have paste handlers of its own.
    e.stopPropagation()
    for (const file of files) add(file)
  })

  const isChipNode = (node: Node | null): boolean =>
    node instanceof HTMLElement && (node.hasAttribute(CHIP_ATTR) || node.hasAttribute(REF_ATTR))

  /** Backspacing away the spacer a chip brought with it is handled here rather
   *  than left to the browser. Deleting the only character between two
   *  `contenteditable=false` chips makes Chrome drop a filler `<br>` in its
   *  place, which is a line break the user did not ask for - and which reads back
   *  as a newline in the comment, because a `<br>` is one. Doing the removal
   *  ourselves leaves the two chips simply adjacent, which is what backspace
   *  there is asking for. */
  editable.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'deleteContentBackward') return
    const selection = document.getSelection()
    if (!selection?.isCollapsed || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    const node = range.startContainer
    if (node.nodeType !== Node.TEXT_NODE) return
    const text = node as Text
    // Only the spacer itself, and only when this deletion would empty it. At
    // offset 0 the target is the chip before it, which the browser handles
    // correctly - a chip is atomic and goes whole.
    if (text.nodeValue !== NBSP || range.startOffset !== 1) return
    const before = text.previousSibling
    if (!isChipNode(before)) return
    e.preventDefault()
    text.remove()
    placeCaretAfter(before!)
    changed()
  })

  editable.addEventListener('input', changed)

  // ------------------------------------------------------------------ drop

  const dragging = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
  let depth = 0

  function endDrag(): void {
    depth = 0
    field.removeAttribute('data-drop')
  }

  field.addEventListener('dragenter', (e) => {
    if (!dragging(e)) return
    e.preventDefault()
    depth++
    field.toggleAttribute('data-drop', true)
  })

  // Without a handler that prevents the default, the drop never fires at all.
  field.addEventListener('dragover', (e) => {
    if (!dragging(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  })

  // Fires for every child the pointer crosses, so the highlight is held on a
  // count rather than on the first leave.
  field.addEventListener('dragleave', (e) => {
    if (!dragging(e)) return
    if (--depth <= 0) endDrag()
  })

  field.addEventListener('drop', (e) => {
    const files = take(e.dataTransfer?.files)
    endDrag()
    if (files.length === 0) return
    // Otherwise the browser navigates to the dropped file and takes the box,
    // and everything typed in it, with it.
    e.preventDefault()
    e.stopPropagation()
    if (document.activeElement !== editable) editable.focus()
    for (const file of files) add(file)
  })

  paintEmpty()

  return {
    wrap,
    editable,
    // All three read the same single walk, so the text a comment reads as, the
    // files it carries and the elements it points at can never disagree about
    // order - and all three are testable without a browser.
    text: () => draftText(snapshot()),
    ids: () => draftFileIds(snapshot()),
    refs: () => draftRefs(snapshot()),
    pending: () => [...uploading].filter((c) => editable.contains(c)).length,
    pendingNames: () => draftPendingNames(snapshot()),
    closeSlash: () => slash.close(),
    beginRef,
    resolveRef,
    cancelRef,
    snapshot,
    restore,
    reset() {
      slash.close()
      uploading.clear()
      editable.textContent = ''
      changed()
    },
    discard() {
      slash.close()
      for (const id of chips().map((c) => c.getAttribute(CHIP_ATTR))) if (id) del(id)
      uploading.clear()
      editable.textContent = ''
      changed()
    },
  }
}

/** The box as data. Everything that reads a composer goes through here, so this
 *  is the only place that knows what the DOM looks like. */
function collectNodes(node: Node, out: DraftNode[]): void {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push({ t: 'text', v: child.nodeValue ?? '' })
      continue
    }
    if (!(child instanceof HTMLElement)) continue
    const name = child.querySelector('.ez-chip-name')?.textContent ?? ''
    if (child.hasAttribute(REF_ATTR)) {
      // The label travels in the attribute, not in what the chip reads: the
      // visible text is the ordinal, and the sidebar, the log and the agent all
      // still need a name for the element itself.
      const ref = parseRef(child.getAttribute(REF_ATTR))
      out.push({
        t: 'ref',
        n: ref?.n ?? 0,
        anchor: ref?.anchor ?? null,
        label: ref?.label ?? name,
      })
      continue
    }
    if (child.hasAttribute(CHIP_ATTR)) {
      out.push({ t: 'file', id: child.getAttribute(CHIP_ATTR) ?? '', name })
      continue
    }
    if (child.tagName === 'BR') {
      out.push({ t: 'text', v: '\n' })
      continue
    }
    // A block the browser made for a new line. The check looks past chips at the
    // last *text* it emitted, which is what the string-only version did.
    const prev = lastText(out)
    if (prev !== undefined && !prev.endsWith('\n')) out.push({ t: 'text', v: '\n' })
    collectNodes(child, out)
  }
}

function lastText(out: DraftNode[]): string | undefined {
  for (let i = out.length - 1; i >= 0; i--) {
    const node = out[i]
    if (node?.t === 'text') return node.v
  }
  return undefined
}

/** An empty attribute is the placeholder a pick is still waiting on. Anything
 *  unparseable is treated as one too: we wrote this JSON and the chip is atomic,
 *  so the only way here is a mangled clone, and a placeholder is the shape that
 *  degrades safely - it reaches neither the agent nor `del()`. */
function parseRef(raw: string | null): NumberedRef | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as NumberedRef
  } catch {
    return null
  }
}
