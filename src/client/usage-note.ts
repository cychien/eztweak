/** The account's remaining allowance, as a line a person can act on.
 *
 *  What the agents report is a window length - 300 minutes, 10080 - and a share
 *  of it spent. "剩 91% / 5 小時" reads back as a duration, and a duration is the
 *  one thing a reviewer cannot use: it says how long the window is, not when the
 *  one they are in ends. The clock time is the answer to the question actually
 *  being asked, which is "when do I get it back".
 *
 *  So the reset time is the line and the window length is the tooltip - the
 *  other way round from where they started. When no reset time has arrived, the
 *  percentage stands on its own rather than falling back to the duration: a
 *  figure with nothing after it is honest about what is known. */

export interface UsageLimit {
  windowMinutes: number
  remaining: number
  resetsAt?: number
}

/** A window's length, as a person would say it. Tooltip-only now: it says which
 *  allowance the percentage is of, which is the one thing it is good for. */
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
 *  Same day is bare time, because that is every five-hour window and most of
 *  what anyone sees. The weekly window lands days out, where a bare time would
 *  read as tonight, so those carry the day - and only ever the day, never the
 *  year: a reset more than a year away is not a thing. */
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

/** The line and its tooltip. A reset already behind us is no reset: the figure
 *  it describes belongs to a window that has rolled over, and dating it into the
 *  past would be worse than saying nothing. */
export function usageNote(limit: UsageLimit, now = Date.now()): { text: string; title: string } {
  const percent = Math.round(limit.remaining * 100)
  const name = windowName(limit.windowMinutes)
  const live = limit.resetsAt !== undefined && limit.resetsAt * 1000 > now
  return {
    text: live ? `剩 ${percent}% 直到 ${clockTime(limit.resetsAt!, now)}` : `剩 ${percent}%`,
    title: live
      ? `${name}用量，${new Date(limit.resetsAt! * 1000).toLocaleString()} 重置`
      : `${name}用量`,
  }
}
