import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  clearInspireToken,
  credentialsFile,
  readCredentials,
  readInspireToken,
  writeInspireToken,
} from '../src/credentials.js'

const file = () => credentialsFile(mkdtempSync(join(tmpdir(), 'eztweak-creds-')))

test('the file sits in the data dir and is written owner-only', () => {
  const path = file()
  assert.ok(path.endsWith(join('credentials.json')))
  writeInspireToken('tok_live', path)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readCredentials(path), { inspire: { token: 'tok_live' } })
  assert.equal(readInspireToken(path), 'tok_live')
})

test('a token replaces the one before it and leaves the rest of the file alone', () => {
  const path = file()
  writeFileSync(path, JSON.stringify({ other: { token: 'keep' }, inspire: { token: 'old' } }))
  writeInspireToken('new', path)
  const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  assert.deepEqual(written, { other: { token: 'keep' }, inspire: { token: 'new' } })
})

test('a missing, unreadable or empty file all read as no token', () => {
  const path = file()
  assert.equal(readInspireToken(path), null)
  writeFileSync(path, 'not json at all')
  assert.equal(readInspireToken(path), null)
  writeFileSync(path, JSON.stringify({ inspire: { token: '   ' } }))
  assert.equal(readInspireToken(path), null)
})

test('a logout forgets the token, and takes the file with it when nothing else is in it', () => {
  const path = file()
  assert.equal(clearInspireToken(path), false)
  writeInspireToken('tok_live', path)
  assert.equal(clearInspireToken(path), true)
  assert.equal(existsSync(path), false)

  writeFileSync(path, JSON.stringify({ other: { token: 'keep' }, inspire: { token: 'go' } }))
  assert.equal(clearInspireToken(path), true)
  assert.deepEqual(readCredentials(path), { other: { token: 'keep' } })
  assert.equal(statSync(path).mode & 0o777, 0o600)
})
