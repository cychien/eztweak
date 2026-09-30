import type {
  IndexedDb,
  IndexedDbIndex,
  IndexedDbStore,
  PageStorage,
  StorageEntry,
} from '../page-state.js'

/** The shell shares the page's origin, and so its storage; these keys are the shell's. */
const SHELL_OWNED_PREFIXES = ['eztweak:', 'ez-update-dismissed', 'ez-confirm-skip:']
const MAX_RECORDS_PER_STORE = 1000
const MAX_BYTES = 1_500_000
const COLLECT_TIMEOUT_MS = 1500

function storageEntries(store: Storage): StorageEntry[] {
  const out: StorageEntry[] = []
  for (let i = 0; i < store.length; i++) {
    const name = store.key(i)
    if (name === null) continue
    if (SHELL_OWNED_PREFIXES.some((p) => name.startsWith(p))) continue
    out.push({ name, value: store.getItem(name) ?? '' })
  }
  return out
}

const done = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((ok, fail) => {
    request.onsuccess = () => ok(request.result)
    request.onerror = () => fail(request.error)
  })

function keyPathOf(
  path: string | string[] | null,
): Pick<IndexedDbIndex, 'keyPath' | 'keyPathArray'> {
  if (typeof path === 'string') return { keyPath: path }
  if (Array.isArray(path)) return { keyPathArray: [...path] }
  return {}
}

/** Only what survives JSON makes the trip, so a record that does not is left out. */
function jsonSafe(value: unknown): boolean {
  try {
    JSON.stringify(value)
    return true
  } catch {
    return false
  }
}

async function readDatabase(factory: IDBFactory, name: string): Promise<IndexedDb> {
  const request = factory.open(name)
  // Opening a database the page never made would create it; `databases()` only lists real ones,
  // but one deleted in between must not come back empty.
  request.onupgradeneeded = () => request.transaction?.abort()
  const db = await done(request)
  try {
    const stores: IndexedDbStore[] = []
    for (const storeName of [...db.objectStoreNames]) {
      const store = db.transaction(storeName, 'readonly').objectStore(storeName)
      const [keys, values] = await Promise.all([
        done(store.getAllKeys(null, MAX_RECORDS_PER_STORE)),
        done(store.getAll(null, MAX_RECORDS_PER_STORE)),
      ])
      const inline = store.keyPath !== null
      const records = values.flatMap((value, i) => {
        const record = inline ? { value } : { key: keys[i], value }
        return jsonSafe(record) ? [record] : []
      })
      const indexes: IndexedDbIndex[] = [...store.indexNames].map((indexName) => {
        const index = store.index(indexName)
        return {
          name: indexName,
          ...keyPathOf(index.keyPath),
          multiEntry: index.multiEntry,
          unique: index.unique,
        }
      })
      stores.push({
        name: storeName,
        ...keyPathOf(store.keyPath),
        autoIncrement: store.autoIncrement,
        records,
        indexes,
      })
    }
    return { name, version: db.version, stores }
  } finally {
    db.close()
  }
}

async function readIndexedDb(factory: IDBFactory): Promise<IndexedDb[]> {
  const listed = await factory.databases()
  const out: IndexedDb[] = []
  for (const { name } of listed) {
    if (!name) continue
    try {
      out.push(await readDatabase(factory, name))
    } catch {
      // A database the page holds open for an upgrade, or one gone since it was listed.
    }
  }
  return out
}

/** The page's storage as the frame showing it sees it, or null when the frame is on another origin. */
export async function collectPageStorage(win: Window): Promise<PageStorage | null> {
  let local: StorageEntry[]
  let session: StorageEntry[]
  let factory: IDBFactory
  try {
    local = storageEntries(win.localStorage)
    session = storageEntries(win.sessionStorage)
    factory = win.indexedDB
  } catch {
    return null
  }
  const timedOut = new Promise<IndexedDb[]>((ok) => setTimeout(() => ok([]), COLLECT_TIMEOUT_MS))
  const indexedDB = await Promise.race([readIndexedDb(factory).catch(() => []), timedOut])
  const storage: PageStorage = { localStorage: local, sessionStorage: session, indexedDB }
  return JSON.stringify(storage).length > MAX_BYTES ? { ...storage, indexedDB: [] } : storage
}
