/** The account's remaining allowance, as a line a person can act on and a card
 *  that shows the rest.
 *
 *  What the agents report is a set of windows - a five-hourly one, a weekly one,
 *  and on Claude a weekly one per model - each with a share spent and a moment it
 *  rolls over. The row above the composer has space for exactly one figure, so
 *  the line takes the window a reviewer runs into first and the card behind it
 *  carries everything else. Both vendors' own commands do the same thing: Claude's
 *  `/usage` and codex's `/status` each print every window, one per line, with the
 *  reset time beside it.
 *
 *  "剩 91% / 5 小時" answered a question nobody asked. The window length is fixed
 *  and knowable; what a reviewer wants is the clock time their allowance comes
 *  back, which a duration never gave them. So the line is the clock time, and the
 *  window length is what labels the rows in the card. */

export interface UsageWindow {
  windowMinutes: number
  remaining: number
  resetsAt?: number
  /** Whose allowance, when it is not the whole account's. */
  model?: string
}

export interface Usage {
  windows: UsageWindow[]
  plan?: string
}

/** A window's length, as a person would say it. */
export function windowName(minutes: number): string {
  if (minutes === 7 * 24 * 60) return '一週'
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天`
  if (minutes % 60 === 0) return `${minutes / 60} 小時`
  return `${minutes} 分鐘`
}

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
}

/** A moment, said as briefly as it can be said without being ambiguous.
 *
 *  Same day is bare time, because that is every five-hour window and most of what
 *  anyone sees. The weekly window lands days out, where a bare time would read as
 *  tonight, so those carry the day - and only ever the day, never the year: a
 *  reset more than a year away is not a thing. */
function clockTime(resetsAt: number, now: number): string {
  const when = new Date(resetsAt * 1000)
  const time = when.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const days = Math.round((startOfDay(when) - startOfDay(new Date(now))) / DAY_MS)
  if (days <= 0) return time
  if (days === 1) return `明天 ${time}`
  return `${when.getMonth() + 1}/${when.getDate()} ${time}`
}

/** A reset already behind us is no reset: the figure it describes belongs to a
 *  window that has rolled over, and dating it into the past would be worse than
 *  saying nothing about when. */
function resetTime(window: UsageWindow, now: number): string {
  return window.resetsAt !== undefined && window.resetsAt * 1000 > now
    ? clockTime(window.resetsAt, now)
    : ''
}

/** The window the line speaks for: the shortest of the account's own.
 *
 *  Shortest, because that is the one a reviewer runs into this afternoon - the
 *  weekly figure is the one they plan around, not the one that stops them mid
 *  review. The account's own, because a single model's weekly share describes an
 *  allowance the reviewer can walk away from by switching models. */
export function tightestWindow(usage: Usage | undefined): UsageWindow | undefined {
  const windows = usage?.windows ?? []
  const account = windows.filter((w) => !w.model)
  return (account.length ? account : windows).sort((a, b) => a.windowMinutes - b.windowMinutes)[0]
}

/** The line above the composer. No tooltip on it: the card is the tooltip, and a
 *  native one would open over it. */
export function usageNote(usage: Usage | undefined, now = Date.now()): string {
  const window = tightestWindow(usage)
  if (!window) return ''
  const percent = Math.round(window.remaining * 100)
  const when = resetTime(window, now)
  return when ? `剩 ${percent}% 直到 ${when}` : `剩 ${percent}%`
}

export interface UsageRow {
  /** The window's length, and whose allowance it is when that is worth saying. */
  label: string
  /** What is left, 0-100. The bar reads the same number as the words beside it:
   *  a bar that filled up as the allowance drained would contradict them. */
  percent: number
  /** "04:20 重置", or nothing when the agent never dated it. */
  when: string
  /** Little enough left that the row should say so on its own. */
  low: boolean
}

const LOW = 0.15

/** Every window the agent reported, in the order it is worth reading: the
 *  account's allowances first, then whatever a single model is separately capped
 *  at. */
export function usageRows(usage: Usage | undefined, now = Date.now()): UsageRow[] {
  return (usage?.windows ?? []).map((window) => {
    const when = resetTime(window, now)
    return {
      label: window.model
        ? `${windowName(window.windowMinutes)} · ${window.model}`
        : windowName(window.windowMinutes),
      percent: Math.round(window.remaining * 100),
      when: when ? `${when} 重置` : '',
      low: window.remaining < LOW,
    }
  })
}

/** The plan, as its vendor spells it out loud. Codex reports `plus`; nobody
 *  wants to read that in lower case beside their own account. */
export function planName(plan: string | undefined): string {
  if (!plan) return ''
  return plan.charAt(0).toUpperCase() + plan.slice(1)
}
