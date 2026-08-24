import { homedir } from 'node:os'
import { join } from 'node:path'

/** Rename checklist: package.json name+bin, this file, skills/<name>/, README. */
export const PKG_NAME = 'eztweak'
export const URL_PREFIX = '/__eztweak'
const ENV_PREFIX = PKG_NAME.toUpperCase()
export const DATA_DIR = process.env[`${ENV_PREFIX}_DATA_DIR`] ?? join(homedir(), `.${PKG_NAME}`)
export const SESSIONS_DIR = join(DATA_DIR, 'sessions')
export const REGISTRY_FILE = join(DATA_DIR, 'daemon.json')
export const DAEMON_LOG = join(DATA_DIR, 'daemon.log')

export const DEFAULT_CONTROL_PORT = 4400
const CONTROL_PORT_ENV = `${ENV_PREFIX}_CONTROL_PORT`
/** A second daemon must never share the control range with the first:
 *  `daemonMain` adopts any live daemon it finds inside its own range, so a
 *  separate DATA_DIR alone does not isolate it. Falling back to the default on a
 *  bad value would silently undo that isolation, so an unusable value is fatal
 *  rather than ignored. */
export function resolveControlPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CONTROL_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1024 || port > 65_525) {
    throw new Error(
      `${CONTROL_PORT_ENV} must be an integer between 1024 and 65525, got ${JSON.stringify(raw)}`,
    )
  }
  return port
}

/** Ten consecutive ports starting at the resolved start. Resolved on call, not
 *  at import: this module is a dependency of the published `eztweak/vite`
 *  entry point, which must never read - let alone fail on - this variable. */
export function controlPortRange(): { start: number; end: number } {
  const start = resolveControlPort(process.env[CONTROL_PORT_ENV])
  return { start, end: start + 9 }
}

/** Surfaces a bad value at the command the user just ran, instead of leaving it
 *  to a detached daemon whose message only reaches the log file. */
export function assertControlPortEnv(): void {
  controlPortRange()
}

/** How stale a session record on disk may be and still be restored when the
 *  daemon starts. Nothing marks a session `ended` when the daemon goes away, so
 *  without an upper bound every start would resurrect a proxy for every session
 *  ever opened, however long dead its dev server is. */
const SESSION_RESTORE_MAX_AGE_DAYS = 7
export const SESSION_RESTORE_MAX_AGE_MS = SESSION_RESTORE_MAX_AGE_DAYS * 24 * 60 * 60_000

export const POLL_TIMEOUT_MS = 50_000
/** Consecutive connection failures a `poll` rides out before giving up. Covers a
 *  daemon restart, which the CLI survives by re-resolving the session port. */
export const POLL_RETRIES = 5
export const IDLE_STOP_MS = 30 * 60_000
export const SOURCE_ATTR = 'data-ez-source'
