import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION, type AssetMeta, type InteractionEvent, type NodeRecord, type WorldSettings } from '../../src/domain/types.ts'
import { openIdbStore, openWorldStore, StoreClosedError } from '../../src/data/idbStore.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import {
  BACKUPS_DIR,
  BLOBS_DIR,
  backupsAvailable,
  decodeName,
  deleteBackup,
  encodeName,
  listBackups,
  openOpfsBlobDir,
  pruneBackups,
  readBackup,
  writeBackup,
} from '../../src/data/opfs.ts'
import type { StoreInfo, WorldStore } from '../../src/data/WorldStore.ts'

// ─── in-memory FileSystemDirectoryHandle mock ────────────────────────────────────────
// Just enough of the OPFS surface for opfs.ts: directories, files, createWritable with
// swap-file semantics (contents replaced on close, discarded on abort or error).

interface MockOptions {
  noCreateWritable?: boolean
  /** Fail the Nth write() call (1-based) on any writable. */
  failOnWrite?: number
}

let clock = 1_000_000
const err = (name: string) => new DOMException(name, name)

async function chunkBytes(chunk: unknown): Promise<Uint8Array> {
  if (chunk instanceof Blob) return new Uint8Array(await chunk.arrayBuffer())
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk.slice(0))
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice()
  throw new TypeError('unsupported chunk')
}

class MockFileHandle {
  readonly kind = 'file'
  readonly name: string
  bytes = new Uint8Array(0)
  lastModified = ++clock
  createWritable?: () => Promise<WritableStream>
  private readonly opts: MockOptions
  private writes = 0

  constructor(name: string, opts: MockOptions) {
    this.name = name
    this.opts = opts
    if (!opts.noCreateWritable) this.createWritable = async () => this.makeWritable()
  }

  async getFile(): Promise<File> {
    return new File([this.bytes as Uint8Array<ArrayBuffer>], this.name, { lastModified: this.lastModified })
  }

  private makeWritable(): WritableStream {
    const parts: Uint8Array[] = []
    const ws = new WritableStream<unknown>({
      write: async (chunk) => {
        if (this.opts.failOnWrite !== undefined && ++this.writes >= this.opts.failOnWrite) throw err('QuotaExceededError')
        parts.push(await chunkBytes(chunk))
      },
      close: () => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
        let o = 0
        for (const p of parts) {
          out.set(p, o)
          o += p.byteLength
        }
        this.bytes = out
        this.lastModified = ++clock
      },
      abort: () => {
        parts.length = 0
      },
    })
    return Object.assign(ws, {
      async write(data: unknown) {
        const w = ws.getWriter()
        try {
          await w.write(data)
        } finally {
          w.releaseLock()
        }
      },
    })
  }
}

class MockDir {
  readonly kind = 'directory'
  readonly name: string
  readonly entries = new Map<string, MockDir | MockFileHandle>()
  readonly opts: MockOptions

  constructor(name = '', opts: MockOptions = {}) {
    this.name = name
    this.opts = opts
  }

  async getDirectoryHandle(name: string, { create = false } = {}): Promise<MockDir> {
    const e = this.entries.get(name)
    if (e) {
      if (e.kind !== 'directory') throw err('TypeMismatchError')
      return e
    }
    if (!create) throw err('NotFoundError')
    const d = new MockDir(name, this.opts)
    this.entries.set(name, d)
    return d
  }

  async getFileHandle(name: string, { create = false } = {}): Promise<MockFileHandle> {
    const e = this.entries.get(name)
    if (e) {
      if (e.kind !== 'file') throw err('TypeMismatchError')
      return e
    }
    if (!create) throw err('NotFoundError')
    const f = new MockFileHandle(name, this.opts)
    this.entries.set(name, f)
    return f
  }

  async removeEntry(name: string, { recursive = false } = {}): Promise<void> {
    const e = this.entries.get(name)
    if (!e) throw err('NotFoundError')
    if (e.kind === 'directory' && e.entries.size > 0 && !recursive) throw err('InvalidModificationError')
    this.entries.delete(name)
  }

  async *values(): AsyncGenerator<MockDir | MockFileHandle> {
    yield* [...this.entries.values()]
  }
}

const asRoot = (d: MockDir) => d as unknown as FileSystemDirectoryHandle

// ─── fixtures ────────────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 9, 14)

function node(id: string, extra: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id,
    slug: id,
    archetype: 'idea',
    title: `Node ${id}`,
    contentMd: '# hello',
    tags: ['a', 'b'],
    temporalOrigin: Date.UTC(2010, 0, 1),
    temporalPrecision: 'day',
    referenceDate: null,
    thermo: { mass: 1, temperature: 0.5 },
    anchorXZ: [30, 4],
    links: [],
    attachments: [],
    visibility: 'private',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    ...extra,
  }
}

const settings: WorldSettings = {
  T0: Date.UTC(1990, 0, 1),
  yPerYear: 12,
  stepsPerYear: 600,
  physicsSeed: 7,
  qualityTier: 'auto',
  firstRunComplete: true,
  lastBackupAt: null,
  autoBackupEnabled: false,
  createdAt: NOW,
  schemaVersion: SCHEMA_VERSION,
}

const ev = (id: string, t: number): InteractionEvent => ({ id, t, kind: 'dwell', nodeId: 'n1' })
const meta = (id: string, mime = 'application/octet-stream'): AssetMeta => ({ id, kind: 'image', mime, bytes: 0, createdAt: NOW, nodeId: null })

function pseudoRandomBytes(n: number, seed = 0x12345678): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n)
  let x = seed >>> 0
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

async function bytesOf(b: Blob | undefined): Promise<Uint8Array> {
  expect(b).toBeDefined()
  return new Uint8Array(await b!.arrayBuffer())
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))

// ─── the WorldStore contract, run against every adapter ──────────────────────────────

interface Adapter {
  name: string
  info: StoreInfo
  make(): Promise<WorldStore>
  root?: () => MockDir | null
}

let currentRoot: MockDir | null = null
const adapters: Adapter[] = [
  { name: 'memoryStore', info: { kind: 'memory', blobBackend: 'memory' }, make: async () => createMemoryStore() },
  {
    // Node has no navigator.storage: the default open must fall back to IDB blobs.
    name: 'idbStore (no OPFS → idb blobs)',
    info: { kind: 'idb', blobBackend: 'idb' },
    make: () => openIdbStore({ name: `hs-test-${crypto.randomUUID()}` }),
  },
  {
    name: 'idbStore (OPFS mock)',
    info: { kind: 'idb', blobBackend: 'opfs' },
    make: () => openIdbStore({ name: `hs-test-${crypto.randomUUID()}`, opfsRoot: asRoot((currentRoot = new MockDir())) }),
    root: () => currentRoot,
  },
]

describe.each(adapters)('WorldStore contract: $name', (adapter) => {
  let store: WorldStore
  beforeEach(async () => {
    store = await adapter.make()
  })
  afterEach(() => store.close())

  it('reports its backend', () => {
    expect(store.info).toEqual(adapter.info)
  })

  it('round-trips settings as a private copy', async () => {
    expect(await store.getSettings()).toBeNull()
    const s = structuredClone(settings)
    await store.putSettings(s)
    s.T0 = 0
    const got = await store.getSettings()
    expect(got).toEqual(settings)
    got!.physicsSeed = 99
    expect((await store.getSettings())!.physicsSeed).toBe(7)
  })

  it('stores nodes by value, lists them by id, and keeps soft-deleted ones', async () => {
    const b = node('b')
    await store.putNode(b)
    await store.putNode(node('a', { deletedAt: NOW, tags: ['trash'] }))
    await store.putNode(node('c'))
    b.title = 'mutated after put'
    const list = await store.listNodes()
    expect(list.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(list[0].deletedAt).toBe(NOW)
    expect(list[1].title).toBe('Node b')
    const got = (await store.getNode('b'))!
    got.tags.push('mutated')
    expect((await store.getNode('b'))!.tags).toEqual(['a', 'b'])
    expect(await store.getNode('missing')).toBeUndefined()
    await store.putNode(node('b', { title: 'v2' }))
    expect((await store.getNode('b'))!.title).toBe('v2')
    await store.deleteNode('b')
    await store.deleteNode('never-existed')
    expect((await store.listNodes()).map((n) => n.id)).toEqual(['a', 'c'])
  })

  it('putNodes writes a batch, and is all-or-nothing when a record fails mid-batch', async () => {
    await store.putNodes([])
    await store.putNode(node('a'))
    await store.putNodes([node('b'), node('c')])
    expect((await store.listNodes()).map((n) => n.id)).toEqual(['a', 'b', 'c'])

    const missingKey = { ...node('x'), id: undefined } as unknown as NodeRecord
    await expect(store.putNodes([node('a', { title: 'changed' }), node('d'), missingKey, node('e')])).rejects.toThrow()
    const unclonable = { ...node('y'), contentMd: (() => 'fn') as unknown as string }
    await expect(store.putNodes([node('a', { title: 'changed' }), node('f'), unclonable, node('g')])).rejects.toThrow()

    const after = await store.listNodes()
    expect(after.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(after[0].title).toBe('Node a')
  })

  it('appends events, lists them since T in time order, and clears before T', async () => {
    await store.appendEvent(ev('e3', 300))
    await store.appendEvent(ev('e1', 100))
    await store.appendEvent(ev('e2b', 200))
    await store.appendEvent(ev('e2a', 200))
    await store.appendEvent({ ...ev('e4', 400), kind: 'demon-match', demonId: 'd', bits: 1.5, amplitude: 0.3 })
    expect((await store.listEvents()).map((e) => e.id)).toEqual(['e1', 'e2a', 'e2b', 'e3', 'e4'])
    expect((await store.listEvents(200)).map((e) => e.id)).toEqual(['e2a', 'e2b', 'e3', 'e4'])
    expect((await store.listEvents(401)).length).toBe(0)
    expect((await store.listEvents(400))[0]).toEqual({ ...ev('e4', 400), kind: 'demon-match', demonId: 'd', bits: 1.5, amplitude: 0.3 })
    expect(await store.clearEvents(300)).toBe(3)
    expect((await store.listEvents()).map((e) => e.id)).toEqual(['e3', 'e4'])
    expect(await store.clearEvents(0)).toBe(0)
    expect(await store.clearEvents()).toBe(2)
    expect(await store.listEvents()).toEqual([])
  })

  it('round-trips blobs byte-exact (Uint8Array, Blob, 0 bytes, a view, 5 MB)', async () => {
    const small = pseudoRandomBytes(1000, 1)
    await store.putBlob({ meta: meta('u8', 'image/webp'), data: small })
    small[0] ^= 0xff // the store must have copied
    const got = await store.getBlob('u8')
    expect(got!.type).toBe('image/webp')
    expect(sameBytes(await bytesOf(got), pseudoRandomBytes(1000, 1))).toBe(true)

    const text = new Blob(['hello, ', 'world'], { type: 'text/plain' })
    await store.putBlob({ meta: meta('blob', 'text/plain'), data: text })
    expect(await (await store.getBlob('blob'))!.text()).toBe('hello, world')

    await store.putBlob({ meta: meta('empty'), data: new Uint8Array(0) })
    expect((await bytesOf(await store.getBlob('empty'))).byteLength).toBe(0)
    expect((await store.getAssetMeta('empty'))!.bytes).toBe(0)

    const backing = pseudoRandomBytes(64, 2)
    await store.putBlob({ meta: meta('view'), data: backing.subarray(8, 24) })
    expect(sameBytes(await bytesOf(await store.getBlob('view')), backing.subarray(8, 24))).toBe(true)

    const big = pseudoRandomBytes(5 * 1024 * 1024, 3)
    await store.putBlob({ meta: { ...meta('big', 'application/x-spz'), kind: 'splat-interior', nodeId: 'n1' }, data: big })
    expect(sameBytes(await bytesOf(await store.getBlob('big')), big)).toBe(true)
    const bigMeta = (await store.getAssetMeta('big'))!
    expect(bigMeta.bytes).toBe(big.byteLength)
    expect(bigMeta.nodeId).toBe('n1')

    expect((await store.listAssets()).map((a) => a.id)).toEqual(['big', 'blob', 'empty', 'u8', 'view'])

    // Overwrite with fewer bytes, then delete.
    await store.putBlob({ meta: meta('u8', 'image/png'), data: new Uint8Array([1, 2, 3]) })
    expect([...(await bytesOf(await store.getBlob('u8')))]).toEqual([1, 2, 3])
    expect((await store.getBlob('u8'))!.type).toBe('image/png')
    await store.deleteBlob('u8')
    await store.deleteBlob('never-existed')
    expect(await store.getBlob('u8')).toBeUndefined()
    expect(await store.getAssetMeta('u8')).toBeUndefined()
    expect(await store.getBlob('missing')).toBeUndefined()
  })

  it('stores small key/value state by value', async () => {
    expect(await store.getKv('k')).toBeUndefined()
    const v = { dir: 'backups', n: [1, 2, 3], at: NOW }
    await store.putKv('k', v)
    v.n.push(4)
    expect(await store.getKv<typeof v>('k')).toEqual({ dir: 'backups', n: [1, 2, 3], at: NOW })
    await store.putKv('falsy', 0)
    expect(await store.getKv('falsy')).toBe(0)
    await store.deleteKv('k')
    expect(await store.getKv('k')).toBeUndefined()
  })

  it('wipe() removes everything (but not OPFS backups)', async () => {
    const root = adapter.root?.() ?? null
    if (root) await writeBackup('pre-import.zip', new Blob(['zip']), asRoot(root))
    await store.putSettings(settings)
    await store.putNodes([node('a'), node('b', { deletedAt: NOW })])
    await store.appendEvent(ev('e', 1))
    await store.putBlob({ meta: meta('x'), data: new Uint8Array([9]) })
    await store.putKv('k', 1)
    await store.wipe()
    expect(await store.getSettings()).toBeNull()
    expect(await store.listNodes()).toEqual([])
    expect(await store.listEvents()).toEqual([])
    expect(await store.listAssets()).toEqual([])
    expect(await store.getBlob('x')).toBeUndefined()
    expect(await store.getKv('k')).toBeUndefined()
    if (root) {
      expect((await listBackups(asRoot(root))).map((b) => b.name)).toEqual(['pre-import.zip'])
      const blobs = root.entries.get(BLOBS_DIR) as MockDir | undefined
      expect(blobs?.entries.size ?? 0).toBe(0)
    }
    // Still usable after a wipe.
    await store.putNode(node('fresh'))
    expect((await store.listNodes()).map((n) => n.id)).toEqual(['fresh'])
  })
})

// ─── idbStore specifics ──────────────────────────────────────────────────────────────

describe('idbStore', () => {
  afterEach(() => vi.unstubAllGlobals())

  function openRaw(name: string, version: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  it('closes itself and reports when another tab upgrades the schema', async () => {
    const name = `hs-test-${crypto.randomUUID()}`
    const onVersionChange = vi.fn()
    const store = await openIdbStore({ name, opfsRoot: null, onVersionChange })
    await store.putNode(node('a'))
    const newer = await openRaw(name, 2) // succeeds only because the store let go
    expect(onVersionChange).toHaveBeenCalledOnce()
    expect(store.closed).toBe(true)
    await expect(store.listNodes()).rejects.toBeInstanceOf(StoreClosedError)
    newer.close()
  })

  it('reports a versionchange caused by deleteDatabase', async () => {
    const name = `hs-test-${crypto.randomUUID()}`
    const onVersionChange = vi.fn()
    const store = await openIdbStore({ name, opfsRoot: null, onVersionChange })
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    expect(onVersionChange).toHaveBeenCalledOnce()
    expect(store.closed).toBe(true)
  })

  it('persists across reopen', async () => {
    const name = `hs-test-${crypto.randomUUID()}`
    const a = await openIdbStore({ name, opfsRoot: null })
    await a.putSettings(settings)
    await a.putNodes([node('x'), node('y')])
    await a.putBlob({ meta: meta('b'), data: new Uint8Array([4, 5]) })
    a.close()
    await expect(a.getSettings()).rejects.toBeInstanceOf(StoreClosedError)
    const b = await openIdbStore({ name, opfsRoot: null })
    expect(await b.getSettings()).toEqual(settings)
    expect((await b.listNodes()).map((n) => n.id)).toEqual(['x', 'y'])
    expect([...(await bytesOf(await b.getBlob('b')))]).toEqual([4, 5])
    b.close()
  })

  it('openWorldStore falls back to memory without IndexedDB, but rethrows VersionError', async () => {
    const name = `hs-test-${crypto.randomUUID()}`
    ;(await openRaw(name, 5)).close()
    await expect(openWorldStore({ name, opfsRoot: null })).rejects.toMatchObject({ name: 'VersionError' })

    vi.stubGlobal('indexedDB', undefined)
    const opened = await openWorldStore({ opfsRoot: null })
    expect(opened.fallback).toBe(true)
    expect(opened.store.info.kind).toBe('memory')
  })

  it('uses IDB blobs when OPFS lacks createWritable', async () => {
    const store = await openIdbStore({ name: `hs-test-${crypto.randomUUID()}`, opfsRoot: asRoot(new MockDir('', { noCreateWritable: true })) })
    expect(store.info.blobBackend).toBe('idb')
    await store.putBlob({ meta: meta('b'), data: new Uint8Array([1]) })
    expect([...(await bytesOf(await store.getBlob('b')))]).toEqual([1])
    store.close()
  })
})

// ─── opfs.ts against the mock ────────────────────────────────────────────────────────

describe('opfs', () => {
  it('encodes arbitrary ids into safe entry names', () => {
    for (const id of ['a/b\\c', '..', '.hidden', 'ünï cødé', 'plain-uuid-1234']) {
      const enc = encodeName(id)
      expect(enc).not.toMatch(/[/\\]/)
      expect(enc.startsWith('.')).toBe(false)
      expect(decodeName(enc)).toBe(id)
    }
    expect(() => encodeName('')).toThrow(TypeError)
  })

  it('feature-detects a usable blob directory', async () => {
    expect(await openOpfsBlobDir(null)).toBeNull()
    expect(await openOpfsBlobDir(asRoot(new MockDir('', { noCreateWritable: true })))).toBeNull()
    const root = new MockDir()
    expect(await openOpfsBlobDir(asRoot(root))).not.toBeNull()
    // The probe file is cleaned up.
    expect([...(root.entries.get(BLOBS_DIR) as MockDir).entries.keys()]).toEqual([])
    // Node has no navigator.storage.getDirectory.
    expect(await openOpfsBlobDir()).toBeNull()
  })

  it('puts, gets, lists, deletes and clears blobs (streams included)', async () => {
    const root = new MockDir()
    const dir = (await openOpfsBlobDir(asRoot(root)))!
    await dir.put('a/1', new Uint8Array([1, 2, 3]))
    await dir.put('b', new Blob(['xyz']))
    const stream = new Blob([pseudoRandomBytes(100_000, 9)]).stream()
    await dir.put('c', stream)
    expect(await dir.list()).toEqual(['a/1', 'b', 'c'])
    expect([...(await bytesOf(await dir.get('a/1')))]).toEqual([1, 2, 3])
    expect(sameBytes(await bytesOf(await dir.get('c')), pseudoRandomBytes(100_000, 9))).toBe(true)
    await dir.delete('b')
    await dir.delete('b')
    expect(await dir.get('b')).toBeUndefined()
    await dir.clear()
    expect(root.entries.has(BLOBS_DIR)).toBe(false)
    expect(await dir.list()).toEqual([])
  })

  it('a failed write keeps the old bytes, and a failed new file leaves nothing behind', async () => {
    const opts: MockOptions = {}
    const root = new MockDir('', opts)
    const dir = (await openOpfsBlobDir(asRoot(root)))!
    await dir.put('keep', new Uint8Array([7, 7]))
    opts.failOnWrite = 0 // every subsequent write fails
    await expect(dir.put('keep', new Uint8Array([1]))).rejects.toMatchObject({ name: 'QuotaExceededError' })
    await expect(dir.put('new', new Blob(['x']).stream())).rejects.toMatchObject({ name: 'QuotaExceededError' })
    delete opts.failOnWrite
    expect([...(await bytesOf(await dir.get('keep')))]).toEqual([7, 7])
    expect(await dir.get('new')).toBeUndefined()
    expect(await dir.list()).toEqual(['keep'])
  })

  it('manages backups: write (Blob or stream), list newest first, read, prune, delete', async () => {
    const root = asRoot(new MockDir())
    expect(await backupsAvailable(root)).toBe(true)
    expect(await backupsAvailable(asRoot(new MockDir('', { noCreateWritable: true })))).toBe(false)
    expect(await backupsAvailable(null)).toBe(false)
    expect(await listBackups(null)).toEqual([])

    const b1 = await writeBackup('2026-10-01.zip', new Blob(['one']), root)
    expect(b1).toMatchObject({ name: '2026-10-01.zip', bytes: 3 })
    await writeBackup('2026-10-02.zip', new Blob(['two!']).stream(), root)
    await writeBackup('2026-10-03.zip', new Blob(['three']), root)
    expect((await listBackups(root)).map((b) => b.name)).toEqual(['2026-10-03.zip', '2026-10-02.zip', '2026-10-01.zip'])
    expect(await (await readBackup('2026-10-02.zip', root))!.text()).toBe('two!')
    expect(await readBackup('nope.zip', root)).toBeUndefined()

    expect(await pruneBackups(2, root)).toEqual(['2026-10-01.zip'])
    expect((await listBackups(root)).map((b) => b.name)).toEqual(['2026-10-03.zip', '2026-10-02.zip'])
    expect(await deleteBackup('2026-10-03.zip', root)).toBe(true)
    expect(await deleteBackup('2026-10-03.zip', root)).toBe(false)
    expect(await pruneBackups(0, root)).toEqual(['2026-10-02.zip'])
    expect(await listBackups(root)).toEqual([])
    await expect(writeBackup('x.zip', new Blob(['x']), null)).rejects.toThrow()
    expect((root as unknown as MockDir).entries.has(BACKUPS_DIR)).toBe(true)
  })
})
