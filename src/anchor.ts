/** Parsing for the parts of a request that arrive as free-form JSON from a page
 *  we do not control. Pure, so the rules are testable without a server. */

import type { Anchor, ExploreCapture, Reference } from './protocol.js'

/** A comment pointing at more elements than this is a bug or an attack, not a
 *  person. Rejecting is better than truncating: silently dropping references
 *  would leave the `[ref N]` markers in the comment naming nothing. */
const MAX_REFERENCES = 16

/** How much of the explored element's markup the agent is shown. Enough for a
 *  component, not for a page: the point is what this element looks like, and a
 *  whole section's worth of DOM buys nothing the prompt can use. Truncation is
 *  flagged rather than hidden, so the agent knows it is not seeing all of it. */
const MAX_CAPTURE_HTML = 16 * 1024
/** The matched rules are the richest capture field and the one most able to
 *  bloat - a utility-class element matches dozens. Capped in count, per rule
 *  and in total, to the same figures the page uses. */
const MAX_CAPTURE_RULES = 40
const MAX_CAPTURE_RULE_CHARS = 1000
const MAX_CAPTURE_RULES_BYTES = 4 * 1024
const MAX_CAPTURE_TOKENS = 40
const MAX_CAPTURE_SIBLINGS = 12

/** What a shadow tree inherits from the page: these, and nothing else. */
const CAPTURE_INHERITED = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'color',
]

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

/** The design-relevant computed values, and nothing else. A whitelist rather
 *  than a cap on how many arrive: the page is asked for exactly these, and a
 *  client sending anything else is sending something the prompt has no use for. */
const CAPTURE_STYLES = [
  'box-sizing',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'color',
  'background-color',
  'border',
  'border-radius',
  'padding',
  'gap',
  'box-shadow',
  'text-transform',
]

/** What the page said the explored element currently looks like. Bounded for
 *  the same reason every other client-supplied field is: it ends up inside the
 *  agent's prompt. Null when there is no markup to explore, which is a 400 -
 *  a round with nothing to vary is not a round. */
export function sanitizeCapture(raw: unknown): ExploreCapture | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  const html = str(v.html, MAX_CAPTURE_HTML)
  if (!html) return null
  const out: ExploreCapture = { html }
  if (v.truncated === true || (typeof v.html === 'string' && v.html.length > MAX_CAPTURE_HTML)) {
    out.truncated = true
  }
  const styles: Record<string, string> = {}
  const given =
    typeof v.styles === 'object' && v.styles !== null ? (v.styles as Record<string, unknown>) : {}
  for (const property of CAPTURE_STYLES) {
    const value = str(given[property], 120)
    if (value) styles[property] = value
  }
  if (Object.keys(styles).length) out.styles = styles
  const width = v.parentWidth
  if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
    out.parentWidth = Math.round(width)
  }
  const rules = cappedStrings(
    v.rules,
    MAX_CAPTURE_RULES,
    MAX_CAPTURE_RULE_CHARS,
    MAX_CAPTURE_RULES_BYTES,
  )
  if (rules.length) out.rules = rules
  if (typeof v.slot === 'object' && v.slot !== null) {
    const given = v.slot as Record<string, unknown>
    const slot: NonNullable<ExploreCapture['slot']> = {}
    for (const key of ['display', 'direction', 'align', 'justify', 'gap'] as const) {
      const value = str(given[key], 120)
      if (value) slot[key] = value
    }
    if (typeof given.inherits === 'object' && given.inherits !== null) {
      const inherits: Record<string, string> = {}
      for (const property of CAPTURE_INHERITED) {
        const value = str((given.inherits as Record<string, unknown>)[property], 120)
        if (value) inherits[property] = value
      }
      if (Object.keys(inherits).length) slot.inherits = inherits
    }
    if (Object.keys(slot).length) out.slot = slot
  }
  if (typeof v.tokens === 'object' && v.tokens !== null) {
    const tokens: Record<string, string> = {}
    for (const [name, value] of Object.entries(v.tokens as Record<string, unknown>)) {
      if (Object.keys(tokens).length >= MAX_CAPTURE_TOKENS) break
      if (!/^--[\w-]{1,60}$/.test(name)) continue
      const clean = str(value, 120)
      if (clean) tokens[name] = clean
    }
    if (Object.keys(tokens).length) out.tokens = tokens
  }
  if (Array.isArray(v.siblings)) {
    const siblings: NonNullable<ExploreCapture['siblings']> = []
    for (const raw of v.siblings.slice(0, MAX_CAPTURE_SIBLINGS)) {
      if (typeof raw !== 'object' || raw === null) continue
      const sib = raw as Record<string, unknown>
      const tag = str(sib.tag, 30)
      if (!tag || typeof sib.width !== 'number' || typeof sib.height !== 'number') continue
      const cls = str(sib.class, 80)
      const text = str(sib.text, 60)
      siblings.push({
        tag,
        ...(cls ? { class: cls } : {}),
        ...(text ? { text } : {}),
        width: Math.round(sib.width),
        height: Math.round(sib.height),
      })
    }
    if (siblings.length) out.siblings = siblings
  }
  if (typeof v.theme === 'object' && v.theme !== null) {
    const given = v.theme as Record<string, unknown>
    const theme: NonNullable<ExploreCapture['theme']> = {}
    const scheme = str(given.scheme, 40)
    if (scheme) theme.scheme = scheme
    const classes = str(given.classes, 120)
    if (classes) theme.classes = classes
    const dataTheme = str(given.dataTheme, 40)
    if (dataTheme) theme.dataTheme = dataTheme
    if (Object.keys(theme).length) out.theme = theme
  }
  return out
}

/** A list of strings, each and all bounded. Anything that is not a string is
 *  dropped rather than failing the whole capture: one bad entry from the page
 *  should not cost the agent the rest. */
function cappedStrings(raw: unknown, max: number, each: number, total: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  let bytes = 0
  for (const item of raw) {
    if (out.length >= max) break
    const value = str(item, each)
    if (!value) continue
    if (bytes + value.length > total) break
    out.push(value)
    bytes += value.length
  }
  return out
}
