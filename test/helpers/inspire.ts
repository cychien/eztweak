import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { CLI_SRC } from './daemon.js'

/** A one-pixel PNG, so no fixture file is needed. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export interface FakeImage {
  kind: string
  viewport: string | null
  position: number
}

export interface FakeEntry {
  id: string
  slug: string
  source_name: string
  source_url: string | null
  why: string
  wrong_when: string | null
  tags: string[]
  description?: string
  elements?: string[]
  wording?: string[]
  actions?: string[]
  layout?: string
  layout_metrics?: Record<string, unknown>
  fidelity?: string
  images: FakeImage[]
  /** Markup per source kind, served back from `/v1/sources/`. */
  sources?: Record<string, string>
}

export const LINEAR_ENTRY: FakeEntry = {
  id: 'ent_7f3a',
  slug: 'linear-command-menu',
  source_name: 'Linear',
  source_url: 'https://linear.app',
  why: 'Every action is one keystroke away, so the chrome around the work stays empty.',
  wrong_when: 'The product is used by people who never learn a shortcut.',
  tags: ['command-menu', 'dialog', 'dense'],
  description: 'A command menu over the whole product, opened from anywhere by a keystroke.',
  elements: ['search_input', 'result_list', 'shortcut_hint'],
  wording: ['Type a command or search', 'Jump to', 'No results'],
  actions: ['run a command', 'jump to an issue', 'dismiss with escape'],
  layout: 'The input sits above the results; the shortcut hints run down the right edge.',
  layout_metrics: { columns: 1, container_width: 640 },
  fidelity: 'dom',
  images: [
    { kind: 'screenshot', viewport: 'desktop', position: 0 },
    { kind: 'mockup', viewport: null, position: 0 },
  ],
  sources: { html: '<div role="dialog"><input placeholder="Type a command or search"></div>' },
}

export const STRIPE_ENTRY: FakeEntry = {
  id: 'ent_b19c',
  slug: 'stripe-checkout',
  source_name: 'Stripe',
  source_url: null,
  why: 'The order summary stays on screen while the form is filled, so nothing is taken on trust.',
  wrong_when: 'There is a single product at a single price.',
  tags: ['checkout'],
  description: 'A two-column checkout with the order summary beside the payment form.',
  elements: ['order_summary', 'payment_form', 'pay_button'],
  actions: ['apply a promotion code', 'pay'],
  layout: 'Summary on the left, form on the right, collapsing to one column on mobile.',
  fidelity: 'image',
  images: [{ kind: 'screenshot', viewport: 'desktop', position: 0 }],
}

/** `mode` drives the CLI's failure paths: refused token, no results, service down. */
export class FakeInspire {
  mode: 'ok' | '401' | 'empty' | 'down' = 'ok'
  entries: FakeEntry[] = [LINEAR_ENTRY, STRIPE_ENTRY]
  readonly searches: { token: string | undefined; body: Record<string, unknown> }[] = []
  readonly imageRequests: string[] = []
  readonly sourceRequests: string[] = []
  private server: Server | null = null
  url = ''

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.route(req, res))
    server.on('connection', (socket) => {
      if (this.mode === 'down') socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (path === '/v1/search' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        unknown
      >
      const bearer = req.headers.authorization?.replace(/^Bearer /, '')
      this.searches.push({ token: bearer, body })
      if (this.mode === '401' || !bearer) return this.send(res, 401, { error: 'unknown token' })
      if (this.mode === 'empty') {
        return this.send(res, 200, { results: [] })
      }
      const scored = typeof body.query === 'string' && body.query.trim() !== ''
      return this.send(res, 200, {
        results: this.entries.map((entry, rank) => ({
          ...entry,
          ...(scored ? { score: Number((0.9 - rank * 0.1).toFixed(2)) } : {}),
          images: entry.images.map((image, index) => ({
            ...image,
            width: 1,
            height: 1,
            url: `${this.url}/v1/images/${entry.id}/${index}`,
          })),
          sources: Object.keys(entry.sources ?? {}).map((kind) => ({
            kind,
            url: `${this.url}/v1/sources/${entry.id}/${kind}`,
          })),
        })),
      })
    }
    if (path.startsWith('/v1/images/')) {
      this.imageRequests.push(path)
      res.writeHead(200, { 'content-type': 'image/png' })
      return void res.end(PNG)
    }
    if (path.startsWith('/v1/sources/')) {
      this.sourceRequests.push(path)
      const [entryId, kind] = path.slice('/v1/sources/'.length).split('/')
      const markup = this.entries.find((entry) => entry.id === entryId)?.sources?.[kind ?? '']
      if (markup === undefined) return this.send(res, 404, { error: 'no such source' })
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      return void res.end(markup)
    }
    this.send(res, 404, { error: 'not found' })
  }
}

export interface CliRun {
  code: number
  stdout: string
  stderr: string
}

export function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_SRC, ...args], {
      env: { ...process.env, EZTWEAK_NO_UPDATE_CHECK: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}
