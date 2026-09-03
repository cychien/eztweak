import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  compareVersions,
  fetchLatestVersion,
  isNewer,
  latestVersion,
  updateChecksDisabled,
} from '../src/update-check.js'

test('compareVersions orders releases and prereleases', () => {
  assert.equal(compareVersions('0.6.1', '0.6.1'), 0)
  assert.equal(compareVersions('0.6.1', '0.7.0'), -1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1)
  assert.equal(compareVersions('0.7.0-beta.1', '0.7.0'), -1)
  assert.equal(compareVersions('0.7.0-beta.2', '0.7.0-beta.1'), 1)
  assert.equal(compareVersions('v0.7.0', '0.7.0'), 0)
  assert.equal(compareVersions('0.7.0+build.5', '0.7.0'), 0)
})

test('an unparseable version never counts as newer', () => {
  assert.equal(isNewer('garbage', '0.6.1'), false)
  assert.equal(isNewer('0.6.1', 'garbage'), true)
  assert.equal(isNewer('0.7.0', '0.6.1'), true)
  assert.equal(isNewer('0.6.1', '0.6.1'), false)
  // A dev build ahead of the registry is not offered the registry's version.
  assert.equal(isNewer('0.6.1', '0.7.0-dev'), false)
})

test('the opt-out env var is read the way people set it', () => {
  assert.equal(updateChecksDisabled({}), false)
  assert.equal(updateChecksDisabled({ EZTWEAK_NO_UPDATE_CHECK: '' }), false)
  assert.equal(updateChecksDisabled({ EZTWEAK_NO_UPDATE_CHECK: '0' }), false)
  assert.equal(updateChecksDisabled({ EZTWEAK_NO_UPDATE_CHECK: 'false' }), false)
  assert.equal(updateChecksDisabled({ EZTWEAK_NO_UPDATE_CHECK: '1' }), true)
  assert.equal(updateChecksDisabled({ EZTWEAK_NO_UPDATE_CHECK: 'true' }), true)
})

const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

test('fetchLatestVersion reads the dist-tag manifest and swallows every failure', async () => {
  assert.equal(await fetchLatestVersion(fakeFetch(200, { version: '0.7.0' })), '0.7.0')
  assert.equal(await fetchLatestVersion(fakeFetch(200, { version: 'nope' })), null)
  assert.equal(await fetchLatestVersion(fakeFetch(200, {})), null)
  assert.equal(await fetchLatestVersion(fakeFetch(404, { error: 'not found' })), null)
  const offline = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  assert.equal(await fetchLatestVersion(offline), null)
})

test('latestVersion asks the registry once per TTL and keeps the last answer offline', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'eztweak-update-')), 'update-check.json')
  let clock = 1_000_000
  const now = () => clock
  const answers: (string | null)[] = []
  let calls = 0
  const fetchLatest = async () => {
    calls++
    return answers.shift() ?? null
  }
  const opts = { fetchLatest, now, file, ttlMs: 1000 }

  answers.push('0.7.0')
  assert.equal(await latestVersion(opts), '0.7.0')
  assert.equal(calls, 1)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).latest, '0.7.0')

  clock += 500
  assert.equal(await latestVersion(opts), '0.7.0')
  assert.equal(calls, 1, 'inside the TTL the cache answers')

  clock += 600
  answers.push(null)
  assert.equal(await latestVersion(opts), '0.7.0', 'a failed refresh falls back to the cache')
  assert.equal(calls, 2)

  answers.push('0.8.0')
  assert.equal(await latestVersion(opts), '0.8.0')
  assert.equal(calls, 3, 'a failed refresh does not extend the TTL')
})
