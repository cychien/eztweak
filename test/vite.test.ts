import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { eztweakSource } from '../src/vite.js'

type TransformFn = (code: string, id: string) => { code: string } | null

function transform(code: string, file = 'src/page.tsx'): string | null {
  const plugin = eztweakSource()
  const fn = plugin.transform as unknown as TransformFn
  const result = fn(code, join(process.cwd(), file))
  return result ? result.code : null
}

test('stamps host elements with file:line', () => {
  const out = transform(`export function Page() {\n  return <div className="a">hi</div>\n}\n`)
  assert.ok(out)
  assert.match(out!, /<div data-ez-source="src\/page\.tsx:2" className="a">/)
})

test('skips component elements and fragments', () => {
  const out = transform(`export const X = () => <><Hero title="t" /><p>a</p></>\n`)
  assert.ok(out)
  assert.ok(!out!.includes('<Hero data-ez-source'))
  assert.match(out!, /<p data-ez-source="src\/page\.tsx:1">/)
})

test('does not double-stamp an element that already has the attribute', () => {
  const src = `export const X = () => <div data-ez-source="manual:1">a</div>\n`
  assert.equal(transform(src), null)
})

test('ignores non-JSX files and node_modules', () => {
  assert.equal(transform(`export const a = 1\n`, 'src/util.ts'), null)
  assert.equal(transform(`export const X = () => <div>a</div>`, 'node_modules/pkg/index.tsx'), null)
})

test('multiline attributes keep correct insert position', () => {
  const out = transform(
    `export function Page() {\n  return (\n    <section\n      id="hero"\n      className="x"\n    >\n      <span>y</span>\n    </section>\n  )\n}\n`,
  )
  assert.ok(out)
  assert.match(out!, /<section data-ez-source="src\/page\.tsx:3"\n {6}id="hero"/)
  assert.match(out!, /<span data-ez-source="src\/page\.tsx:7">/)
})

// The path is for the agent to open, and the agent stands at the project root -
// the nearest `.git` or `package.json` above where the CLI was run. A Vite root
// nested inside that project has to stamp paths the agent can resolve from there,
// not from Vite's own root.
test('a vite root nested inside the project stamps paths from the project root', () => {
  const project = mkdtempSync(join(tmpdir(), 'ez-vite-'))
  writeFileSync(join(project, 'package.json'), '{}')
  const site = join(project, 'fixtures', 'site')
  mkdirSync(site, { recursive: true })
  const plugin = eztweakSource()
  plugin.configResolved({ root: site })
  const out = plugin.transform(`export const P = () => <p>hi</p>\n`, join(site, 'src/App.tsx'))
  assert.match(out!.code, /data-ez-source="fixtures\/site\/src\/App\.tsx:1"/)
})

test('a vite root that is the project stamps paths from itself, as before', () => {
  const project = mkdtempSync(join(tmpdir(), 'ez-vite-'))
  writeFileSync(join(project, 'package.json'), '{}')
  const plugin = eztweakSource()
  plugin.configResolved({ root: project })
  const out = plugin.transform(`export const P = () => <p>hi</p>\n`, join(project, 'src/App.tsx'))
  assert.match(out!.code, /data-ez-source="src\/App\.tsx:1"/)
})
