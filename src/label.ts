import type {
  Anchor,
  AgentAttachment,
  AgentItem,
  Annotation,
  Attachment,
  ConversationItem,
  Reference,
} from './protocol.js'

/** Just enough of the session store to locate a file. Taking this rather than a
 *  directory keeps the `<id>-<name>` convention in the one place that writes it. */
export interface AttachmentLocator {
  attachmentPath(a: Attachment): string
}

/** Absolute path, because the agent shares this machine and would rather open
 *  the file than be handed bytes. */
export function toAgentAttachment(a: Attachment, files: AttachmentLocator): AgentAttachment {
  return { name: a.name, mime: a.mime, size: a.size, path: files.attachmentPath(a) }
}

export function toAgentAttachments(
  list: Attachment[] | undefined,
  files: AttachmentLocator,
): AgentAttachment[] | undefined {
  return list?.length ? list.map((a) => toAgentAttachment(a, files)) : undefined
}

/** The machine-precise-first run shared by an item's own label and the label of
 *  anything it points at: file:line, then the component chain, then the section,
 *  then the text, then where the user was looking. `selector` is a fallback for
 *  when none of those landed, not a peer of them. */
function anchorParts(anchor: Anchor, textMax: number, withViewport: boolean): string[] {
  const parts: string[] = []
  if (anchor.source) parts.push(anchor.source)
  if (anchor.components?.length) parts.push(`<${anchor.components.join(' ← ')}>`)
  if (anchor.section) parts.push(`[section: ${anchor.section}]`)
  if (anchor.text) parts.push(`"${truncate(anchor.text, textMax)}"`)
  if (withViewport && anchor.viewport) {
    const { width, height, preset } = anchor.viewport
    parts.push(preset ? `@${preset} ${width}x${height}` : `@${width}x${height}`)
  }
  if (parts.length === 0 && anchor.selector) parts.push(anchor.selector)
  return parts
}

/** Agent-facing one-liner for a referenced element. No viewport: this is a
 *  summary sitting inside another label, and the full anchor travels beside it. */
export function referenceLabel(reference: Reference): string {
  return anchorParts(reference.anchor, 40, false).join(' · ') || reference.label
}

/** One-line, best-anchor-first summary the agent can act on without parsing the anchor. */
export function toAgentItem(a: Annotation, files: AttachmentLocator): AgentItem {
  const parts = anchorParts(a.anchor, a.kind === 'text' ? 60 : 40, true)
  if (a.kind === 'page') parts.unshift(`[page ${a.anchor.page ?? ''}]`.trim())
  if (a.kind === 'point') {
    const rel = a.anchor.point?.rel
    const at = rel ? ` ${Math.round(rel.x * 100)}%/${Math.round(rel.y * 100)}%` : ''
    parts.unshift(`[pin${at}]`)
  }
  // Last, in the order the agent needs them: the anchor above says where the
  // comment is, then what the user handed over with it. References come before
  // files because they are anchors too, and because the comment's own `[ref N]`
  // markers need something to resolve against.
  a.references?.forEach((r) => parts.push(`[ref ${r.n}: ${referenceLabel(r)}]`))
  // Numbered, not a bare list: the comment carries `[file n]` where the user put
  // it, and n is this array's position - so a comment about two files says which
  // is which instead of leaving the agent to guess from a comma-separated set.
  a.attachments?.forEach((x, i) => parts.push(`[file ${i + 1}: ${x.name}]`))
  const attachments = toAgentAttachments(a.attachments, files)
  return {
    id: a.id,
    kind: a.kind,
    comment: a.comment,
    label: parts.join(' · '),
    anchor: a.anchor,
    ...(attachments ? { attachments } : {}),
    ...(a.references?.length ? { references: a.references } : {}),
  }
}

/** Where the user pointed, in the terms they'd recognise. The text they clicked
 *  beats structural names, which beat the filename — the reverse of the agent's
 *  ordering, which wants the most machine-precise anchor first. */
export function shortAnchor(anchor: Anchor): string {
  const what =
    (anchor.text && truncate(anchor.text, 22)) ||
    anchor.section ||
    anchor.components?.[0] ||
    anchor.source?.split('/').pop() ||
    ''
  const at = viewportTag(anchor)
  return [what, at].filter(Boolean).join(' · ')
}

/** Only non-desktop widths are worth the pixels — desktop is the implied default,
 *  and a tag on every single row would read as noise. */
export function viewportTag(anchor: Anchor): string {
  const vp = anchor.viewport
  if (!vp || vp.preset === 'desktop') return ''
  return `${vp.width}px`
}

export function toConversationItem(a: Annotation): ConversationItem {
  const attachments = a.attachments?.map((x) => x.name)
  const references = a.references?.map((r) => ({ n: r.n, label: r.label }))
  return {
    comment: a.comment,
    where: shortAnchor(a.anchor),
    ...(attachments?.length ? { attachments } : {}),
    ...(references?.length ? { references } : {}),
  }
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}
