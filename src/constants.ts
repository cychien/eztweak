import { homedir } from 'node:os'
import { join } from 'node:path'

/** Rename checklist: package.json name+bin, this file, skills/<name>/, README. */
export const PKG_NAME = 'eztweak'
export const URL_PREFIX = '/__eztweak'
export const DATA_DIR =
  process.env[`${PKG_NAME.toUpperCase()}_DATA_DIR`] ?? join(homedir(), `.${PKG_NAME}`)
export const SESSIONS_DIR = join(DATA_DIR, 'sessions')
export const REGISTRY_FILE = join(DATA_DIR, 'daemon.json')
export const DAEMON_LOG = join(DATA_DIR, 'daemon.log')
export const CONTROL_PORT_RANGE = { start: 4400, end: 4409 }
export const POLL_TIMEOUT_MS = 50_000
/** Consecutive connection failures a `poll` rides out before giving up. Covers a
 *  daemon restart, which the CLI survives by re-resolving the session port. */
export const POLL_RETRIES = 5
export const IDLE_STOP_MS = 30 * 60_000
export const SOURCE_ATTR = 'data-ez-source'
