/** Renders @hugeicons/core-free-icons data as plain SVG — the shell and overlay
 *  ship no framework, so the React <HugeiconsIcon> wrapper isn't available. */

export type IconNode = readonly (readonly [string, Record<string, string | number>])[]

const SVG_NS = 'http://www.w3.org/2000/svg'

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

export function icon(node: IconNode, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('data-ez-ui', '')
  for (const [tag, attrs] of node) {
    const child = document.createElementNS(SVG_NS, tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'key') continue
      child.setAttribute(kebab(key), String(value))
    }
    svg.appendChild(child)
  }
  return svg
}
