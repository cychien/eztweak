/** Naming for the agent's session config options, shared by the daemon (which
 *  writes the switch into the thread) and the shell (which draws the control).
 *  One home, because both are answering the same question - what is this option
 *  called, and what is this value called - and two answers that drift would have
 *  the thread reporting a switch to something the menu never offered. */

import type { SessionConfigOption } from '@agentclientprotocol/sdk'

/** What the user picked. The protocol's own two value shapes: a select's value
 *  id, or a boolean option's state. */
export type AcpConfigValue = string | boolean

/** The option's name in the user's words where we have one, the agent's
 *  otherwise.
 *
 *  Keyed on `category` rather than on `id`, because the category is the spec's
 *  own way of saying what a selector *is*: an agent free to call its model
 *  option anything still tags it `model`. Unknown categories fall through to the
 *  agent's `name` by design - the spec requires clients to handle categories
 *  they have never heard of, and an option we cannot name is still one the user
 *  can be shown and can set. */
export function configLabel(option: SessionConfigOption): string {
  switch (option.category) {
    case 'model':
      return '模型'
    case 'thought_level':
      return '思考強度'
    case 'mode':
      return '模式'
    default:
      return option.name
  }
}

/** Every value a select offers, flat. The protocol allows either a plain list or
 *  a list of named groups, and nothing here cares which. */
export function configValues(option: SessionConfigOption) {
  if (option.type !== 'select') return []
  return option.options.flatMap((o) => ('options' in o ? o.options : [o]))
}

/** The display name of a select's current value, or the raw id when the value is
 *  not one the option offers. That happens: an agent reports the model a session
 *  was resumed onto even when the picker no longer lists it. */
export function configValueName(option: SessionConfigOption, value: AcpConfigValue): string {
  if (typeof value === 'boolean') return value ? '開啟' : '關閉'
  return configValues(option).find((o) => o.value === value)?.name ?? value
}

/** A value's name trimmed to what identifies it, for a control that has one line
 *  to say it in. The agent's names carry a parenthesised qualifier - "Opus (1M
 *  context)", "Default (recommended)" - and four of those side by side do not
 *  fit the sidebar. The qualifier is not lost: it is what the control's tooltip
 *  is for. */
export function shortConfigValueName(name: string): string {
  const paren = name.indexOf(' (')
  return paren > 0 ? name.slice(0, paren) : name
}
