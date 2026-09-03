import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The bundled skill's `metadata.version` is stamped by `scripts/sync-skill-version.mjs`
 *  from the `version` lifecycle script. Nothing reads it at runtime - the daemon
 *  deliberately does not sync skills - but it is how anyone holding a copy can
 *  tell which release it came from, so a release must not ship it stale. */
test('the bundled skill is stamped with the package version', () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string
  }
  const skill = readFileSync(join(ROOT, 'skills', 'eztweak', 'SKILL.md'), 'utf8')
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill)
  assert.ok(front, 'SKILL.md has frontmatter')
  assert.match(front[1]!, /^name: eztweak$/m)
  const stamped = /^\s+version:\s*([0-9A-Za-z.+-]+)\s*$/m.exec(front[1]!)?.[1]
  assert.equal(stamped, version, 'run scripts/sync-skill-version.mjs')
})
