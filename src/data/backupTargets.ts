import { openDB } from 'idb'
import type { IDBPDatabase } from 'idb'
import { blobSink, opfsBackupTarget } from './archive.ts'
import type { BackupTarget } from './archive.ts'
import { backupsAvailable, readBackup } from './opfs.ts'

// Where the automatic pre-import backup goes. OPFS 'backups/' is preferred (streamed to disk).
// Safari before FileSystemWritableFileStream (and some private windows) cannot write OPFS
// from the main thread; there the backup is collected as Blob parts and stored in a separate
// IndexedDB database, so "import always takes a backup first" holds on every engine. The
// database is separate from the world's so store.wipe() during the import cannot touch it.

export const BACKUP_DB_NAME = 'hyperspace-backups'
const STORE = 'backups'

interface BackupRow {
  name: string
  blob: Blob
  bytes: number
  createdAt: number
}

async function openBackupDb(dbName: string): Promise<IDBPDatabase> {
  return openDB(dbName, 1, {
    upgrade(d) {
      d.createObjectStore(STORE, { keyPath: 'name' })
    },
  })
}

async function withDb<T>(dbName: string, fn: (db: IDBPDatabase) => Promise<T>): Promise<T> {
  const db = await openBackupDb(dbName)
  try {
    return await fn(db)
  } finally {
    db.close()
  }
}

/** Whether the IndexedDB backup database can be opened. */
export async function idbBackupsAvailable(dbName = BACKUP_DB_NAME): Promise<boolean> {
  try {
    await withDb(dbName, async () => undefined)
    return true
  } catch {
    return false
  }
}

const newestFirst = (a: BackupRow, b: BackupRow) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)

/** Pre-import backups as Blobs in their own IndexedDB database. */
export function idbBackupTarget(opts: { dbName?: string; now?: () => number } = {}): BackupTarget {
  const dbName = opts.dbName ?? BACKUP_DB_NAME
  const now = opts.now ?? Date.now
  return {
    async write(name, fill) {
      const sink = blobSink()
      await fill(sink)
      const blob = sink.blob()
      const row: BackupRow = { name, blob, bytes: blob.size, createdAt: now() }
      await withDb(dbName, (db) => db.put(STORE, row))
    },
    async prune(keep) {
      await withDb(dbName, async (db) => {
        const rows = ((await db.getAll(STORE)) as BackupRow[]).sort(newestFirst)
        for (const r of rows.slice(Math.max(0, Math.floor(keep)))) await db.delete(STORE, r.name)
      })
    },
    async read(name) {
      const row = (await withDb(dbName, (db) => db.get(STORE, name))) as BackupRow | undefined
      return row?.blob
    },
  }
}

/** OPFS when writable, else IndexedDB, else null (the caller must then ask before importing). */
export async function defaultBackupTarget(): Promise<BackupTarget | null> {
  if (await backupsAvailable()) return opfsBackupTarget()
  if (await idbBackupsAvailable()) return idbBackupTarget()
  return null
}

/** Find a pre-import backup by name in either location. */
export async function readAnyBackup(name: string, dbName = BACKUP_DB_NAME): Promise<Blob | undefined> {
  const fromOpfs = await readBackup(name).catch(() => undefined)
  if (fromOpfs) return fromOpfs
  if (!(await idbBackupsAvailable(dbName))) return undefined
  return idbBackupTarget({ dbName }).read!(name)
}
