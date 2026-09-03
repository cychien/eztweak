import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { NO_UPDATE_CHECK_ENV, PKG_NAME, UPDATE_CHECK_FILE, UPDATE_CHECK_TTL_MS } from './constants.js'

interface ParsedVersion {
  nums: [number, number, number]
  pre: string | null
}

function parseVersion(raw: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null }
}

/** Semver ordering for the two things this needs it for: is the registry ahead
 *  of the running daemon, and is an installed skill behind it. A release
 *  outranks its own prereleases; prereleases order by identifier, which is enough
 *  to keep a local dev build from being offered the version it is ahead of. An
 *  unparseable version compares as older than anything parseable. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i]! < pb.nums[i]! ? -1 : 1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return pa.pre < pb.pre ? -1 : 1
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

export function updateChecksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[NO_UPDATE_CHECK_ENV]
  return raw !== undefined && raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false'
}

export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PKG_NAME}/latest`

/** The `latest` dist-tag, or null when the registry cannot be reached or says
 *  something unexpected. Both are the same to the caller: nothing to offer. */
export async function fetchLatestVersion(
  fetchImpl: typeof fetch = fetch,
  url = REGISTRY_LATEST_URL,
): Promise<string | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === 'string' && parseVersion(body.version) ? body.version : null
  } catch {
    return null
  }
}

export interface UpdateCheckCache {
  checkedAt: number
  latest: string
}

export function readUpdateCheckCache(file = UPDATE_CHECK_FILE): UpdateCheckCache | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<UpdateCheckCache>
    if (typeof parsed.checkedAt !== 'number' || typeof parsed.latest !== 'string') return null
    return { checkedAt: parsed.checkedAt, latest: parsed.latest }
  } catch {
    return null
  }
}

/** Best effort: the cache only spares the registry a request, so a data dir that
 *  is read-only, full, or on a volume that has gone away must cost the check its
 *  cache, not its answer. */
export function writeUpdateCheckCache(cache: UpdateCheckCache, file = UPDATE_CHECK_FILE): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cache, null, 2))
  } catch {
    /* asked again next time */
  }
}

/** The latest version on the registry, asked at most once per TTL across every
 *  daemon that shares the data dir. A daemon is replaced on every CLI version
 *  change, so without the cache each replacement would ask again. */
export async function latestVersion(opts: {
  fetchLatest?: () => Promise<string | null>
  now?: () => number
  file?: string
  ttlMs?: number
} = {}): Promise<string | null> {
  const now = opts.now ?? Date.now
  const file = opts.file ?? UPDATE_CHECK_FILE
  const ttl = opts.ttlMs ?? UPDATE_CHECK_TTL_MS
  const cached = readUpdateCheckCache(file)
  if (cached && now() - cached.checkedAt < ttl) return cached.latest
  const fresh = await (opts.fetchLatest ?? fetchLatestVersion)()
  if (fresh) writeUpdateCheckCache({ checkedAt: now(), latest: fresh }, file)
  return fresh ?? cached?.latest ?? null
}
