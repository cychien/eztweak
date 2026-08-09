import assert from 'node:assert/strict'
import { test } from 'node:test'
import { URL_PREFIX } from '../src/constants.js'
import { injectOverlay, wantsHtml } from '../src/inject.js'

test('injects overlay assets right after <head>', () => {
  const out = injectOverlay('<html><head><title>x</title></head><body></body></html>')
  assert.match(out, new RegExp(`<head><link rel="stylesheet" href="${URL_PREFIX}/overlay.css">`))
  assert.ok(out.includes(`${URL_PREFIX}/overlay.js`))
})

test('handles head with attributes', () => {
  const out = injectOverlay('<head lang="en"><meta charset="utf-8"></head>')
  assert.ok(out.indexOf('overlay.css') > out.indexOf('lang="en"'))
  assert.ok(out.indexOf('overlay.css') < out.indexOf('<meta'))
})

test('falls back to <body> when there is no head', () => {
  const out = injectOverlay('<body class="a"><p>hi</p></body>')
  assert.ok(out.indexOf('overlay.js') < out.indexOf('<p>hi</p>'))
})

test('prepends when neither head nor body exists', () => {
  const out = injectOverlay('<div>fragment</div>')
  assert.ok(out.startsWith('<link'))
})

test('is idempotent', () => {
  const once = injectOverlay('<head></head>')
  assert.equal(injectOverlay(once), once)
})

test('wantsHtml matches navigation requests only', () => {
  assert.equal(wantsHtml('text/html,application/xhtml+xml'), true)
  assert.equal(wantsHtml('*/*'), false)
  assert.equal(wantsHtml(undefined), false)
})
