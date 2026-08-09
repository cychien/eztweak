import type { Anchor, Annotation, AgentItem, ConversationItem } from './protocol.js'

/** One-line, best-anchor-first summary the agent can act on without parsing the anchor. */
export function toAgentItem(a: Annotation): AgentItem {
  const parts: string[] = []
  if (a.anchor.source) parts.push(a.anchor.source)
  if (a.anchor.components?.length) parts.push(`<${a.anchor.components.join(' ← ')}>`)
  if (a.anchor.section) parts.push(`[section: ${a.anchor.section}]`)
  if (a.kind === 'text' && a.anchor.text) parts.push(`"${truncate(a.anchor.text, 60)}"`)
  else if (a.anchor.text) parts.push(`"${truncate(a.anchor.text, 40)}"`)
  if (a.anchor.viewport) {
    const { width, height, preset } = a.anchor.viewport
    parts.push(preset ? `@${preset} ${width}x${height}` : `@${width}x${height}`)
  }
  if (parts.length === 0 && a.anchor.selector) parts.push(a.anchor.selector)
  if (a.kind === 'page') parts.unshift(`[page ${a.anchor.page ?? ''}]`.trim())
  if (a.kind === 'point') {
    const rel = a.anchor.point?.rel
    const at = rel ? ` ${Math.round(rel.x * 100)}%/${Math.round(rel.y * 100)}%` : ''
    parts.unshift(`[pin${at}]`)
  }
  return {
    id: a.id,
    kind: a.kind,
    comment: a.comment,
    label: parts.join(' · '),
    anchor: a.anchor,
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
  return { comment: a.comment, where: shortAnchor(a.anchor) }
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}
