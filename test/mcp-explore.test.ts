import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'node:http'
import express from 'express'
import {
  type IncomingVariant,
  ExploreMcp,
  MCP_PATH,
  MCP_ROUTE,
  isExploreTool,
} from '../src/mcp-explore.js'

/** One JSON-RPC round trip, as an MCP client makes it. */
async function rpc(
  url: string,
  token: string | null,
  method: string,
  params: unknown,
  id: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** An initialized MCP connection to one round, and a way to call its tool. */
async function client(port: number, exploreId: string, token: string) {
  const url = `http://127.0.0.1:${port}${MCP_PATH}/${exploreId}`
  let id = 0
  const init = await rpc(
    url,
    token,
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
    ++id,
  )
  return {
    url,
    init,
    call: (args: unknown) =>
      rpc(url, token, 'tools/call', { name: 'explore_variant', arguments: args }, ++id),
    list: () => rpc(url, token, 'tools/list', {}, ++id),
    raw: (t: string | null, method: string, params: unknown) => rpc(url, t, method, params, ++id),
  }
}

/** The MCP server on a throwaway app, reached the way the agent reaches it. */
function harness() {
  const mcp = new ExploreMcp()
  const got: IncomingVariant[] = []
  // Mounted the way the daemon mounts it: an api router under the url prefix,
  // with the route relative to it. Building the path any other way here would
  // let the two drift and the test still pass.
  const api = express.Router()
  api.use(express.json())
  api.post(MCP_ROUTE, mcp.handler())
  const app = express()
  app.use(MCP_PATH.slice(0, -'/mcp'.length), api)
  const server = createServer(app)
  const ready = new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    }),
  )
  after(() => server.close())
  return { mcp, got, ready }
}

const text = (body: Record<string, unknown>): string => {
  const result = body.result as { content?: { text?: string }[] } | undefined
  return result?.content?.[0]?.text ?? ''
}
const isError = (body: Record<string, unknown>): boolean =>
  (body.result as { isError?: boolean } | undefined)?.isError === true

test('a variant sent to a live round reaches its sink, and the answer is the sink to the agent', async () => {
  const { mcp, got, ready } = harness()
  const port = await ready
  const { token } = mcp.open('r1', (v) => {
    got.push(v)
    return `got ${got.length}`
  })
  const c = await client(port, 'r1', token)
  assert.equal((c.init.body.result as { serverInfo: { name: string } }).serverInfo.name, 'eztweak')

  const first = await c.call({ name: '緊湊版', html: '<div>a</div>', note: 'tighter' })
  assert.equal(isError(first.body), false)
  assert.equal(text(first.body), 'got 1')
  const second = await c.call({ name: 'Outline', html: '<div>b</div>' })
  assert.equal(text(second.body), 'got 2')
  assert.deepEqual(got, [
    { name: '緊湊版', html: '<div>a</div>', note: 'tighter' },
    { name: 'Outline', html: '<div>b</div>' },
  ])
})

test('the tool is the only one, and its description says the rules', async () => {
  const { mcp, ready } = harness()
  const port = await ready
  const { token } = mcp.open('r1', () => 'ok')
  const listed = (await (await client(port, 'r1', token)).list()).body.result as {
    tools: { name: string; description: string; inputSchema: { required?: string[] } }[]
  }
  assert.deepEqual(
    listed.tools.map((t) => t.name),
    ['explore_variant'],
  )
  assert.match(listed.tools[0]!.description, /exactly one root element/)
  assert.deepEqual(listed.tools[0]!.inputSchema.required?.sort(), ['html', 'name'])
})

test('a variant the page must not be shown comes back as a tool error, and nothing is recorded', async () => {
  const { mcp, got, ready } = harness()
  const port = await ready
  const { token } = mcp.open('r1', (v) => {
    got.push(v)
    return 'ok'
  })
  const c = await client(port, 'r1', token)
  const refused = await c.call({ name: 'x', html: '<div>a</div><div>b</div>' })
  assert.equal(isError(refused.body), true)
  assert.match(text(refused.body), /2 top-level elements/)
  const scripted = await c.call({ name: 'x', html: '<div><script>go()</script></div>' })
  assert.equal(isError(scripted.body), true)
  assert.deepEqual(got, [])
})

test('a round that is over, an unknown round, and a wrong token are all the same refusal', async () => {
  const { mcp, ready } = harness()
  const port = await ready
  const { token } = mcp.open('r1', () => 'ok')
  const c = await client(port, 'r1', token)
  assert.equal((await c.call({ name: 'x', html: '<div>a</div>' })).status, 200)

  const wrongToken = await c.raw('nope', 'tools/call', {
    name: 'explore_variant',
    arguments: { name: 'x', html: '<div>a</div>' },
  })
  assert.equal(wrongToken.status, 404)
  const noToken = await c.raw(null, 'tools/list', {})
  assert.equal(noToken.status, 404)

  const unknown = await client(port, 'r2', token)
  assert.equal(unknown.init.status, 404)

  mcp.close('r1')
  const late = await c.call({ name: 'x', html: '<div>a</div>' })
  assert.equal(late.status, 404)
  assert.match(JSON.stringify(late.body), /not taking variants/)
})

test('each live round is its own server entry, named and tokened apart', async () => {
  const { mcp } = harness()
  const a = mcp.open('r1', () => 'ok')
  const b = mcp.open('r2', () => 'ok')
  assert.notEqual(a.token, b.token)
  const entries = mcp.serverEntries(4321)
  assert.deepEqual(
    entries.map((e) => [e.type, e.name, e.url]),
    [
      ['http', 'eztweak-explore-r1', `http://127.0.0.1:4321${MCP_PATH}/r1`],
      ['http', 'eztweak-explore-r2', `http://127.0.0.1:4321${MCP_PATH}/r2`],
    ],
  )
  assert.deepEqual(entries[0]!.headers, [{ name: 'authorization', value: `Bearer ${a.token}` }])
  mcp.closeAll()
  assert.deepEqual(mcp.serverEntries(4321), [])
})

test('the tool is recognised by its full name on one of our servers, and by nothing looser', () => {
  const mcp = new ExploreMcp()
  mcp.open('7d503b164853', () => 'ok')
  const [entry] = mcp.serverEntries(4321)
  // The name an agent uses when it asks permission is built from the server
  // name it was handed, so the recogniser is tested against that, not a literal.
  assert.equal(isExploreTool(`mcp__${entry!.name}__explore_variant`), true)
  assert.equal(isExploreTool('Bash'), false)
  assert.equal(isExploreTool('explore_variant'), false)
  assert.equal(isExploreTool(`mcp__${entry!.name}__something_else`), false)
  assert.equal(isExploreTool('mcp__other-server__explore_variant'), false)
  mcp.closeAll()
})
