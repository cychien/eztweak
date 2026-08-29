import { build, context } from 'esbuild'
import { execSync } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const node = {
  platform: 'node',
  format: 'esm',
  target: 'node20',
  bundle: true,
  packages: 'external',
  sourcemap: false,
}

const browser = {
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  bundle: true,
  minify: false,
}

/** `group` is what a rebuild invalidates: a `node` bundle is loaded once at
 *  daemon startup, so it needs a restart; a `client` asset is re-read from
 *  disk on every request, so a browser reload is enough. */
export const targets = [
  {
    group: 'node',
    config: {
      ...node,
      entryPoints: ['src/cli.ts'],
      outfile: 'dist/cli.mjs',
      banner: { js: '#!/usr/bin/env node' },
    },
  },
  { group: 'node', config: { ...node, entryPoints: ['src/vite.ts'], outfile: 'dist/vite.mjs' } },
  {
    group: 'client',
    config: { ...browser, entryPoints: ['src/client/overlay.ts'], outfile: 'dist/overlay.js' },
  },
  {
    group: 'client',
    config: { ...browser, entryPoints: ['src/client/shell.ts'], outfile: 'dist/shell.js' },
  },
  {
    group: 'client',
    config: { ...browser, entryPoints: ['src/client/overlay.css'], outfile: 'dist/overlay.css' },
  },
  {
    group: 'client',
    config: { ...browser, entryPoints: ['src/client/shell.css'], outfile: 'dist/shell.css' },
  },
]


export async function buildAll() {
  mkdirSync('dist', { recursive: true })
  await Promise.all(targets.map((t) => build(t.config)))
  chmodSync('dist/cli.mjs', 0o755)
}

export function emitTypes() {
  execSync('npx tsc -p tsconfig.dts.json', { stdio: 'inherit' })
}

/** Rebuild every target on change. `onBuilt(group, outfile, result)` fires once
 *  per finished target, the initial build included. Resolves to a disposer. */
export async function watchAll(onBuilt) {
  mkdirSync('dist', { recursive: true })
  const contexts = await Promise.all(
    targets.map((t) =>
      context({
        ...t.config,
        plugins: [
          {
            name: 'ez:notify',
            setup: (b) => b.onEnd((result) => onBuilt(t.group, t.config.outfile, result)),
          },
        ],
      }),
    ),
  )
  await Promise.all(contexts.map((c) => c.watch()))
  return () => Promise.all(contexts.map((c) => c.dispose()))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildAll()
  emitTypes()
  console.log('build ok')
}
