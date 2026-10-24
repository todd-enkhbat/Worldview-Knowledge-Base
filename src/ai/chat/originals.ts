import { openDB, type IDBPDatabase } from 'idb'

// Files the user added to the chat, kept until a note keeps them (milestone 1b follow-up).
// In memory for the session, and copied to a small per-browser IndexedDB store so a card kept
// after a reload still gets its original. Entries expire after 14 days. Device-local: the
// world itself (and its archive) holds an original only once a note has kept it.

const DB = 'hyperspace-intake'
const STORE = 'files'
const TTL_MS = 14 * 24 * 3600 * 1000

interface Row {
  name: string
  file: File
  at: number
}

const memory = new Map<string, File>()
let db: Promise<IDBPDatabase | null> | null = null

function open(): Promise<IDBPDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  db ??= openDB(DB, 1, {
    upgrade(d) {
      d.createObjectStore(STORE, { keyPath: 'name' })
    },
  })
    .then(async (d) => {
      // Drop what has waited too long.
      const cutoff = Date.now() - TTL_MS
      for (const row of (await d.getAll(STORE)) as Row[]) if (row.at < cutoff) await d.delete(STORE, row.name)
      return d
    })
    .catch(() => null)
  return db
}

const keysOf = (file: File) => {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  return rel ? [file.name, rel] : [file.name]
}

/** Remember a file the user added (memory now, browser storage in the background). */
export function rememberOriginal(file: File): void {
  for (const k of keysOf(file)) memory.set(k, file)
  void open().then(async (d) => {
    if (!d) return
    for (const k of keysOf(file)) await d.put(STORE, { name: k, file, at: Date.now() } satisfies Row).catch(() => {})
  })
}

/** The file added under this name (or its base name), from memory or browser storage. */
export async function findOriginal(name: string): Promise<File | undefined> {
  const base = name.split('/').pop()!
  const hit = memory.get(name) ?? memory.get(base)
  if (hit) return hit
  const d = await open()
  if (!d) return undefined
  const row = ((await d.get(STORE, name).catch(() => undefined)) ?? (await d.get(STORE, base).catch(() => undefined))) as Row | undefined
  if (row) memory.set(name, row.file)
  return row?.file
}

/** Test hook: forget the in-memory copies (as a reload would). */
export function _forgetMemoryForTests(): void {
  memory.clear()
}
