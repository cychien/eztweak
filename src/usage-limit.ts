/** The last usage figure an agent reported, kept across daemon restarts.
 *
 *  The figure only ever arrives pushed: a `usage_update` the agent chose to send,
 *  on a turn it chose to send it on. Nothing here can ask for it - there is no
 *  file to read, no local command to run, and no ACP request that returns it. So
 *  a daemon that forgot it on exit would show nothing at all until the review's
 *  next turn, which is most of the time a reviewer spends looking at the screen.
 *
 *  Remembering it is what makes the line permanent. It is written where the
 *  agents are written down rather than on the review, because the limit belongs
 *  to the account: every review on this machine is spending the same allowance,
 *  and the second one should not start blank.
 *
 *  Kept per agent command, since what an agent reports is its own vendor's
 *  figure, and dropped once the window it describes has rolled over - a spent
 *  percentage from a window that has since reset is not stale, it is wrong. */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AcpLimit } from './acp-agent.js'
import { agentProfileFor } from './agents.js'
import { askCodex } from './codex-app-server.js'
import { DATA_DIR } from './constants.js'

const FILE = join(DATA_DIR, 'usage-limits.json')

type Remembered = Record<string, AcpLimit>

function read(): Remembered {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Remembered
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** The last figure for this agent, if it still describes the window it names.
 *
 *  Both fields are checked, not just read: this file outlives the version that
 *  wrote it, and a figure from a shape that has since changed would otherwise
 *  reach the shell as a window with no length - "剩 58% / undefined". */
export function rememberedLimit(command: string, now = Date.now()): AcpLimit | undefined {
  const limit = read()[command]
  if (!limit || typeof limit.remaining !== 'number') return undefined
  if (typeof limit.windowMinutes !== 'number' || limit.windowMinutes <= 0) return undefined
  if (limit.resetsAt !== undefined && limit.resetsAt * 1000 <= now) return undefined
  return limit
}

export function rememberLimit(command: string, limit: AcpLimit): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(FILE, JSON.stringify({ ...read(), [command]: limit }, null, 2))
  } catch {
    /* best effort - losing this costs one blank line until the next turn */
  }
}

const FIVE_HOURS = 300
const ONE_WEEK = 7 * 24 * 60

/** One window, from a used fraction. Shared by both vendors' readers.
 *
 *  Clamped, because a used share runs past 1 on an account into its overage and a
 *  negative remainder is not a thing to show anyone. Rounded because `1 - 0.42` is
 *  `0.5800000000000001` in binary, and that lands in a file a person can open. */
function window(windowMinutes: number, used: number, resetsAt: unknown): AcpLimit {
  return {
    windowMinutes,
    remaining: Math.round(Math.min(1, Math.max(0, 1 - used)) * 1e4) / 1e4,
    ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? { resetsAt } : {}),
  }
}

/** Claude's rate-limit report, as the window that empties first.
 *
 *  Read defensively. Both callers hand this a vendor payload - one off a
 *  `usage_update._meta` bag, one off a line of the CLI's own JSON stream - so
 *  every field is checked rather than trusted, and anything unrecognisable is
 *  simply no report. */
export function limitFrom(info: unknown): AcpLimit | null {
  const windows = (info as { unifiedWindows?: Record<string, unknown> })?.unifiedWindows
  if (!windows || typeof windows !== 'object') return null
  for (const [name, minutes] of [
    ['five_hour', FIVE_HOURS],
    ['seven_day', ONE_WEEK],
  ] as const) {
    const found = windows[name] as { utilization?: unknown; resetsAt?: unknown } | undefined
    if (!found || typeof found.utilization !== 'number' || !Number.isFinite(found.utilization)) {
      continue
    }
    return window(minutes, found.utilization, found.resetsAt)
  }
  return null
}

/** Codex's rate-limit report, from `account/rateLimits/read` on its app-server.
 *
 *  Two unnamed windows rather than Claude's named pair, each carrying its own
 *  length, so the shortest one is picked rather than a fixed order assumed. */
export function codexLimitFrom(result: unknown): AcpLimit | null {
  const limits = (result as { rateLimits?: Record<string, unknown> })?.rateLimits
  if (!limits || typeof limits !== 'object') return null
  const found: AcpLimit[] = []
  for (const key of ['primary', 'secondary'] as const) {
    const slot = limits[key] as
      | { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown }
      | undefined
    if (!slot || typeof slot.usedPercent !== 'number' || !Number.isFinite(slot.usedPercent)) continue
    if (typeof slot.windowDurationMins !== 'number' || slot.windowDurationMins <= 0) continue
    found.push(window(slot.windowDurationMins, slot.usedPercent / 100, slot.resetsAt))
  }
  return found.sort((a, b) => a.windowMinutes - b.windowMinutes)[0] ?? null
}

/** Codex's own figure, asked for directly.
 *
 *  `codex-acp` receives `account/rateLimits/updated` and drops it - the numbers
 *  reach a user only inside the text of its `/status` command - so nothing about
 *  codex arrives over ACP. But the request behind `/status` is a plain JSON-RPC
 *  call to a local app-server, which costs no turn at all, so this asks for
 *  itself rather than going without. See `codex-app-server.ts`. */
async function readCodexLimit(binary: string): Promise<AcpLimit | undefined> {
  return codexLimitFrom(await askCodex(binary, 'account/rateLimits/read', null)) ?? undefined
}


/** Claude's figure, from the one local command that reports it.
 *
 *  `/usage` is a local slash command: in print mode it answers without reaching
 *  the model at all - `num_turns: 0`, `total_cost_usd: 0`, every token count zero,
 *  measured at ~1.5s. It is also the only way in. The CLI's rate-limit figure
 *  lives in the memory of a process that has made a request, the SDK control
 *  protocol has no request for it (`initialize`, `interrupt`, `set_model` and the
 *  rest - nothing about usage), `system init` does not carry it, no file on disk
 *  holds it, and `/status` is refused in print mode.
 *
 *  The cost of that is parsing rendered text, which is why this reads only the
 *  two percentages and leaves the reset times alone: a date rendered as "Sep 15
 *  at 4:30pm (Asia/Taipei)" is far more fragile to read than "52% used", and the
 *  reset time is a tooltip. It arrives properly typed on the push channel
 *  instead - see `limitFrom` - and is carried forward across a read that lacks
 *  it.
 *
 *  Wording drift costs a figure, not a crash: nothing matches, nothing is
 *  reported, and the push channel still fills the line in on the next turn. */
export function claudeLimitFromUsageText(text: string): AcpLimit | null {
  const found: AcpLimit[] = []
  for (const [pattern, minutes] of [
    [/^Current session:\s*([\d.]+)% used/m, FIVE_HOURS],
    // Anchored on "all models" so the per-model weekly lines below it - which
    // limit one model rather than the account - are not read as the account's.
    [/^Current week \(all models\):\s*([\d.]+)% used/m, ONE_WEEK],
  ] as const) {
    const used = Number(pattern.exec(text)?.[1])
    if (!Number.isFinite(used)) continue
    found.push(window(minutes, used / 100, undefined))
  }
  return found.sort((a, b) => a.windowMinutes - b.windowMinutes)[0] ?? null
}

async function readClaudeLimit(binary: string): Promise<AcpLimit | undefined> {
  const child = spawn(binary, ['-p', '/usage', '--output-format', 'json'], {
    // A scratch cwd: `/usage` loads the settings of wherever it is run, and this
    // has no business inheriting the review's.
    cwd: mkdtempSync(join(tmpdir(), 'eztweak-usage-')),
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), READ_TIMEOUT_MS)
  try {
    return await new Promise<AcpLimit | undefined>((resolve) => {
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => (out += chunk))
      child.on('error', () => resolve(undefined))
      child.on('close', () => {
        try {
          const answer = (JSON.parse(out) as { result?: unknown }).result
          resolve(typeof answer === 'string' ? (claudeLimitFromUsageText(answer) ?? undefined) : undefined)
        } catch {
          resolve(undefined)
        }
      })
    })
  } finally {
    clearTimeout(timer)
  }
}

/** When each agent was last asked, so a burst of short turns cannot turn a
 *  free read into a loop against someone's backend. The CLI throttles its own
 *  rate-limit reporting on the same interval. */
const lastRead = new Map<string, number>()
const READ_FLOOR_MS = 30_000

/** The agent's figure, asked for directly. Free on both agents, and typically a
 *  second or two; throttled per agent, and undefined when there is nothing to be
 *  had - an unknown ACP server, a CLI that is not installed, a read too soon
 *  after the last one. */
export async function readLimit(command: string, now = Date.now()): Promise<AcpLimit | undefined> {
  const profile = agentProfileFor(command)
  if (!profile?.brand) return undefined
  const last = lastRead.get(command)
  if (last !== undefined && now - last < READ_FLOOR_MS) return undefined
  lastRead.set(command, now)
  return profile.brand === 'openai'
    ? readCodexLimit(profile.binary)
    : readClaudeLimit(profile.binary)
}

const READ_TIMEOUT_MS = 60_000
