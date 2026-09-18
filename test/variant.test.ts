import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Anchor } from '../src/protocol.js'
import { type Candidate, locate, scoreCandidate } from '../src/client/variant.js'

/** Three cards rendered from one component, which is the case the search exists
 *  for: with the build plugin they differ by `file:line`, without it only by
 *  their own text and position. */
const CARDS: Candidate[] = [
  {
    source: 'src/Pricing.tsx:12',
    components: ['PriceCard', 'Pricing'],
    selector: 'main > div:nth-of-type(1)',
    text: 'Starter',
  },
  {
    source: 'src/Pricing.tsx:12',
    components: ['PriceCard', 'Pricing'],
    selector: 'main > div:nth-of-type(2)',
    text: 'Team',
  },
  {
    source: 'src/Pricing.tsx:12',
    components: ['PriceCard', 'Pricing'],
    selector: 'main > div:nth-of-type(3)',
    text: 'Enterprise',
  },
]

test('the text is what tells two instances of one component apart', () => {
  const anchor: Anchor = {
    source: 'src/Pricing.tsx:12',
    components: ['PriceCard', 'Pricing'],
    selector: 'main > div:nth-of-type(2)',
    text: 'Team',
  }
  assert.equal(locate(anchor, CARDS), 1)
})

test('a card that moved is still found: the selector changed, the rest did not', () => {
  const anchor: Anchor = {
    source: 'src/Pricing.tsx:12',
    components: ['PriceCard', 'Pricing'],
    selector: 'main > div:nth-of-type(2)',
    text: 'Enterprise',
  }
  // What a re-order does. The selector now names a different card, and the text
  // is what says which one the user meant.
  assert.equal(locate(anchor, CARDS), 2)
})

test('a different file:line is refused outright, not merely scored low', () => {
  const anchor: Anchor = {
    source: 'src/Hero.tsx:3',
    components: ['PriceCard', 'Pricing'],
    selector: 'main > div:nth-of-type(1)',
    text: 'Starter',
  }
  assert.equal(scoreCandidate(anchor, CARDS[0]!), -1)
  assert.equal(locate(anchor, CARDS), null)
})

test('without the build plugin the selector carries it, and text breaks the tie', () => {
  const plain = CARDS.map(({ source: _source, ...rest }) => rest)
  const anchor: Anchor = {
    components: ['PriceCard', 'Pricing'],
    selector: 'main > div:nth-of-type(3)',
    text: 'Enterprise',
  }
  assert.equal(locate(anchor, plain), 2)
})

test('a shared component name alone is never a match', () => {
  // Every card in the list has this much in common with every other. Swapping
  // one of them because of it would be a confident wrong answer.
  const anchor: Anchor = { components: ['PriceCard', 'Pricing'] }
  assert.equal(locate(anchor, CARDS), null)
  assert.equal(locate({ text: 'Sta' }, CARDS), null)
})

test('nothing on the page that answers the anchor means nothing is swapped', () => {
  const anchor: Anchor = { source: 'src/Gone.tsx:1', text: 'gone' }
  assert.equal(locate(anchor, CARDS), null)
  assert.equal(locate(anchor, []), null)
})

test('an exact source match wins over a mere selector match', () => {
  const anchor: Anchor = { source: 'src/Pricing.tsx:12', text: 'Team' }
  const decoy: Candidate = { selector: 'main > div:nth-of-type(2)', text: 'Team' }
  assert.equal(locate(anchor, [decoy, ...CARDS]), 2)
})

test('first past the post on a tie, which is document order', () => {
  const twins: Candidate[] = [
    { source: 'a.tsx:1', text: 'same' },
    { source: 'a.tsx:1', text: 'same' },
  ]
  assert.equal(locate({ source: 'a.tsx:1', text: 'same' }, twins), 0)
})
