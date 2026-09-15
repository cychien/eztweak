import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachmentIds, parseReferences, sanitizeAnchor, sanitizeCapture } from '../src/anchor.js'

test('an absent field means none, a malformed one is an error', () => {
  assert.deepEqual(attachmentIds(undefined), [])
  assert.deepEqual(parseReferences(undefined), [])
  assert.deepEqual(parseReferences(null), [])
  assert.equal(attachmentIds('a1'), null)
  assert.equal(parseReferences({}), null)
  assert.equal(parseReferences(['a1']), null, 'a bare string is not a reference')
})

test('a reference keeps its number, its anchor and its label', () => {
  const parsed = parseReferences([
    { n: 2, anchor: { source: 'src/b.tsx:88', components: ['Row', 'List'] }, label: '立即報名' },
  ])
  assert.deepEqual(parsed, [
    { n: 2, anchor: { source: 'src/b.tsx:88', components: ['Row', 'List'] }, label: '立即報名' },
  ])
})

// The comment's `[ref n]` markers resolve against this number, so a missing or
// nonsense one leaves the agent unable to tell which reference is which.
test('a reference without a usable number is refused', () => {
  const anchor = { source: 'a' }
  assert.equal(parseReferences([{ anchor, label: 'x' }]), null, 'no number')
  assert.equal(parseReferences([{ n: 0, anchor, label: 'x' }]), null)
  assert.equal(parseReferences([{ n: 1.5, anchor, label: 'x' }]), null)
  assert.equal(parseReferences([{ n: '1', anchor, label: 'x' }]), null)
  assert.equal(parseReferences([{ n: 1000, anchor, label: 'x' }]), null)
  assert.equal(parseReferences([{ n: 999, anchor, label: 'x' }])?.length, 1)
})

// Everything here ends up inside the agent's prompt, so nothing arrives unbounded
// and nothing arrives that we did not ask for.
test('unknown keys do not survive and strings are bounded', () => {
  const clean = sanitizeAnchor({
    source: 'a'.repeat(500),
    selector: 'b'.repeat(500),
    text: 'c'.repeat(500),
    onclick: 'alert(1)',
    __proto__: { polluted: true },
  })
  assert.equal(clean?.source?.length, 300)
  assert.equal(clean?.selector?.length, 400)
  assert.equal(clean?.text?.length, 200)
  assert.deepEqual(Object.keys(clean!), ['source', 'selector', 'text'])
})

test('the component chain is capped in both directions', () => {
  const clean = sanitizeAnchor({ components: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] })
  assert.equal(clean?.components?.length, 6)
  assert.equal(sanitizeAnchor({ components: [] })?.components, undefined)
  assert.equal(sanitizeAnchor({ components: 'A' })?.components, undefined)
})

test('numbers are numbers or the shape is dropped whole', () => {
  assert.deepEqual(sanitizeAnchor({ rect: { x: 1, y: 2, width: 3, height: 4 } })?.rect, {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  })
  assert.equal(sanitizeAnchor({ rect: { x: 1, y: 2, width: 3 } })?.rect, undefined)
  assert.equal(sanitizeAnchor({ rect: { x: '1', y: 2, width: 3, height: 4 } })?.rect, undefined)
  assert.equal(sanitizeAnchor({ viewport: { width: Number.NaN, height: 8 } })?.viewport, undefined)
})

test('a pin without a rel still has one', () => {
  assert.deepEqual(sanitizeAnchor({ point: { x: 4, y: 5 } })?.point, {
    x: 4,
    y: 5,
    rel: { x: 0, y: 0 },
  })
})

test('an empty anchor is a valid anchor, a non-object is not', () => {
  assert.deepEqual(sanitizeAnchor({}), {})
  assert.equal(sanitizeAnchor(null), null)
  assert.equal(sanitizeAnchor([]), null)
  assert.equal(sanitizeAnchor('div'), null)
})

// Dropping a bad reference would leave its [ref N] marker in the comment naming
// nothing, which is worse for the agent than an error the client can report.
test('one unusable reference fails the request rather than vanishing', () => {
  assert.equal(
    parseReferences([
      { n: 1, anchor: { source: 'a' } },
      { n: 2, anchor: null },
    ]),
    null,
  )
  assert.equal(parseReferences([{ n: 1, label: 'no anchor' }]), null)
})

test('a reference with no label parses to an empty one', () => {
  assert.deepEqual(parseReferences([{ n: 1, anchor: { source: 'a' } }]), [
    { n: 1, anchor: { source: 'a' }, label: '' },
  ])
})

test('more references than a person would pick is refused', () => {
  const many = Array.from({ length: 17 }, (_, i) => ({
    n: i + 1,
    anchor: { source: 'a' },
    label: 'x',
  }))
  assert.equal(parseReferences(many), null)
  assert.equal(parseReferences(many.slice(0, 16))?.length, 16)
  assert.equal(parseReferences(many, 2), null)
})

// The framed list is a label per element and lands in the agent's prompt, so it
// is bounded the same way every other string here is.
test('the framed list is bounded in length and in width', () => {
  const many = Array.from({ length: 30 }, (_, i) => `<C${i}>`)
  assert.equal(sanitizeAnchor({ contains: many })?.contains?.length, 16)
  assert.equal(sanitizeAnchor({ contains: ['x'.repeat(500)] })?.contains?.[0]?.length, 120)
  assert.equal(sanitizeAnchor({ contains: [] })?.contains, undefined)
  assert.equal(sanitizeAnchor({ contains: '<Card>' })?.contains, undefined)
})

// ------------------------------------------------------------- explore capture

test('a capture keeps what a variant needs to be written and drops what it does not', () => {
  const capture = sanitizeCapture({
    html: '<a class="btn">go</a>',
    styles: { 'font-size': '15px', 'background-color': 'rgb(37, 99, 235)', zzz: 'dropped' },
    parentWidth: 640.4,
    rules: ['.btn { padding: 12px }', '.btn:hover { opacity: .9 }', 42, ''],
    slot: {
      display: 'flex',
      align: 'center',
      gap: '12px',
      bogus: 'dropped',
      inherits: { 'font-family': 'Inter', color: 'rgb(23, 23, 23)', padding: 'dropped' },
    },
    tokens: {
      '--brand': '#2563eb',
      '--radius': '8px',
      'not-a-token': 'dropped',
      '--x y': 'dropped',
    },
    siblings: [
      { tag: 'a', class: 'btn btn-ghost', text: '看 2 分鐘介紹', width: 120.6, height: 44 },
      { tag: 'p', width: 'nope', height: 1 },
      'junk',
    ],
    theme: { scheme: 'light dark', classes: 'theme-a', dataTheme: 'dark', extra: 'dropped' },
  })
  assert.deepEqual(capture, {
    html: '<a class="btn">go</a>',
    styles: { 'font-size': '15px', 'background-color': 'rgb(37, 99, 235)' },
    parentWidth: 640,
    rules: ['.btn { padding: 12px }', '.btn:hover { opacity: .9 }'],
    slot: {
      display: 'flex',
      align: 'center',
      gap: '12px',
      inherits: { 'font-family': 'Inter', color: 'rgb(23, 23, 23)' },
    },
    tokens: { '--brand': '#2563eb', '--radius': '8px' },
    siblings: [{ tag: 'a', class: 'btn btn-ghost', text: '看 2 分鐘介紹', width: 121, height: 44 }],
    theme: { scheme: 'light dark', classes: 'theme-a', dataTheme: 'dark' },
  })
})

test('the matched rules are bounded in count, per rule, and in total', () => {
  const many = Array.from({ length: 60 }, (_, i) => `.r${i} { color: red }`)
  assert.equal(sanitizeCapture({ html: '<i/>', rules: many })!.rules!.length, 40)
  const long = sanitizeCapture({ html: '<i/>', rules: ['x'.repeat(5000)] })!.rules!
  assert.equal(long.length, 1)
  assert.equal(long[0]!.length, 1000)
  const total = sanitizeCapture({ html: '<i/>', rules: Array(10).fill('y'.repeat(900)) })!.rules!
  assert.equal(total.length, 4)
})

test('a capture with none of the new fields is unchanged, and one with nothing to vary is refused', () => {
  assert.deepEqual(sanitizeCapture({ html: '<i/>' }), { html: '<i/>' })
  assert.equal(sanitizeCapture({ html: '', rules: ['.a{}'] }), null)
  assert.equal(sanitizeCapture({ rules: ['.a{}'] }), null)
})
