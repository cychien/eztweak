/** What a variant has to be before the page is asked to show it.
 *
 *  The daemon has no DOM, so this is deliberately the half of the checking that
 *  does not need one: size, emptiness, one root element, and the handful of
 *  things that must never reach the page whatever the agent meant by them. The
 *  overlay sanitises against a real parser on the other side - this is the half
 *  the *agent* can act on, because a rejection here comes back as the tool's
 *  answer while it is still working and can fix it. */

/** Room for a component and a small `<style>`, not for a page. A variant is one
 *  element's worth of markup; anything this size is a misunderstanding of the
 *  task, and saying so is more useful than rendering it. */
export const MAX_VARIANT_HTML = 32 * 1024

export const MAX_VARIANT_NAME = 40

/** Things that are never a style exploration. Matched on the tag name so an
 *  attribute or a word in the text cannot trip them, and checked here as well
 *  as in the overlay because the agent is owed the reason, not just the
 *  silence. */
const FORBIDDEN_TAGS = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base']

export type VariantProblem =
  | { code: 'empty' }
  | { code: 'too-long'; length: number }
  | { code: 'name-too-long'; length: number }
  | { code: 'forbidden-tag'; tag: string }
  | { code: 'event-handler'; attribute: string }
  | { code: 'javascript-url' }
  | { code: 'not-one-root'; roots: number }

/** The reason, in the words the agent is handed. Written as an instruction
 *  rather than a complaint: what comes back is the agent's next attempt, so the
 *  message's job is to make that attempt right. */
export function variantProblemMessage(problem: VariantProblem): string {
  switch (problem.code) {
    case 'empty':
      return 'html is empty. Send the markup for one element.'
    case 'too-long':
      return `html is ${problem.length} bytes; the limit is ${MAX_VARIANT_HTML}. Send one element's markup, not a page.`
    case 'name-too-long':
      return `name is ${problem.length} characters; the limit is ${MAX_VARIANT_NAME}. A short label, not a description.`
    case 'forbidden-tag':
      return `html contains <${problem.tag}>, which a variant may not use. A variant is markup and CSS only - no scripts, no embeds, no external resources.`
    case 'event-handler':
      return `html sets the inline handler ${problem.attribute}. A variant is markup and CSS only - no scripts.`
    case 'javascript-url':
      return 'html contains a javascript: url. A variant is markup and CSS only - no scripts.'
    case 'not-one-root':
      return problem.roots === 0
        ? 'html has no element at its top level. A variant is one root element, optionally with a <style> block inside it.'
        : `html has ${problem.roots} top-level elements. A variant is one root element - wrap them in a single container.`
  }
}

/** Null when the variant may be shown. Deliberately returns the first problem
 *  rather than all of them: the agent fixes one thing and sends again, and a
 *  list invites it to think the last item is optional. */
export function checkVariant(name: string, html: string): VariantProblem | null {
  if (name.length > MAX_VARIANT_NAME) return { code: 'name-too-long', length: name.length }
  if (!html.trim()) return { code: 'empty' }
  if (html.length > MAX_VARIANT_HTML) return { code: 'too-long', length: html.length }

  const tags = scanTags(html)
  if (!tags) return { code: 'not-one-root', roots: 0 }

  for (const tag of tags.names) {
    if (FORBIDDEN_TAGS.includes(tag)) return { code: 'forbidden-tag', tag }
  }
  const handler = /\son([a-z]+)\s*=/i.exec(html)
  if (handler) return { code: 'event-handler', attribute: `on${handler[1]!.toLowerCase()}` }
  if (/javascript:/i.test(html)) return { code: 'javascript-url' }
  if (tags.roots !== 1) return { code: 'not-one-root', roots: tags.roots }
  return null
}

/** Elements that never have a closing tag, so a depth counter must not wait for
 *  one. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** Every tag name in `html`, and how many elements sit at its top level.
 *
 *  A tag scanner, not a parser: it reads tags and tracks nesting depth, and it
 *  is honest about what that buys. A `<` inside a text node or an attribute
 *  value can fool it. That is acceptable for what it decides - whether to hand
 *  the agent back a "one root element" instruction - because the agent can look
 *  at its own markup and try again, and because the overlay parses for real
 *  before anything reaches the page. Comments, doctypes and CDATA are skipped;
 *  raw-text elements (`<style>`, `<textarea>`, `<title>`) are read to their
 *  close so markup-looking text inside them counts for nothing.
 *
 *  Null when the markup is so unbalanced there is nothing to say about roots -
 *  a close tag with nothing open. */
function scanTags(html: string): { names: string[]; roots: number } | null {
  const names: string[] = []
  let depth = 0
  let roots = 0
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end === -1 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt)
      i = end === -1 ? html.length : end + 1
      continue
    }
    const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 64))
    if (!tag) {
      i = lt + 1
      continue
    }
    const end = closingBracket(html, lt)
    if (end === -1) break
    const closing = tag[1] === '/'
    const name = tag[2]!.toLowerCase()
    names.push(name)
    const selfClosing = html[end - 1] === '/'
    if (closing) {
      if (depth === 0) return null
      depth -= 1
    } else if (!selfClosing && !VOID_TAGS.has(name)) {
      if (depth === 0) roots += 1
      depth += 1
    } else if (depth === 0) {
      roots += 1
    }
    i = end + 1
    if (!closing && RAW_TEXT.has(name) && !selfClosing) {
      const close = html.toLowerCase().indexOf(`</${name}`, i)
      if (close === -1) break
      i = close
    }
  }
  return { names, roots }
}

/** Elements whose content is text, not markup. */
const RAW_TEXT = new Set(['style', 'script', 'textarea', 'title'])

/** The `>` that ends the tag starting at `from`, looking past any in a quoted
 *  attribute value. -1 when the tag never closes. */
function closingBracket(html: string, from: number): number {
  let quote: string | null = null
  for (let i = from + 1; i < html.length; i += 1) {
    const ch = html[i]!
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') return i
  }
  return -1
}
