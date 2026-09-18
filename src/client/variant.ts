/** Standing an agent's variant in a live element's place, and finding that place
 *  again every time the app rebuilds it.
 *
 *  Four decisions carry this file.
 *
 *  **The original is hidden, never removed.** A host is inserted as its next
 *  sibling and the original gets `data-ez-swapped`, which a rule takes out of
 *  layout. Replacing the node would break the app: React's reconciler asserts on
 *  the nodes it created, and the next update that touches a replaced one throws.
 *  A foreign *sibling* it tolerates, because it positions its own children
 *  relative to its own children. Taking the original out of layout rather than
 *  merely hiding it is what lets the variant have its flex or grid slot, which is
 *  most of what a layout review is looking at.
 *
 *  **The variant lives in a shadow root, and the host is `display: contents`.**
 *  Isolation both ways is the shadow boundary's to give, not a selector rewrite's:
 *  the page's rules cannot reach the variant, the variant's `<style>` cannot
 *  reach the page, and `@media` and `@keyframes` just work. What does cross the
 *  boundary is exactly what a variant of *this* page should get - inherited
 *  typography and colour, and the page's CSS custom properties - so it looks
 *  native without being subject to `.cta-row a { ... }`. The host itself has no
 *  box: `display: contents` hands its slot to the variant, so the flex or grid
 *  item is the agent's markup, not a wrapper around it. The earlier rewrite is
 *  gone with the bug it had - a rule for the variant's own root class was
 *  rewritten to a descendant selector and never matched it again, which is what
 *  "the base styles are missing" looked like.
 *
 *  **The element is found again, not held onto.** A popover is the general case,
 *  not a special one: React re-renders, HMR remounts, the user navigates away and
 *  back. An element reference survives none of that; the anchor does. So a
 *  `MutationObserver` re-runs the search whenever nodes arrive and re-applies the
 *  selection to a fresh match. That is what makes "close the dialog, open it
 *  again, the variant is still there" true, and with the build plugin it is
 *  exact: the same JSX has the same `file:line` on every mount.
 *
 *  **The search is pure.** `locate` scores serialised candidates rather than
 *  elements, so the rules that decide which of three identical cards the user
 *  meant can be tested without a DOM - which the test suite does not have. */

import type { Anchor } from '../protocol.js'

/** Marks the real element while its variant stands in for it. */
export const SWAPPED_ATTR = 'data-ez-swapped'
/** Marks a variant root, and names the round it belongs to. */
export const VARIANT_ATTR = 'data-ez-variant'
const SOURCE_ATTR = 'data-ez-source'

// --------------------------------------------------------------- locating

/** One element the page offers, reduced to what the search reads. Serialisable
 *  on purpose: the scoring is the part worth testing, and it should not need a
 *  browser to run. */
export interface Candidate {
  source?: string
  components?: string[]
  selector?: string
  text?: string
}

/** How well a candidate answers an anchor, or -1 for "not this one".
 *
 *  Layered the way the anchor itself is, and the order is the point.
 *
 *  `source` is `file:line` from the build plugin, the only identity here that
 *  survives a re-render, so it outranks everything. **Text comes next, above the
 *  selector**, because the two answer different questions: the text says *which
 *  instance*, the selector says *which position*, and when a list re-orders it is
 *  the position that has moved. Three cards from one component share a `source`
 *  and differ only in what they say; ranking their position higher would follow
 *  the swap to whatever is now second. Component chain scores last and never
 *  alone - every card in a list has it - so it breaks a tie and cannot make one.
 *
 *  A candidate that contradicts the anchor where both are specific - a different
 *  `file:line` - is rejected outright rather than scored low, because a confident
 *  wrong swap is worse than none. */
export function scoreCandidate(anchor: Anchor, candidate: Candidate): number {
  if (anchor.source && candidate.source && anchor.source !== candidate.source) return -1
  let score = 0
  if (anchor.source && candidate.source === anchor.source) score += 100
  if (anchor.text && candidate.text) {
    if (candidate.text === anchor.text) score += 40
    else if (candidate.text.includes(anchor.text) || anchor.text.includes(candidate.text)) {
      score += 12
    }
  }
  if (anchor.selector && candidate.selector === anchor.selector) score += 20
  if (anchor.components?.length && candidate.components?.length) {
    if (candidate.components[0] === anchor.components[0]) score += 4
    if (anchor.components.every((name) => candidate.components!.includes(name))) score += 2
  }
  return score
}

/** Nothing weaker than this is a match. One layer agreeing on its own - a shared
 *  component name, a substring of the text - is what every card in a list has in
 *  common, and swapping the wrong one is worse than swapping none. */
const MIN_SCORE = 20

/** Which candidate the anchor means, or null when none of them convincingly do.
 *
 *  First past the post on a tie, which is document order: two candidates the
 *  anchor cannot tell apart are two the *user* could not have told apart either,
 *  and the first is the one they were most likely looking at. */
export function locate(anchor: Anchor, candidates: Candidate[]): number | null {
  let best = -1
  let bestScore = MIN_SCORE - 1
  candidates.forEach((candidate, i) => {
    const score = scoreCandidate(anchor, candidate)
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  })
  return best === -1 ? null : best
}

// --------------------------------------------------------------- sanitising

const FORBIDDEN_TAGS = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base']

/** Strip everything a style exploration has no business carrying. The daemon
 *  refuses most of this already, on the way in from the agent - this is the same
 *  rules enforced where there is a real parser, because what reaches the page is
 *  what actually matters and a string check is not a parse. */
function sanitize(root: Element): void {
  for (const tag of FORBIDDEN_TAGS) {
    for (const node of [...root.querySelectorAll(tag)]) node.remove()
  }
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on')) element.removeAttribute(attribute.name)
      else if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^\s*javascript:/i.test(attribute.value)
      ) {
        element.removeAttribute(attribute.name)
      }
    }
  }
}

/** The variant's markup, parsed and sanitised, as one root element. Null when
 *  there is no element in it, which the daemon should already have refused.
 *
 *  `:root` becomes `:host`. Inside a shadow tree `:root` matches nothing - the
 *  shadow root is not an element - and an agent writing `:root { --x: ... }` for
 *  its own tokens would silently lose them. The prompt says so too; this catches
 *  the ones that did not listen. A plain text replace rather than a CSSOM walk,
 *  because the sheet does not exist until the node is in a document and the
 *  variant is built before that. */
export function buildVariant(html: string, doc: Document): Element | null {
  const template = doc.createElement('template')
  template.innerHTML = html
  const root = template.content.firstElementChild
  if (!root) return null
  sanitize(root)
  for (const style of root.querySelectorAll('style')) {
    style.textContent = (style.textContent ?? '').replace(/:root\b/g, ':host')
  }
  return root
}

/** The element a variant stands in as. Marked with the round it belongs to,
 *  boxless so the variant takes the slot, and open so devtools and the overlay
 *  can look inside. */
export const HOST_TAG = 'ez-variant'

export function mountVariant(
  root: Element,
  exploreId: string,
  doc: Document,
  /** The sizing model of the element the variant stands in for. */
  boxSizing: string,
): HTMLElement {
  const host = doc.createElement(HOST_TAG)
  host.setAttribute(VARIANT_ATTR, exploreId)
  host.style.display = 'contents'
  // The one reset that decides layout rather than looks. Nearly every page sets
  // `border-box` on `*`, and nothing from the page reaches a shadow tree - so a
  // variant written the way the page is written, `width: 100%` with padding,
  // came out content-box and overflowed its slot by exactly that padding. The
  // element's own value, not a fixed one: the variant should lay out under the
  // rule its original did.
  const baseline = doc.createElement('style')
  baseline.textContent = `*, *::before, *::after { box-sizing: ${boxSizing}; }`
  host.attachShadow({ mode: 'open' }).append(baseline, root)
  return host
}

// --------------------------------------------------------------- swapping

/** What one round wants standing on the page: its own markup, or nothing. */
export interface Swap {
  exploreId: string
  anchor: Anchor
  html: string | null
}

/** Everything one document currently has swapped, and the observer keeping it
 *  that way. One of these per preview frame. */
export class VariantSwapper {
  private readonly swaps = new Map<string, Swap>()
  private observer: MutationObserver | null = null
  private queued = false

  constructor(
    private readonly doc: Document,
    /** How the candidates are read off the document. Injected so the overlay's
     *  own `cssPath` and `componentChain` are the ones used, rather than a second
     *  implementation here that could disagree with the anchors they built. */
    private readonly describe: (element: Element) => Candidate,
  ) {}

  /** Put a round's variant on the page, or take it off with `html: null`.
   *
   *  Always restores first. `apply` leaves a round alone that already has
   *  something standing, which is what makes re-applying after a re-render
   *  idempotent - but the user picking a *different* variant of the same round is
   *  a real change, and without this it would be swallowed by that same guard. */
  set(swap: Swap): void {
    this.restore(swap.exploreId)
    if (swap.html === null) {
      this.swaps.delete(swap.exploreId)
    } else {
      this.swaps.set(swap.exploreId, swap)
      this.apply(swap)
    }
    this.watch()
  }

  /** Give the page back, whole. */
  clear(): void {
    for (const exploreId of [...this.swaps.keys()]) this.restore(exploreId)
    this.swaps.clear()
    this.watch()
  }

  /** Re-apply everything to whatever is mounted now. Called by the observer, and
   *  safe to call at any time: a round already standing where it should be is
   *  left alone. */
  reapply(): void {
    for (const swap of this.swaps.values()) this.apply(swap)
  }

  private apply(swap: Swap): void {
    if (this.doc.querySelector(`[${VARIANT_ATTR}="${cssEscape(swap.exploreId)}"]`)) return
    const elements = [...this.doc.querySelectorAll<Element>(`[${SOURCE_ATTR}], body *`)].filter(
      (el) => !el.closest(`[${VARIANT_ATTR}]`) && !el.hasAttribute(SWAPPED_ATTR),
    )
    const index = locate(
      swap.anchor,
      elements.map((el) => this.describe(el)),
    )
    if (index === null) return
    const target = elements[index]!
    const root = buildVariant(swap.html!, this.doc)
    if (!root) return
    const boxSizing = this.doc.defaultView?.getComputedStyle(target).boxSizing || 'content-box'
    target.setAttribute(SWAPPED_ATTR, swap.exploreId)
    target.insertAdjacentElement(
      'afterend',
      mountVariant(root, swap.exploreId, this.doc, boxSizing),
    )
  }

  private restore(exploreId: string): void {
    const id = cssEscape(exploreId)
    for (const node of this.doc.querySelectorAll(`[${VARIANT_ATTR}="${id}"]`)) node.remove()
    for (const node of this.doc.querySelectorAll(`[${SWAPPED_ATTR}="${id}"]`)) {
      node.removeAttribute(SWAPPED_ATTR)
    }
  }

  /** Watch only while something is swapped: an observer on the whole body is not
   *  free, and a review with no explore open should not be paying for one. */
  private watch(): void {
    if (!this.swaps.size) {
      this.observer?.disconnect()
      this.observer = null
      return
    }
    if (this.observer) return
    this.observer = new MutationObserver((records) => {
      // Our own insertions and removals are mutations too. Reacting to them would
      // be a loop, so a batch that is only ever us is dropped.
      const theirs = records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some(
          (node) => !(node instanceof Element) || !this.ours(node),
        ),
      )
      if (!theirs) return
      // Coalesced: a re-render arrives as a burst of records, and searching the
      // document once per record would be the same answer computed many times.
      if (this.queued) return
      this.queued = true
      queueMicrotask(() => {
        this.queued = false
        this.collectOrphans()
        this.reapply()
      })
    })
    this.observer.observe(this.doc.body, { childList: true, subtree: true })
  }

  private ours(node: Element): boolean {
    return node.hasAttribute(VARIANT_ATTR) || node.hasAttribute(SWAPPED_ATTR)
  }

  /** A variant whose original is gone - the app removed one child rather than
   *  the subtree - would otherwise be left standing on its own, which reads as
   *  the variant having become the page. */
  private collectOrphans(): void {
    for (const variant of this.doc.querySelectorAll(`[${VARIANT_ATTR}]`)) {
      const id = variant.getAttribute(VARIANT_ATTR)!
      if (!this.doc.querySelector(`[${SWAPPED_ATTR}="${cssEscape(id)}"]`)) variant.remove()
    }
  }
}

const cssEscape = (value: string): string =>
  typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&')

// --------------------------------------------------------------- capturing

/** The computed values worth showing an agent: the ones a designer would name,
 *  not the ones a layout engine would. Mirrored in `sanitizeCapture`, which is
 *  what actually decides - this list only decides what is worth asking for. */
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

/** What crosses into a shadow tree from outside: the inherited properties. These
 *  are read off the *parent*, because that is what the variant will actually
 *  inherit - the element's own values include its own rules, which the variant
 *  does not get. */
const INHERITED = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'color',
]

/** How the parent lays its children out, which is the slot the variant has to
 *  fit. */
type SlotKey = 'display' | 'direction' | 'align' | 'justify' | 'gap'
const SLOT_LAYOUT: Record<SlotKey, string> = {
  display: 'display',
  direction: 'flex-direction',
  align: 'align-items',
  justify: 'justify-content',
  gap: 'gap',
}

/** How much markup travels. Matched to the daemon's own cap, so what the page
 *  sends is what the agent sees rather than something silently trimmed later. */
const MAX_CAPTURE_HTML = 16 * 1024
/** Matched rules are the richest field and the one most able to bloat: a
 *  utility-class element can match dozens. The daemon caps to the same. */
const MAX_RULES_BYTES = 4 * 1024
const MAX_RULES = 40
const MAX_TOKENS = 40
const MAX_SIBLINGS = 12

export interface Capture {
  html: string
  truncated?: true
  styles?: Record<string, string>
  parentWidth?: number
  rules?: string[]
  slot?: {
    display?: string
    direction?: string
    align?: string
    justify?: string
    gap?: string
    inherits?: Record<string, string>
  }
  tokens?: Record<string, string>
  siblings?: { tag: string; class?: string; text?: string; width: number; height: number }[]
  theme?: { scheme?: string; classes?: string; dataTheme?: string }
}

/** What the element looks like right now, for the agent to write variants of.
 *  Taken at the moment the user asks, because by the time a variant comes back
 *  the agent's own markup may be standing in this element's place. */
export function captureElement(element: Element): Capture {
  const doc = element.ownerDocument
  const view = doc.defaultView
  const html = element.outerHTML
  const capture: Capture = {
    html: html.slice(0, MAX_CAPTURE_HTML),
    ...(html.length > MAX_CAPTURE_HTML ? { truncated: true as const } : {}),
  }
  if (!view) return capture

  const styles = pick(view.getComputedStyle(element), CAPTURE_STYLES)
  if (Object.keys(styles).length) capture.styles = styles

  const rules = matchedRules(element, doc)
  if (rules.length) capture.rules = rules

  const parent = element.parentElement
  if (parent) {
    const width = parent.getBoundingClientRect().width
    if (width > 0) capture.parentWidth = Math.round(width)
    const computed = view.getComputedStyle(parent)
    const slot: NonNullable<Capture['slot']> = {}
    for (const [key, property] of Object.entries(SLOT_LAYOUT) as [SlotKey, string][]) {
      const value = computed.getPropertyValue(property).trim()
      if (value && value !== 'normal') slot[key] = value
    }
    const inherits = pick(computed, INHERITED)
    if (Object.keys(inherits).length) slot.inherits = inherits
    if (Object.keys(slot).length) capture.slot = slot

    const siblings = [...parent.children]
      .filter(
        (el) => el !== element && !el.hasAttribute(VARIANT_ATTR) && !el.hasAttribute(SWAPPED_ATTR),
      )
      .slice(0, MAX_SIBLINGS)
      .map((el) => {
        const rect = el.getBoundingClientRect()
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
        const cls = el.getAttribute('class')?.trim().slice(0, 80)
        return {
          tag: el.tagName.toLowerCase(),
          ...(cls ? { class: cls } : {}),
          ...(text ? { text } : {}),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      })
    if (siblings.length) capture.siblings = siblings
  }

  const tokens = rootTokens(doc)
  if (Object.keys(tokens).length) capture.tokens = tokens

  const rootEl = doc.documentElement
  const theme: NonNullable<Capture['theme']> = {}
  const scheme = view.getComputedStyle(rootEl).getPropertyValue('color-scheme').trim()
  if (scheme && scheme !== 'normal') theme.scheme = scheme
  const classes = [rootEl.className, doc.body?.className ?? ''].filter(Boolean).join(' ').trim()
  if (classes) theme.classes = classes.slice(0, 120)
  const dataTheme = rootEl.dataset.theme ?? doc.body?.dataset.theme
  if (dataTheme) theme.dataTheme = dataTheme.slice(0, 40)
  if (Object.keys(theme).length) capture.theme = theme

  return capture
}

function pick(computed: CSSStyleDeclaration, properties: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const property of properties) {
    const value = computed.getPropertyValue(property).trim()
    if (value) out[property] = value
  }
  return out
}

/** Pseudo-classes and pseudo-elements a rule can carry and still be *about* this
 *  element. Stripped before matching - `el.matches('.btn:hover')` is false unless
 *  the pointer is on it - and the rule kept whole, because the hover state is
 *  the point. */
const PSEUDO = /::?[a-zA-Z-]+(\([^)]*\))?/g

/** The page's rules that apply to the element or anything inside it, in sheet
 *  order, deduplicated, capped. `@media` blocks are unwrapped so the condition
 *  travels with the rule. Cross-origin sheets refuse `cssRules` and are skipped:
 *  what cannot be read cannot be copied, and the agent is told about the rules
 *  it *is* shown, not promised all of them. */
function matchedRules(element: Element, doc: Document): string[] {
  const targets = [element, ...element.querySelectorAll('*')]
  const seen = new Set<string>()
  const out: string[] = []
  let bytes = 0
  const applies = (selectorText: string): boolean =>
    selectorText.split(',').some((one) => {
      const base = one.replace(PSEUDO, '').trim()
      if (!base) return false
      try {
        return targets.some((t) => t.matches(base))
      } catch {
        return false
      }
    })
  const take = (text: string): boolean => {
    if (seen.has(text)) return true
    if (out.length >= MAX_RULES || bytes + text.length > MAX_RULES_BYTES) return false
    seen.add(text)
    out.push(text)
    bytes += text.length
    return true
  }
  const walk = (rules: CSSRuleList, wrap: (text: string) => string): boolean => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        if (applies(rule.selectorText) && !take(wrap(rule.cssText))) return false
      } else if (rule instanceof CSSMediaRule) {
        const condition = rule.conditionText
        if (!walk(rule.cssRules, (text) => wrap(`@media ${condition} { ${text} }`))) return false
      } else if (rule instanceof CSSSupportsRule) {
        const condition = rule.conditionText
        if (!walk(rule.cssRules, (text) => wrap(`@supports ${condition} { ${text} }`))) return false
      }
    }
    return true
  }
  for (const sheet of doc.styleSheets) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    if (!walk(rules, (text) => text)) break
  }
  return out
}

/** Custom properties declared on `:root` / `html`, resolved through the
 *  computed style so the agent sees `#2563eb` and not a chain of `var()`. Read
 *  off the sheets rather than the computed style because computed styles do not
 *  enumerate custom properties. */
function rootTokens(doc: Document): Record<string, string> {
  const names = new Set<string>()
  const walk = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        if (!/(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText)) continue
        for (let i = 0; i < rule.style.length; i += 1) {
          const name = rule.style[i]!
          if (name.startsWith('--')) names.add(name)
        }
      } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
        walk(rule.cssRules)
      }
    }
  }
  for (const sheet of doc.styleSheets) {
    try {
      walk(sheet.cssRules)
    } catch {
      continue
    }
  }
  const computed = doc.defaultView?.getComputedStyle(doc.documentElement)
  const out: Record<string, string> = {}
  if (!computed) return out
  for (const name of [...names].slice(0, MAX_TOKENS)) {
    const value = computed.getPropertyValue(name).trim()
    if (value) out[name] = value.slice(0, 120)
  }
  return out
}
