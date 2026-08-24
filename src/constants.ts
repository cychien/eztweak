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
/** Ten consecutive ports starting here. A second daemon must never share the
 *  range with the first: `daemonMain` adopts any live daemon it finds inside
 *  its own range, so a separate DATA_DIR alone does not isolate it. */
export function resolveControlPort(raw: string | undefined): number {
  const port = Number(raw)
  const usable = Number.isInteger(port) && port >= 1024 && port <= 65_525
  return usable ? port : DEFAULT_CONTROL_PORT
}
const controlStart = resolveControlPort(process.env[`${ENV_PREFIX}_CONTROL_PORT`])
export const CONTROL_PORT_RANGE = { start: controlStart, end: controlStart + 9 }

export const POLL_TIMEOUT_MS = 50_000
/** Consecutive connection failures a `poll` rides out before giving up. Covers a
 *  daemon restart, which the CLI survives by re-resolving the session port. */
export const POLL_RETRIES = 5
export const IDLE_STOP_MS = 30 * 60_000
export const SOURCE_ATTR = 'data-ez-source'
