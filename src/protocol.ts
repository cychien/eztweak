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
  rect?: { x: number; y: number; width: number; height: number }
  viewport?: { width: number; height: number; preset?: string }
  /** page pathname the annotation was made on */
  page?: string
}

export interface Annotation {
  id: string
  kind: AnnotationKind
  comment: string
  anchor: Anchor
  createdAt: number
}

export interface FeedbackBatch {
  batchId: string
  items: Annotation[]
  /** free-form message typed in the shell's note box */
  note: string | null
  sentAt: number
  deliveredAt?: number
  ackedAt?: number
}

/** One annotation as it reads back in the conversation log. `where` is a short,
 *  human-recognisable hint — not the agent-facing anchor. */
export interface ConversationItem {
  comment: string
  where: string
}

export interface ConversationEntry {
  role: 'user' | 'agent' | 'system'
  /** Free-form message. For a sent batch this is the user's note, if any. */
  text: string
  ts: number
  batchId?: string
  items?: ConversationItem[]
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
  | { type: 'feedback'; batchId: string; url: string; note: string | null; items: AgentItem[] }
  | { type: 'session-ended'; endedBy: SessionEndedBy }

export interface AgentItem {
  id: string
  kind: AnnotationKind
  comment: string
  /** one-line human-ordered summary: source · components · section · text */
  label: string
  anchor: Anchor
}
