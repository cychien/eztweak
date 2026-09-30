/** The signed-in state of the page the user is reviewing, so a browser of the
 *  agent's own opens it the way the user sees it. Shaped as Playwright's
 *  `storageState`, the de facto format for handing a session to a headless
 *  browser; `sessionStorage` is the one addition. */

export interface StorageEntry {
  name: string
  value: string
}

export interface IndexedDbIndex {
  name: string
  keyPath?: string
  keyPathArray?: string[]
  multiEntry: boolean
  unique: boolean
}

export interface IndexedDbRecord {
  key?: unknown
  value: unknown
}

export interface IndexedDbStore {
  name: string
  keyPath?: string
  keyPathArray?: string[]
  autoIncrement: boolean
  records: IndexedDbRecord[]
  indexes: IndexedDbIndex[]
}

export interface IndexedDb {
  name: string
  version: number
  stores: IndexedDbStore[]
}

/** What the shell can read of the page from inside it: all but its cookies. */
export interface PageStorage {
  localStorage: StorageEntry[]
  sessionStorage: StorageEntry[]
  indexedDB: IndexedDb[]
}

export interface StorageStateCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

export interface StorageState {
  cookies: StorageStateCookie[]
  origins: {
    origin: string
    localStorage: StorageEntry[]
    sessionStorage: StorageEntry[]
    indexedDB: IndexedDb[]
  }[]
}

/** A `Cookie` request header, which carries names and values only. */
export function parseCookieHeader(header: string | null | undefined): StorageEntry[] {
  if (!header) return []
  return header.split(';').flatMap((pair) => {
    const at = pair.indexOf('=')
    const name = (at < 0 ? '' : pair.slice(0, at)).trim()
    return name ? [{ name, value: pair.slice(at + 1).trim() }] : []
  })
}

/** A request header's cookies are the ones the page sends, so what is known of
 *  each is that it goes to this host at this path; the rest is left at the
 *  defaults a cookie set without them gets. */
export function storageState(
  origin: string,
  cookieHeader: string | null,
  storage: PageStorage | null,
): StorageState {
  const { hostname } = new URL(origin)
  return {
    cookies: parseCookieHeader(cookieHeader).map(({ name, value }) => ({
      name,
      value,
      domain: hostname,
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    })),
    origins: storage
      ? [
          {
            origin,
            localStorage: storage.localStorage,
            sessionStorage: storage.sessionStorage,
            indexedDB: storage.indexedDB,
          },
        ]
      : [],
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function entries(raw: unknown): StorageEntry[] | null {
  if (!Array.isArray(raw)) return null
  const out: StorageEntry[] = []
  for (const e of raw) {
    if (!isRecord(e) || typeof e.name !== 'string' || typeof e.value !== 'string') return null
    out.push({ name: e.name, value: e.value })
  }
  return out
}

function keyPath(raw: Record<string, unknown>): Pick<IndexedDbIndex, 'keyPath' | 'keyPathArray'> {
  if (typeof raw.keyPath === 'string') return { keyPath: raw.keyPath }
  if (Array.isArray(raw.keyPathArray) && raw.keyPathArray.every((k) => typeof k === 'string')) {
    return { keyPathArray: raw.keyPathArray as string[] }
  }
  return {}
}

function database(raw: unknown): IndexedDb | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !Array.isArray(raw.stores)) return null
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
    return null
  }
  const stores: IndexedDbStore[] = []
  for (const s of raw.stores) {
    if (!isRecord(s) || typeof s.name !== 'string') return null
    if (!Array.isArray(s.records) || !Array.isArray(s.indexes)) return null
    const indexes: IndexedDbIndex[] = []
    for (const i of s.indexes) {
      if (!isRecord(i) || typeof i.name !== 'string') return null
      indexes.push({ name: i.name, ...keyPath(i), multiEntry: !!i.multiEntry, unique: !!i.unique })
    }
    stores.push({
      name: s.name,
      ...keyPath(s),
      autoIncrement: !!s.autoIncrement,
      records: s.records
        .filter(isRecord)
        .map((r) => ('key' in r ? { key: r.key, value: r.value } : { value: r.value })),
      indexes,
    })
  }
  return { name: raw.name, version: raw.version, stores }
}

/** The shell's report, or null when it is not one. */
export function parsePageStorage(raw: unknown): PageStorage | null {
  if (!isRecord(raw)) return null
  const local = entries(raw.localStorage)
  const session = entries(raw.sessionStorage)
  if (!local || !session || !Array.isArray(raw.indexedDB)) return null
  const dbs: IndexedDb[] = []
  for (const db of raw.indexedDB) {
    const parsed = database(db)
    if (!parsed) return null
    dbs.push(parsed)
  }
  return { localStorage: local, sessionStorage: session, indexedDB: dbs }
}
