import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })

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

await Promise.all([
  build({ ...node, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.mjs', banner: { js: '#!/usr/bin/env node' } }),
  build({ ...node, entryPoints: ['src/vite.ts'], outfile: 'dist/vite.mjs' }),
  build({ ...browser, entryPoints: ['src/client/overlay.ts'], outfile: 'dist/overlay.js' }),
  build({ ...browser, entryPoints: ['src/client/shell.ts'], outfile: 'dist/shell.js' }),
  build({ ...browser, entryPoints: ['src/client/overlay.css'], outfile: 'dist/overlay.css' }),
  build({ ...browser, entryPoints: ['src/client/shell.css'], outfile: 'dist/shell.css' }),
])

execSync('npx tsc -p tsconfig.dts.json', { stdio: 'inherit' })
execSync('chmod +x dist/cli.mjs')
console.log('build ok')
