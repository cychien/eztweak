import { relative } from 'node:path'
import { parse } from '@babel/parser'
import MagicString from 'magic-string'
import { SOURCE_ATTR } from './constants.js'

/**
 * Structural subset of Vite's Plugin type. Deliberately not imported from
 * 'vite' so the emitted d.ts never pins a Vite major — the object is
 * assignable to Plugin in every Vite version that has these hooks (5+).
 */
export interface ReviewkitSourcePlugin {
  name: string
  apply: 'serve'
  enforce: 'pre'
  configResolved(config: { root: string }): void
  transform(code: string, id: string): { code: string; map: string } | null
}

interface BabelNode {
  type: string
  start?: number | null
  end?: number | null
  loc?: { start: { line: number } } | null
  [key: string]: unknown
}

function walk(node: BabelNode, visit: (node: BabelNode) => void): void {
  visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) {
          walk(child as BabelNode, visit)
        }
      }
    } else if (value && typeof value === 'object' && 'type' in value) {
      walk(value as BabelNode, visit)
    }
  }
}

/**
 * Dev-only JSX transform: stamps `data-ez-source="relative/file.tsx:line"` on
 * host elements (lowercase tags) so overlay annotations resolve to exact
 * source locations. `apply: 'serve'` — never part of a production build.
 */
export function eztweakSource(): ReviewkitSourcePlugin {
  let root = process.cwd()
  return {
    name: 'eztweak:source',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      root = config.root
    },
    transform(code, id) {
      const [file] = id.split('?')
      if (!file || !/\.[jt]sx$/.test(file) || file.includes('node_modules') || id.startsWith('\0')) {
        return null
      }
      let ast: ReturnType<typeof parse>
      try {
        ast = parse(code, {
          sourceType: 'module',
          plugins: ['jsx', 'typescript', 'decorators-legacy'],
        })
      } catch {
        return null
      }
      const rel = relative(root, file)
      const s = new MagicString(code)
      let changed = false
      walk(ast.program as unknown as BabelNode, (node) => {
        if (node.type !== 'JSXOpeningElement') return
        const name = node.name as BabelNode | undefined
        if (!name || name.type !== 'JSXIdentifier') return
        const tag = name['name']
        if (typeof tag !== 'string' || !/^[a-z]/.test(tag)) return
        const attrs = node['attributes'] as BabelNode[] | undefined
        const hasAttr = attrs?.some(
          (a) =>
            a.type === 'JSXAttribute' &&
            (a['name'] as BabelNode | undefined)?.['name'] === SOURCE_ATTR,
        )
        if (hasAttr || typeof name.end !== 'number' || !node.loc) return
        s.appendRight(name.end, ` ${SOURCE_ATTR}="${rel}:${node.loc.start.line}"`)
        changed = true
      })
      if (!changed) return null
      return { code: s.toString(), map: s.generateMap({ hires: true }).toString() }
    },
  }
}
