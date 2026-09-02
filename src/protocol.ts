/** `element` = the user framed a region. `point` = the user dropped a pin and we
 *  resolved whatever sits under it. `text` = a selection inside an element. */
export type AnnotationKind = 'element' | 'point' | 'text' | 'page'

export interface Anchor {
  /** Only for kind=point: where the pin landed. `rel` is the position inside the
   *  resolved element (0–1), which disambiguates a pin dropped on a wide box. */
  point?: { x: number; y: number; rel: { x: number; y: number } }
  /** file:line from the optional build-plugin attribute (`data-ez-source`) */
  source?: string
  /** React component chain, innermost first (e.g. ["HeroSection", "SchoolPage"]) */
  components?: string[]
  /** nearest `data-section` / landmark ancestor */
  section?: string
  selector?: string
  /** trimmed text content or the selected text for kind=text */
  text?: string
  /** Only for a framed region: one line per element the frame enclosed,
   *  outermost first. The anchor's other fields resolve to their common
   *  ancestor, so this is what says the user meant a group rather than it. */
  contains?: string[]
  /** The element's own box - or, for a framed region, the box the user drew. */
  rect?: { x: number; y: number; width: number; height: number }
  viewport?: { width: number; height: number; preset?: string }
  /** page pathname the annotation was made on */
  page?: string
}

/** A file pasted into a comment box, stored under `<sessionDir>/attachments/`.
 *  The bytes never travel in the annotation itself - clients hold only the id. */
export interface Attachment {
  id: string
  /** display name, deduplicated within the session (image.png, image-2.png, …) */
  name: string
  mime: string
  size: number
  createdAt: number
}

/** Agent-facing view: an absolute path, because the agent runs on this machine
 *  and would rather open the file than be handed bytes. */
export interface AgentAttachment {
  name: string
  mime: string
  size: number
  path: string
}

/** An element the user pointed the agent *at* from inside a comment - "make this
 *  match that one" - as opposed to the element the comment is *about*. Same
 *  layered anchor, because the same walk produced it.
 *
 *  Deliberately not folded into `Anchor`: an anchor answers "where is this
 *  feedback about", which is singular by construction, and a batch note has no
 *  anchor at all yet still has to be able to point at something. The comment
 *  text carries `[ref n]` markers, because unlike a file a reference's *position
 *  in the sentence* is the point. */
export interface Reference {
  /** What `[ref n]` in the comment refers to. Assigned when the user picked the
   *  element and stable for the life of the comment, so it is **not** an index
   *  into this array and the numbers may have gaps: deleting one reference must
   *  not renumber the others under the user. Match on this, not on position. */
  n: number
  anchor: Anchor
  /** A name for the element, for the sidebar and the conversation log. */
  label: string
}

/** A reference as it reads back in the conversation log and the queue: enough to
 *  render the chip the comment's `[ref n]` marker stands for, and nothing more -
 *  the anchor is the agent's business. */
export interface ReferenceEcho {
  n: number
  label: string
}

export interface Annotation {
  id: string
  kind: AnnotationKind
  comment: string
  anchor: Anchor
  createdAt: number
  attachments?: Attachment[]
  references?: Reference[]
}

export interface FeedbackBatch {
  batchId: string
  items: Annotation[]
  /** free-form message typed in the shell's note box */
  note: string | null
  /** files pasted into the note box, i.e. attached to the batch, not to an item */
  attachments?: Attachment[]
  /** elements picked into the note box, i.e. pointed at by the batch, not an item */
  references?: Reference[]
  sentAt: number
  deliveredAt?: number
  ackedAt?: number
}

/** One annotation as it reads back in the conversation log. `where` is a short,
 *  human-recognisable hint — not the agent-facing anchor. */
export interface ConversationItem {
  comment: string
  where: string
  /** names only: the log shows what was attached, not where it lives */
  attachments?: string[]
  references?: ReferenceEcho[]
}

export interface ConversationEntry {
  role: 'user' | 'agent' | 'system'
  /** Free-form message. For a sent batch this is the user's note, if any. */
  text: string
  ts: number
  /** For a user entry, the batch it sent. For an agent or turn-end system entry,
   *  the batch it answers - which is what lets the thread draw a reply under its
   *  own question when the two are not adjacent in the log. Absent on anything
   *  that belongs to no batch. */
  batchId?: string
  items?: ConversationItem[]
  attachments?: string[]
  references?: ReferenceEcho[]
}

export type SessionEndedBy = 'user' | 'agent'

export interface SessionState {
  id: string
  targetOrigin: string
  /** port of this session's proxy+shell+api server */
  port: number
  state: 'active' | 'ended'
  endedBy?: SessionEndedBy
  createdAt: number
}

/** What `poll` prints to stdout (one JSON document, then exit). */
export type PollResult =
  | {
      type: 'feedback'
      batchId: string
      url: string
      note: string | null
      items: AgentItem[]
      /** files that came with the note rather than with any one item */
      attachments?: AgentAttachment[]
      /** elements the note points at, rather than any one item */
      references?: Reference[]
    }
  | { type: 'session-ended'; endedBy: SessionEndedBy }

export interface AgentItem {
  id: string
  kind: AnnotationKind
  comment: string
  /** one-line human-ordered summary: source · components · section · text */
  label: string
  anchor: Anchor
  attachments?: AgentAttachment[]
  /** Elements this comment points at. `[ref n]` in `comment` and in `label` names
   *  the entry whose `n` matches - not a position in this array. */
  references?: Reference[]
}
