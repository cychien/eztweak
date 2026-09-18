/** Whether the project under review has a `DESIGN.md`, and what the agent is
 *  told about it.
 *
 *  DESIGN.md (github.com/google-labs-code/design.md) is a design system as one
 *  file at the project root: YAML frontmatter for the tokens, prose for the
 *  reasons behind them. An agent that holds one changes a system rather than a
 *  button. An agent in a project without one is offered the chance to write it,
 *  once per conversation, before it acts on the first batch.
 *
 *  The daemon does the looking and the agent does the asking. One `existsSync`
 *  cannot be forgotten and costs no turn, and a project that has the file gets
 *  a prompt with nothing about asking in it. The question itself goes through
 *  the agent's own question tool, which already lands in the shell's ask card;
 *  and the conversation, not the daemon, remembers the answer - which is why
 *  the offer is made once per chat and then left alone. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const DESIGN_MD = 'DESIGN.md'

/** `present`: the file is there. `missing`: it is not, and this conversation has
 *  not been offered one. `quiet`: it is not, and it has - the conversation holds
 *  the answer, so nothing more is said. */
export type DesignMdState = 'present' | 'missing' | 'quiet'

export function designMdState(
  project: string,
  chat: { designMdOfferedAt?: number },
): DesignMdState {
  if (existsSync(join(project, DESIGN_MD))) return 'present'
  return chat.designMdOfferedAt ? 'quiet' : 'missing'
}

/** The dot-free alias: `npx @google/design.md` trips over the dot in the package
 *  name on some npm versions, and the README says to run this instead. */
const CLI = 'npx -y -p @google/design.md designmd'

/** What a review turn is told, before the batch. Nothing, once the offer has
 *  been made and the file still is not there. */
export function designMdBrief(state: DesignMdState): string[] {
  switch (state) {
    case 'present':
      return [
        "`DESIGN.md` at the project root is the design system's source of truth. Read it before any",
        'visual change and keep to it, the prose as much as the tokens. When a change needs something',
        'it does not cover, extend `DESIGN.md` as well as the code.',
      ]
    case 'missing':
      return [
        'This project has no `DESIGN.md` at its root: the one file that holds its design system as',
        'tokens and the reasons behind them (the format: https://github.com/google-labs-code/design.md).',
        'Before you act on the batch below, ask the user this, word for word:',
        '',
        '  這個專案還沒有 DESIGN.md。要先建立一份，作為設計統一標準嗎？',
        '',
        'with two options, in this order: 「建立 DESIGN.md（推薦）」 and 「這次先不要」. Ask before you',
        'look at anything. Use your question tool if you have one; otherwise ask in your reply and end',
        'the turn - the answer arrives as the next message.',
        '',
        `If they choose to create it: read the format with \`${CLI} spec\` - it says what the document`,
        'has to contain, so none of that is repeated here. What the format cannot know is that the',
        'page is running, at the `url` in the batch below.',
        '',
        'Open it, and read it the way a design-token extractor does: computed styles off the rendered',
        'DOM, counted. Frequency is what the stylesheet cannot tell you - the colour on three hundred',
        'elements is the surface, the one on two is the accent, a rule that matches nothing is not in',
        'the system at all, and the sizes the page keeps landing on are the scale. Then look at the',
        'whole for what no measurement gives you: what dominates, how much air there is, what the page',
        'does without.',
        '',
        "For the intent behind it, read the project's own deliberate sources: a design or style",
        "guideline document, a Tailwind config or `@theme` block, shadcn's `components.json` and the",
        'CSS variables it declares, `:root` custom properties, a `tokens.json`.',
        '',
        'Declare a section the product genuinely has no answer for in `omitted` rather than inventing',
        `one. Run \`${CLI} lint DESIGN.md\` and fix what it reports. Tell the user in a short paragraph`,
        'what the document captured and where each part came from. Then handle the batch, to the',
        'document you just wrote.',
        '',
        'If they decline: handle the batch as usual, and do not raise it again.',
      ]
    case 'quiet':
      return []
  }
}

/** The reading rule of an explore branch. A branch may not edit anything, so it
 *  is never offered the file; when the file exists it binds the variants too. */
export function designMdExploreRule(state: DesignMdState): string[] {
  return state === 'present'
    ? [
        "- You may read the file in the element's anchor for context, and `DESIGN.md` at the project",
        "  root - the design system's source of truth. Keep every variant within its tokens and prose;",
        '  one that steps outside them is proposing a change to the system, so say so in its note.',
        '  Nothing else needs reading.',
      ]
    : ["- You may read the file in the element's anchor for context; nothing else needs reading."]
}
