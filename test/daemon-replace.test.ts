import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { after, test } from 'node:test'
import { DaemonWorld, waitFor } from './helpers/daemon.js'

const world = new DaemonWorld(4520)
after(() => world.dispose())

/** A dev server that answers a websocket upgrade and then holds the socket, the
 *  way Vite's HMR channel does for as long as the page is open. */
function wsTarget(): Promise<{ port: number; close: () => void }> {
  const server = createServer((_req, res) => res.end('<html></html>'))
  server.on('upgrade', (_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    )
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ port, close: () => server.close() })
    }),
  )
}

/** A websocket client, upgraded through the session port and left open. */
function holdWs(sessionPort: number): Promise<{ closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(sessionPort, '127.0.0.1', () => {
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${sessionPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    const closed = new Promise<void>((done) => socket.once('close', () => done()))
    socket.once('data', (chunk) => {
      if (!chunk.toString().startsWith('HTTP/1.1 101')) reject(new Error(chunk.toString()))
      else resolve({ closed })
    })
    socket.once('error', reject)
  })
}

// A second project on the same origin replaces the first's session, and the
// replacement waited on the old server closing - which waits on every open
// connection. A shell tab keeps the app's HMR websocket open through the proxy
// for as long as it is on screen, so the CLI hung with no answer, forever.
test('replacing a session does not wait on the websockets its shell tab holds', async () => {
  const target = await wsTarget()
  after(() => target.close())
  world.spawnDaemon()
  const { port: control } = await world.liveDaemon()
  const url = `http://localhost:${target.port}/`

  const first = await world.openSession(control, { url, project: `${world.dataDir}/one` })
  const ws = await holdWs(first.port)

  const started = Date.now()
  const second = await world.openSession(control, { url, project: `${world.dataDir}/two` })
  assert.ok(Date.now() - started < 5000, 'the replacement answered')
  assert.notEqual(second.port, first.port)

  await waitFor(
    async () => (await ws.closed.then(() => true)) || null,
    'the held websocket to be closed',
    5000,
  )
})
