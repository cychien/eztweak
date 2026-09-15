/** One question to a codex app-server, and nothing else.
 *
 *  Codex keeps things eztweak wants - the account's rate limits, the names it has
 *  given past conversations - and exposes none of them over ACP: `codex-acp`
 *  receives them and drops them. They are all one JSON-RPC call away on its
 *  app-server, which costs no model turn, so this stands one up for a second and
 *  asks.
 *
 *  A server of its own rather than the one the running agent is talking to: there
 *  is no way in to that one, and a second one is cheap - measured under a second,
 *  end to end. */

import { spawn } from 'node:child_process'

const INITIALIZE = 1
const CALL = 2
const TIMEOUT_MS = 60_000
/** Codex wants a version in `clientInfo` and does nothing with it but echo it
 *  back inside a user-agent string. Not eztweak's version, and tying it to one
 *  would be a release chore that buys nothing. */
const CLIENT = { name: 'eztweak', version: '1' }

/** The result of `method`, or undefined if anything at all went wrong - codex is
 *  not installed, the call is not answered, the shape is not what was expected.
 *  Every caller here is decorating a UI with something it can do without. */
export function askCodex(
  binary: string,
  method: string,
  params: unknown,
): Promise<unknown | undefined> {
  const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
  return new Promise<unknown | undefined>((resolve) => {
    let answer: unknown
    let rest = ''
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        let message: { id?: unknown; result?: unknown }
        try {
          message = JSON.parse(line) as { id?: unknown; result?: unknown }
        } catch {
          continue
        }
        // Notifications arrive unasked between the two answers; only the ids this
        // asked for mean anything.
        if (message.id === INITIALIZE) send({ jsonrpc: '2.0', id: CALL, method, params })
        else if (message.id === CALL) {
          answer = message.result
          child.kill()
        }
      }
    })
    child.on('error', () => resolve(undefined))
    child.on('close', () => resolve(answer))
    send({ jsonrpc: '2.0', id: INITIALIZE, method: 'initialize', params: { clientInfo: CLIENT } })
  }).finally(() => clearTimeout(timer))
}
