/** Standing an agent's variant in a live element's place, and finding that place
 *  again every time the app rebuilds it.
 *
 *  Three decisions carry this file.
 *
 *  **The original is hidden, never removed.** The variant is inserted as its next
 *  sibling and the original gets `data-ez-swapped`, which a rule takes out of
 *  layout. Replacing the node would break the app: React's reconciler asserts on
 *  the nodes it created, and the next update that touches a replaced one throws.
 *  A foreign *sibling* it tolerates, because it positions its own children
 *  relative to its own children. Taking the original out of layout rather than
 *  merely hiding it is what lets the variant have its flex or grid slot, which is
 *  most of what a layout review is looking at.
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

/** Confine a variant's own `<style>` to the variant.
 *
 *  Rewriting `selectorText` through the CSSOM rather than the text, so a
 *  selector list is handled a comma at a time and the browser's own parse is
 *  what decides where one selector ends. Nested at-rules are left alone in this
 *  version: a variant leaning on `@media` will leak, which is a known limit
 *  rather than an oversight - the common case by far is a handful of flat rules
 *  for the markup right there. */
function scopeStyles(root: Element, exploreId: string): void {
  const scope = `[${VARIANT_ATTR}="${CSS.escape(exploreId)}"]`
  for (const style of root.querySelectorAll('style')) {
    const sheet = (style as HTMLStyleElement).sheet
    if (!sheet) continue
    try {
      for (const rule of [...sheet.cssRules]) {
        if (!(rule instanceof CSSStyleRule)) continue
        rule.selectorText = rule.selectorText
          .split(',')
          .map((one) => {
            const trimmed = one.trim()
            // `:root`, `html` and `body` in a variant mean "the thing I am", not
            // the document - honouring them literally would paint the page.
            if (/^(:root|html|body)$/i.test(trimmed)) return scope
            return `${scope} ${trimmed}`
          })
          .join(', ')
      }
      // Whatever the rewrite produced is the styling now; keeping the original
      // text would let a later re-parse undo the scoping.
      style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join('\n')
    } catch {
      // A sheet the browser will not let us read - the safe answer is no styling
      // rather than unscoped styling.
      style.remove()
    }
  }
}

/** Parse a variant into one root element, sanitised and scoped. Null when there
 *  is no element in it, which the daemon should already have refused. */
export function buildVariant(html: string, exploreId: string, doc: Document): Element | null {
  const template = doc.createElement('template')
  template.innerHTML = html
  const root = template.content.firstElementChild
  if (!root) return null
  sanitize(root)
  root.setAttribute(VARIANT_ATTR, exploreId)
  // Scoping needs a live sheet, which a template's inert content does not have,
  // so the node is in the document by the time this runs. See `applyOne`.
  return root
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
    const variant = buildVariant(swap.html!, swap.exploreId, this.doc)
    if (!variant) return
    target.setAttribute(SWAPPED_ATTR, swap.exploreId)
    target.insertAdjacentElement('afterend', variant)
    // After insertion: a `<style>` only has a `sheet` once it is in the document.
    scopeStyles(variant, swap.exploreId)
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

/** How much markup travels. Matched to the daemon's own cap, so what the page
 *  sends is what the agent sees rather than something silently trimmed later. */
const MAX_CAPTURE_HTML = 16 * 1024

export interface Capture {
  html: string
  truncated?: true
  styles?: Record<string, string>
  parentWidth?: number
}

/** What the element looks like right now, for the agent to write variants of.
 *  Taken at the moment the user asks, because by the time a variant comes back
 *  the agent's own markup may be standing in this element's place. */
export function captureElement(element: Element): Capture {
  const html = element.outerHTML
  const capture: Capture = {
    html: html.slice(0, MAX_CAPTURE_HTML),
    ...(html.length > MAX_CAPTURE_HTML ? { truncated: true as const } : {}),
  }
  const computed = element.ownerDocument.defaultView?.getComputedStyle(element)
  if (computed) {
    const styles: Record<string, string> = {}
    for (const property of CAPTURE_STYLES) {
      const value = computed.getPropertyValue(property).trim()
      if (value) styles[property] = value
    }
    if (Object.keys(styles).length) capture.styles = styles
  }
  const parent = element.parentElement
  if (parent) {
    const width = parent.getBoundingClientRect().width
    if (width > 0) capture.parentWidth = Math.round(width)
  }
  return capture
}
