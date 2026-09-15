/** The MCP server the agent sends variants back through.
 *
 *  eztweak is the ACP *client*, so the ordinary way to give an agent a tool -
 *  be an MCP server it connects to - is not open to it: a client has no way to
 *  hand tools down the ACP connection. ACP's own answer to that is the
 *  `mcp-over-acp` RFD (`mcp/connect`, `mcp/message`, a `type: "acp"` server),
 *  whose types ship in SDK 1.4.0 marked UNSTABLE, and which neither agent
 *  implements yet: probed 2026-09-15, `claude-agent-acp` 0.77.0 advertises
 *  `mcpCapabilities: { http, sse }` and `codex-acp` 1.11.0 answers `acp: false`.
 *  So the tool is served over HTTP, on the session's own Express app, and the
 *  url goes to the agent in `mcpServers`. When `acp` arrives this is the piece
 *  that moves; the tool and everything behind it do not.
 *
 *  ## One server per round
 *
 *  Each explore round gets its own url and its own token. Attribution is then
 *  the daemon's rather than the agent's: a call on round A's url cannot land in
 *  round B however confused the agent gets about which explore it is answering,
 *  and a call on a round that is over is refused with a reason instead of
 *  appearing in a strip the user has closed. It also means the tool takes no
 *  round id, which is one fewer thing for the agent to copy wrong.
 *
 *  The token is not decoration. Binding to loopback is not authentication -
 *  every process on this machine can reach the port - and this tool puts markup
 *  on the page the user is reviewing.
 *
 *  ## Nothing here waits for the user
 *
 *  `explore_variant` returns as soon as the variant is recorded. MCP clients
 *  time out a tool call, and the escape hatch for a long one - resetting the
 *  timeout on `notifications/progress` - is the *client's* to opt into, which
 *  several current ones do not. Anything that needs the user's answer goes
 *  through ACP elicitation, which is built to block; this channel is for the
 *  agent handing something over and carrying on. */

import { randomUUID } from 'node:crypto'
import type { Request, RequestHandler, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { MAX_VARIANT_HTML, checkVariant, variantProblemMessage } from './explore.js'
import { URL_PREFIX } from './constants.js'

/** One variant, as the agent sent it and the daemon accepted it. */
export interface IncomingVariant {
  name: string
  html: string
  note?: string
}

/** What the daemon does with a variant, and what it wants said back. Returning
 *  a string rather than void because the agent's next move depends on it: how
 *  many it has sent so far is what tells it when to stop. */
export type VariantSink = (variant: IncomingVariant) => string

interface Round {
  token: string
  sink: VariantSink
}

/** ACP's `McpServer`, narrowed to the HTTP arm this serves. Written out rather
 *  than imported so this module does not depend on the ACP SDK for a shape it
 *  only produces. */
export interface McpServerEntry {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

/** The rounds currently taking variants. Lives on the session, so a second
 *  session's rounds are unreachable from this one's urls. */
export class ExploreMcp {
  private readonly rounds = new Map<string, Round>()

  /** Open a round and return what the agent needs to reach it. The id is the
   *  caller's, so it can be the same id the round is known by everywhere else;
   *  the token is minted here, because nothing outside needs to choose it. */
  open(exploreId: string, sink: VariantSink): { token: string } {
    const token = randomUUID()
    this.rounds.set(exploreId, { token, sink })
    return { token }
  }

  /** The round is over - the turn ended, the user dismissed it, the session
   *  moved on. A late variant is then refused rather than shown. */
  close(exploreId: string): void {
    this.rounds.delete(exploreId)
  }

  closeAll(): void {
    this.rounds.clear()
  }

  /** What goes in `session/new` / `session/resume` as `mcpServers`: one entry
   *  per live round. `port` is the session's own, which is only known once it
   *  has bound and can change when a session is restored, so it is asked for at
   *  open time rather than held.
   *
   *  Named per round rather than one server for all of them, because the name is
   *  what the agent sees its tools grouped under and a round is what it is
   *  answering. */
  serverEntries(port: number): McpServerEntry[] {
    return [...this.rounds.keys()].map((exploreId) => ({
      type: 'http',
      name: `eztweak-explore-${exploreId}`,
      url: `http://127.0.0.1:${port}${URL_PREFIX}/mcp/${exploreId}`,
      headers: [{ name: 'authorization', value: `Bearer ${this.rounds.get(exploreId)!.token}` }],
    }))
  }

  /** The Express handler for `POST /mcp/:exploreId`.
   *
   *  A fresh server and transport per request, in the SDK's stateless mode. The
   *  alternative - one transport held for the life of the round - buys nothing
   *  here (there is no server-initiated traffic to keep a stream open for) and
   *  costs the request-id isolation that stateless mode gives for free. */
  handler(): RequestHandler {
    return async (req: Request, res: Response) => {
      const exploreId = String(req.params.exploreId ?? '')
      const round = this.rounds.get(exploreId)
      // The same answer for an unknown round and a wrong token: a caller that
      // has neither should not be able to learn which of the two it got right.
      if (!round || bearer(req) !== round.token) {
        res.status(404).json(rpcError(-32004, 'this explore round is not taking variants'))
        return
      }
      const server = new McpServer(
        { name: 'eztweak', version: '1' },
        { capabilities: { tools: {} } },
      )
      register(server, round.sink)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]! : null
}

/** A JSON-RPC error body, for the refusals that happen before the transport is
 *  involved and so cannot be expressed as one of its responses. */
function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', id: null, error: { code, message } }
}

/** The description is the only thing that tells the agent when to call this, so
 *  it is written for that job rather than as a summary of what the function
 *  does. The rules are here as well as in the validator because an agent that
 *  reads them first spends fewer turns being corrected. */
const DESCRIPTION = [
  'Hand one UI variant of the element being explored back to the user, who sees it swapped into the live page.',
  'Call it once per variant, as soon as that variant is ready, rather than saving them all for the end: each call puts a new option in front of the user immediately.',
  'The variant is a visual exploration, not an implementation. It is never written to a file and never wired to data.',
  '',
  'html must be:',
  '- exactly one root element, which may contain anything;',
  `- markup and CSS only - no <script>, <iframe>, <link>, inline on* handlers or javascript: urls, and at most ${MAX_VARIANT_HTML} bytes;`,
  '- self-contained in its styling: either inline styles, one <style> block inside the root, or class names that already appear in the markup you were given. A class the project has never rendered has no CSS behind it, so it will do nothing.',
].join('\n')

function register(server: McpServer, sink: VariantSink): void {
  server.registerTool(
    'explore_variant',
    {
      title: 'Show a UI variant',
      description: DESCRIPTION,
      inputSchema: {
        name: z
          .string()
          .describe(
            'A short label for this variant, in the user\'s language. Shown on its button - "緊湊版", "Outline".',
          ),
        html: z.string().describe('The variant markup: one root element.'),
        note: z
          .string()
          .optional()
          .describe('One line on what this variant changes, when the name does not say it.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ name, html, note }) => {
      const problem = checkVariant(name, html)
      if (problem) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: variantProblemMessage(problem) }],
        }
      }
      return {
        content: [{ type: 'text' as const, text: sink({ name, html, ...(note ? { note } : {}) }) }],
      }
    },
  )
}
