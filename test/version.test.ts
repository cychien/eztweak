import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NextFunction, Request, Response } from 'express'
import { VERSION_HEADER, versionGate } from '../src/version.js'

function run(header: string | undefined) {
  const gate = versionGate('0.2.0')
  const outcome = { status: 0, body: undefined as { error?: string; hint?: string } | undefined, passed: false }
  const req = {
    get: (name: string) => (name.toLowerCase() === VERSION_HEADER ? header : undefined),
  } as Request
  const res = {
    status(code: number) {
      outcome.status = code
      return this
    },
    json(body: { error?: string; hint?: string }) {
      outcome.body = body
      return this
    },
  } as unknown as Response
  gate(req, res, (() => {
    outcome.passed = true
  }) as NextFunction)
  return outcome
}

test('passes a CLI on the same version through', () => {
  const { passed, status } = run('0.2.0')
  assert.equal(passed, true)
  assert.equal(status, 0)
})

test('refuses a mismatched CLI with an upgrade hint', () => {
  const { passed, status, body } = run('0.1.0')
  assert.equal(passed, false)
  assert.equal(status, 409)
  assert.match(body!.error!, /v0\.1\.0/)
  assert.match(body!.error!, /v0\.2\.0/)
  assert.match(body!.hint!, /@latest/)
})

test('refuses a CLI too old to send the version header', () => {
  const { passed, status, body } = run(undefined)
  assert.equal(passed, false)
  assert.equal(status, 409)
  assert.match(body!.error!, /predates/)
  assert.match(body!.hint!, /@latest/)
})
