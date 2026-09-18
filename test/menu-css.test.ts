import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client', 'shell.css'),
  'utf8',
)

/** Every control in the shell that hangs a dropdown. Each marks itself
 *  `data-open`, and one shared rule is what turns that into a visible menu. */
const MENU_HOSTS = ['ez-seg-device', 'ez-shown', 'ez-config', 'ez-agent', 'ez-update-hint']

/** The rule is shared by every menu in the shell, which makes it the kind of
 *  thing that gets deleted by accident: removing one control's styles takes the
 *  whole rule if the removal matches on selector text. That happened - the chat
 *  picker was removed and every dropdown in the sidebar silently stopped opening,
 *  with the markup, the state and the aria attributes all still correct. Nothing
 *  else here can see that, so this looks. */
test('every control that opens a menu is in the rule that shows one', () => {
  const rule = /([^{}]*\[data-open\][^{}]*\.ez-menu[^{}]*)\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'no rule shows an open menu at all')
  const [, selectors, body] = rule
  assert.match(body!, /display:\s*(flex|block|grid)/, 'the rule does not show anything')
  for (const host of MENU_HOSTS) {
    assert.ok(
      selectors!.includes(`.${host}[data-open]`),
      `${host} opens a menu that nothing makes visible`,
    )
  }
})

// The chip colours are load-bearing in the same way: each says what kind of thing
// the chip stands for, and a missing one is a chip that looks like another kind.
test('each kind of chip keeps a colour of its own', () => {
  for (const [chip, token] of [
    ['.ez-chip {', '--attach'],
    ['.ez-chip-ref {', '--ref'],
    ['.ez-chip-skill {', '--skill-ink'],
  ] as const) {
    const at = css.indexOf(chip)
    assert.ok(at > -1, `${chip} is gone`)
    assert.ok(css.slice(at, at + 700).includes(token), `${chip} no longer uses ${token}`)
  }
})

// A file and a picked element are objects dropped into a sentence, and a badge is
// the right shape for those. A skill is something the sentence says, so it is ink
// and nothing else - which means undoing what `.ez-chip` gives it.
test('the skill is type, not a badge', () => {
  const at = css.indexOf('.ez-chip-skill {')
  const rule = css.slice(at, css.indexOf('}', at))
  assert.match(rule, /background:\s*none/, 'the skill has grown a fill')
  assert.match(rule, /padding:\s*0/, 'the skill has grown padding')
})
