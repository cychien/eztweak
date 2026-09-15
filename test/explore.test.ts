import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_VARIANT_HTML, checkVariant, variantProblemMessage } from '../src/explore.js'

const ok = (html: string, name = 'v') => assert.equal(checkVariant(name, html), null, html)
const problem = (html: string, code: string, name = 'v') =>
  assert.equal(checkVariant(name, html)?.code, code, html)

test('one root element passes, whatever is inside it', () => {
  ok('<div>hi</div>')
  ok('<button class="btn"><span>買</span><svg viewBox="0 0 1 1"><path d="M0 0"/></svg></button>')
  ok('<div>\n  <style>.a { color: red }</style>\n  <p>a</p>\n</div>')
  ok('  <section data-x="a>b">text</section>  ')
  ok('<img src="x.png">')
  ok('<input type="text" />')
  ok('<!-- a note --><div>hi</div>')
})

test('anything but exactly one root is refused, with the count', () => {
  assert.deepEqual(checkVariant('v', '<div>a</div><div>b</div>'), {
    code: 'not-one-root',
    roots: 2,
  })
  assert.deepEqual(checkVariant('v', 'just text'), { code: 'not-one-root', roots: 0 })
  assert.deepEqual(checkVariant('v', '<br><br>'), { code: 'not-one-root', roots: 2 })
  // A stray close tag is unbalanced enough that there is nothing to count.
  assert.deepEqual(checkVariant('v', '</div>'), { code: 'not-one-root', roots: 0 })
})

test('markup that looks like tags but is not does not count as a root', () => {
  // Raw-text content is read to its close, so CSS with a `<` in it is text.
  ok('<div><style>.a::before { content: "<b>" }</style>text</div>')
  ok('<p>2 &lt; 3</p>')
})

test('a variant is markup and CSS only', () => {
  assert.deepEqual(checkVariant('v', '<div><script>alert(1)</script></div>'), {
    code: 'forbidden-tag',
    tag: 'script',
  })
  problem('<div><iframe src="x"></iframe></div>', 'forbidden-tag')
  problem('<div><link rel="stylesheet" href="x.css"></div>', 'forbidden-tag')
  assert.deepEqual(checkVariant('v', '<div onclick="go()">x</div>'), {
    code: 'event-handler',
    attribute: 'onclick',
  })
  problem('<div ONMOUSEOVER="go()">x</div>', 'event-handler')
  problem('<a href="javascript:go()">x</a>', 'javascript-url')
})

test('emptiness and size are refused before anything else is looked at', () => {
  problem('', 'empty')
  problem('   \n  ', 'empty')
  problem(`<div>${'x'.repeat(MAX_VARIANT_HTML)}</div>`, 'too-long')
  problem('<div>ok</div>', 'name-too-long', 'x'.repeat(41))
})

test('every message tells the agent what to do instead', () => {
  const messages = [
    { code: 'empty' as const },
    { code: 'too-long' as const, length: 99_999 },
    { code: 'name-too-long' as const, length: 41 },
    { code: 'forbidden-tag' as const, tag: 'script' },
    { code: 'event-handler' as const, attribute: 'onclick' },
    { code: 'javascript-url' as const },
    { code: 'not-one-root' as const, roots: 0 },
    { code: 'not-one-root' as const, roots: 3 },
  ].map(variantProblemMessage)
  for (const message of messages) {
    assert.ok(message.length > 20, message)
    assert.ok(message.endsWith('.'), message)
  }
  assert.match(messages[7]!, /3 top-level elements/)
})
