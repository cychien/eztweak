/** Client for the inspiration database. Image URLs expire in minutes, so images are
 *  cached locally and the agent is given paths. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR, PKG_NAME } from './constants.js'

export const DEFAULT_INSPIRE_URL = 'https://inspire.ezdesign.dev'
export const INSPIRE_URL_ENV = `${PKG_NAME.toUpperCase()}_INSPIRE_URL`

const SEARCH_TIMEOUT_MS = 15_000
const IMAGE_TIMEOUT_MS = 30_000

export interface InspireImage {
  kind: string
  viewport?: string | null
  width?: number
  height?: number
  position?: number
  url: string
}

export interface InspireSource {
  kind: string
  url: string
}

export interface InspireEntry {
  id: string
  slug: string
  source_name: string
  source_url?: string | null
  why: string
  wrong_when?: string | null
  metadata?: unknown
  tags?: string[]
  description?: string | null
  elements?: string[]
  wording?: string[]
  actions?: string[]
  layout?: string | null
  layout_metrics?: unknown
  fidelity?: string | null
  score?: number
  images?: InspireImage[]
  sources?: InspireSource[]
}

export interface SearchResponse {
  results: InspireEntry[]
}

export interface SearchQuery {
  query?: string
  tags: string[]
  limit?: number
}

export class InspireError extends Error {}

export function inspireBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[INSPIRE_URL_ENV]?.trim()
  return (raw && raw !== '' ? raw : DEFAULT_INSPIRE_URL).replace(/\/+$/, '')
}

export function apiUrl(path: string, base: string = inspireBaseUrl()): string {
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

export function inspirationCacheDir(dataDir: string = DATA_DIR): string {
  return join(dataDir, 'cache', 'inspiration')
}

export function imageCachePath(
  entryId: string,
  image: InspireImage,
  index = 0,
  dataDir: string = DATA_DIR,
): string {
  const position = image.position ?? index
  const parts = [image.kind, image.viewport ?? undefined, String(position)].filter(
    (p): p is string => typeof p === 'string' && p !== '',
  )
  return join(inspirationCacheDir(dataDir), entryId, `${parts.join('-')}.png`)
}

export function sourceCachePath(
  entryId: string,
  source: InspireSource,
  dataDir: string = DATA_DIR,
): string {
  return join(inspirationCacheDir(dataDir), entryId, `source.${source.kind}`)
}

/** What was cached for one entry: its images, and a working implementation of it. */
export interface CachedFiles {
  images: string[]
  sources: string[]
}

const slugify = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** The slug minus its source name: `linear-command-menu` from Linear is "command menu". */
export function entryTitle(entry: InspireEntry): string {
  const prefix = `${slugify(entry.source_name)}-`
  const rest = entry.slug.startsWith(prefix) ? entry.slug.slice(prefix.length) : entry.slug
  return (rest || entry.slug).replace(/-/g, ' ')
}

const askedFor = (query: SearchQuery) =>
  [query.query ? `"${query.query}"` : '', query.tags.length ? `tags ${query.tags.join(', ')}` : '']
    .filter(Boolean)
    .join(' · ')

export function noMatchesLine(query: SearchQuery): string {
  return `no matches for ${askedFor(query)}`
}

const words = (value: string) => value.replace(/_/g, ' ')

/** As the curator wrote it: a sentence stays on the line, several lines go beneath it. */
function whyLines(why: string): string[] {
  const text = why.trim()
  return text.includes('\n') ? ['Why it works:', text] : [`Why it works: ${text}`]
}

/** Older entries lack the inventory fields, so their lines are dropped, not printed empty. The
 *  code comes last: it is opened only for the results that are built from. */
export function renderEntry(
  entry: InspireEntry,
  files: CachedFiles = { images: [], sources: [] },
): string {
  const approximate = entry.fidelity === 'image' ? '  (approximate)' : ''
  const lines = [
    `## ${entry.source_name}: ${entryTitle(entry)}  (slug ${entry.slug})${approximate}`,
  ]
  if (entry.tags?.length) lines.push(`tags: ${entry.tags.join(', ')}`)
  if (entry.description) lines.push(`Shows: ${entry.description}`)
  if (entry.elements?.length) lines.push(`Components: ${entry.elements.map(words).join(', ')}`)
  if (entry.actions?.length) lines.push(`Actions: ${entry.actions.join(', ')}`)
  lines.push(...whyLines(entry.why))
  if (entry.wrong_when) lines.push(`Wrong when: ${entry.wrong_when}`)
  if (files.images.length) lines.push(`images: ${files.images.join(', ')}`)
  if (files.sources.length) lines.push(`code: ${files.sources.join(', ')}`)
  return lines.join('\n')
}

export function renderSearch(
  response: SearchResponse,
  filesByEntry: Map<string, CachedFiles>,
  query: SearchQuery,
): string {
  const blocks = response.results.map((entry) => renderEntry(entry, filesByEntry.get(entry.id)))
  return blocks.length ? blocks.join('\n\n') : noMatchesLine(query)
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    throw new InspireError(`cannot reach the inspiration service at ${new URL(url).origin}`)
  }
}

export interface ClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  dataDir?: string
}

export async function search(
  query: SearchQuery,
  token: string,
  opts: ClientOptions = {},
): Promise<SearchResponse> {
  const base = opts.baseUrl ?? inspireBaseUrl()
  const body: Record<string, unknown> = {}
  if (query.query) body.query = query.query
  if (query.tags.length) body.tags = query.tags
  if (query.limit !== undefined) body.limit = query.limit
  const res = await request(
    apiUrl('/v1/search', base),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    SEARCH_TIMEOUT_MS,
    opts.fetchImpl ?? fetch,
  )
  if (res.status === 401) {
    throw new InspireError(
      `the inspiration token was refused; run \`${PKG_NAME} login\` with a current token`,
    )
  }
  if (!res.ok) throw new InspireError(`the inspiration service answered ${res.status}`)
  const parsed = (await res.json().catch(() => null)) as SearchResponse | null
  if (!parsed || !Array.isArray(parsed.results)) {
    throw new InspireError('the inspiration service answered with something unreadable')
  }
  return parsed
}

async function download(url: string, path: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) })
    if (!res.ok) return false
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from(await res.arrayBuffer()))
    return true
  } catch {
    return false
  }
}

const VIEWPORT_ORDER = ['desktop', 'mobile', 'detail']
const viewportRank = (image: InspireImage) => {
  const at = VIEWPORT_ORDER.indexOf(image.viewport ?? '')
  return at < 0 ? VIEWPORT_ORDER.length : at
}

/** A file that cannot be fetched is dropped rather than failing the search. Images are
 *  kept once fetched; the code is fetched each time, since an entry's code is edited. The
 *  desktop screenshot comes first, since it is the one image read with the text. */
export async function cacheFiles(
  results: InspireEntry[],
  opts: ClientOptions = {},
): Promise<Map<string, CachedFiles>> {
  const dataDir = opts.dataDir ?? DATA_DIR
  const fetchImpl = opts.fetchImpl ?? fetch
  const files = new Map<string, CachedFiles>()
  for (const entry of results) {
    const images: string[] = []
    const ordered = [...(entry.images ?? []).entries()].sort(
      ([, a], [, b]) => viewportRank(a) - viewportRank(b),
    )
    for (const [index, image] of ordered) {
      const path = imageCachePath(entry.id, image, index, dataDir)
      if (existsSync(path) || (await download(image.url, path, fetchImpl))) images.push(path)
    }
    const sources: string[] = []
    for (const source of entry.sources ?? []) {
      const path = sourceCachePath(entry.id, source, dataDir)
      if ((await download(source.url, path, fetchImpl)) || existsSync(path)) sources.push(path)
    }
    files.set(entry.id, { images, sources })
  }
  return files
}

/** A file that was not cached keeps its service url, so the others still line up. */
export function withLocalPaths(
  response: SearchResponse,
  filesByEntry: Map<string, CachedFiles>,
  dataDir: string = DATA_DIR,
): SearchResponse {
  return {
    ...response,
    results: response.results.map((entry) => {
      const local = filesByEntry.get(entry.id) ?? { images: [], sources: [] }
      const cached = new Set([...local.images, ...local.sources])
      const localOr = (path: string, url: string) => (cached.has(path) ? path : url)
      return {
        ...entry,
        images: (entry.images ?? []).map((image, index) => ({
          ...image,
          url: localOr(imageCachePath(entry.id, image, index, dataDir), image.url),
        })),
        sources: (entry.sources ?? []).map((source) => ({
          ...source,
          url: localOr(sourceCachePath(entry.id, source, dataDir), source.url),
        })),
      }
    }),
  }
}

export interface SearchArgs extends SearchQuery {
  json: boolean
}

const list = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

/** Returns an error message when the invocation cannot be acted on. */
export function parseSearchArgs(args: string[]): SearchArgs | { error: string } {
  const value = (name: string): string | undefined => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  for (const name of ['--query', '--tag', '--limit']) {
    if (args.includes(name) && value(name) === undefined)
      return { error: `missing value for ${name}` }
  }
  const query = value('--query')?.trim() || undefined
  const tags = list(value('--tag'))
  if (!query && !tags.length) return { error: 'give --query, --tag, or both' }
  const rawLimit = value('--limit')
  let limit: number | undefined
  if (rawLimit !== undefined) {
    limit = Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1) return { error: `invalid --limit: ${rawLimit}` }
  }
  return { query, tags, limit, json: args.includes('--json') }
}
