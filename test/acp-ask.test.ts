import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type AcpAskField, fieldsFromSchema, validateAnswers } from '../src/acp-ask.js'

/** The shape `claude-agent-acp` sends for AskUserQuestion: one titled `oneOf`
 *  select per question, each with an optional free-text companion. */
const ASK_USER_QUESTION = {
  type: 'object',
  properties: {
    style: {
      type: 'string',
      title: 'Which style?',
      oneOf: [
        { const: 'compact', title: 'Compact', description: 'Tighter spacing' },
        { const: 'airy', title: 'Airy' },
      ],
    },
    style_other: { type: 'string', title: 'Other' },
  },
  required: ['style'],
}

test('a select keeps its options and an unrequired companion becomes an optional text field', () => {
  const fields = fieldsFromSchema(ASK_USER_QUESTION)
  assert.deepEqual(fields, [
    {
      key: 'style',
      text: 'Which style?',
      kind: 'select',
      options: [
        { id: 'compact', name: 'Compact', description: 'Tighter spacing' },
        { id: 'airy', name: 'Airy' },
      ],
    },
    { key: 'style_other', text: 'Other', kind: 'text', optional: true },
  ])
})

test('every primitive the protocol allows is drawn, with its bounds and default', () => {
  const fields = fieldsFromSchema({
    properties: {
      name: { type: 'string', description: 'A name', minLength: 1, maxLength: 40, default: 'x' },
      email: { type: 'string', format: 'email', pattern: '@' },
      count: { type: 'integer', minimum: 1, maximum: 9, default: 3 },
      ratio: { type: 'number', maximum: 1 },
      confirm: { type: 'boolean', default: false },
      colour: { type: 'string', enum: ['red', 'blue'] },
      tags: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: {
          anyOf: [
            { const: 'a', title: 'A' },
            { const: 'b', title: 'B' },
          ],
        },
        default: ['a'],
      },
      plain: { type: 'array', items: { type: 'string', enum: ['p', 'q'] } },
    },
    required: ['name', 'email', 'count', 'ratio', 'confirm', 'colour', 'tags', 'plain'],
  })
  assert.deepEqual(fields, [
    { key: 'name', text: 'A name', kind: 'text', min: 1, max: 40, default: 'x' },
    { key: 'email', kind: 'text', pattern: '@', format: 'email' },
    { key: 'count', kind: 'number', integer: true, min: 1, max: 9, default: 3 },
    { key: 'ratio', kind: 'number', max: 1 },
    { key: 'confirm', kind: 'boolean', default: false },
    {
      key: 'colour',
      kind: 'select',
      options: [
        { id: 'red', name: 'red' },
        { id: 'blue', name: 'blue' },
      ],
    },
    {
      key: 'tags',
      kind: 'multiselect',
      options: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      min: 1,
      max: 2,
      default: ['a'],
    },
    {
      key: 'plain',
      kind: 'multiselect',
      options: [
        { id: 'p', name: 'p' },
        { id: 'q', name: 'q' },
      ],
    },
  ])
})

test('a required field the shell cannot draw makes the whole form undrawable', () => {
  assert.equal(
    fieldsFromSchema({
      properties: { ok: { type: 'string' }, blob: { type: 'object' } },
      required: ['ok', 'blob'],
    }),
    null,
  )
  assert.equal(
    fieldsFromSchema({
      properties: { list: { type: 'array', items: { type: 'number' } } },
      required: ['list'],
    }),
    null,
  )
})

test('an optional field the shell cannot draw is left out; a form with nothing left is undrawable', () => {
  assert.deepEqual(
    fieldsFromSchema({ properties: { ok: { type: 'string' }, blob: { type: 'object' } } }),
    [{ key: 'ok', kind: 'text', optional: true }],
  )
  assert.equal(fieldsFromSchema({ properties: { blob: { type: 'object' } } }), null)
  assert.equal(fieldsFromSchema({}), null)
})

const FIELDS: AcpAskField[] = [
  { key: 'style', kind: 'select', options: [{ id: 'a', name: 'A' }] },
  { key: 'note', kind: 'text', min: 2, max: 5, pattern: '^[a-z]+$', optional: true },
  { key: 'n', kind: 'number', integer: true, min: 1, max: 3 },
  { key: 'yes', kind: 'boolean' },
  {
    key: 'tags',
    kind: 'multiselect',
    options: [
      { id: 'x', name: 'X' },
      { id: 'y', name: 'Y' },
    ],
    max: 1,
  },
]

test('a complete, well-typed answer passes through with blank optionals dropped', () => {
  assert.deepEqual(
    validateAnswers(FIELDS, { style: 'a', note: '', n: 2, yes: false, tags: ['y'] }),
    {
      style: 'a',
      n: 2,
      yes: false,
      tags: ['y'],
    },
  )
  assert.deepEqual(
    validateAnswers(FIELDS, { style: 'a', note: 'abc', n: 1, yes: true, tags: ['x'] }),
    {
      style: 'a',
      note: 'abc',
      n: 1,
      yes: true,
      tags: ['x'],
    },
  )
})

test('anything off is refused whole', () => {
  const ok = { style: 'a', n: 2, yes: true, tags: ['x'] }
  const cases: Record<string, unknown>[] = [
    { ...ok, style: 'zzz' },
    { ...ok, style: undefined },
    { ...ok, note: 'a' },
    { ...ok, note: 'abcdef' },
    { ...ok, note: 'ABC' },
    { ...ok, n: 2.5 },
    { ...ok, n: 0 },
    { ...ok, n: '2' },
    { ...ok, yes: 'true' },
    { ...ok, tags: ['x', 'y'] },
    { ...ok, tags: ['x', 'x'] },
    { ...ok, tags: ['nope'] },
    { ...ok, tags: 'x' },
  ]
  for (const raw of cases) assert.equal(validateAnswers(FIELDS, raw), null, JSON.stringify(raw))
  assert.equal(validateAnswers(FIELDS, null), null)
  assert.equal(validateAnswers(FIELDS, []), null)
  assert.equal(validateAnswers(FIELDS, 'x'), null)
})

test('a pattern the agent got wrong accepts rather than crashes', () => {
  assert.deepEqual(validateAnswers([{ key: 't', kind: 'text', pattern: '(' }], { t: 'anything' }), {
    t: 'anything',
  })
})

/** `claude-agent-acp`'s AskUserQuestion, exactly as it ships: nothing required,
 *  one "Other" box per question marked in `_meta`, a multi-select as an array. */
const CLAUDE_ASK = {
  type: 'object',
  properties: {
    question_0: {
      type: 'string',
      title: 'Auth method',
      oneOf: [
        { const: 'OAuth', title: 'OAuth' },
        { const: 'API key', title: 'API key' },
      ],
    },
    question_0_custom: {
      type: 'string',
      title: 'Other',
      description: 'Type your own answer instead of choosing an option above (optional).',
      _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true } },
    },
    question_1: {
      type: 'array',
      title: 'Features',
      description: 'Which features do you want?',
      items: {
        anyOf: [
          { const: 'A', title: 'A' },
          { const: 'B', title: 'B' },
        ],
      },
    },
    question_1_custom: {
      type: 'string',
      title: 'Other',
      _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_1', isCustomAnswer: true } },
    },
  },
}

test("Claude's Other box folds into the choice it belongs to, and a typed Other answers it", () => {
  const fields = fieldsFromSchema(CLAUDE_ASK)!
  assert.deepEqual(
    fields.map((f) => [f.key, f.kind, 'custom' in f ? f.custom : undefined]),
    [
      ['question_0', 'select', { key: 'question_0_custom', text: 'Other' }],
      ['question_1', 'multiselect', { key: 'question_1_custom', text: 'Other' }],
    ],
  )
  assert.deepEqual(validateAnswers(fields, { question_0: 'OAuth', question_1: ['A'] }), {
    question_0: 'OAuth',
    question_1: ['A'],
  })
  assert.deepEqual(
    validateAnswers(fields, {
      question_0_custom: 'SAML',
      question_1: ['A'],
      question_1_custom: 'C',
    }),
    {
      question_0_custom: 'SAML',
      question_1: ['A'],
      question_1_custom: 'C',
    },
  )
  assert.equal(validateAnswers(fields, { question_0_custom: 42 }), null)
})

test('an Other box whose question is missing, or required, stays a text field of its own', () => {
  const fields = fieldsFromSchema({
    properties: {
      question_0_custom: CLAUDE_ASK.properties.question_0_custom,
      lone: {
        type: 'string',
        _meta: { _askUserQuestionCustomAnswer: { questionId: 'q', isCustomAnswer: true } },
      },
    },
    required: ['lone'],
  })
  assert.deepEqual(fields, [
    { key: 'lone', kind: 'text' },
    { key: 'question_0_custom', kind: 'text', optional: true, text: 'Other' },
  ])
})
