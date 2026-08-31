import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reduceNav } from '../src/client/nav.js'
import type { NavEvent, NavState } from '../src/client/nav.js'

const at = (url: string): NavState => ({ url })

function run(state: NavState, ...events: NavEvent[]): NavState {
  return events.reduce((s, e) => reduceNav(s, e).state, state)
}

test('a link the overlay caught is the shell’s to push, and every frame follows', () => {
  const { state, effects } = reduceNav(at('/'), { t: 'request', url: '/changelog' })
  assert.equal(state.url, '/changelog')
  assert.deepEqual(effects, [
    { do: 'push', url: '/changelog' },
    { do: 'navigate', url: '/changelog' },
  ])
})

// Otherwise back would land on the page it was already showing, and the press
// before it would be the one that finally moved.
test('a link to the page already open reloads without leaving an entry behind', () => {
  const { state, effects } = reduceNav(at('/pricing'), { t: 'request', url: '/pricing' })
  assert.equal(state.url, '/pricing')
  assert.deepEqual(effects, [{ do: 'navigate', url: '/pricing' }])
})

// The app already transitioned, so sending that frame anywhere would throw the
// transition away and reload it onto the page it is standing on.
test('a client-side route change pushes, and brings only the other frames along', () => {
  const { state, effects } = reduceNav(at('/'), { t: 'moved', url: '/faq', from: 'mobile' })
  assert.equal(state.url, '/faq')
  assert.deepEqual(effects, [
    { do: 'push', url: '/faq' },
    { do: 'navigate', url: '/faq', except: 'mobile' },
  ])
})

// A form submit, or the app assigning `location`: the entry for it was written
// inside the preview before the shell heard anything, so a push here would make
// one navigation cost two presses of back.
test('a navigation the overlay could not catch is recorded, not pushed', () => {
  const { effects } = reduceNav(at('/'), { t: 'loaded', url: '/search?q=1', from: 'desktop' })
  assert.deepEqual(effects, [
    { do: 'replace', url: '/search?q=1' },
    { do: 'navigate', url: '/search?q=1', except: 'desktop' },
  ])
})

test('a frame landing where it was sent says nothing', () => {
  const sent = run(at('/'), { t: 'request', url: '/changelog' })
  for (const id of ['mobile', 'tablet', 'desktop']) {
    assert.deepEqual(reduceNav(sent, { t: 'loaded', url: '/changelog', from: id }).effects, [])
  }
})

// The whole point of the shell owning the history: the frames that were on
// these pages have been thrown away and remounted since, and the entry is the
// only record of where back goes.
test('back moves every frame, however many times the stage has been rebuilt', () => {
  const state = run(at('/'), { t: 'request', url: '/changelog' })
  const { state: back, effects } = reduceNav(state, { t: 'pop', url: '/' })
  assert.equal(back.url, '/')
  assert.deepEqual(effects, [{ do: 'navigate', url: '/' }])
})

// The browser has already moved; pushing or replacing here would write over the
// entry that is being travelled to.
test('a traversal writes no history of its own', () => {
  const { effects } = reduceNav(at('/a'), { t: 'pop', url: '/b' })
  assert.equal(effects.some((e) => e.do === 'push' || e.do === 'replace'), false)
})

test('a traversal onto the page already showing moves nothing', () => {
  assert.deepEqual(reduceNav(at('/a'), { t: 'pop', url: '/a' }).effects, [])
})

// Query and hash travel with the page: three previews of the same route filtered
// three different ways are not the comparison the canvas is for.
test('the page a frame is pointed at keeps its query and hash', () => {
  const { state, effects } = reduceNav(at('/'), { t: 'request', url: '/docs?tab=api#usage' })
  assert.equal(state.url, '/docs?tab=api#usage')
  assert.deepEqual(effects.at(-1), { do: 'navigate', url: '/docs?tab=api#usage' })
})
