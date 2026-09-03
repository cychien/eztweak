import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Updater, type UpdaterDeps } from '../src/updater.js'

/** A fake package root at `version`, with the cli entry a handover names. */
function fakePackage(base: string, version: string): string {
  const root = join(base, 'pkg', version)
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'cli.mjs'), '')
  return root
}

interface World {
  updater: Updater
  base: string
  log: string[]
  changes: number
  latest: string | null
  install: UpdaterDeps['install']
  handover: UpdaterDeps['handover']
  retired: Promise<void>
}

function world(current: string, overrides: Partial<UpdaterDeps> = {}): World {
  const base = mkdtempSync(join(tmpdir(), 'eztweak-updater-'))
  const w = { base, log: [] as string[], changes: 0, latest: null as string | null } as World
  let retire!: () => void
  w.retired = new Promise<void>((r) => {
    retire = r
  })
  w.install = async (version) => {
    w.log.push(`install ${version}`)
    return fakePackage(base, version)
  }
  w.handover = async (cliEntry) => {
    w.log.push(`handover ${cliEntry.replace(base, '')}`)
  }
  const deps: UpdaterDeps = {
    current,
    latestVersion: async () => w.latest,
    install: (v) => w.install(v),
    handover: (e) => w.handover(e),
    retire: async () => {
      w.log.push('retire')
      retire()
    },
    onChange: () => {
      w.changes++
    },
    ...overrides,
  }
  w.updater = new Updater(deps)
  return w
}

const settle = () => new Promise((r) => setTimeout(r, 20))

test('nothing to offer while the registry is not ahead of this daemon', async () => {
  const w = world('0.6.1')
  w.latest = '0.6.1'
  await w.updater.check()
  assert.equal(w.updater.snapshot(), undefined)
  assert.equal(w.updater.run(), 'nothing')

  w.latest = '0.6.0'
  await w.updater.check()
  assert.equal(w.updater.snapshot(), undefined, 'an older registry is not an update')
  assert.equal(w.changes, 0, 'no change, no broadcast')
})

test('a newer version is offered once, and the offer is broadcast', async () => {
  const w = world('0.6.1')
  w.latest = '0.7.0'
  await w.updater.check()
  assert.deepEqual(w.updater.snapshot(), { latest: '0.7.0', phase: 'available' })
  assert.equal(w.changes, 1)

  await w.updater.check()
  assert.equal(w.changes, 1, 'the same answer is not re-broadcast')
})

test('an update installs, hands over and retires, in that order', async () => {
  const w = world('0.6.1')
  w.latest = '0.7.0'
  await w.updater.check()

  const phases: string[] = []
  const record = () => phases.push(w.updater.snapshot()?.phase ?? 'none')
  w.install = async (version) => {
    record()
    w.log.push(`install ${version}`)
    return fakePackage(w.base, version)
  }
  w.handover = async (cliEntry) => {
    record()
    w.log.push(`handover ${cliEntry.replace(w.base, '')}`)
  }

  assert.equal(w.updater.run(), 'started')
  assert.equal(w.updater.run(), 'busy')
  await w.retired
  assert.deepEqual(phases, ['installing', 'handing-over'])
  assert.deepEqual(w.log, ['install 0.7.0', 'handover /pkg/0.7.0/dist/cli.mjs', 'retire'])
})

test('a failed install is reported and can be retried; the daemon is untouched', async () => {
  const w = world('0.6.1')
  w.latest = '0.7.0'
  await w.updater.check()
  w.install = async () => {
    throw new Error('npm install eztweak@0.7.0 failed: code ETARGET')
  }
  assert.equal(w.updater.run(), 'started')
  await settle()
  assert.deepEqual(w.updater.snapshot(), {
    latest: '0.7.0',
    phase: 'failed',
    error: 'npm install eztweak@0.7.0 failed: code ETARGET',
  })
  assert.deepEqual(w.log, [], 'nothing was handed over')

  w.install = async (version) => {
    w.log.push(`install ${version}`)
    return fakePackage(w.base, version)
  }
  assert.equal(w.updater.run(), 'started')
  await w.retired
  assert.equal(w.log.at(-1), 'retire')
})

test('a successor that never comes up leaves this daemon serving, with the error shown', async () => {
  const w = world('0.6.1')
  w.latest = '0.7.0'
  await w.updater.check()
  w.handover = async () => {
    throw new Error('new daemon did not come up within 20s')
  }
  assert.equal(w.updater.run(), 'started')
  await settle()
  const snap = w.updater.snapshot()
  assert.equal(snap?.phase, 'failed')
  assert.match(snap?.error ?? '', /did not come up/)
  assert.deepEqual(w.log, ['install 0.7.0'], 'retire never ran')
})
