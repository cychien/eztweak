/** The serializable mirror of what a comment box holds: text runs and chips
 *  interleaved, in document order. `attachify` walks the DOM once into this
 *  shape, and every semantic - the text the comment reads as, which files it
 *  carries, which elements it points at - is a pure function of it. That is why
 *  those semantics are testable at all: the walk needs a browser, this does not.
 *
 *  It is also the only thing that crosses a document boundary. An overlay popup
 *  whose page is about to be navigated away is handed to the shell as one of
 *  these, and rebuilt from it on the way back. */

export interface AnchorWire {
  source?: string
  components?: string[]
  section?: string
  selector?: string
  text?: string
  /** Elements a framed region enclosed. See `Anchor.contains` in protocol.ts. */
  contains?: string[]
  point?: { x: number; y: number; rel: { x: number; y: number } }
  rect?: { x: number; y: number; width: number; height: number }
  viewport?: { width: number; height: number; preset?: string }
  page?: string
}

/** An element the user pointed the agent *at* from inside a comment. What the
 *  picker produces; the composer is what gives it a number. */
export interface RefWire {
  anchor: AnchorWire
  /** A name for the element, for the sidebar and the conversation log. Not what
   *  the chip reads - see `n`. */
  label: string
}

/** A reference once it has a place in a comment. `n` is assigned when the pick
 *  lands and never changes: it is what the chip reads and what the comment's
 *  `[ref n]` marker names, so deleting an earlier reference must not renumber the
 *  ones that survive - the user would watch a chip they were not touching change
 *  its name. Numbers are therefore stable but not contiguous. */
export interface NumberedRef extends RefWire {
  n: number
}

export type DraftNode =
  | { t: 'text'; v: string }
  /** `id` is empty while the upload is still in flight, exactly as the chip's
   *  own attribute is. */
  | { t: 'file'; id: string; name: string }
  /** `anchor: null` is the placeholder a pick leaves in the box while the user
   *  is off choosing an element. It holds the spot so the answer lands where the
   *  slash was typed, in this document or in the one after the navigation. `n` is
   *  meaningless until the anchor arrives. */
  | { t: 'ref'; n: number; anchor: AnchorWire | null; label: string }

/** What the popup was anchored to, captured as data rather than as a live node,
 *  so a save is still machine-precise when the node itself is gone. */
export interface DraftSubject {
  kind: 'element' | 'point' | 'text'
  /** `location.pathname` when the draft was taken. Decides where it may reopen. */
  page: string
  /** `buildAnchor()`'s output verbatim: everything re-resolution needs, and
   *  everything a save needs when re-resolution fails. */
  anchor: AnchorWire
  /** kind=text only. A Range cannot cross a navigation; the literal string can. */
  selectedText?: string
  /** kind=point only, in page coordinates. */
  pin?: { x: number; y: number }
  /** Where the viewport was when the draft was taken. A fresh document starts at
   *  the top, so without this a popup for anything below the fold comes back
   *  clamped to a corner, detached from the thing it is about. */
  scroll?: { x: number; y: number }
}

export interface DraftWire {
  /** The pick this draft belongs to, so a stale one cannot answer a fresh pick. */
  id: string
  host: 'popup' | 'note'
  createdAt: number
  /** Absent for the note box: it lives outside the iframe and never dies, so it
   *  has nothing to rebuild. */
  subject?: DraftSubject
  body: DraftNode[]
}

/** A plain trailing space in a contenteditable collapses to nothing, which would
 *  leave the caret with nowhere to sit after a chip that ends the box. */
export const NBSP = '\u00a0'

/** How a reference appears in the comment text.
 *
 *  The one definition of the format: `draftText` writes it and the shell reads it
 *  back to put the chip where the sentence had it. Two copies of this regex is
 *  two things to keep in step, and the failure is silent - a marker that renders
 *  as literal text. */
export const refMarker = (n: number): string => `[ref ${n}]`

/** What a reference chip reads, wherever it is drawn - the composer, the queue,
 *  the conversation log. Its number, not a description: a truncated run of the
 *  element's own text reads as a quotation and says nothing about *which* element
 *  was picked, while the number is the same one the sentence carries. The
 *  descriptive label goes in the chip's tooltip, where it answers "which one was
 *  that again" without crowding the line. */
export const refChipText = (n: number): string => `選取元素 ${n}`

/** How an attachment appears in the comment text. Files are marked for the same
 *  reason references are: a comment can point at one mid sentence, so *where* it
 *  sat is part of what the user said - "check this csv against that screenshot"
 *  is two files and a relationship between them.
 *
 *  Unlike a reference the number is positional, not an identity. A file chip
 *  reads its own name, so nothing on screen carries a number the user could
 *  watch renumber; the markers and the id list come out of one walk at send time,
 *  so they cannot disagree. `[file n]` is therefore the id at index n-1. */
export const fileMarker = (n: number): string => `[file ${n}]`
const MARKER = /\[(ref|file) (\d+)\]/g

export type CommentPart =
  | { t: 'text'; v: string }
  | { t: 'ref'; n: number }
  | { t: 'file'; n: number }

/** A comment split at its markers, so a reader can render the reference inline
 *  rather than leaving `[ref 1]` showing. */
export function splitComment(text: string): CommentPart[] {
  const out: CommentPart[] = []
  let at = 0
  for (const match of text.matchAll(MARKER)) {
    if (match.index > at) out.push({ t: 'text', v: text.slice(at, match.index) })
    out.push({ t: match[1] === 'file' ? 'file' : 'ref', n: Number(match[2]) })
    at = match.index + match[0].length
  }
  if (at < text.length) out.push({ t: 'text', v: text.slice(at) })
  return out
}

/** The text the comment reads as.
 *
 *  A file chip contributes nothing - its name is the file's, not the user's
 *  words, and the agent gets the files as their own field. A resolved reference
 *  contributes `[ref N]`, because unlike a file its *position* is the whole
 *  point: the sentence is "make this match [ref 1]". N is the number stored on
 *  the node, the same identity `draftRefs` reports, so the marker in the comment
 *  can never drift from the reference it names - and never the node's position,
 *  which would renumber the rest when one chip is deleted. */
export function draftText(body: DraftNode[]): string {
  const out: string[] = []
  // Counted in this pass, so the numbering matches `draftFileIds` by construction.
  let file = 0
  for (const node of body) {
    if (node.t === 'text') out.push(node.v)
    else if (node.t === 'ref' && node.anchor) out.push(refMarker(node.n))
    else if (node.t === 'file' && node.id) out.push(fileMarker(++file))
  }
  return out.join('').replaceAll(NBSP, ' ').trim()
}

/** A stored comment back into composer nodes - the inverse of the send-time walk,
 *  and what lets a queued annotation be reopened in a box and edited.
 *
 *  Each `[ref n]` / `[file n]` becomes its chip where the sentence had it, so the
 *  edit starts from what the reader was already looking at. A marker naming
 *  something that is no longer there stays as literal text, exactly as the
 *  read-only renderer shows it: the user can then see it and delete it, which is
 *  better than a silent disappearance they cannot account for.
 *
 *  Anything the markers did *not* place is appended. That is not a corner case -
 *  annotations written before `[file n]` existed carry files with no marker at
 *  all, and dropping them here would mean editing an old comment quietly threw
 *  its screenshots away. */
export function bodyFromComment(
  text: string,
  refs: NumberedRef[],
  files: { id: string; name: string }[],
): DraftNode[] {
  const byNumber = new Map(refs.map((r) => [r.n, r]))
  const placedRefs = new Set<number>()
  const placedFiles = new Set<number>()
  const body: DraftNode[] = []
  for (const part of splitComment(text)) {
    if (part.t === 'text') {
      body.push({ t: 'text', v: part.v })
      continue
    }
    if (part.t === 'ref') {
      const ref = byNumber.get(part.n)
      if (!ref) {
        body.push({ t: 'text', v: refMarker(part.n) })
        continue
      }
      placedRefs.add(part.n)
      body.push({ t: 'ref', n: ref.n, anchor: ref.anchor, label: ref.label })
      continue
    }
    const file = files[part.n - 1]
    if (!file) {
      body.push({ t: 'text', v: fileMarker(part.n) })
      continue
    }
    placedFiles.add(part.n)
    body.push({ t: 'file', id: file.id, name: file.name })
  }
  const trailing: DraftNode[] = []
  for (const ref of refs) {
    if (!placedRefs.has(ref.n)) trailing.push({ t: 'ref', ...ref })
  }
  files.forEach((file, i) => {
    if (!placedFiles.has(i + 1)) trailing.push({ t: 'file', id: file.id, name: file.name })
  })
  // A space before each appended chip, and one after the last: chips are atomic
  // to the caret, so without them an appended run has nowhere to type between.
  for (const node of trailing) body.push({ t: 'text', v: NBSP }, node)
  body.push({ t: 'text', v: NBSP })
  return normalizeDraft(body)
}

/** Resolved references in document order, each carrying the number the comment
 *  refers to it by. Order and numbering are independent: the array is positional,
 *  `n` is an identity. */
export function draftRefs(body: DraftNode[]): NumberedRef[] {
  const out: NumberedRef[] = []
  for (const node of body) {
    if (node.t === 'ref' && node.anchor) {
      out.push({ n: node.n, anchor: node.anchor, label: node.label })
    }
  }
  return out
}

/** The number a newly landed reference should take: one past the highest already
 *  spoken for, so a number is never reused and never moves. */
export function nextRefNumber(body: DraftNode[]): number {
  let max = 0
  for (const node of body) {
    if (node.t === 'ref' && node.anchor && node.n > max) max = node.n
  }
  return max + 1
}

/** Attachment ids in document order - the order `draftText`'s `[file n]` markers
 *  count, so `[file n]` is the id at index n-1. A chip whose upload has not
 *  landed has no id yet, so it is neither marked nor listed. */
export function draftFileIds(body: DraftNode[]): string[] {
  return body.flatMap((n) => (n.t === 'file' && n.id ? [n.id] : []))
}

/** Names of the chips a snapshot cannot carry: an upload in flight belongs to
 *  the document that started it and cannot be resumed from another one. Carried
 *  so a restore can say which files did not come back. */
export function draftPendingNames(body: DraftNode[]): string[] {
  return body.flatMap((n) => (n.t === 'file' && !n.id ? [n.name] : []))
}

/** True while a pick is outstanding: exactly one placeholder is expected. */
export function hasPendingRef(body: DraftNode[]): boolean {
  return body.some((n) => n.t === 'ref' && !n.anchor)
}

/** Fill in the placeholder a pick left behind. This is how an answer reaches a
 *  composer that no longer exists: the body it will be rebuilt from already has
 *  the spot marked, so the reference lands where the slash was typed even though
 *  the document that saw it typed is gone. */
export function resolveDraftRef(body: DraftNode[], ref: RefWire): DraftNode[] {
  const n = nextRefNumber(body)
  let done = false
  return body.map((node) => {
    if (done || node.t !== 'ref' || node.anchor) return node
    done = true
    return { t: 'ref', n, anchor: ref.anchor, label: ref.label }
  })
}

/** Drop the placeholder instead, for a pick that was called off. */
export function dropDraftRef(body: DraftNode[]): DraftNode[] {
  let done = false
  return normalizeDraft(
    body.filter((node) => {
      if (done || node.t !== 'ref' || node.anchor) return true
      done = true
      return false
    }),
  )
}

/** What can actually be rebuilt in another document. An upload in flight cannot,
 *  so its chip is dropped rather than restored as one that will never resolve. */
export function restorableBody(body: DraftNode[]): DraftNode[] {
  return normalizeDraft(body.filter((n) => !(n.t === 'file' && !n.id)))
}

/** Collapse adjacent text runs and drop empty ones, so two snapshots of the same
 *  box compare equal and a restore round-trips. The browser is free to split a
 *  text node wherever it likes; the draft should not care. */
export function normalizeDraft(body: DraftNode[]): DraftNode[] {
  const out: DraftNode[] = []
  for (const node of body) {
    if (node.t !== 'text') {
      out.push(node)
      continue
    }
    if (!node.v) continue
    const last = out[out.length - 1]
    if (last?.t === 'text') out[out.length - 1] = { t: 'text', v: last.v + node.v }
    else out.push(node)
  }
  return out
}

/** Whether a draft's subject belongs to the page the overlay is now showing. The
 *  note box has no subject and belongs to no page, so it is never "here". */
export function draftBelongsHere(draft: DraftWire, page: string): boolean {
  return draft.subject?.page === page
}

/** Mirrors ATTACHMENT_GRACE_MS in src/constants.ts, which imports node builtins
 *  and so cannot be pulled into a browser bundle. */
export const GRACE_MS = 24 * 60 * 60_000

/** A draft older than the attachment grace window can no longer resolve its own
 *  file ids - the sweep has taken them - so restoring it would only produce a
 *  save that is certain to fail. */
export function draftExpired(draft: DraftWire, now: number, graceMs: number): boolean {
  return now - draft.createdAt >= graceMs
}
