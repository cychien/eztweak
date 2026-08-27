/** Parsing for the parts of a request that arrive as free-form JSON from a page
 *  we do not control. Pure, so the rules are testable without a server. */

import type { Anchor, Reference } from './protocol.js'

/** A comment pointing at more elements than this is a bug or an attack, not a
 *  person. Rejecting is better than truncating: silently dropping references
 *  would leave the `[ref N]` markers in the comment naming nothing. */
const MAX_REFERENCES = 16

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v ? v.slice(0, max) : undefined

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

function strings(v: unknown, max: number, each: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.slice(0, max).flatMap((x) => {
    const s = str(x, each)
    return s ? [s] : []
  })
  return out.length ? out : undefined
}

function point(v: unknown): Anchor['point'] {
  if (typeof v !== 'object' || v === null) return undefined
  const { x, y, rel } = v as Record<string, unknown>
  const px = num(x)
  const py = num(y)
  if (px === undefined || py === undefined) return undefined
  const r = (typeof rel === 'object' && rel !== null ? rel : {}) as Record<string, unknown>
  return { x: px, y: py, rel: { x: num(r.x) ?? 0, y: num(r.y) ?? 0 } }
}

function rect(v: unknown): Anchor['rect'] {
  if (typeof v !== 'object' || v === null) return undefined
  const { x, y, width, height } = v as Record<string, unknown>
  const vals = [num(x), num(y), num(width), num(height)]
  if (vals.some((n) => n === undefined)) return undefined
  return { x: vals[0]!, y: vals[1]!, width: vals[2]!, height: vals[3]! }
}

function viewport(v: unknown): Anchor['viewport'] {
  if (typeof v !== 'object' || v === null) return undefined
  const { width, height, preset } = v as Record<string, unknown>
  const w = num(width)
  const h = num(height)
  if (w === undefined || h === undefined) return undefined
  const p = str(preset, 40)
  return { width: w, height: h, ...(p ? { preset: p } : {}) }
}

/** Whitelist and bound an anchor. Unknown keys do not survive and no string is
 *  unbounded, because all of this ends up inside the agent's prompt.
 *
 *  Note the gap this does *not* close: an item's own `anchor` is still stored
 *  exactly as it arrived. Same trust level, same argument for bounding it - but
 *  changing what a queued annotation holds is a separate change from adding
 *  references, so it is left alone here rather than folded in quietly. */
export function sanitizeAnchor(raw: unknown): Anchor | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  const out: Anchor = {}
  const source = str(v.source, 300)
  if (source) out.source = source
  const components = strings(v.components, 6, 80)
  if (components) out.components = components
  const section = str(v.section, 120)
  if (section) out.section = section
  const selector = str(v.selector, 400)
  if (selector) out.selector = selector
  const text = str(v.text, 200)
  if (text) out.text = text
  const contains = strings(v.contains, 16, 120)
  if (contains) out.contains = contains
  const page = str(v.page, 300)
  if (page) out.page = page
  const p = point(v.point)
  if (p) out.point = p
  const r = rect(v.rect)
  if (r) out.rect = r
  const vp = viewport(v.viewport)
  if (vp) out.viewport = vp
  return out
}

/** Null marks a malformed field, which is a 400 - distinct from an absent one,
 *  which just means no ids. Moved here from the daemon so the two request
 *  parsers sit together and can be tested the same way. */
export function attachmentIds(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) return null
  return raw
}

/** Same contract as `attachmentIds`: null is a 400, [] is "none". A reference
 *  whose anchor is unusable fails the whole request rather than vanishing - a
 *  missing reference leaves a `[ref N]` marker in the comment pointing at
 *  nothing, which is worse for the agent than an error the client can report. */
export function parseReferences(raw: unknown, max = MAX_REFERENCES): Reference[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > max) return null
  const out: Reference[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const { n, anchor, label } = item as Record<string, unknown>
    const clean = sanitizeAnchor(anchor)
    if (!clean) return null
    // The comment's `[ref n]` markers resolve against this, so a missing or
    // nonsense number leaves the agent unable to tell which reference is which.
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 999) return null
    out.push({ n, anchor: clean, label: str(label, 120) ?? '' })
  }
  return out
}
