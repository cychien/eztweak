/** The markdown an agent's reply actually uses, and nothing more: paragraphs,
 *  headings, lists, fenced code, and the inline trio (bold, italic, code) plus
 *  links. Parsed to a tree and rendered by building DOM nodes - never markup
 *  strings - so agent output cannot smuggle HTML into the shell.
 *
 *  The parser is pure and total: any string parses, including one cut off
 *  mid-token, because the streaming reply is re-rendered on every chunk. */

export type MdInline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong'; children: MdInline[] }
  | { t: 'em'; children: MdInline[] }
  | { t: 'link'; text: string; href: string }
  | { t: 'break' }

export type MdBlock =
  | { t: 'p'; children: MdInline[] }
  | { t: 'heading'; level: number; children: MdInline[] }
  | { t: 'list'; ordered: boolean; items: MdInline[][] }
  | { t: 'fence'; text: string }

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/
const HEADING = /^(#{1,4})\s+(.*)$/
const FENCE = /^\s{0,3}```/

/** Inline tokens, longest-wins at each position. Emphasis marks must sit flush
 *  against their content, or a bare `*` in prose would swallow the paragraph.
 *  A source string, not a shared regex: `parseInline` recurses into emphasis
 *  content, and a module-level `g` regex would have its `lastIndex` trampled
 *  by the recursion - re-scanning old ground forever. */
const INLINE =
  /(`+)([^`]+?)\1|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|_([^_\s][^_\n]*?)_|\[([^\]\n]+)\]\(([^)\s]+)\)/

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = []
  const pushText = (chunk: string): void => {
    // Single newlines inside a paragraph are line breaks: agent replies lean on
    // them ("#1 ...\n#2 ..."), and folding them loses the list they imply.
    const lines = chunk.split('\n')
    lines.forEach((line, i) => {
      if (line) out.push({ t: 'text', text: line })
      if (i < lines.length - 1) out.push({ t: 'break' })
    })
  }
  let at = 0
  const inline = new RegExp(INLINE.source, 'g')
  for (;;) {
    const m = inline.exec(text)
    if (!m) break
    if (m.index > at) pushText(text.slice(at, m.index))
    at = m.index + m[0].length
    if (m[2] !== undefined) out.push({ t: 'code', text: m[2].trim() })
    else if (m[3] !== undefined || m[4] !== undefined) {
      out.push({ t: 'strong', children: parseInline(m[3] ?? m[4]!) })
    } else if (m[5] !== undefined || m[6] !== undefined) {
      out.push({ t: 'em', children: parseInline(m[5] ?? m[6]!) })
    } else if (m[7] !== undefined && m[8] !== undefined) {
      // Only links a browser can follow somewhere harmless. Anything else -
      // javascript:, data:, a relative path into the shell - stays as text.
      if (/^https?:\/\//.test(m[8])) out.push({ t: 'link', text: m[7], href: m[8] })
      else pushText(m[0])
    }
  }
  if (at < text.length) pushText(text.slice(at))
  return out
}

export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = []
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    if (FENCE.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!)
      i++ // closing fence, or one past the end when the stream is mid-block
      blocks.push({ t: 'fence', text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ t: 'heading', level: heading[1]!.length, children: parseInline(heading[2]!) })
      i++
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      const items: MdInline[][] = []
      while (i < lines.length) {
        const m = ordered ? NUMBERED.exec(lines[i]!) : BULLET.exec(lines[i]!)
        if (!m) break
        // A wrapped item continues on indented lines until the next marker.
        const parts = [m[1]!]
        i++
        while (
          i < lines.length &&
          lines[i]!.trim() &&
          !BULLET.test(lines[i]!) &&
          !NUMBERED.test(lines[i]!) &&
          /^\s{2,}/.test(lines[i]!)
        ) {
          parts.push(lines[i]!.trim())
          i++
        }
        items.push(parseInline(parts.join(' ')))
      }
      blocks.push({ t: 'list', ordered, items })
      continue
    }
    // Paragraph: up to the next blank line or block opener.
    const parts: string[] = []
    while (i < lines.length) {
      const l = lines[i]!
      if (!l.trim() || FENCE.test(l) || HEADING.test(l) || BULLET.test(l) || NUMBERED.test(l)) {
        break
      }
      parts.push(l)
      i++
    }
    blocks.push({ t: 'p', children: parseInline(parts.join('\n')) })
  }
  return blocks
}

function renderInline(into: HTMLElement, nodes: MdInline[]): void {
  for (const node of nodes) {
    switch (node.t) {
      case 'text':
        into.append(node.text)
        break
      case 'break':
        into.append(document.createElement('br'))
        break
      case 'code': {
        const el = document.createElement('code')
        el.className = 'ez-md-code'
        el.textContent = node.text
        into.append(el)
        break
      }
      case 'strong':
      case 'em': {
        const el = document.createElement(node.t === 'strong' ? 'strong' : 'em')
        renderInline(el, node.children)
        into.append(el)
        break
      }
      case 'link': {
        const el = document.createElement('a')
        el.href = node.href
        el.textContent = node.text
        el.target = '_blank'
        el.rel = 'noreferrer noopener'
        into.append(el)
        break
      }
    }
  }
}

/** Markdown to DOM. `className` goes on the wrapper so callers can scope it. */
export function markdownEl(text: string, className: string): HTMLElement {
  const box = document.createElement('div')
  box.className = className
  for (const block of parseMarkdown(text)) {
    switch (block.t) {
      case 'p': {
        const el = document.createElement('p')
        renderInline(el, block.children)
        box.append(el)
        break
      }
      case 'heading': {
        // h5/h6 regardless of source level: this renders inside a 340px
        // sidebar thread, where a real h2 would shout over the page.
        const el = document.createElement(block.level <= 2 ? 'h5' : 'h6')
        renderInline(el, block.children)
        box.append(el)
        break
      }
      case 'list': {
        const el = document.createElement(block.ordered ? 'ol' : 'ul')
        for (const item of block.items) {
          const li = document.createElement('li')
          renderInline(li, item)
          el.append(li)
        }
        box.append(el)
        break
      }
      case 'fence': {
        const pre = document.createElement('pre')
        pre.className = 'ez-md-pre'
        pre.textContent = block.text
        box.append(pre)
        break
      }
    }
  }
  return box
}
