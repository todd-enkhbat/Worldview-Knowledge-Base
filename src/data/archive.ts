import { Inflate, Zip, ZipPassThrough } from 'fflate'
import { ARCHETYPES, SCHEMA_VERSION } from '../domain/types.ts'
import type { AssetMeta, InteractionEvent, InteractionKind, NodeRecord, WorldSettings } from '../domain/types.ts'
import type { WorldStore } from './WorldStore.ts'
import { hashRecords } from './hash.ts'
import { backupsAvailable, pruneBackups, readBackup, writeBackup } from './opfs.ts'

// Streaming export / import of the whole world as a STORED (uncompressed) zip: SPZ splats
// are already compressed, so deflate would burn CPU for nothing.
//
//   manifest.json   format, versions, settings (incl. T0), counts, recordsHash
//   nodes.jsonl     every NodeRecord, trash included, one per line
//   events.jsonl    the interaction log
//   assets/<id>     raw blob bytes (id percent-encoded)
//   assets.json     AssetMeta[] for the entries above
//
// Export pipes each blob's stream() through fflate's Zip + ZipPassThrough into a sink, chunk
// by chunk, so the archive never exists as one buffer (on Chrome it goes straight to disk via
// showSaveFilePicker). manifest.json and assets.json are written last, once the final counts
// are known.
//
// Import does NOT use fflate's Unzip. fflate's streaming Zip always writes data descriptors
// (sizes after the data), and its Unzip finds the end of such an entry by scanning the payload
// for the next PK signature. Splat files are high-entropy, so a 100 MB asset contains one of
// the three 4-byte signatures with probability ≈ 7 %, which would silently cut the asset short.
// The input is a Blob, so we can seek instead: read the central directory at the end (exact
// offsets, sizes and CRCs), then hand each asset to the store as a zero-copy file.slice().
//
// Limits: zip32 only (fflate cannot write zip64), so an archive must stay below 4 GiB and
// 65 535 entries. Both are checked before the first byte is written.

export const ARCHIVE_FORMAT = 'hyperspace-archive'
export const ARCHIVE_FORMAT_VERSION = 1
export const APP_VERSION = '0.1.0'
/** zip32 sizes and offsets are unsigned 32-bit. */
export const ZIP32_MAX_BYTES = 0xffff_ffff
export const ZIP32_MAX_ENTRIES = 0xffff
export const PRE_IMPORT_BACKUPS_KEPT = 3
/** kv entries that belong to this device, not to the world: kept across an import. */
export const DEVICE_KV_KEYS: readonly string[] = ['autoBackupDir']
/**
 * kv key present while an import is replacing the world (written right after the wipe,
 * removed after the last write). If the tab dies in between, the next start finds it and can
 * offer to restore the pre-import backup instead of silently showing a half-imported world.
 */
export const IMPORT_MARKER_KV = 'importInProgress'

export interface ImportMarker {
  /** Pre-import backup to restore from, or null when the import ran without one. */
  backupName: string | null
  startedAt: number
}

/** The marker of an interrupted import, or null. */
export async function readImportMarker(store: WorldStore): Promise<ImportMarker | null> {
  const m = await store.getKv<ImportMarker>(IMPORT_MARKER_KV)
  return m && typeof m === 'object' && typeof m.startedAt === 'number' ? m : null
}

/** Largest single chunk handed to a sink; bigger stream chunks are split (zero-copy). */
const MAX_SINK_CHUNK = 1 << 20
/** JSONL is encoded in batches of about this many UTF-16 code units. */
const TEXT_BATCH = 256 * 1024
/** Blob sinks fold pending parts into one Blob every this many bytes. */
const BLOB_FOLD_BYTES = 16 << 20
const MAX_MANIFEST_BYTES = 4 << 20
const MAX_ASSET_INDEX_BYTES = 64 << 20

export const ENTRY_MANIFEST = 'manifest.json'
export const ENTRY_NODES = 'nodes.jsonl'
export const ENTRY_EVENTS = 'events.jsonl'
export const ENTRY_ASSETS = 'assets.json'
export const assetEntryName = (id: string): string => `assets/${encodeURIComponent(id)}`

// Fixed per-entry overhead of a fflate stored entry: local header 30 + descriptor 16 +
// central header 46, plus the name twice.
const entryOverhead = (name: string) => 92 + 2 * new TextEncoder().encode(name).length
const EOCD_BYTES = 22

export interface ArchiveCounts {
  nodes: number
  live: number
  trash: number
  events: number
  assets: number
  assetBytes: number
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT
  formatVersion: number
  schemaVersion: number
  /** Epoch ms. */
  exportedAt: number
  origin: string
  appVersion: string
  settings: WorldSettings | null
  counts: ArchiveCounts
  /** hashRecords over every record in nodes.jsonl (trash included). */
  recordsHash: string
}

export type ArchiveErrorCode =
  | 'too-large'
  | 'not-zip'
  | 'truncated'
  | 'zip64'
  | 'unsupported'
  | 'missing-entry'
  | 'wrong-format'
  | 'wrong-version'
  | 'newer-schema'
  | 'corrupt'
  | 'hash-mismatch'
  | 'backup-unavailable'
  | 'backup-failed'
  | 'import-failed'

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode
  /** Set when an import failed after the wipe: the pre-import backup to restore from. */
  backupName?: string
  constructor(code: ArchiveErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ArchiveError'
    this.code = code
  }
}

// ─── sinks ─────────────────────────────────────────────────────────────────────────

/** Where export bytes go. write() may apply backpressure by returning a promise. */
export interface ArchiveSink {
  write(chunk: Uint8Array): void | Promise<void>
  close(): void | Promise<void>
  /** Called instead of close() when the export fails; should discard partial output. */
  abort?(reason: unknown): void | Promise<void>
}

/** Any WritableStream, including the FileSystemWritableFileStream from showSaveFilePicker. */
export function writableSink(stream: WritableStream<Uint8Array>): ArchiveSink {
  const writer = stream.getWriter()
  return {
    async write(chunk) {
      await writer.ready
      await writer.write(chunk)
    },
    async close() {
      await writer.close()
    },
    async abort(reason) {
      await writer.abort(reason).catch(() => {})
    },
  }
}

export interface BlobSink extends ArchiveSink {
  /** The finished archive. Valid after close(). */
  blob(): Blob
}

/**
 * Collects the archive as Blob parts (Safari / Firefox fallback). Pending chunks are folded
 * into a Blob every 16 MiB, so the bytes move into browser-managed (often disk-backed)
 * storage instead of accumulating on the JS heap.
 */
export function blobSink(type = 'application/zip'): BlobSink {
  let folded = new Blob([], { type })
  let pending: BlobPart[] = []
  let pendingBytes = 0
  let closed = false
  const fold = () => {
    if (pending.length === 0) return
    folded = new Blob([folded, ...pending], { type })
    pending = []
    pendingBytes = 0
  }
  return {
    write(chunk) {
      pending.push(chunk as Uint8Array<ArrayBuffer>)
      pendingBytes += chunk.length
      if (pendingBytes >= BLOB_FOLD_BYTES) fold()
    },
    close() {
      fold()
      closed = true
    },
    abort() {
      pending = []
      folded = new Blob([], { type })
    },
    blob() {
      if (!closed) throw new Error('blobSink: archive is not finished')
      return folded
    },
  }
}

export interface BytesSink extends ArchiveSink {
  bytes(): Uint8Array
  /** Total bytes written. */
  readonly written: number
  /** Largest single chunk received. */
  readonly maxChunk: number
}

/** Collects into one Uint8Array. For tests and small dev exports only. */
export function bytesSink(): BytesSink {
  const chunks: Uint8Array[] = []
  let written = 0
  let maxChunk = 0
  return {
    write(chunk) {
      chunks.push(chunk.slice())
      written += chunk.length
      maxChunk = Math.max(maxChunk, chunk.length)
    },
    close() {},
    bytes() {
      const out = new Uint8Array(written)
      let off = 0
      for (const c of chunks) {
        out.set(c, off)
        off += c.length
      }
      return out
    },
    get written() {
      return written
    },
    get maxChunk() {
      return maxChunk
    },
  }
}

// ─── export ────────────────────────────────────────────────────────────────────────

export interface ArchiveProgress {
  phase: 'records' | 'assets' | 'verify' | 'backup' | 'write' | 'done'
  /** Bytes written (export) or processed (import) so far. */
  done: number
  /** Best estimate of the total for this phase. */
  total: number
}

export interface ExportOptions {
  onProgress?: (p: ArchiveProgress) => void
  /** Epoch ms stamped into the manifest and the zip entry times. */
  now?: number
  origin?: string
  appVersion?: string
}

export interface ExportResult {
  manifest: ArchiveManifest
  /** Archive size in bytes. */
  bytes: number
  /** Asset ids whose bytes were missing from the store (left out of the archive). */
  missingAssets: string[]
}

async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  let done = false
  try {
    for (;;) {
      const r = await reader.read()
      if (r.done) {
        done = true
        return
      }
      yield r.value
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function* jsonlBatches(items: readonly unknown[]): Generator<Uint8Array> {
  const enc = new TextEncoder()
  let buf = ''
  for (const item of items) {
    buf += JSON.stringify(item) + '\n'
    if (buf.length >= TEXT_BATCH) {
      yield enc.encode(buf)
      buf = ''
    }
  }
  if (buf) yield enc.encode(buf)
}

function defaultOrigin(): string {
  return typeof location === 'undefined' ? '' : location.origin
}

/** The earliest date a zip header can carry. */
const ZIP_EPOCH = Date.UTC(1980, 0, 2)

/**
 * Stream the whole world into `sink`. Reads the record, event and asset lists up front
 * (small), checks the zip32 limits from AssetMeta.bytes, then writes entry by entry,
 * awaiting the sink after every chunk so a slow disk applies backpressure.
 *
 * Asset bytes are fetched one at a time inside the write loop, never all up front: with
 * the IndexedDB blob fallback (Safari without OPFS createWritable) getBlob materialises the
 * whole asset in memory, so resolving every blob first would hold the entire world in RAM.
 * Because a blob can only be found missing at that point, assets.json and manifest.json
 * (which carry the final counts) are written last; readers use the central directory, so
 * entry order does not matter.
 */
export async function exportArchive(store: WorldStore, sink: ArchiveSink, opts: ExportOptions = {}): Promise<ExportResult> {
  const now = opts.now ?? Date.now()
  const [settings, nodes, events, metas] = await Promise.all([
    store.getSettings(),
    store.listNodes(),
    store.listEvents(),
    store.listAssets(),
  ])
  const trash = nodes.filter((n) => n.deletedAt !== null).length
  const recordsHash = await hashRecords(nodes)

  // Size check before writing anything. Text sizes are estimated in UTF-16 units (exact for
  // ASCII) and the manifest by its settings plus a fixed allowance; the running byte count
  // below enforces the hard limit regardless.
  const names = [ENTRY_MANIFEST, ENTRY_NODES, ENTRY_EVENTS, ENTRY_ASSETS, ...metas.map((m) => assetEntryName(m.id))]
  if (names.length > ZIP32_MAX_ENTRIES) {
    throw new ArchiveError('too-large', `Too many assets for one archive (${metas.length}; zip32 allows ${ZIP32_MAX_ENTRIES - 4}).`)
  }
  const expectedAssetBytes = metas.reduce((s, m) => s + (Number.isFinite(m.bytes) ? m.bytes : 0), 0)
  const textEstimate =
    nodes.reduce((s, n) => s + JSON.stringify(n).length + 1, 0) +
    events.reduce((s, e) => s + JSON.stringify(e).length + 1, 0) +
    JSON.stringify(metas).length +
    JSON.stringify(settings).length +
    1024
  const total = expectedAssetBytes + textEstimate + names.reduce((s, n) => s + entryOverhead(n), 0) + EOCD_BYTES
  if (total > ZIP32_MAX_BYTES) {
    throw new ArchiveError(
      'too-large',
      `The world is ${(total / 2 ** 30).toFixed(2)} GiB; one archive is limited to 4 GiB (zip32). Remove or shrink large splats and try again.`,
    )
  }

  const queue: Uint8Array[] = []
  let zipError: Error | null = null
  const zip = new Zip((err, chunk) => {
    if (err) zipError = err
    else if (chunk.length) queue.push(chunk)
  })
  let written = 0
  let phase: ArchiveProgress['phase'] = 'records'
  const drain = async () => {
    if (zipError) throw zipError
    while (queue.length) {
      const c = queue.shift()!
      for (let off = 0; off < c.length; off += MAX_SINK_CHUNK) {
        const part = off === 0 && c.length <= MAX_SINK_CHUNK ? c : c.subarray(off, Math.min(c.length, off + MAX_SINK_CHUNK))
        written += part.length
        if (written > ZIP32_MAX_BYTES) throw new ArchiveError('too-large', 'Archive exceeded 4 GiB (zip32 limit) while writing.')
        await sink.write(part)
      }
    }
    opts.onProgress?.({ phase, done: written, total: Math.max(total, written) })
  }
  const addEntry = async (name: string, chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) => {
    const entry = new ZipPassThrough(name)
    entry.mtime = Math.max(now, ZIP_EPOCH)
    zip.add(entry)
    await drain()
    for await (const chunk of chunks) {
      for (let off = 0; off < chunk.length; off += MAX_SINK_CHUNK) {
        entry.push(chunk.length <= MAX_SINK_CHUNK ? chunk : chunk.subarray(off, Math.min(chunk.length, off + MAX_SINK_CHUNK)), false)
        await drain()
      }
    }
    entry.push(new Uint8Array(0), true)
    await drain()
  }

  const exported: AssetMeta[] = []
  const missingAssets: string[] = []
  let assetBytes = 0
  let manifest: ArchiveManifest
  try {
    await addEntry(ENTRY_NODES, jsonlBatches(nodes))
    await addEntry(ENTRY_EVENTS, jsonlBatches(events))
    phase = 'assets'
    for (const meta of metas) {
      const blob = await store.getBlob(meta.id)
      if (!blob) {
        missingAssets.push(meta.id)
        continue
      }
      await addEntry(assetEntryName(meta.id), streamChunks(blob.stream()))
      exported.push(meta)
      assetBytes += blob.size
    }
    manifest = {
      format: ARCHIVE_FORMAT,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: now,
      origin: opts.origin ?? defaultOrigin(),
      appVersion: opts.appVersion ?? APP_VERSION,
      settings,
      counts: { nodes: nodes.length, live: nodes.length - trash, trash, events: events.length, assets: exported.length, assetBytes },
      recordsHash,
    }
    await addEntry(ENTRY_ASSETS, [new TextEncoder().encode(JSON.stringify(exported))])
    await addEntry(ENTRY_MANIFEST, [new TextEncoder().encode(JSON.stringify(manifest, null, 2))])
    zip.end()
    phase = 'done'
    await drain()
    await sink.close()
  } catch (error) {
    zip.terminate()
    await sink.abort?.(error)
    throw error
  }
  return { manifest, bytes: written, missingAssets }
}

/** Local-time stamp for file names: YYYY-MM-DD-HHmm. */
export function fileStamp(epochMs: number): string {
  const d = new Date(epochMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export function defaultArchiveName(now = Date.now()): string {
  return `hyperspace-${fileStamp(now)}.zip`
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (opts: {
    suggestedName?: string
    id?: string
    types?: { description?: string; accept: Record<string, string[]> }[]
  }) => Promise<FileSystemFileHandle>
}

export type SaveResult = { method: 'picker' | 'download'; result: ExportResult } | { method: 'cancelled' }

/**
 * User-facing export: a native save dialog streaming straight to disk where available
 * (Chrome), otherwise Blob parts and a download link (Safari, Firefox).
 */
export async function saveArchive(store: WorldStore, opts: ExportOptions & { suggestedName?: string } = {}): Promise<SaveResult> {
  const name = opts.suggestedName ?? defaultArchiveName(opts.now)
  const picker = (globalThis as SaveFilePickerWindow).showSaveFilePicker
  if (typeof picker === 'function') {
    let handle: FileSystemFileHandle
    try {
      handle = await picker({
        suggestedName: name,
        id: 'hyperspace-export',
        types: [{ description: 'Hyperspace archive', accept: { 'application/zip': ['.zip'] } }],
      })
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') return { method: 'cancelled' }
      throw e
    }
    const writable = await handle.createWritable()
    return { method: 'picker', result: await exportArchive(store, writableSink(writable), opts) }
  }
  const sink = blobSink()
  const result = await exportArchive(store, sink, opts)
  const url = URL.createObjectURL(sink.blob())
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.rel = 'noopener'
    document.body.append(a)
    a.click()
    a.remove()
  } finally {
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return { method: 'download', result }
}

// ─── zip reading (central directory) ───────────────────────────────────────────────

interface ZipEntry {
  name: string
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
}

interface ZipIndex {
  entries: Map<string, ZipEntry>
  /** Offset of the central directory: no entry data may extend past it. */
  cdOffset: number
}

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64_LOCATOR = 0x07064b50

async function readRange(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer())
}

async function readZipIndex(file: Blob): Promise<ZipIndex> {
  const head = await readRange(file, 0, 4)
  const looksZip = head.length === 4 && (u32(head, 0) === SIG_LOCAL || u32(head, 0) === SIG_EOCD)
  if (!looksZip) throw new ArchiveError('not-zip', 'This file is not a Hyperspace archive (not a zip file).')
  const tailLen = Math.min(file.size, EOCD_BYTES + 0xffff)
  const tailStart = file.size - tailLen
  const tail = await readRange(file, tailStart, file.size)
  let p = -1
  for (let i = tail.length - EOCD_BYTES; i >= 0; i--) {
    // The comment length must reach exactly to the end of the file, which rules out a
    // signature that merely occurs inside the comment or the last entry.
    if (u32(tail, i) === SIG_EOCD && i + EOCD_BYTES + u16(tail, i + 20) === tail.length) {
      p = i
      break
    }
  }
  if (p < 0) throw new ArchiveError('truncated', 'The archive is incomplete (no end-of-archive record). Was the download or copy cut short?')
  const eocdOffset = tailStart + p
  const disk = u16(tail, p + 4)
  const cdDisk = u16(tail, p + 6)
  const diskEntries = u16(tail, p + 8)
  const count = u16(tail, p + 10)
  const cdSize = u32(tail, p + 12)
  const cdOffset = u32(tail, p + 16)
  const locator = eocdOffset >= 20 ? await readRange(file, eocdOffset - 20, eocdOffset - 16) : null
  if (count === 0xffff || cdSize === 0xffff_ffff || cdOffset === 0xffff_ffff || (locator && u32(locator, 0) === SIG_EOCD64_LOCATOR)) {
    throw new ArchiveError('zip64', 'This archive uses zip64 (over 4 GiB or 65 535 entries), which this app cannot read.')
  }
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== count) throw new ArchiveError('unsupported', 'Multi-part zip archives are not supported.')
  if (cdOffset + cdSize !== eocdOffset) throw new ArchiveError('corrupt', 'The archive directory is damaged.')

  const cd = await readRange(file, cdOffset, cdOffset + cdSize)
  const entries = new Map<string, ZipEntry>()
  const dec = new TextDecoder()
  let i = 0
  for (let k = 0; k < count; k++) {
    if (i + 46 > cd.length || u32(cd, i) !== SIG_CENTRAL) throw new ArchiveError('corrupt', 'The archive directory is damaged.')
    const nameLen = u16(cd, i + 28)
    const extraLen = u16(cd, i + 30)
    const commentLen = u16(cd, i + 32)
    const entry: ZipEntry = {
      flags: u16(cd, i + 8),
      method: u16(cd, i + 10),
      crc: u32(cd, i + 16),
      compressedSize: u32(cd, i + 20),
      size: u32(cd, i + 24),
      localOffset: u32(cd, i + 42),
      name: dec.decode(cd.subarray(i + 46, i + 46 + nameLen)),
    }
    if (entry.compressedSize === 0xffff_ffff || entry.size === 0xffff_ffff || entry.localOffset === 0xffff_ffff) {
      throw new ArchiveError('zip64', 'This archive uses zip64 entries, which this app cannot read.')
    }
    if (entry.flags & 1) throw new ArchiveError('unsupported', 'Encrypted archives are not supported.')
    if (entries.has(entry.name)) throw new ArchiveError('corrupt', `The archive lists ${entry.name} twice.`)
    if (!entry.name.endsWith('/')) entries.set(entry.name, entry)
    i += 46 + nameLen + extraLen + commentLen
  }
  return { entries, cdOffset }
}

/** [start, end) of an entry's (possibly compressed) data in the file. */
async function dataRange(file: Blob, index: ZipIndex, entry: ZipEntry): Promise<[number, number]> {
  const lh = await readRange(file, entry.localOffset, entry.localOffset + 30)
  if (lh.length < 30 || u32(lh, 0) !== SIG_LOCAL) throw new ArchiveError('corrupt', `The archive entry ${entry.name} is damaged.`)
  const start = entry.localOffset + 30 + u16(lh, 26) + u16(lh, 28)
  const end = start + entry.compressedSize
  if (end > index.cdOffset) throw new ArchiveError('corrupt', `The archive entry ${entry.name} is damaged.`)
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ArchiveError('unsupported', `The archive entry ${entry.name} uses an unsupported compression method (${entry.method}).`)
  }
  if (entry.method === 0 && entry.compressedSize !== entry.size) throw new ArchiveError('corrupt', `The archive entry ${entry.name} is damaged.`)
  return [start, end]
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32Update(crc: number, data: Uint8Array): number {
  let c = ~crc
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

/** Uncompressed chunks of one entry; verifies size and CRC once the entry is fully read. */
async function* entryChunks(file: Blob, index: ZipIndex, entry: ZipEntry): AsyncGenerator<Uint8Array> {
  const [start, end] = await dataRange(file, index, entry)
  let crc = 0
  let size = 0
  const raw = streamChunks(file.slice(start, end).stream())
  if (entry.method === 0) {
    for await (const chunk of raw) {
      crc = crc32Update(crc, chunk)
      size += chunk.length
      yield chunk
    }
  } else {
    const out: Uint8Array[] = []
    let inflateError: unknown = null
    const inflate = new Inflate((chunk) => out.push(chunk))
    const take = function* () {
      while (out.length) {
        const c = out.shift()!
        crc = crc32Update(crc, c)
        size += c.length
        yield c
      }
    }
    for await (const chunk of raw) {
      try {
        inflate.push(chunk, false)
      } catch (e) {
        inflateError = e
        break
      }
      yield* take()
    }
    if (!inflateError) {
      try {
        inflate.push(new Uint8Array(0), true)
      } catch (e) {
        inflateError = e
      }
    }
    if (inflateError) throw new ArchiveError('corrupt', `The archive entry ${entry.name} is damaged.`, { cause: inflateError })
    yield* take()
  }
  if (size !== entry.size || crc !== entry.crc) {
    throw new ArchiveError('corrupt', `The archive entry ${entry.name} is damaged (checksum mismatch).`)
  }
}

async function drainEntry(file: Blob, index: ZipIndex, entry: ZipEntry, onBytes: (n: number) => void): Promise<void> {
  for await (const chunk of entryChunks(file, index, entry)) onBytes(chunk.length)
}

async function entryText(file: Blob, index: ZipIndex, entry: ZipEntry, max: number): Promise<string> {
  if (entry.size > max) throw new ArchiveError('corrupt', `The archive entry ${entry.name} is implausibly large.`)
  const dec = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  try {
    for await (const chunk of entryChunks(file, index, entry)) text += dec.decode(chunk, { stream: true })
    return text + dec.decode()
  } catch (e) {
    if (e instanceof ArchiveError) throw e
    throw new ArchiveError('corrupt', `The archive entry ${entry.name} is not valid UTF-8.`, { cause: e })
  }
}

async function* entryJsonLines(file: Blob, index: ZipIndex, entry: ZipEntry): AsyncGenerator<unknown> {
  const dec = new TextDecoder('utf-8', { fatal: true })
  let rest = ''
  let lineNo = 0
  const parse = (line: string): unknown => {
    lineNo++
    try {
      return JSON.parse(line)
    } catch (e) {
      throw new ArchiveError('corrupt', `${entry.name} line ${lineNo} is not valid JSON.`, { cause: e })
    }
  }
  try {
    for await (const chunk of entryChunks(file, index, entry)) {
      rest += dec.decode(chunk, { stream: true })
      let from = 0
      for (let nl = rest.indexOf('\n'); nl >= 0; nl = rest.indexOf('\n', from)) {
        const line = rest.slice(from, nl)
        from = nl + 1
        if (line.trim()) yield parse(line)
      }
      rest = rest.slice(from)
    }
    rest += dec.decode()
  } catch (e) {
    if (e instanceof ArchiveError) throw e
    throw new ArchiveError('corrupt', `${entry.name} is not valid UTF-8.`, { cause: e })
  }
  if (rest.trim()) yield parse(rest)
}

// ─── validation of parsed content ──────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const INTERACTION_KINDS: readonly InteractionKind[] = ['dwell', 'inspect', 'enter', 'demon-match']

function checkManifest(raw: unknown): ArchiveManifest {
  if (!isObj(raw) || raw.format !== ARCHIVE_FORMAT) {
    throw new ArchiveError('wrong-format', 'This zip is not a Hyperspace archive (manifest format mismatch).')
  }
  if (!isNum(raw.formatVersion) || raw.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveError(
      'wrong-version',
      isNum(raw.formatVersion) && raw.formatVersion > ARCHIVE_FORMAT_VERSION
        ? `This archive was written by a newer version of the app (format ${raw.formatVersion}). Update the app to import it.`
        : `Unsupported archive format version ${String(raw.formatVersion)}.`,
    )
  }
  if (!isNum(raw.schemaVersion) || !Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) {
    throw new ArchiveError('corrupt', 'The archive manifest has no valid schemaVersion.')
  }
  if (raw.schemaVersion > SCHEMA_VERSION) {
    throw new ArchiveError('newer-schema', `This archive uses data schema ${raw.schemaVersion}; this app understands up to ${SCHEMA_VERSION}. Update the app.`)
  }
  const s = raw.settings
  if (s !== null && !(isObj(s) && isNum(s.T0))) throw new ArchiveError('corrupt', 'The archive manifest has invalid settings (T0 missing).')
  const c = raw.counts
  if (!isObj(c) || !isNum(c.nodes) || !isNum(c.events) || !isNum(c.assets)) {
    throw new ArchiveError('corrupt', 'The archive manifest has no valid counts.')
  }
  if (typeof raw.recordsHash !== 'string' || !/^[0-9a-f]{64}$/.test(raw.recordsHash)) {
    throw new ArchiveError('corrupt', 'The archive manifest has no valid recordsHash.')
  }
  return raw as unknown as ArchiveManifest
}

function checkNode(v: unknown, line: number): NodeRecord {
  const ok =
    isObj(v) &&
    typeof v.id === 'string' &&
    v.id !== '' &&
    typeof v.title === 'string' &&
    typeof v.slug === 'string' &&
    typeof v.contentMd === 'string' &&
    ARCHETYPES.includes(v.archetype as NodeRecord['archetype']) &&
    isNum(v.temporalOrigin) &&
    Array.isArray(v.anchorXZ) &&
    v.anchorXZ.length === 2 &&
    v.anchorXZ.every(isNum) &&
    Array.isArray(v.tags) &&
    Array.isArray(v.links) &&
    Array.isArray(v.attachments) &&
    isObj(v.thermo) &&
    (v.deletedAt === null || isNum(v.deletedAt))
  if (!ok) throw new ArchiveError('corrupt', `${ENTRY_NODES} line ${line} is not a valid record.`)
  return v as unknown as NodeRecord
}

function checkEvent(v: unknown, line: number): InteractionEvent {
  const ok =
    isObj(v) &&
    typeof v.id === 'string' &&
    isNum(v.t) &&
    typeof v.nodeId === 'string' &&
    INTERACTION_KINDS.includes(v.kind as InteractionKind)
  if (!ok) throw new ArchiveError('corrupt', `${ENTRY_EVENTS} line ${line} is not a valid event.`)
  return v as unknown as InteractionEvent
}

function checkAssetIndex(raw: unknown): AssetMeta[] {
  if (!Array.isArray(raw)) throw new ArchiveError('corrupt', `${ENTRY_ASSETS} is not a list.`)
  const seen = new Set<string>()
  for (const m of raw) {
    if (!isObj(m) || typeof m.id !== 'string' || m.id === '' || typeof m.kind !== 'string' || typeof m.mime !== 'string') {
      throw new ArchiveError('corrupt', `${ENTRY_ASSETS} has an invalid entry.`)
    }
    if (seen.has(m.id)) throw new ArchiveError('corrupt', `${ENTRY_ASSETS} lists ${m.id} twice.`)
    seen.add(m.id)
  }
  return raw as AssetMeta[]
}

// ─── import ────────────────────────────────────────────────────────────────────────

export interface ParsedArchive {
  manifest: ArchiveManifest
  nodes: NodeRecord[]
  events: InteractionEvent[]
  assets: AssetMeta[]
  /** Uncompressed bytes of each asset, ready to hand to store.putBlob. */
  assetData(id: string): Promise<Blob>
}

/**
 * Read and fully validate an archive without touching any store: structure, manifest,
 * every line of nodes/events, the records hash, and the CRC of every asset.
 */
export async function readArchive(file: Blob, onProgress?: (p: ArchiveProgress) => void): Promise<ParsedArchive> {
  if (file.size > ZIP32_MAX_BYTES) throw new ArchiveError('zip64', 'Archives over 4 GiB (zip64) are not supported.')
  const index = await readZipIndex(file)
  const need = (name: string) => {
    const e = index.entries.get(name)
    if (!e) throw new ArchiveError('missing-entry', `The archive has no ${name}.`)
    return e
  }
  let manifestRaw: unknown
  try {
    manifestRaw = JSON.parse(await entryText(file, index, need(ENTRY_MANIFEST), MAX_MANIFEST_BYTES))
  } catch (e) {
    if (e instanceof ArchiveError) throw e
    throw new ArchiveError('corrupt', `${ENTRY_MANIFEST} is not valid JSON.`, { cause: e })
  }
  const manifest = checkManifest(manifestRaw)

  const total = file.size
  let done = 0
  const tick = (phase: ArchiveProgress['phase']) => (n: number) => {
    done += n
    onProgress?.({ phase, done, total })
  }

  const nodes: NodeRecord[] = []
  const ids = new Set<string>()
  for await (const v of entryJsonLines(file, index, need(ENTRY_NODES))) {
    const n = checkNode(v, nodes.length + 1)
    if (ids.has(n.id)) throw new ArchiveError('corrupt', `${ENTRY_NODES} contains record ${n.id} twice.`)
    ids.add(n.id)
    nodes.push(n)
  }
  if (nodes.length !== manifest.counts.nodes) {
    throw new ArchiveError('corrupt', `The archive should hold ${manifest.counts.nodes} records but has ${nodes.length}.`)
  }
  if ((await hashRecords(nodes)) !== manifest.recordsHash) {
    throw new ArchiveError('hash-mismatch', 'The records do not match the archive checksum; the archive is damaged or was edited.')
  }
  tick('records')(need(ENTRY_NODES).size)

  const events: InteractionEvent[] = []
  const eventsEntry = index.entries.get(ENTRY_EVENTS)
  if (eventsEntry) {
    for await (const v of entryJsonLines(file, index, eventsEntry)) events.push(checkEvent(v, events.length + 1))
  }
  if (events.length !== manifest.counts.events) {
    throw new ArchiveError('corrupt', `The archive should hold ${manifest.counts.events} events but has ${events.length}.`)
  }

  let assets: AssetMeta[] = []
  const indexEntry = index.entries.get(ENTRY_ASSETS)
  if (indexEntry) {
    try {
      assets = checkAssetIndex(JSON.parse(await entryText(file, index, indexEntry, MAX_ASSET_INDEX_BYTES)))
    } catch (e) {
      if (e instanceof ArchiveError) throw e
      throw new ArchiveError('corrupt', `${ENTRY_ASSETS} is not valid JSON.`, { cause: e })
    }
  }
  if (assets.length !== manifest.counts.assets) {
    throw new ArchiveError('corrupt', `The archive should hold ${manifest.counts.assets} assets but has ${assets.length}.`)
  }
  const verify = tick('verify')
  for (const meta of assets) await drainEntry(file, index, need(assetEntryName(meta.id)), verify)

  return {
    manifest,
    nodes,
    events,
    assets,
    async assetData(id) {
      const entry = need(assetEntryName(id))
      if (entry.method === 0) {
        const [start, end] = await dataRange(file, index, entry)
        // Zero-copy: the store streams this slice of the user's file straight into OPFS.
        return file.slice(start, end)
      }
      const parts: BlobPart[] = []
      for await (const chunk of entryChunks(file, index, entry)) parts.push(chunk as Uint8Array<ArrayBuffer>)
      return new Blob(parts)
    },
  }
}

/** Where pre-import backups go. The default is OPFS 'backups/'. */
export interface BackupTarget {
  /** Stream an archive into a backup called `name`; resolves once it is stored. */
  write(name: string, fill: (sink: ArchiveSink) => Promise<unknown>): Promise<void>
  /** Keep only the newest `keep` backups. */
  prune(keep: number): Promise<void>
  read?(name: string): Promise<Blob | undefined>
}

export function opfsBackupTarget(root?: FileSystemDirectoryHandle | null): BackupTarget {
  return {
    async write(name, fill) {
      const pipe = new TransformStream<Uint8Array, Uint8Array>()
      const writing = writeBackup(name, pipe.readable, root)
      // If the OPFS side fails before it starts reading, nothing drains the pipe and the
      // exporter would wait on backpressure forever: cancel the readable to error the writer.
      writing.catch((e) => pipe.readable.cancel(e).catch(() => {}))
      try {
        await fill(writableSink(pipe.writable))
      } catch (e) {
        await writing.catch(() => {})
        throw e
      }
      await writing
    },
    async prune(keep) {
      await pruneBackups(keep, root)
    },
    read: (name) => readBackup(name, root),
  }
}

export function preImportBackupName(now: number): string {
  return `pre-import-${new Date(now).toISOString()}.zip`
}

export interface ImportOptions {
  /** Pre-import backup destination. Default: OPFS. */
  backup?: BackupTarget
  /**
   * Proceed when no backup target is usable (OPFS missing). Only for a caller that has
   * already made the user confirm, e.g. after offering a manual export.
   */
  allowWithoutBackup?: boolean
  /** kv keys kept across the replace (device-local state). Default DEVICE_KV_KEYS. */
  preserveKv?: readonly string[]
  onProgress?: (p: ArchiveProgress) => void
  now?: number
}

export interface ImportResult {
  manifest: ArchiveManifest
  nodes: number
  events: number
  assets: number
  /** Name of the pre-import backup, or null when none was taken (allowWithoutBackup). */
  backupName: string | null
}

/**
 * Import = REPLACE. Order: (1) read and validate the whole archive; any failure here leaves
 * the store untouched. (2) Stream a backup of the current world to the backup target and
 * prune to the newest 3. (3) Wipe and write everything. If (3) fails, try to restore the
 * backup; the error carries backupName either way.
 */
export async function importArchive(store: WorldStore, file: Blob, opts: ImportOptions = {}): Promise<ImportResult> {
  const now = opts.now ?? Date.now()
  const parsed = await readArchive(file, opts.onProgress)

  let target: BackupTarget | null = opts.backup ?? null
  if (!target && (await backupsAvailable())) target = opfsBackupTarget()
  if (!target && !opts.allowWithoutBackup) {
    throw new ArchiveError('backup-unavailable', 'Cannot take the automatic pre-import backup here (no private file system). Export your world manually first.')
  }
  let backupName: string | null = null
  if (target) {
    backupName = preImportBackupName(now)
    const name = backupName
    opts.onProgress?.({ phase: 'backup', done: 0, total: 1 })
    try {
      await target.write(name, (sink) => exportArchive(store, sink, { now }))
      await target.prune(PRE_IMPORT_BACKUPS_KEPT)
    } catch (e) {
      throw new ArchiveError('backup-failed', 'The pre-import backup failed, so nothing was imported.', { cause: e })
    }
  }

  const marker: ImportMarker = { backupName, startedAt: now }
  try {
    await replaceWorld(store, parsed, opts, marker)
  } catch (e) {
    const err = new ArchiveError('import-failed', 'The import failed part-way.', { cause: e })
    if (backupName && target?.read) {
      const backup = await target.read(backupName).catch(() => undefined)
      if (backup) {
        try {
          await replaceWorld(store, await readArchive(backup), opts, marker)
          err.message = 'The import failed part-way; your previous world was restored from the automatic backup.'
        } catch {
          err.message = `The import failed part-way and the automatic restore failed too. Your previous world is in the backup ${backupName}.`
        }
      }
    }
    if (backupName) err.backupName = backupName
    throw err
  }
  opts.onProgress?.({ phase: 'done', done: 1, total: 1 })
  return {
    manifest: parsed.manifest,
    nodes: parsed.nodes.length,
    events: parsed.events.length,
    assets: parsed.assets.length,
    backupName,
  }
}

async function replaceWorld(store: WorldStore, parsed: ParsedArchive, opts: ImportOptions, marker: ImportMarker): Promise<void> {
  const keys = opts.preserveKv ?? DEVICE_KV_KEYS
  const kept = await Promise.all(keys.map(async (k) => [k, await store.getKv(k)] as const))
  const total = parsed.nodes.length + parsed.events.length + parsed.assets.length
  let done = 0
  const step = (n: number) => {
    done += n
    opts.onProgress?.({ phase: 'write', done, total })
  }

  await store.wipe()
  await store.putKv(IMPORT_MARKER_KV, marker)
  if (parsed.manifest.settings) await store.putSettings(parsed.manifest.settings)
  if (parsed.nodes.length) await store.putNodes(parsed.nodes)
  step(parsed.nodes.length)
  for (const e of parsed.events) {
    await store.appendEvent(e)
    step(1)
  }
  for (const meta of parsed.assets) {
    await store.putBlob({ meta, data: await parsed.assetData(meta.id) })
    step(1)
  }
  for (const [k, v] of kept) if (v !== undefined) await store.putKv(k, v)
  await store.deleteKv(IMPORT_MARKER_KV)
}
