// Origin Private File System: blob bytes ('blobs/', one file per asset id) and
// pre-import backups ('backups/', used by archive.ts).
//
// Writes go through createWritable(): the browser writes into a swap file and swaps it in
// on close(), so a failed or aborted write leaves the previous contents intact. The sync
// access handle is worker-only (and Safari's main thread has no other OPFS write path before
// createWritable shipped), so when createWritable is missing OPFS is treated as unavailable
// for blobs and idbStore falls back to its IndexedDB 'blobs' store.

export const BLOBS_DIR = 'blobs'
export const BACKUPS_DIR = 'backups'
/** Probe file written once at open; the leading dot can never collide with an encoded id. */
const PROBE_NAME = '.probe'

type Dir = FileSystemDirectoryHandle

export type WriteData = Blob | Uint8Array | ReadableStream<Uint8Array>

export class OpfsUnavailableError extends Error {
  constructor(message = 'Origin Private File System is unavailable') {
    super(message)
    this.name = 'OpfsUnavailableError'
  }
}

function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'NotFoundError'
}

/**
 * OPFS entry names may not contain '/' or '\' or be '.'/'..'. Ids and backup names are
 * arbitrary strings, so percent-encode them (and a leading dot, which also keeps them
 * clear of PROBE_NAME).
 */
export function encodeName(name: string): string {
  if (typeof name !== 'string' || name === '') throw new TypeError('OPFS entry name must be a non-empty string')
  return encodeURIComponent(name).replace(/^\./, '%2E')
}

export function decodeName(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

export function opfsApiPresent(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
}

/** The OPFS root, or null when the API is missing or refuses (some private windows). */
export async function getOpfsRoot(): Promise<Dir | null> {
  if (!opfsApiPresent()) return null
  try {
    return await navigator.storage.getDirectory()
  } catch {
    return null
  }
}

function canStreamWrite(fh: FileSystemFileHandle): boolean {
  return typeof (fh as Partial<FileSystemFileHandle>).createWritable === 'function'
}

async function fileExists(dir: Dir, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  } catch (e) {
    if (isNotFound(e)) return false
    throw e
  }
}

async function removeQuietly(dir: Dir, name: string, recursive = false): Promise<boolean> {
  try {
    await dir.removeEntry(name, { recursive })
    return true
  } catch (e) {
    if (isNotFound(e)) return false
    throw e
  }
}

/** Write a whole file through createWritable. On failure the old file (if any) is untouched. */
export async function writeFile(dir: Dir, name: string, data: WriteData): Promise<void> {
  const existed = await fileExists(dir, name)
  const fh = await dir.getFileHandle(name, { create: true })
  try {
    if (!canStreamWrite(fh)) throw new OpfsUnavailableError('FileSystemFileHandle.createWritable is unavailable')
    const w = await fh.createWritable()
    if (data instanceof ReadableStream) {
      // pipeTo closes the writable on success and aborts it (discarding the swap file) on error.
      await data.pipeTo(w)
      return
    }
    try {
      const chunk = data instanceof Uint8Array ? (data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : data.slice()) : data
      await w.write(chunk)
      await w.close()
    } catch (e) {
      await w.abort().catch(() => {})
      throw e
    }
  } catch (e) {
    // getFileHandle({create}) already made an empty file; do not leave it behind.
    if (!existed) await removeQuietly(dir, name).catch(() => {})
    throw e
  }
}

async function readFile(dir: Dir, name: string): Promise<File | undefined> {
  try {
    return await (await dir.getFileHandle(name)).getFile()
  } catch (e) {
    if (isNotFound(e)) return undefined
    throw e
  }
}

async function listFiles(dir: Dir): Promise<FileSystemFileHandle[]> {
  const out: FileSystemFileHandle[] = []
  for await (const h of dir.values()) if (h.kind === 'file' && !h.name.startsWith('.')) out.push(h as FileSystemFileHandle)
  return out
}

// ─── blobs/ ────────────────────────────────────────────────────────────────────────

export interface OpfsBlobDir {
  put(id: string, data: WriteData): Promise<void>
  /** The stored file (a Blob with an empty type; callers re-type it from AssetMeta). */
  get(id: string): Promise<File | undefined>
  delete(id: string): Promise<void>
  list(): Promise<string[]>
  /** Remove the whole directory (wipe). Backups are not touched. */
  clear(): Promise<void>
}

export function createOpfsBlobDir(root: Dir, dirName = BLOBS_DIR): OpfsBlobDir {
  // Resolve per call: clear() removes the directory, which would orphan a cached handle.
  const dir = () => root.getDirectoryHandle(dirName, { create: true })
  return {
    async put(id, data) {
      await writeFile(await dir(), encodeName(id), data)
    },
    async get(id) {
      return readFile(await dir(), encodeName(id))
    },
    async delete(id) {
      await removeQuietly(await dir(), encodeName(id))
    },
    async list() {
      return (await listFiles(await dir())).map((h) => decodeName(h.name)).sort()
    },
    async clear() {
      await removeQuietly(root, dirName, true)
    },
  }
}

/** True when a probe file can be written through createWritable (and is then removed). */
async function probeWritable(dir: Dir): Promise<boolean> {
  try {
    const fh = await dir.getFileHandle(PROBE_NAME, { create: true })
    if (!canStreamWrite(fh)) {
      await removeQuietly(dir, PROBE_NAME).catch(() => {})
      return false
    }
    const w = await fh.createWritable()
    await w.write(new Uint8Array([1]))
    await w.close()
    await removeQuietly(dir, PROBE_NAME)
    return true
  } catch {
    return false
  }
}

/**
 * Feature-detect a working OPFS blob directory: the root must resolve and a probe file must
 * be writable through createWritable (Safari private windows and pre-createWritable Safari
 * fail here). Returns null when blobs should live in IndexedDB instead.
 */
export async function openOpfsBlobDir(root?: Dir | null): Promise<OpfsBlobDir | null> {
  const r = root === undefined ? await getOpfsRoot() : root
  if (!r) return null
  try {
    if (!(await probeWritable(await r.getDirectoryHandle(BLOBS_DIR, { create: true })))) return null
  } catch {
    return null
  }
  return createOpfsBlobDir(r)
}

// ─── backups/ ──────────────────────────────────────────────────────────────────────

export interface BackupInfo {
  name: string
  bytes: number
  lastModified: number
}

async function backupsDir(root?: Dir | null): Promise<Dir | null> {
  const r = root === undefined ? await getOpfsRoot() : root
  return r ? r.getDirectoryHandle(BACKUPS_DIR, { create: true }) : null
}

const newestFirst = (a: BackupInfo, b: BackupInfo) =>
  b.lastModified - a.lastModified || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)

async function listIn(dir: Dir): Promise<BackupInfo[]> {
  const out: BackupInfo[] = []
  for (const h of await listFiles(dir)) {
    const f = await h.getFile()
    out.push({ name: decodeName(h.name), bytes: f.size, lastModified: f.lastModified })
  }
  return out.sort(newestFirst)
}

/** Whether writeBackup can work here (OPFS present and writable through createWritable). */
export async function backupsAvailable(root?: Dir | null): Promise<boolean> {
  try {
    const dir = await backupsDir(root)
    return dir !== null && (await probeWritable(dir))
  } catch {
    return false
  }
}

/** Backups, newest first (ties broken by name, so timestamped names sort correctly). */
export async function listBackups(root?: Dir | null): Promise<BackupInfo[]> {
  const dir = await backupsDir(root)
  return dir ? listIn(dir) : []
}

/** Stream a backup into backups/<name>. Replaces an existing backup of the same name atomically. */
export async function writeBackup(name: string, data: ReadableStream<Uint8Array> | Blob, root?: Dir | null): Promise<BackupInfo> {
  const dir = await backupsDir(root)
  if (!dir) throw new OpfsUnavailableError()
  const file = encodeName(name)
  await writeFile(dir, file, data)
  const f = (await readFile(dir, file))!
  return { name, bytes: f.size, lastModified: f.lastModified }
}

export async function readBackup(name: string, root?: Dir | null): Promise<File | undefined> {
  const dir = await backupsDir(root)
  return dir ? readFile(dir, encodeName(name)) : undefined
}

export async function deleteBackup(name: string, root?: Dir | null): Promise<boolean> {
  const dir = await backupsDir(root)
  return dir ? removeQuietly(dir, encodeName(name)) : false
}

/** Keep the newest `keep` backups; returns the names removed. */
export async function pruneBackups(keep: number, root?: Dir | null): Promise<string[]> {
  const dir = await backupsDir(root)
  if (!dir) return []
  const stale = (await listIn(dir)).slice(Math.max(0, Math.floor(keep)))
  for (const b of stale) await removeQuietly(dir, encodeName(b.name))
  return stale.map((b) => b.name)
}
