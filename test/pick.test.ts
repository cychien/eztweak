import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ARM_TIMEOUT_MS, modLabel, reducePick } from '../src/client/pick.js'
import type { PickEffect, PickEvent, PickState } from '../src/client/pick.js'
import type { DraftNode, DraftWire, RefWire } from '../src/client/draft.js'

const ref = (source: string): RefWire => ({ anchor: { source }, label: source })
const placeholder: DraftNode = { t: 'ref', n: 0, anchor: null, label: '選取中…' }

const draft = (page: string, body: DraftNode[] = [{ t: 'text', v: '跟 ' }, placeholder]): DraftWire => ({
  id: 'p1',
  host: 'popup',
  createdAt: 0,
  subject: { kind: 'element', page, anchor: { source: 'src/a.tsx:1' } },
  body,
})

/** Drive a sequence and keep the last state, the way the shell does. */
function run(events: PickEvent[]): { state: PickState | null; effects: PickEffect[] } {
  let state: PickState | null = null
  let effects: PickEffect[] = []
  for (const e of events) {
    const out = reducePick(state, e)
    state = out.state
    effects = out.effects
  }
  return { state, effects }
}

const dos = (effects: PickEffect[]) => effects.map((x) => x.do)

test('the modifier is named for the platform', () => {
  assert.equal(modLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), '⌘')
  assert.equal(modLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Ctrl')
  assert.equal(modLabel('Mozilla/5.0 (X11; Linux x86_64)'), 'Ctrl')
})

test('the note box asks the overlay to start picking', () => {
  const { state, effects } = run([{ t: 'arm', id: 'p1', host: 'note', now: 0 }])
  assert.deepEqual(effects[0], { do: 'arm-overlay', id: 'p1', host: 'note' })
  assert.equal(state?.phase, 'picking')
  assert.equal(state?.armed, false)
})

// The popup's pick starts inside the overlay, so the shell first hears about it
// when the overlay says it is listening.
test('a pick that started in the overlay is adopted, not ignored', () => {
  const { state } = run([{ t: 'armed', id: 'p9', host: 'popup', now: 0 }])
  assert.equal(state?.id, 'p9')
  assert.equal(state?.armed, true)
})

test('a second command while one is out changes nothing', () => {
  const { state, effects } = run([
    { t: 'arm', id: 'p1', host: 'note', now: 0 },
    { t: 'armed', id: 'p1', host: 'note', now: 0 },
    { t: 'arm', id: 'p2', host: 'note', now: 1 },
  ])
  assert.equal(state?.id, 'p1')
  assert.deepEqual(effects, [])
})

test('events carrying a stale id are ignored', () => {
  const { state, effects } = run([
    { t: 'arm', id: 'p1', host: 'note', now: 0 },
    { t: 'picked', id: 'old', ref: ref('a'), page: '/' },
  ])
  assert.equal(state?.id, 'p1', 'still picking')
  assert.deepEqual(effects, [])
})

test('a note pick drops its answer straight into the note box', () => {
  const { state, effects } = run([
    { t: 'arm', id: 'p1', host: 'note', now: 0 },
    { t: 'armed', id: 'p1', host: 'note', now: 0 },
    { t: 'picked', id: 'p1', ref: ref('src/b.tsx:8'), page: '/other' },
  ])
  assert.equal(state, null, 'and the transaction is over')
  assert.deepEqual(effects, [{ do: 'insert-note', ref: ref('src/b.tsx:8') }, { do: 'banner', text: null }])
})

// The overlay still had its own popup, so it did everything itself. The shell's
// copy is stale and must be dropped without touching anything.
test('a pick the overlay finished itself just clears the shell', () => {
  const { state, effects } = run([
    { t: 'armed', id: 'p1', host: 'popup', now: 0 },
    { t: 'draft', id: 'p1', draft: draft('/pricing') },
    { t: 'draft-done', id: 'p1' },
  ])
  assert.equal(state, null)
  assert.deepEqual(dos(effects), ['banner'])
})

test('landing on another page navigates back, then restores', () => {
  const first = reducePick(
    {
      id: 'p1',
      host: 'popup',
      phase: 'picking',
      armed: true,
      frame: null,
      draft: draft('/pricing'),
      ref: null,
      page: '/docs',
      armedAt: 0,
      returns: 0,
    },
    { t: 'picked', id: 'p1', ref: ref('src/b.tsx:8'), page: '/docs' },
  )
  assert.deepEqual(dos(first.effects), ['navigate', 'banner'])
  assert.deepEqual(first.effects[0], { do: 'navigate', page: '/pricing' })
  assert.equal(first.state?.phase, 'returning')

  const back = reducePick(first.state, { t: 'ready', page: '/pricing', now: 10 })
  assert.equal(back.state, null)
  const restore = back.effects[0] as { do: 'restore'; draft: DraftWire }
  assert.equal(restore.do, 'restore')
  // The answer is grafted into the spot the placeholder was holding.
  assert.deepEqual(restore.draft.body, [
    { t: 'text', v: '跟 ' },
    { t: 'ref', n: 1, anchor: { source: 'src/b.tsx:8' }, label: 'src/b.tsx:8' },
  ])
})

// The user walked back to the page themselves before pointing at anything, so
// there is nowhere to navigate to.
test('landing on the page the composer belongs to restores at once', () => {
  const { state, effects } = run([
    { t: 'armed', id: 'p1', host: 'popup', now: 0 },
    { t: 'draft', id: 'p1', draft: draft('/pricing') },
    { t: 'picked', id: 'p1', ref: ref('b'), page: '/pricing' },
  ])
  assert.equal(state, null)
  assert.deepEqual(dos(effects), ['restore', 'banner'])
})

// This is the case shell ownership exists for: the app navigated the iframe and
// the overlay died without a word.
test('a fresh overlay is re-armed, and told where to come back to', () => {
  const { state, effects } = run([
    { t: 'armed', id: 'p1', host: 'popup', now: 0 },
    { t: 'draft', id: 'p1', draft: draft('/pricing') },
    { t: 'ready', page: '/docs', now: 50 },
  ])
  assert.equal(state?.armed, false, 'and waits for the new one to confirm')
  assert.deepEqual(effects[0], {
    do: 'arm-overlay',
    id: 'p1',
    host: 'popup',
    returnTo: '/pricing',
  })
})

test('a re-arm restarts the timeout rather than inheriting the old one', () => {
  const { state } = run([
    { t: 'arm', id: 'p1', host: 'note', now: 0 },
    { t: 'ready', page: '/docs', now: 9000 },
  ])
  assert.equal(state?.armedAt, 9000)
})

// A page with no overlay in it - a crashed app, a build-error screen - never
// confirms, and must not look like a hang.
test('a pick nothing confirms times out with a reason', () => {
  const armed = reducePick(null, { t: 'arm', id: 'p1', host: 'note', now: 0 })
  assert.deepEqual(reducePick(armed.state, { t: 'tick', now: ARM_TIMEOUT_MS - 1 }).effects, [])
  const out = reducePick(armed.state, { t: 'tick', now: ARM_TIMEOUT_MS })
  assert.equal(out.state, null)
  assert.equal((out.effects[0] as { text: string }).text.length > 0, true)
})

test('a confirmed pick never times out', () => {
  const { state } = run([
    { t: 'arm', id: 'p1', host: 'note', now: 0 },
    { t: 'armed', id: 'p1', host: 'note', now: 0 },
  ])
  assert.deepEqual(reducePick(state, { t: 'tick', now: 999_999 }).effects, [])
})

test('a cancel the overlay already undid leaves nothing to do', () => {
  const { state, effects } = run([
    { t: 'armed', id: 'p1', host: 'popup', now: 0 },
    { t: 'draft', id: 'p1', draft: draft('/pricing') },
    { t: 'cancelled', id: 'p1', resumed: true },
  ])
  assert.equal(state, null)
  assert.deepEqual(dos(effects), ['banner'])
})

// Cancelled from a page the popup does not live on: the typed text is still worth
// something, so it goes back and is restored without a reference.
test('a cancel away from home still carries the comment back', () => {
  const first = run([
    { t: 'armed', id: 'p1', host: 'popup', now: 0 },
    { t: 'draft', id: 'p1', draft: draft('/pricing') },
    { t: 'ready', page: '/docs', now: 1 },
    { t: 'armed', id: 'p1', host: 'popup', now: 1 },
  ])
  const out = reducePick(first.state, { t: 'cancelled', id: 'p1', resumed: false })
  assert.deepEqual(dos(out.effects), ['navigate', 'banner'])
  const back = reducePick(out.state, { t: 'ready', page: '/pricing', now: 2 })
  const restore = back.effects[0] as { do: 'restore'; draft: DraftWire }
  assert.equal(restore.do, 'restore')
  assert.deepEqual(restore.draft.body, [{ t: 'text', v: '跟 ' }], 'placeholder gone, text kept')
})

test('an app that redirects away from home is chased twice, then given up on', () => {
  let state = reducePick(
    {
      id: 'p1',
      host: 'popup',
      phase: 'returning',
      armed: true,
      frame: null,
      draft: draft('/pricing'),
      ref: ref('b'),
      page: '/docs',
      armedAt: 0,
      returns: 1,
    },
    { t: 'ready', page: '/login', now: 1 },
  )
  assert.deepEqual(dos(state.effects), ['navigate', 'banner'])
  state = reducePick(state.state, { t: 'ready', page: '/login', now: 2 })
  assert.equal(state.state, null)
  assert.deepEqual(dos(state.effects), ['banner'])
})

// Deliberate: the shell cannot tell whether the overlay still holds the live
// popup those files are chipped in, and deleting them when it does would destroy
// what the user is looking at.
test('no abort path ever deletes a file', () => {
  const reasons = ['escape', 'mode', 'sent', 'ended'] as const
  for (const reason of reasons) {
    const { state, effects } = run([
      { t: 'armed', id: 'p1', host: 'popup', now: 0 },
      { t: 'draft', id: 'p1', draft: draft('/pricing') },
      { t: 'abort', reason },
    ])
    assert.equal(state, null, reason)
    assert.deepEqual(dos(effects), ['abort-overlay', 'banner'], reason)
  }
})

test('aborting when nothing is out is a no-op', () => {
  assert.deepEqual(reducePick(null, { t: 'abort', reason: 'sent' }), { state: null, effects: [] })
  assert.deepEqual(reducePick(null, { t: 'ready', page: '/', now: 0 }), { state: null, effects: [] })
})

// The overlay only sends `picked` once its own popup is gone, so a popup pick
// with no draft has nothing left that could receive the answer.
test('a popup pick with no draft ends quietly instead of throwing', () => {
  const { state, effects } = run([
    { t: 'armed', id: 'p1', host: 'popup', now: 0 },
    { t: 'picked', id: 'p1', ref: ref('b'), page: '/' },
  ])
  assert.equal(state, null)
  assert.deepEqual(dos(effects), ['banner'])
})

// Past the grace window the sweep has taken the files the chips name, so the
// restore is refused rather than producing a save that cannot succeed.
test('an expired draft is reported instead of restored', () => {
  const { state, effects } = run([
    { t: 'armed', id: 'p1', host: 'popup', now: 0 },
    { t: 'draft', id: 'p1', draft: draft('/pricing') },
    { t: 'expired', id: 'p1' },
  ])
  assert.equal(state, null)
  assert.deepEqual(dos(effects), ['banner'])
  assert.equal((effects[0] as { text: string }).text.length > 0, true)
})

test('an expiry for a pick we are not tracking is ignored', () => {
  const { state, effects } = run([
    { t: 'arm', id: 'p1', host: 'note', now: 0 },
    { t: 'expired', id: 'other' },
  ])
  assert.equal(state?.id, 'p1')
  assert.deepEqual(effects, [])
})

// ---------------------------------------------------------------- many frames

// The canvas shows every device at once, so a command typed in the sidebar has
// no frame of its own: it goes out to all of them and the user's click decides.
test('a sidebar pick stays out to every frame while they all answer', () => {
  const { state, effects } = run([
    { t: 'arm', id: 'p1', host: 'note', now: 0 },
    { t: 'armed', id: 'p1', host: 'note', now: 1, frame: 'desktop' },
    { t: 'armed', id: 'p1', host: 'note', now: 1, frame: 'mobile' },
  ])
  assert.equal(state?.frame, null, 'saying it is listening is not claiming it')
  assert.equal(state?.armed, true)
  assert.deepEqual(effects, [], 'nobody is stood down for answering')
})

test('the frame that is pointed at takes the pick and stands the others down', () => {
  const { state, effects } = run([
    { t: 'arm', id: 'p1', host: 'note', now: 0 },
    { t: 'armed', id: 'p1', host: 'note', now: 1, frame: 'mobile' },
    { t: 'picked', id: 'p1', ref: ref('src/b.tsx:8'), page: '/', frame: 'mobile' },
  ])
  assert.equal(state, null, 'and the pick is over')
  assert.deepEqual(effects, [
    { do: 'insert-note', ref: ref('src/b.tsx:8') },
    { do: 'disarm-others', id: 'p1', keep: 'mobile' },
    { do: 'banner', text: null },
  ])
})

test('once a frame holds the pick, the others are not listened to', () => {
  const held: PickState = {
    id: 'p1',
    host: 'note',
    phase: 'picking',
    armed: true,
    frame: 'mobile',
    draft: null,
    ref: null,
    page: '/',
    armedAt: 0,
    returns: 0,
  }
  const stray = reducePick(held, {
    t: 'picked',
    id: 'p1',
    ref: ref('src/other.tsx:2'),
    page: '/',
    frame: 'tablet',
  })
  assert.equal(stray.state, held, 'the pick is still out')
  assert.deepEqual(stray.effects, [])

  const own = reducePick(held, {
    t: 'picked',
    id: 'p1',
    ref: ref('src/a.tsx:1'),
    page: '/',
    frame: 'mobile',
  })
  assert.deepEqual(dos(own.effects), ['insert-note', 'disarm-others', 'banner'])
})

// Every frame reloads when one of them navigates, so the shell hears `ready`
// three times. Only the frame the pick is out to may act on it - otherwise the
// other two spend the return budget and the comment is given up on.
test('a ready from a frame that does not hold the pick changes nothing', () => {
  const returning: PickState = {
    id: 'p1',
    host: 'popup',
    phase: 'returning',
    armed: true,
    frame: 'mobile',
    draft: draft('/pricing'),
    ref: ref('b'),
    page: '/docs',
    armedAt: 0,
    returns: 1,
  }
  const other = reducePick(returning, { t: 'ready', page: '/docs', now: 1, frame: 'desktop' })
  assert.equal(other.state?.returns, 1, 'the budget is untouched')
  assert.deepEqual(other.effects, [])
})

test('a pick from an overlay popup belongs to its own frame from the start', () => {
  const { state, effects } = run([
    { t: 'armed', id: 'p1', host: 'popup', now: 0, frame: 'tablet' },
    { t: 'draft', id: 'p1', draft: draft('/pricing'), frame: 'tablet' },
    { t: 'picked', id: 'p1', ref: ref('src/b.tsx:8'), page: '/docs', frame: 'tablet' },
  ])
  assert.equal(state?.frame, 'tablet')
  assert.deepEqual(effects[0], { do: 'navigate', page: '/pricing', frame: 'tablet' })
})

test('an abort reaches the frame holding the pick, not all of them', () => {
  const { effects } = run([
    { t: 'armed', id: 'p1', host: 'popup', now: 0, frame: 'tablet' },
    { t: 'abort', reason: 'mode' },
  ])
  assert.deepEqual(effects[0], { do: 'abort-overlay', id: 'p1', frame: 'tablet' })
})

// Nothing has answered yet, so the re-armed frame is the one that reloaded and
// the other frames stay armed exactly as they were.
test('a frame that reloads under an unclaimed pick is re-armed on its own', () => {
  const { state, effects } = run([
    { t: 'arm', id: 'p1', host: 'note', now: 0 },
    { t: 'ready', page: '/', now: 10, frame: 'desktop' },
  ])
  assert.equal(state?.frame, null, 'still anyone’s to answer')
  assert.deepEqual(effects[0], { do: 'arm-overlay', id: 'p1', host: 'note', frame: 'desktop' })
})
