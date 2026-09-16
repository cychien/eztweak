import { existsSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'

/** The project a path belongs to: the nearest directory at or above it holding
 *  a `.git` or a `package.json`, or the path itself when nothing above it does.
 *
 *  One rule, because two sides have to agree on it. The CLI scopes a session by
 *  the project it was run from, and the agent works from that directory; the
 *  build plugin stamps `file:line` on elements for that same agent to open. A
 *  Vite root nested inside the project - a fixture, an example site, one app of
 *  a monorepo run from the top - used to stamp paths relative to itself, which
 *  the agent then could not find from where it stood. */
export function projectRoot(from: string): string {
  let dir = resolve(from)
  const { root } = parse(dir)
  for (;;) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) return dir
    if (dir === root) return resolve(from)
    dir = dirname(dir)
  }
}
