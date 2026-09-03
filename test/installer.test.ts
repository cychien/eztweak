import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.EZTWEAK_DATA_DIR = mkdtempSync(join(tmpdir(), 'eztweak-installer-'))

const { npmErrorSummary, pruneInstalledVersions, shellQuote } = await import('../src/installer.js')
const { VERSIONS_DIR } = await import('../src/constants.js')

test('npmErrorSummary keeps what npm said and drops the noise around it', () => {
  const stderr = [
    'npm error code ETARGET',
    'npm error notarget No matching version found for eztweak@9.9.9.',
    'npm error notarget In most cases you or one of your dependencies are requesting',
    "npm error notarget a package version that doesn't exist.",
    'npm error A complete log of this run can be found in: /Users/x/.npm/_logs/1.log',
  ].join('\n')
  assert.equal(
    npmErrorSummary(stderr),
    'code ETARGET notarget No matching version found for eztweak@9.9.9.',
  )
  assert.equal(npmErrorSummary('something odd\nlast line'), 'last line')
  assert.equal(npmErrorSummary(''), '')
})

// Proven through a real shell rather than against an expected string: the point
// is that the argument arrives whole, not that it is escaped a particular way.
test('shellQuote survives a round trip through the shell it is quoting for', {
  skip: process.platform === 'win32' ? 'POSIX quoting' : false,
}, () => {
  for (const arg of [
    '/Users/John Smith/.eztweak/versions/0.7.0',
    "/tmp/it's here/x",
    '/tmp/a$HOME/b',
    '/tmp/a&b;c/d',
    '/tmp/back\\slash',
    'eztweak@0.7.0',
    '--no-audit',
  ]) {
    const out = spawnSync('sh', ['-c', `printf %s ${shellQuote(arg)}`], { encoding: 'utf8' })
    assert.equal(out.status, 0, arg)
    assert.equal(out.stdout, arg, arg)
  }
})

function installedVersion(version: string): string {
  const dir = join(VERSIONS_DIR, version, 'node_modules', 'eztweak', 'dist')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cli.mjs'), '')
  return join(dir, 'cli.mjs')
}

test('pruning keeps the version it runs from and drops the rest', () => {
  const running = installedVersion('0.7.0')
  installedVersion('0.6.1')
  installedVersion('0.5.0')
  pruneInstalledVersions(running)
  assert.deepEqual(readdirSync(VERSIONS_DIR), ['0.7.0'])
})

// The running path arrives already symlink-resolved (Node resolves the main
// entry), while the versions root is built from an env var and does not.
// Comparing the two as text made the daemon delete the tree it serves from -
// a data dir under macOS `/tmp` (a link to `/private/tmp`) is enough.
test('pruning compares real paths, so a symlinked data dir is not self-destructive', () => {
  const real = mkdtempSync(join(tmpdir(), 'eztweak-real-'))
  const link = join(mkdtempSync(join(tmpdir(), 'eztweak-link-')), 'data')
  symlinkSync(real, link)

  const viaLink = join(link, 'versions')
  const dir = join(viaLink, '0.7.0', 'node_modules', 'eztweak', 'dist')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cli.mjs'), '')
  mkdirSync(join(viaLink, '0.6.1'), { recursive: true })

  // What the daemon passes in: its own entry, symlinks already resolved.
  const running = join(real, 'versions', '0.7.0', 'node_modules', 'eztweak', 'dist', 'cli.mjs')
  pruneInstalledVersions(running, viaLink)
  assert.deepEqual(readdirSync(viaLink).sort(), ['0.7.0'])
})
