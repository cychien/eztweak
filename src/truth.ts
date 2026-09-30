/** The design harness (增強設計 in the shell). The shell, not the agent, asks to
 *  create missing files, because the answer decides whether the switch stays on. */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const PRODUCT_MD = 'PRODUCT.md'
export const DESIGN_MD = 'DESIGN.md'

export type TruthFile = 'product' | 'design'

/** How much of make.md a batch runs: high is all of it; the others leave steps out. */
export type DesignEffort = 'low' | 'medium' | 'high'
export const DESIGN_EFFORTS: readonly DesignEffort[] = ['low', 'medium', 'high']

function effortLine(effort: DesignEffort): string[] {
  return effort === 'high'
    ? []
    : [
        `Design effort for this turn: ${effort}. make.md's Effort section says what that leaves out.`,
      ]
}

const FILE_NAME: Record<TruthFile, string> = { product: PRODUCT_MD, design: DESIGN_MD }

export interface Truth {
  product: boolean
  design: boolean
  enabled: boolean
  /** The agent has had harness instructions earlier in this conversation. */
  seen: boolean
}

export function truthState(project: string, enabled: boolean, seen = false): Truth {
  return {
    product: existsSync(join(project, PRODUCT_MD)),
    design: existsSync(join(project, DESIGN_MD)),
    enabled,
    seen,
  }
}

/** The harness applies only to a turn whose prompt says so, in these words. */
export const HARNESS_ON = '增強設計 (the design harness) is on for this turn.'

/** The harness's own names mean nothing to the user. */
export const HARNESS_WORDS =
  'To the user this is 增強設計: say 設計規範 and 靈感, never harness, make.md, precedent or ' +
  'inspire, and never mention the review or its scores.'

/** The published package may predate `inspire`, so the daemon hands over the CLI it is itself. */
/** How the agent reaches the inspiration database this turn: through the daemon's own command, or
 *  not at all, when no one on this machine has logged in to it. */
export type Inspire = { cli: string } | 'unavailable'

function inspireLine(inspire: Inspire | undefined): string[] {
  if (!inspire) return []
  if (inspire === 'unavailable') {
    return [
      'The inspiration database cannot be searched on this machine (no `eztweak login`): skip',
      "make.md's search for precedent, and say nothing about it.",
    ]
  }
  return [
    `Run inspiration commands as \`${inspire.cli} inspire ...\` in place of \`npx -y eztweak@latest inspire ...\`,`,
    'and never another copy of eztweak: if it fails, that is the failure.',
  ]
}

/** Retracts what an agent read in an earlier turn; unexposed chats never see it. */
export const HARNESS_OFF =
  '增強設計 (the design harness) is off for this turn. Do not use it: no harness steps, no ' +
  'designing by `PRODUCT.md` or `DESIGN.md`, no review by its rules, and no edits to ' +
  '`PRODUCT.md`, `DESIGN.md` or `.eztweak/config.json` unless an item asks for one.'

export function missingTruth(truth: Truth): TruthFile[] {
  const missing: TruthFile[] = []
  if (!truth.product) missing.push('product')
  if (!truth.design) missing.push('design')
  return missing
}

export function harnessReady(truth: Truth): boolean {
  return truth.enabled && truth.product && truth.design
}

/** `skills/eztweak` sits beside both `dist` and `src`. */
export function skillDir(fromDir: string): string {
  return resolve(fromDir, '..', 'skills', 'eztweak')
}

export function skillReference(skill: string, name: string): string {
  return join(skill, 'reference', `${name}.md`)
}

const names = (files: TruthFile[]) => files.map((f) => `\`${FILE_NAME[f]}\``)

export function truthFilesZh(files: TruthFile[]): string {
  return files.map((f) => FILE_NAME[f]).join(' 與 ')
}

function whatIsMissing(missing: TruthFile[]): string {
  if (missing.length > 1) {
    return 'the two files that hold what the product is for and what it looks like'
  }
  return missing[0] === 'product'
    ? 'the file that holds what the product is for - who it serves, what it makes possible, what is fixed'
    : 'the one file that holds its design system as tokens and the reasons behind them'
}

/** Stack and components always run: each skips itself once the config has its output. */
function creationSteps(missing: TruthFile[], skill: string): string[] {
  const steps: string[] = []
  if (missing.includes('product')) steps.push('product')
  steps.push('stack')
  if (missing.includes('design')) steps.push('design')
  steps.push('components')
  return steps.map((step) => `read \`${skillReference(skill, step)}\` and follow it`)
}

/** Never a question: switching the harness on was the user's yes. */
export function truthBrief(
  truth: Truth,
  skill: string,
  inspire?: Inspire,
  effort: DesignEffort = 'high',
): string[] {
  if (!truth.enabled) return truth.seen ? [HARNESS_OFF] : []
  const missing = missingTruth(truth)
  if (!missing.length) {
    return [
      HARNESS_ON,
      HARNESS_WORDS,
      ...inspireLine(inspire),
      'Read `PRODUCT.md` and `DESIGN.md` at the project root before any visual change.',
      'Keep to `PRODUCT.md`; take `DESIGN.md` as a direction to start from, not a rule to obey.',
      'An ordinary change edits code only: leave the two files alone unless the user asks, or',
      "make.md's Learn step calls for it.",
      ...effortLine(effort),
    ]
  }
  const them = missing.length > 1 ? 'them' : 'it'
  return [
    HARNESS_ON,
    HARNESS_WORDS,
    ...inspireLine(inspire),
    `This project has no ${names(missing).join(' or ')} at its root:`,
    `${whatIsMissing(missing)}. Before you act on the batch below, create ${them}:`,
    `${creationSteps(missing, skill).join(', then ')}, then read`,
    `\`${skillReference(skill, 'make')}\` and handle the batch by it.`,
    ...effortLine(effort),
  ]
}

export function setupBrief(
  truth: Truth,
  skill: string,
  inspire?: Inspire,
  page?: string,
): string[] {
  const missing = missingTruth(truth)
  if (!missing.length) {
    return [
      HARNESS_ON,
      'The user switched on the design harness - 增強設計, as the review shell calls it to them.',
      '`PRODUCT.md` and `DESIGN.md` are both already at the project root,',
      'so there is nothing to set up: say so in one line.',
    ]
  }
  const them = missing.length > 1 ? 'them' : 'it'
  return [
    HARNESS_ON,
    HARNESS_WORDS,
    ...inspireLine(inspire),
    'The user switched on the design harness - 增強設計, as the review shell calls it to them -',
    `and agreed to create what it needs. This project has no ${names(missing).join(' or ')} at its`,
    `root: ${whatIsMissing(missing)}.`,
    ...(page ? [`The page is running at ${page}.`] : []),
    '',
    `Create ${them} now: ${creationSteps(missing, skill).join(', then ')}.`,
    '',
    'No feedback batch comes with this turn and no UI is to change. When the steps are done, reply',
    'in two or three lines with what the files now say and what you asked rather than found.',
  ]
}

export function truthExploreRule(truth: Truth, skill: string, inspire?: Inspire): string[] {
  if (!harnessReady(truth)) {
    return [
      "- You may read the file in the element's anchor for context; nothing else needs reading.",
      ...(truth.seen && !truth.enabled ? [`- ${HARNESS_OFF}`] : []),
    ]
  }
  return [
    `- ${HARNESS_ON} ${HARNESS_WORDS}`,
    ...inspireLine(inspire).map((l, i) => (i ? `  ${l}` : `- ${l}`)),
    "- You may read the file in the element's anchor for context, and `PRODUCT.md` and `DESIGN.md`",
    '  at the project root. Keep every variant to `PRODUCT.md`. `DESIGN.md` is a direction, not a',
    '  fence: variants may range past it.',
    `- Read \`${skillReference(skill, 'make')}\` and make the variants by it.`,
  ]
}
