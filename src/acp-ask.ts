/** The form an agent's question takes on the way to the shell, and the answer on
 *  the way back.
 *
 *  A permission prompt and Claude's AskUserQuestion both arrive as single-selects.
 *  An elicitation form can carry the rest of the protocol's primitives - free
 *  text, a number, a yes/no, a multi-select - and until this module the client
 *  kept only the selects and declined the others, which meant a form asking for
 *  a sentence could never be completed from the review shell.
 *
 *  Pure: the schema walk and the answer check are both data in, data out, so the
 *  tests need no agent process for them. */

export interface AcpAskOption {
  id: string
  name: string
  description?: string
  /** Permission-option kind (allow_once, reject_once, ...) - styling hint. */
  hint?: string
}

/** A free-text companion to a choice - the "Other" box under a multiple choice.
 *  Claude's AskUserQuestion sends one per question as a separate optional
 *  string property, marked in `_meta`; drawn as part of the choice it belongs
 *  to, because a box labelled "Other" three fields away from its question is
 *  not the same control. Answered under its own `key`. */
export interface AcpAskCustom {
  key: string
  text?: string
}

/** One field of an ask. `optional` is set when the schema does not list the
 *  property as required, so the shell can let it go unanswered. */
export type AcpAskField = {
  key: string
  text?: string
  optional?: true
} & (
  | { kind: 'select'; options: AcpAskOption[]; default?: string; custom?: AcpAskCustom }
  | {
      kind: 'multiselect'
      options: AcpAskOption[]
      min?: number
      max?: number
      default?: string[]
      custom?: AcpAskCustom
    }
  | {
      kind: 'text'
      min?: number
      max?: number
      pattern?: string
      format?: string
      default?: string
    }
  | { kind: 'number'; integer?: true; min?: number; max?: number; default?: number }
  | { kind: 'boolean'; default?: boolean }
)

export type AcpAskAnswer = string | number | boolean | string[]
export type AcpAskAnswers = Record<string, AcpAskAnswer>

/** The schema as this module reads it. The SDK's own union leaves an open
 *  `{ type: string }` arm for future kinds, which erases every field the moment
 *  a `switch` narrows on `type`; reading through a flat shape instead keeps the
 *  known kinds typed and lets the unknown ones fall to `default`. */
export interface ElicitationSchemaIn {
  properties?: Record<string, unknown> | null
  required?: string[] | null
}

interface PropertyIn {
  type?: string
  title?: string | null
  description?: string | null
  default?: unknown
  minLength?: number | null
  maxLength?: number | null
  pattern?: string | null
  format?: string | null
  enum?: string[] | null
  oneOf?: TitledOption[] | null
  minimum?: number | null
  maximum?: number | null
  minItems?: number | null
  maxItems?: number | null
  items?: { type?: string; enum?: string[] | null; anyOf?: TitledOption[] | null } | null
  _meta?: Record<string, unknown> | null
}

/** How `claude-agent-acp` marks a question's "Other" box. A vendor key, read
 *  through ACP's `_meta` extension point, which is what the point is for. */
const CUSTOM_ANSWER_META_KEY = '_askUserQuestionCustomAnswer'

function customAnswerFor(property: PropertyIn): string | null {
  const bag = property._meta?.[CUSTOM_ANSWER_META_KEY] as
    { questionId?: unknown; isCustomAnswer?: unknown } | undefined
  return bag?.isCustomAnswer === true && typeof bag.questionId === 'string' ? bag.questionId : null
}

interface TitledOption {
  const?: unknown
  title?: string
  description?: string | null
}

/** The fields an elicitation form asks for, in the schema's own order - or null
 *  when the form cannot be completed here: a required property of a type the
 *  shell cannot draw, or nothing drawable at all. Parking such a form on a card
 *  the user could never submit would hang the agent on the user. An *optional*
 *  property of an unknown type is simply left out. */
export function fieldsFromSchema(schema: ElicitationSchemaIn): AcpAskField[] | null {
  const required = new Set(schema.required ?? [])
  const fields: AcpAskField[] = []
  const customs: { key: string; text?: string; questionId: string }[] = []
  for (const [key, raw] of Object.entries(schema.properties ?? {})) {
    const property = raw as PropertyIn
    const questionId = customAnswerFor(property)
    if (questionId && property.type === 'string' && !required.has(key)) {
      const text = property.title ?? property.description ?? undefined
      customs.push({ key, questionId, ...(text ? { text } : {}) })
      continue
    }
    const field = fieldFrom(key, property)
    if (!field) {
      if (required.has(key)) return null
      continue
    }
    fields.push(required.has(key) ? field : { ...field, optional: true })
  }
  for (const { questionId, ...custom } of customs) {
    const owner = fields.find((f) => f.key === questionId)
    // A box whose question is not here to attach to is still a text field.
    if (!owner || (owner.kind !== 'select' && owner.kind !== 'multiselect')) {
      fields.push({
        key: custom.key,
        kind: 'text',
        optional: true,
        ...(custom.text ? { text: custom.text } : {}),
      })
      continue
    }
    owner.custom = custom
  }
  return fields.length ? fields : null
}

function fieldFrom(key: string, property: PropertyIn): AcpAskField | null {
  const text = property.description ?? property.title ?? undefined
  const base = text ? { key, text } : { key }
  switch (property.type) {
    case 'string': {
      const options = selectOptions(property.oneOf, property.enum)
      if (options) {
        return { ...base, kind: 'select', options, ...defaultIf(property.default, 'string') }
      }
      return {
        ...base,
        kind: 'text',
        ...numberIf('min', property.minLength),
        ...numberIf('max', property.maxLength),
        ...(property.pattern ? { pattern: property.pattern } : {}),
        ...(property.format ? { format: property.format } : {}),
        ...defaultIf(property.default, 'string'),
      }
    }
    case 'number':
    case 'integer':
      return {
        ...base,
        kind: 'number',
        ...(property.type === 'integer' ? { integer: true } : {}),
        ...numberIf('min', property.minimum),
        ...numberIf('max', property.maximum),
        ...defaultIf(property.default, 'number'),
      }
    case 'boolean':
      return { ...base, kind: 'boolean', ...defaultIf(property.default, 'boolean') }
    case 'array': {
      const options = selectOptions(property.items?.anyOf, property.items?.enum)
      if (!options) return null
      return {
        ...base,
        kind: 'multiselect',
        options,
        ...numberIf('min', property.minItems),
        ...numberIf('max', property.maxItems),
        ...(Array.isArray(property.default) && property.default.every((v) => typeof v === 'string')
          ? { default: property.default }
          : {}),
      }
    }
    default:
      return null
  }
}

function selectOptions(
  titled: TitledOption[] | null | undefined,
  plain: string[] | null | undefined,
): AcpAskOption[] | null {
  if (titled?.length) {
    const options = titled.flatMap((o) =>
      typeof o.const === 'string'
        ? [
            {
              id: o.const,
              name: o.title ?? o.const,
              ...(o.description ? { description: o.description } : {}),
            },
          ]
        : [],
    )
    return options.length ? options : null
  }
  if (plain?.length) return plain.map((value) => ({ id: value, name: value }))
  return null
}

function numberIf<K extends string>(
  key: K,
  value: number | null | undefined,
): Partial<Record<K, number>> {
  return typeof value === 'number' ? ({ [key]: value } as Record<K, number>) : {}
}

function defaultIf<T extends 'string' | 'number' | 'boolean'>(
  value: unknown,
  type: T,
): { default?: T extends 'string' ? string : T extends 'number' ? number : boolean } {
  return typeof value === type ? ({ default: value } as never) : {}
}

/** The answers the shell sent, checked against the fields they answer. Null when
 *  anything is off - a required field missing, a value outside its field's
 *  bounds, an option the field never offered - because the agent is owed either
 *  a complete, well-typed answer or nothing. Optional fields the user left blank
 *  are simply absent from the result. */
export function validateAnswers(fields: AcpAskField[], raw: unknown): AcpAskAnswers | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const given = raw as Record<string, unknown>
  const answers: AcpAskAnswers = {}
  for (const field of fields) {
    const custom =
      field.kind === 'select' || field.kind === 'multiselect' ? field.custom : undefined
    const typed = custom ? given[custom.key] : undefined
    if (typed !== undefined && typed !== null && typed !== '') {
      if (typeof typed !== 'string') return null
      answers[custom!.key] = typed
    }
    const value = given[field.key]
    if (value === undefined || value === null || value === '') {
      // A typed "Other" answers the question its box belongs to.
      if (field.optional || typed) continue
      return null
    }
    const checked = checkAnswer(field, value)
    if (checked === null) return null
    answers[field.key] = checked
  }
  return answers
}

function checkAnswer(field: AcpAskField, value: unknown): AcpAskAnswer | null {
  switch (field.kind) {
    case 'select':
      return typeof value === 'string' && field.options.some((o) => o.id === value) ? value : null
    case 'multiselect': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return null
      const ids = value as string[]
      if (new Set(ids).size !== ids.length) return null
      if (!ids.every((id) => field.options.some((o) => o.id === id))) return null
      if (field.min !== undefined && ids.length < field.min) return null
      if (field.max !== undefined && ids.length > field.max) return null
      return ids
    }
    case 'text': {
      if (typeof value !== 'string') return null
      if (field.min !== undefined && value.length < field.min) return null
      if (field.max !== undefined && value.length > field.max) return null
      if (field.pattern !== undefined && !safeMatch(field.pattern, value)) return null
      return value
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      if (field.integer && !Number.isInteger(value)) return null
      if (field.min !== undefined && value < field.min) return null
      if (field.max !== undefined && value > field.max) return null
      return value
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : null
  }
}

/** A pattern the agent wrote, so a bad one is its mistake rather than a crash
 *  here: an unparseable regex accepts everything. */
function safeMatch(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(value)
  } catch {
    return true
  }
}
