/** A name for each past conversation, so the resume picker lists something a
 *  person can recognise instead of a column of timestamps.
 *
 *  ACP has a slot for this - `session/list` returns `SessionInfo.title` - but
 *  neither agent implements it: both negotiate protocol v1 and neither advertises
 *  the `listSessions` capability (measured, 2026-09-15). Both do title their own
 *  conversations; both do it outside the protocol, in their own way, so this asks
 *  each in its own language and falls back on what the review itself recorded.
 *
 *  The fallback is not a corner case. Claude prunes old transcripts - a cleanup
 *  had already taken two of this project's conversations by the time this was
 *  written - so a chat routinely outlives the file its title would come from. */

import { existsSync, openSync, readSync, readdirSync, closeSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentProfileFor } from './agents.js'
import { askCodex } from './codex-app-server.js'
import type { ChatSummary } from './store.js'

/** How much of a transcript's tail to read looking for the title.
 *
 *  Claude re-emits `ai-title` as a conversation grows - dozens of times in a long
 *  one - and the last is the current one, so the end of the file is where to
 *  look. A transcript can be tens of megabytes; this keeps a title lookup off
 *  that scale for the common case, and the whole file is only read when the tail
 *  turns out to hold none. */
const TAIL_BYTES = 512 * 1024

/** Claude writes its generated title into the session transcript as its own
 *  record, and names the transcript after the session id - which is the same id
 *  ACP hands out, verified against sessions this daemon opened.
 *
 *  Found by looking rather than by rebuilding Claude's directory naming: the
 *  project folder is a flattened path whose escaping rules are not ours to
 *  reimplement, and a file named after a uuid needs no such guess. */
export function claudeTitle(sessionId: string, home = homedir()): string | undefined {
  const root = join(home, '.claude', 'projects')
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !existsSync(root)) return undefined
  let path: string | undefined
  try {
    for (const dir of readdirSync(root)) {
      const candidate = join(root, dir, `${sessionId}.jsonl`)
      if (existsSync(candidate)) {
        path = candidate
        break
      }
    }
  } catch {
    return undefined
  }
  if (!path) return undefined
  return lastAiTitle(path)
}

function lastAiTitle(path: string): string | undefined {
  const fromTail = scanForTitle(path, TAIL_BYTES)
  if (fromTail.title || fromTail.wholeFile) return fromTail.title
  return scanForTitle(path, Number.POSITIVE_INFINITY).title
}

function scanForTitle(path: string, want: number): { title?: string; wholeFile: boolean } {
  let fd: number | undefined
  try {
    const size = statSync(path).size
    const take = Math.min(size, want)
    const wholeFile = take === size
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(take)
    readSync(fd, buffer, 0, take, size - take)
    const lines = buffer.toString('utf8').split('\n')
    // The first line of a tail is whatever the read landed in the middle of.
    if (!wholeFile) lines.shift()
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!
      if (!line.includes('"ai-title"')) continue
      try {
        const record = JSON.parse(line) as { type?: string; aiTitle?: unknown }
        if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle) {
          return { title: record.aiTitle, wholeFile }
        }
      } catch {
        /* a line the read cut in half, or one this version cannot read */
      }
    }
    return { wholeFile }
  } catch {
    return { wholeFile: true }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Codex's names for the threads in this directory, by thread id - which is the
 *  ACP session id, verified by driving a real turn and finding it at the head of
 *  `thread/list`.
 *
 *  `name` only, never `preview`. A preview is the thread's first user message,
 *  and every conversation eztweak opens begins with the same preamble, so
 *  previews would title every row in the picker identically. A thread codex has
 *  not named is left for the fallback to name. */
export async function codexTitles(cwd: string, binary = 'codex'): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const result = (await askCodex(binary, 'thread/list', { cwd, limit: THREAD_PAGE })) as
    | { data?: { id?: unknown; name?: unknown }[] }
    | undefined
  for (const thread of result?.data ?? []) {
    if (typeof thread.id !== 'string') continue
    if (typeof thread.name !== 'string' || !thread.name.trim()) continue
    titles.set(thread.id, thread.name.trim())
  }
  return titles
}

/** Enough to cover any review's worth of conversations without paging. */
const THREAD_PAGE = 50

/** A name for each conversation, best source first.
 *
 *  The agent's own title when it has one: it read the whole conversation to write
 *  it, which nothing here can do. What the review recorded otherwise - the first
 *  thing the user said in that conversation, in their words. And nothing at all
 *  for a conversation that has neither, which the picker draws as its time.
 *
 *  One lookup per agent, not per chat: Claude answers off the filesystem and
 *  codex answers a single `thread/list`, so the whole picker costs one call. */
export async function chatTitles(
  chats: ChatSummary[],
  command: string,
  cwd: string,
): Promise<Map<string, string>> {
  const brand = agentProfileFor(command)?.brand
  const named =
    brand === 'openai' ? await codexTitles(cwd, agentProfileFor(command)?.binary) : new Map()
  const titles = new Map<string, string>()
  for (const chat of chats) {
    const fromAgent =
      chat.acpSessionId === undefined
        ? undefined
        : brand === 'claude'
          ? claudeTitle(chat.acpSessionId)
          : named.get(chat.acpSessionId)
    const title = fromAgent ?? chat.said
    if (title) titles.set(chat.id, oneLine(title))
  }
  return titles
}

/** A title is a line. A note can be a paragraph, and a comment can carry the
 *  newlines the user typed into the box. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Whether a conversation belongs in the picker.
 *
 *  A conversation nobody said anything in was never a conversation, and returning
 *  to one is indistinguishable from starting a fresh one - switching agent alone
 *  leaves one behind every time. Listing them buries what the picker exists to
 *  find under a column of identical timestamps.
 *
 *  Two survive whatever they hold. The one being viewed, because a picker that
 *  cannot show where you are is worse than a long one. And the newest, because it
 *  is the way back: leave it out while it is empty and stepping onto an older
 *  conversation is a one-way door. */
export function worthListing(
  chat: { title?: string; current: boolean },
  index: number,
  all: unknown[],
): boolean {
  return !!chat.title || chat.current || index === all.length - 1
}
