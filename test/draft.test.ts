import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NBSP,
  bodyFromComment,
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
import type { AnchorWire, DraftNode, DraftWire, NumberedRef } from '../src/client/draft.js'

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

test('a file chip is marked where it sits', () => {
  const body = [text('看這個 '), file('a1', 'shot.png'), text(`${NBSP}的間距`)]
  assert.equal(draftText(body), '看這個 [file 1] 的間距')
  assert.deepEqual(draftFileIds(body), ['a1'])
})

// Unlike a file, where a reference sits *is* the point: the sentence is
// "make this match that one".
test('a reference is a numbered marker where it stands', () => {
  const body = [text('這裡的間距要跟 '), ref('src/b.tsx:88'), text(' 一樣')]
  assert.equal(draftText(body), '這裡的間距要跟 [ref 1] 一樣')
})

test('references and files number independently of each other', () => {
  const body = [
    ref('src/a.tsx:1', 1),
    text(' 和 '),
    file('f1', 'shot.png'),
    text(' 還有 '),
    ref('src/b.tsx:2', 2),
  ]
  assert.equal(draftText(body), '[ref 1] 和 [file 1] 還有 [ref 2]')
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

// A comment that is nothing but a pasted file still says where the file went,
// which is all it had to say.
test('a file-only body reads as its marker', () => {
  assert.equal(draftText([file('a1', 'shot.png')]), '[file 1]')
  assert.equal(draftText([file('a1', 'shot.png'), text(NBSP)]), '[file 1]')
  assert.equal(draftText([file('', 'uploading.png')]), '', 'but not one still in flight')
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

// A comment can point at a file mid sentence, which is what the README promises,
// so where the chip sat is part of what the user said. Positional rather than an
// identity: a file chip reads its own name, so no number on screen can renumber
// under the user, and the markers come out of the same walk as the id list.
test('a file is marked where it sits, numbered by document order', () => {
  const body = [text('比對 '), file('a1', 'x.csv'), text(' 和 '), file('a2', 'y.png')]
  assert.equal(draftText(body), '比對 [file 1] 和 [file 2]')
  assert.deepEqual(draftFileIds(body), ['a1', 'a2'])
})

test('file markers and the id list cannot disagree', () => {
  const body = [file('a1', 'x'), text(' '), ref('r', 4), text(' '), file('a2', 'y')]
  const ids = draftFileIds(body)
  const markers = draftText(body).match(/\[file (\d+)\]/g)!
  assert.deepEqual(markers, ['[file 1]', '[file 2]'])
  markers.forEach((m, i) => assert.equal(Number(m.match(/\d+/)![0]) - 1, i))
  assert.deepEqual(ids, ['a1', 'a2'])
})

// Deleting a file renumbers the rest, and that is fine: nothing on screen shows
// the number, and both halves are recomputed together at send time.
test('deleting a file renumbers the survivors consistently', () => {
  const body = [file('a1', 'x'), text(' '), file('a2', 'y')]
  const after = body.filter((n) => !(n.t === 'file' && n.id === 'a1'))
  assert.equal(draftText(after), '[file 1]')
  assert.deepEqual(draftFileIds(after), ['a2'])
})

test('an upload still in flight is neither marked nor listed', () => {
  const body = [file('', 'uploading.png'), text(' '), file('a1', 'done.png')]
  assert.equal(draftText(body), '[file 1]')
  assert.deepEqual(draftFileIds(body), ['a1'])
})

test('both kinds of marker split out of one comment', () => {
  assert.deepEqual(splitComment('A [ref 2] B [file 1] C'), [
    { t: 'text', v: 'A ' },
    { t: 'ref', n: 2 },
    { t: 'text', v: ' B ' },
    { t: 'file', n: 1 },
    { t: 'text', v: ' C' },
  ])
})

// ------------------------------------------------------- bodyFromComment

const anchorAt = (source: string): AnchorWire => ({ source })
const aRef = (n: number, source: string): NumberedRef => ({
  n,
  anchor: anchorAt(source),
  label: source,
})
const aFile = (id: string, name: string) => ({ id, name })

/** What the editor has to guarantee: reopening a stored comment and saving it
 *  untouched leaves the annotation as it was. The text is compared after
 *  `draftText`'s own trim, which is what a save would have written anyway. */
function roundTrip(
  text: string,
  refs: NumberedRef[],
  files: { id: string; name: string }[],
): { text: string; refs: NumberedRef[]; ids: string[] } {
  const body = bodyFromComment(text, refs, files)
  return { text: draftText(body), refs: draftRefs(body), ids: draftFileIds(body) }
}

test('a plain comment round-trips through the editor untouched', () => {
  assert.deepEqual(roundTrip('這邊的間距再小一點', [], []), {
    text: '這邊的間距再小一點',
    refs: [],
    ids: [],
  })
})

test('chips are rebuilt where the sentence had them', () => {
  const body = bodyFromComment(
    '把這個改成跟 [ref 2] 一樣，參考 [file 1]',
    [aRef(2, 'src/Hero.tsx:4')],
    [aFile('f1', 'shot.png')],
  )
  assert.deepEqual(
    body.map((n) => n.t),
    ['text', 'ref', 'text', 'file', 'text'],
  )
  assert.deepEqual(roundTrip('把這個改成跟 [ref 2] 一樣，參考 [file 1]', [aRef(2, 'src/Hero.tsx:4')], [
    aFile('f1', 'shot.png'),
  ]), {
    text: '把這個改成跟 [ref 2] 一樣，參考 [file 1]',
    refs: [aRef(2, 'src/Hero.tsx:4')],
    ids: ['f1'],
  })
})

// A reference's number is its identity, not its position - so a comment that
// names only [ref 5] has to come back naming [ref 5], not [ref 1].
test('a reference keeps its own number, gaps and all', () => {
  assert.deepEqual(roundTrip('像 [ref 5] 那樣', [aRef(5, 'a.tsx:1')], []), {
    text: '像 [ref 5] 那樣',
    refs: [aRef(5, 'a.tsx:1')],
    ids: [],
  })
})

// The case that would otherwise lose data silently: annotations written before
// `[file n]` existed carry files that no marker places.
test('files no marker places are appended rather than dropped', () => {
  const result = roundTrip('看一下這個', [], [aFile('f1', 'a.png'), aFile('f2', 'b.png')])
  assert.deepEqual(result.ids, ['f1', 'f2'])
  assert.equal(result.text, '看一下這個 [file 1] [file 2]')
})

test('references no marker places are appended too', () => {
  const result = roundTrip('對齊一下', [aRef(1, 'a.tsx:1'), aRef(3, 'b.tsx:9')], [])
  assert.deepEqual(result.refs, [aRef(1, 'a.tsx:1'), aRef(3, 'b.tsx:9')])
  assert.equal(result.text, '對齊一下 [ref 1] [ref 3]')
})

// Better than a chip that quietly vanishes: the user can see the dead marker and
// delete it. This is also what the read-only renderer shows.
test('a marker naming something that is gone stays as literal text', () => {
  const result = roundTrip('像 [ref 9] 那樣，還有 [file 4]', [], [])
  assert.equal(result.text, '像 [ref 9] 那樣，還有 [file 4]')
  assert.deepEqual(result.refs, [])
  assert.deepEqual(result.ids, [])
})

// `[file n]` is positional, so a comment that names them out of order comes back
// renumbered - but paired with the same ids, which is what actually matters.
test('out-of-order file markers renumber against the ids they name', () => {
  const result = roundTrip('先 [file 2] 再 [file 1]', [], [aFile('f1', 'a.png'), aFile('f2', 'b.png')])
  assert.equal(result.text, '先 [file 1] 再 [file 2]')
  assert.deepEqual(result.ids, ['f2', 'f1'], 'the second id is still the one named first')
})

test('the body always ends on text, so the caret can sit past a trailing chip', () => {
  const body = bodyFromComment('看 [file 1]', [], [aFile('f1', 'a.png')])
  assert.equal(body[body.length - 1]?.t, 'text')
})
