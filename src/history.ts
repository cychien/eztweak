/** What earlier conversations asked for, so a fresh session after `/new` can
 *  still recognise a repeated correction. The words only; judging is the agent's. */

export interface Said {
  where?: string
  said: string
}

/** Past it the oldest go first: the pattern worth noticing is the one still repeating. */
export const HISTORY_BUDGET = 1200
const LINE_MAX = 120

function line(s: Said): string {
  const text = `- ${s.where ? `${s.where}: ` : ''}${s.said}`.replace(/\s+/g, ' ')
  return text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text
}

export function historyBrief(said: Said[]): string[] {
  if (!said.length) return []
  const lines: string[] = []
  let spent = 0
  for (const s of said) {
    const l = line(s)
    if (spent + l.length > HISTORY_BUDGET) break
    lines.push(l)
    spent += l.length + 1
  }
  if (!lines.length) return []
  return [
    'This review had earlier conversations that this session did not see. What the user asked for',
    'in them, newest first. All of it is already handled and none of it is being asked again: it',
    'is here so that a request which has come before can be recognised as one.',
    '',
    ...lines,
  ]
}
