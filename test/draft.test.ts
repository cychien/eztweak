import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NBSP,
  draftBelongsHere,
  draftExpired,
  draftFileIds,
  draftPendingNames,
  draftRefs,
  draftText,
  dropDraftRef,
  hasPendingRef,
  nextRefNumber,
  normalizeDraft,
  resolveDraftRef,
  restorableBody,
  splitComment,
} from '../src/client/draft.js'
import type { AnchorWire, DraftNode, DraftWire } from '../src/client/draft.js'

const text = (v: string): DraftNode => ({ t: 'text', v })
const file = (id: string, name: string): DraftNode => ({ t: 'file', id, name })
const anchor = (source: string): AnchorWire => ({ source, selector: 'div' })
const ref = (source: string, n = 1, label = source): DraftNode => ({
  t: 'ref',
  n,
  anchor: anchor(source),
  label,
})
const picking: DraftNode = { t: 'ref', n: 0, anchor: null, label: '選取中…' }

test('a file chip contributes nothing to the comment', () => {
  const body = [text('看這個 '), file('a1', 'shot.png'), text(`${NBSP}的間距`)]
  // Two spaces, not one: the chip sat between the user's space and its own NBSP
  // spacer. Preserves what `text()` has always produced.
  assert.equal(draftText(body), '看這個  的間距')
  assert.deepEqual(draftFileIds(body), ['a1'])
})

// Unlike a file, where a reference sits *is* the point: the sentence is
// "make this match that one".
test('a reference is a numbered marker where it stands', () => {
  const body = [text('這裡的間距要跟 '), ref('src/b.tsx:88'), text(' 一樣')]
  assert.equal(draftText(body), '這裡的間距要跟 [ref 1] 一樣')
})

test('markers are numbered in document order, past interleaved files', () => {
  const body = [
    ref('src/a.tsx:1', 1),
    text(' 和 '),
    file('f1', 'shot.png'),
    text(' 還有 '),
    ref('src/b.tsx:2', 2),
  ]
  assert.equal(draftText(body), '[ref 1] 和  還有 [ref 2]')
  assert.deepEqual(
    draftRefs(body).map((r) => r.anchor.source),
    ['src/a.tsx:1', 'src/b.tsx:2'],
  )
})

// The numbering in the comment and the array the agent gets come out of the same
// pass, so they cannot drift. This is the property that matters.
test('every marker names the reference carrying that number', () => {
  const body = [ref('a', 1), text(' x '), ref('b', 4), text(' y '), ref('c', 7)]
  const refs = draftRefs(body)
  const markers = draftText(body).match(/\[ref (\d+)\]/g)!
  assert.deepEqual(markers, ['[ref 1]', '[ref 4]', '[ref 7]'])
  for (const marker of markers) {
    const n = Number(marker.match(/\d+/)![0])
    assert.equal(refs.find((r) => r.n === n)?.anchor.source, { 1: 'a', 4: 'b', 7: 'c' }[n])
  }
})

// A number is an identity, not a position: deleting one reference must not
// rename the ones the user did not touch, so gaps are expected and the agent has
// to match on `n` rather than on where it sits in the array.
test('numbers survive the deletion of an earlier reference', () => {
  const body = [text('A '), ref('a', 1), text(' B '), ref('b', 2)]
  const survivors = body.filter((n) => !(n.t === 'ref' && n.n === 1))
  assert.equal(draftText(survivors), 'A  B [ref 2]')
  assert.deepEqual(draftRefs(survivors).map((r) => r.n), [2])
})

test('the next number is one past the highest already spoken for', () => {
  assert.equal(nextRefNumber([]), 1)
  assert.equal(nextRefNumber([ref('a', 1), ref('b', 2)]), 3)
  // The gap left by a deleted reference is not reused.
  assert.equal(nextRefNumber([ref('b', 2)]), 3)
  assert.equal(nextRefNumber([picking]), 1, 'a placeholder has no number yet')
})

test('a placeholder is not a reference yet', () => {
  const body = [text('跟 '), picking, text(' 一樣')]
  assert.equal(draftText(body), '跟  一樣', 'no marker until it resolves')
  assert.deepEqual(draftRefs(body), [])
  assert.equal(hasPendingRef(body), true)
  assert.equal(hasPendingRef([ref('a')]), false)
})

test('an upload still in flight has no id, so it is not one', () => {
  const body = [file('', 'uploading.png'), file('a1', 'done.png')]
  assert.deepEqual(draftFileIds(body), ['a1'])
  assert.deepEqual(draftPendingNames(body), ['uploading.png'])
})

test('a non-breaking space reads as a space, and the ends are trimmed', () => {
  assert.equal(draftText([text(`${NBSP}${NBSP}中間${NBSP}`)]), '中間')
})

test('newlines the browser made survive the walk', () => {
  assert.equal(draftText([text('第一行\n第二行')]), '第一行\n第二行')
})

test('adjacent text runs collapse, empty ones vanish', () => {
  assert.deepEqual(normalizeDraft([text('ab'), text(''), text('cd')]), [text('abcd')])
  assert.deepEqual(normalizeDraft([text(''), file('a', 'x'), text('')]), [file('a', 'x')])
  assert.deepEqual(normalizeDraft([]), [])
})

// The round trip a cross-page restore depends on: whatever shape the browser
// hands back, the draft must compare equal to what was stored.
test('a snapshot split anywhere normalizes to the same draft', () => {
  const whole = [text('看 '), ref('src/a.tsx:1'), text(' 這裡')]
  const split = [text('看'), text(' '), ref('src/a.tsx:1'), text(' '), text('這裡')]
  assert.deepEqual(normalizeDraft(split), normalizeDraft(whole))
  assert.equal(draftText(split), draftText(whole))
})

test('a chip-only body still reads as empty text', () => {
  assert.equal(draftText([file('a1', 'shot.png')]), '')
  assert.equal(draftText([file('a1', 'shot.png'), text(NBSP)]), '')
})

test('a restore drops the uploads it cannot resume, and keeps the rest in place', () => {
  const body = [text('a '), file('', 'lost.png'), text(' b '), file('k1', 'kept.png'), ref('r')]
  assert.deepEqual(restorableBody(body), [text('a  b '), file('k1', 'kept.png'), ref('r')])
})

test('a placeholder survives a restore, so the answer still lands in its spot', () => {
  const body = [text('跟 '), picking, text(' 一樣')]
  assert.deepEqual(restorableBody(body), body)
})

const draft = (over: Partial<DraftWire> = {}): DraftWire => ({
  id: 'p1',
  host: 'popup',
  createdAt: 1000,
  subject: { kind: 'element', page: '/pricing', anchor: anchor('src/a.tsx:1') },
  body: [],
  ...over,
})

test('a draft belongs only to the page it was taken on', () => {
  assert.equal(draftBelongsHere(draft(), '/pricing'), true)
  assert.equal(draftBelongsHere(draft(), '/'), false)
})

// The note box lives outside the iframe and never dies, so it has no subject and
// belongs to no page - it must never be treated as something to rebuild.
test('a note draft is never "here"', () => {
  assert.equal(draftBelongsHere(draft({ host: 'note', subject: undefined }), '/pricing'), false)
})

// Past the grace window the sweep has taken the files, so restoring would only
// build a composer whose save is certain to fail.
test('a draft expires with the attachments it references', () => {
  const grace = 500
  assert.equal(draftExpired(draft(), 1400, grace), false)
  assert.equal(draftExpired(draft(), 1500, grace), true)
  assert.equal(draftExpired(draft(), 9000, grace), true)
})

// How an answer reaches a composer that no longer exists: the body it will be
// rebuilt from already has the spot marked.
test('resolving a placeholder fills its spot, leaving everything else alone', () => {
  const body = [text('跟 '), picking, text(' 一樣')]
  const filled = resolveDraftRef(body, { anchor: anchor('src/b.tsx:88'), label: 'Row' })
  assert.deepEqual(filled, [
    text('跟 '),
    { t: 'ref', n: 1, anchor: anchor('src/b.tsx:88'), label: 'Row' },
    text(' 一樣'),
  ])
  assert.equal(draftText(filled), '跟 [ref 1] 一樣')
})

test('a resolved placeholder takes the next free number, not the next slot', () => {
  const body = [ref('a', 3), text(' '), picking]
  const filled = resolveDraftRef(body, { anchor: anchor('b'), label: 'b' })
  assert.equal(draftText(filled), '[ref 3] [ref 4]')
})

test('only the first placeholder resolves, and settled references are untouched', () => {
  const body = [ref('a'), picking, picking]
  const filled = resolveDraftRef(body, { anchor: anchor('b'), label: 'b' })
  assert.deepEqual(filled[0], ref('a'))
  assert.equal((filled[1] as { anchor: unknown }).anchor !== null, true)
  assert.equal((filled[2] as { anchor: unknown }).anchor, null)
})

test('resolving a body with no placeholder changes nothing', () => {
  const body = [text('a'), ref('x')]
  assert.deepEqual(resolveDraftRef(body, { anchor: anchor('b'), label: 'b' }), body)
})

// A cancelled pick still carries the comment back, just without a reference.
test('dropping a placeholder closes the gap it left', () => {
  assert.deepEqual(dropDraftRef([text('跟 '), picking, text(' 一樣')]), [text('跟  一樣')])
  assert.deepEqual(dropDraftRef([ref('a'), picking]), [ref('a')])
  assert.deepEqual(dropDraftRef([text('a')]), [text('a')])
})

// The shell renders the chip where the sentence had it, so the split has to be
// exact: one copy of this format, read back by whoever displays it.
test('a comment splits at its markers, keeping the text around them', () => {
  assert.deepEqual(splitComment('A [ref 1] B [ref 12] C'), [
    { t: 'text', v: 'A ' },
    { t: 'ref', n: 1 },
    { t: 'text', v: ' B ' },
    { t: 'ref', n: 12 },
    { t: 'text', v: ' C' },
  ])
})

test('a marker at either end leaves no empty text run', () => {
  assert.deepEqual(splitComment('[ref 1] tail'), [
    { t: 'ref', n: 1 },
    { t: 'text', v: ' tail' },
  ])
  assert.deepEqual(splitComment('head [ref 2]'), [
    { t: 'text', v: 'head ' },
    { t: 'ref', n: 2 },
  ])
  assert.deepEqual(splitComment('[ref 3]'), [{ t: 'ref', n: 3 }])
})

test('a comment with no markers is one run, and an empty one is nothing', () => {
  assert.deepEqual(splitComment('就這樣'), [{ t: 'text', v: '就這樣' }])
  assert.deepEqual(splitComment(''), [])
})

// Whatever `draftText` emits must come back out of `splitComment` unchanged.
test('the writer and the reader agree on the format', () => {
  const body = [text('跟 '), ref('a', 7), text(' 一樣')]
  assert.deepEqual(splitComment(draftText(body)), [
    { t: 'text', v: '跟 ' },
    { t: 'ref', n: 7 },
    { t: 'text', v: ' 一樣' },
  ])
})

test('text that merely looks like a marker is left alone', () => {
  assert.deepEqual(splitComment('see [ref] or [ref x]'), [{ t: 'text', v: 'see [ref] or [ref x]' }])
})
