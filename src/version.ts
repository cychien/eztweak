import type { RequestHandler } from 'express'
import { PKG_NAME } from './constants.js'

export const VERSION_HEADER = `x-${PKG_NAME}-version`

/** Reopening with @latest restarts the daemon on the CLI's version, so one hint
 *  covers a stale CLI and a stale daemon alike. */
export function versionMismatchBody(
  cliVersion: string | undefined,
  daemonVersion: string,
): { error: string; hint: string } {
  return {
    error: cliVersion
      ? `this ${PKG_NAME} CLI is v${cliVersion} but the daemon is running v${daemonVersion}`
      : `this ${PKG_NAME} CLI predates the running daemon (v${daemonVersion})`,
    hint: `re-run as \`npx -y ${PKG_NAME}@latest <url>\` to bring both to the current version`,
  }
}

/** The wire protocol is only guaranteed between identical versions, so anything
 *  else — newer, older, or too old to send the header — is refused, not guessed at. */
export function versionGate(daemonVersion: string): RequestHandler {
  return (req, res, next) => {
    const cliVersion = req.get(VERSION_HEADER) || undefined
    if (cliVersion === daemonVersion) return next()
    res.status(409).json(versionMismatchBody(cliVersion, daemonVersion))
  }
}
