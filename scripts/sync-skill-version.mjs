/** Stamps package.json's version into the bundled skill's frontmatter. Runs from
 *  the `version` lifecycle script, so `npm version` keeps the two in step; the
 *  daemon judges an installed skill stale by comparing this against itself. */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const skillFile = join(root, 'skills', 'eztweak', 'SKILL.md')
const skill = readFileSync(skillFile, 'utf8')
const line = /^(\s+version:\s*).*$/m
if (!line.test(skill)) throw new Error(`no metadata.version line to stamp in ${skillFile}`)
writeFileSync(skillFile, skill.replace(line, `$1${version}`))
console.log(`skill version -> ${version}`)
