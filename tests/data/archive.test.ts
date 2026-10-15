import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import {
  ArchiveError,
  blobSink,
  bytesSink,
  exportArchive,
  importArchive,
  opfsBackupTarget,
  readArchive,
  ZIP32_MAX_BYTES,
} from '../../src/data/archive.ts'
import type { ArchiveSink, BackupTarget } from '../../src/data/archive.ts'
import { canonicalJson, hashBytes, hashRecords } from '../../src/data/hash.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import type { WorldStore } from '../../src/data/WorldStore.ts'
import { SCHEMA_VERSION } from '../../src/domain/types.ts'
import type { AssetMeta, InteractionEvent, NodeRecord, WorldSettings } from '../../src/domain/types.ts'

const T0 = Date.UTC(1990, 4, 17)
const NOW = Date.UTC(2026, 9, 14, 12, 30)

function settings(): WorldSettings {
  return {
    T0,
    yPerYear: 12,
    stepsPerYear: 600,
    physicsSeed: 1234,
    qualityTier: 'auto',
    firstRunComplete: true,
    lastBackupAt: null,
    autoBackupEnabled: false,
    createdAt: NOW - 1000,
    schemaVersion: SCHEMA_VERSION,
  }
}

function node(id: string, title: string, extra: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    archetype: 'idea',
    title,
    contentMd: `About ${title}.\n\nSecond paragraph with "quotes" and a tab\t.`,
    tags: ['entropy', 'time'],
    temporalOrigin: T0 + 20 * 365 * 86_400_000,
    temporalPrecision: 'month',
    referenceDate: { epochMs: Date.UTC(1872, 0, 1), precision: 'year', label: 'H-theorem' },
    thermo: { mass: 1.5, temperature: 0.4 },
    anchorXZ: [31.25, -12.5],
    links: [],
    attachments: [],
    visibility: 'private',
    createdAt: NOW - 500,
    updatedAt: NOW - 400,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    ...extra,
  }
}

function pseudoRandomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

/** Bytes that contain every zip signature, to prove the reader never scans payloads. */
function withZipSignatures(bytes: Uint8Array): Uint8Array {
  const sigs = [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x07, 0x08],
    [0x50, 0x4b, 0x01, 0x02],
    [0x50, 0x4b, 0x05, 0x06],
  ]
  sigs.forEach((s, k) => bytes.set(s, Math.floor(((k + 1) * bytes.length) / 6)))
  return bytes
}

const imageMeta = (id: string, bytes: number): AssetMeta => ({ id, kind: 'image', mime: 'image/png', bytes, createdAt: NOW - 300, nodeId: 'n-1' })

async function seedWorld(store: WorldStore): Promise<void> {
  await store.putSettings(settings())
  await store.putNodes([
    node('n-1', 'Maxwell’s demon Ψ 🌀', { links: [{ targetId: 'n-2', kind: 'contradicts', label: 'exorcism', createdAt: NOW - 450 }] }),
    node('n-2', "Bennett's exorcism", { archetype: 'document' }),
    node('n-3', 'Trashed thought', { deletedAt: NOW - 100, tags: [] }),
  ])
  const events: InteractionEvent[] = [
    { id: 'e-1', t: NOW - 50, kind: 'inspect', nodeId: 'n-1', amplitude: 1 },
    { id: 'e-2', t: NOW - 40, kind: 'demon-match', nodeId: 'n-2', amplitude: 0.25, demonId: 'n-1', bits: 3.5 },
  ]
  for (const e of events) await store.appendEvent(e)
  const img = withZipSignatures(pseudoRandomBytes(300_000, 7))
  await store.putBlob({ meta: imageMeta('img/1 ä', img.length), data: img })
  const text = strToU8('field notes\nline two\n')
  await store.putBlob({ meta: { id: 'txt-1', kind: 'text', mime: 'text/plain', bytes: text.length, createdAt: NOW - 200, nodeId: 'n-2' }, data: text })
  await store.putKv('autoBackupDir', { device: 'local handle' })
}

async function snapshot(store: WorldStore) {
  const assets = await store.listAssets()
  const blobs: Record<string, string> = {}
  for (const a of assets) blobs[a.id] = await hashBytes((await store.getBlob(a.id))!)
  return {
    settings: await store.getSettings(),
    nodes: await store.listNodes(),
    events: await store.listEvents(),
    assets,
    blobs,
  }
}

function memoryBackup(log: string[] = []): BackupTarget & { blobs: Map<string, Blob> } {
  const blobs = new Map<string, Blob>()
  return {
    blobs,
    async write(name, fill) {
      log.push('backup:start')
      const sink = blobSink()
      await fill(sink)
      blobs.set(name, sink.blob())
      log.push('backup:end')
    },
    async prune(keep) {
      log.push(`prune:${keep}`)
      const names = [...blobs.keys()].sort().reverse()
      for (const n of names.slice(keep)) blobs.delete(n)
    },
    async read(name) {
      return blobs.get(name)
    },
  }
}

const MUTATORS = ['putSettings', 'putNode', 'putNodes', 'deleteNode', 'appendEvent', 'clearEvents', 'putBlob', 'deleteBlob', 'putKv', 'deleteKv', 'wipe'] as const

function spyMutators(store: WorldStore, log?: string[]) {
  return MUTATORS.map((m) => {
    const original = (store[m] as (...a: unknown[]) => Promise<unknown>).bind(store)
    const spy = vi.spyOn(store, m) as unknown as { mockImplementation(fn: (...a: unknown[]) => Promise<unknown>): unknown }
    spy.mockImplementation(async (...args: unknown[]) => {
      log?.push(m)
      return original(...args)
    })
    return spy
  })
}

async function exportBytes(store: WorldStore): Promise<Uint8Array> {
  const sink = bytesSink()
  await exportArchive(store, sink, { now: NOW, origin: 'http://localhost:5173' })
  return sink.bytes()
}

describe('hash', () => {
  it('canonicalJson sorts keys, drops undefined and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [3, { d: undefined, c: 'x' }], e: undefined })).toBe('{"a":[3,{"c":"x"}],"b":1}')
    expect(canonicalJson([undefined, NaN, -0])).toBe('[null,null,0]')
  })

  it('hashRecords is independent of record order and key order', async () => {
    const a = node('a', 'Alpha')
    const b = node('b', 'Beta')
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as unknown as NodeRecord
    expect(await hashRecords([a, b])).toBe(await hashRecords([reordered, a]))
    expect(await hashRecords([a, b])).not.toBe(await hashRecords([a, { ...b, title: 'Beta!' }]))
    expect(await hashRecords([a])).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('archive round trip', () => {
  it('export → import into a fresh store preserves everything byte-exact', async () => {
    const source = createMemoryStore()
    await seedWorld(source)
    const before = await snapshot(source)
    const bytes = await exportBytes(source)

    // A standard zip that other tools can open, entries stored uncompressed.
    const files = unzipSync(bytes)
    expect(Object.keys(files).sort()).toEqual(['assets.json', 'assets/img%2F1%20%C3%A4', 'assets/txt-1', 'events.jsonl', 'manifest.json', 'nodes.jsonl'])
    const manifest = JSON.parse(strFromU8(files['manifest.json']))
    expect(manifest).toMatchObject({
      format: 'hyperspace-archive',
      formatVersion: 1,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: NOW,
      origin: 'http://localhost:5173',
      settings: { T0 },
      counts: { nodes: 3, live: 2, trash: 1, events: 2, assets: 2 },
      recordsHash: await hashRecords(before.nodes),
    })

    const target = createMemoryStore()
    await target.putKv('autoBackupDir', { device: 'target handle' })
    const result = await importArchive(target, new Blob([bytes as Uint8Array<ArrayBuffer>]), { backup: memoryBackup(), now: NOW })
    expect(result).toMatchObject({ nodes: 3, events: 2, assets: 2 })

    const after = await snapshot(target)
    expect(after).toEqual(before)
    expect(await hashRecords(after.nodes)).toBe(await hashRecords(before.nodes))
    // Device-local kv survives the replace; the source's handle is never imported.
    expect(await target.getKv('autoBackupDir')).toEqual({ device: 'target handle' })
  })

  it('streams a 64 MB asset without any buffer over 8 MB in the exporter', async () => {
    const SIZE = 64 * 1024 * 1024
    const big = withZipSignatures(pseudoRandomBytes(SIZE, 99))
    const bigHash = await hashBytes(big)
    const source = createMemoryStore()
    await source.putSettings(settings())
    await source.putNodes([node('n-1', 'Diorama')])
    await source.putBlob({ meta: { ...imageMeta('splat-1', SIZE), kind: 'splat-interior', mime: 'application/octet-stream' }, data: big })

    // The exporter may only stream blobs: whole-buffer reads would throw.
    class StreamOnlyBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error('exporter must stream, not buffer')
      }
      override bytes(): Promise<Uint8Array<ArrayBuffer>> {
        throw new Error('exporter must stream, not buffer')
      }
      override text(): Promise<string> {
        throw new Error('exporter must stream, not buffer')
      }
    }
    const getBlob = source.getBlob.bind(source)
    vi.spyOn(source, 'getBlob').mockImplementation(async (id) => {
      const b = await getBlob(id)
      return b && new StreamOnlyBlob([b])
    })

    const parts: Blob[] = []
    let maxChunk = 0
    let writes = 0
    const progress: number[] = []
    const sink: ArchiveSink = {
      async write(chunk) {
        maxChunk = Math.max(maxChunk, chunk.length)
        writes++
        parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]))
      },
      close() {},
    }
    const { bytes } = await exportArchive(source, sink, { now: NOW, onProgress: (p) => progress.push(p.done) })
    expect(maxChunk).toBeLessThanOrEqual(8 * 1024 * 1024)
    expect(writes).toBeGreaterThan(64)
    expect(bytes).toBeGreaterThan(SIZE)
    expect(progress.at(-1)).toBe(bytes)

    const archive = new Blob(parts)
    expect(archive.size).toBe(bytes)
    const target = createMemoryStore()
    await importArchive(target, archive, { backup: memoryBackup(), now: NOW })
    const imported = (await target.getBlob('splat-1'))!
    expect(imported.size).toBe(SIZE)
    expect(await hashBytes(imported)).toBe(bigHash)
  })
})

describe('archive rejection happens before any write', () => {
  async function fixture() {
    const source = createMemoryStore()
    await seedWorld(source)
    const bytes = await exportBytes(source)
    const target = createMemoryStore()
    await target.putSettings({ ...settings(), T0: T0 - 1 })
    await target.putNodes([node('keep-1', 'Existing world')])
    return { bytes, target, files: unzipSync(bytes) }
  }

  const rezip = (files: Record<string, Uint8Array>) => zipSync(files, { level: 0 })

  const cases: [string, (f: Awaited<ReturnType<typeof fixture>>) => Uint8Array, ArchiveError['code']][] = [
    ['not a zip', () => pseudoRandomBytes(5000, 3), 'not-zip'],
    ['truncated tail', ({ bytes }) => bytes.slice(0, bytes.length - 10), 'truncated'],
    ['truncated half', ({ bytes }) => bytes.slice(0, bytes.length >> 1), 'truncated'],
    [
      'flipped byte in an asset',
      ({ bytes }) => {
        const out = bytes.slice()
        out[Math.floor(out.length / 2)] ^= 0xff
        return out
      },
      'corrupt',
    ],
    [
      'wrong formatVersion',
      ({ files }) => {
        const m = JSON.parse(strFromU8(files['manifest.json']))
        return rezip({ ...files, 'manifest.json': strToU8(JSON.stringify({ ...m, formatVersion: 2 })) })
      },
      'wrong-version',
    ],
    [
      'foreign format',
      ({ files }) => {
        const m = JSON.parse(strFromU8(files['manifest.json']))
        return rezip({ ...files, 'manifest.json': strToU8(JSON.stringify({ ...m, format: 'something-else' })) })
      },
      'wrong-format',
    ],
    [
      'newer schema',
      ({ files }) => {
        const m = JSON.parse(strFromU8(files['manifest.json']))
        return rezip({ ...files, 'manifest.json': strToU8(JSON.stringify({ ...m, schemaVersion: SCHEMA_VERSION + 1 })) })
      },
      'newer-schema',
    ],
    [
      'edited record (valid zip, wrong hash)',
      ({ files }) => rezip({ ...files, 'nodes.jsonl': strToU8(strFromU8(files['nodes.jsonl']).replace('Trashed thought', 'Edited thought')) }),
      'hash-mismatch',
    ],
    [
      'broken JSON line',
      ({ files }) => rezip({ ...files, 'nodes.jsonl': strToU8(strFromU8(files['nodes.jsonl']) + '{"id": oops\n') }),
      'corrupt',
    ],
    [
      'missing asset entry',
      ({ files }) => {
        const rest = { ...files }
        delete rest['assets/txt-1']
        return rezip(rest)
      },
      'missing-entry',
    ],
  ]

  it.each(cases)('%s', async (_label, make, code) => {
    const f = await fixture()
    const before = await snapshot(f.target)
    const backup = memoryBackup()
    const backupWrite = vi.spyOn(backup, 'write')
    const spies = spyMutators(f.target)
    const err = await importArchive(f.target, new Blob([make(f) as Uint8Array<ArrayBuffer>]), { backup, now: NOW }).catch((e) => e)
    expect(err).toBeInstanceOf(ArchiveError)
    expect((err as ArchiveError).code).toBe(code)
    for (const s of spies) expect(s).not.toHaveBeenCalled()
    expect(backupWrite).not.toHaveBeenCalled()
    expect(await snapshot(f.target)).toEqual(before)
  })

  it('refuses to import without a usable backup target unless explicitly allowed', async () => {
    const f = await fixture()
    const spies = spyMutators(f.target)
    const archive = new Blob([f.bytes as Uint8Array<ArrayBuffer>])
    const err = await importArchive(f.target, archive, { now: NOW }).catch((e) => e)
    expect((err as ArchiveError).code).toBe('backup-unavailable')
    for (const s of spies) expect(s).not.toHaveBeenCalled()

    const ok = await importArchive(f.target, archive, { now: NOW, allowWithoutBackup: true })
    expect(ok.backupName).toBeNull()
    expect((await f.target.listNodes()).map((n) => n.id)).toEqual(['n-1', 'n-2', 'n-3'])
  })

  it('accepts a deflate-recompressed archive (e.g. re-zipped by an OS tool)', async () => {
    const f = await fixture()
    const deflated = zipSync(f.files, { level: 6 })
    const parsed = await readArchive(new Blob([deflated as Uint8Array<ArrayBuffer>]))
    expect(parsed.nodes).toHaveLength(3)
    expect(new Uint8Array(await (await parsed.assetData('txt-1')).arrayBuffer())).toEqual(f.files['assets/txt-1'])
  })
})

describe('import = replace with a pre-import backup', () => {
  it('writes the backup of the current world before the wipe, then prunes to 3', async () => {
    const source = createMemoryStore()
    await seedWorld(source)
    const archive = new Blob([(await exportBytes(source)) as Uint8Array<ArrayBuffer>])

    const target = createMemoryStore()
    await target.putSettings({ ...settings(), T0: T0 - 5 })
    await target.putNodes([node('old-1', 'Old world')])
    const oldHash = await hashRecords(await target.listNodes())

    const log: string[] = []
    const backup = memoryBackup(log)
    for (const name of ['pre-import-2020-01-01T00:00:00.000Z.zip', 'pre-import-2021-01-01T00:00:00.000Z.zip', 'pre-import-2022-01-01T00:00:00.000Z.zip']) {
      backup.blobs.set(name, new Blob([]))
    }
    spyMutators(target, log)
    const result = await importArchive(target, archive, { backup, now: NOW })

    expect(result.backupName).toBe(`pre-import-${new Date(NOW).toISOString()}.zip`)
    expect(log.indexOf('backup:end')).toBeGreaterThanOrEqual(0)
    expect(log.indexOf('backup:end')).toBeLessThan(log.indexOf('wipe'))
    expect(log.indexOf('prune:3')).toBeLessThan(log.indexOf('wipe'))
    expect(log.slice(0, log.indexOf('backup:start'))).toEqual([])
    expect([...backup.blobs.keys()]).toHaveLength(3)

    const saved = await readArchive(backup.blobs.get(result.backupName!)!)
    expect(await hashRecords(saved.nodes)).toBe(oldHash)
    expect(saved.manifest.settings?.T0).toBe(T0 - 5)
  })

  it('restores the previous world from the backup when the write phase fails', async () => {
    const source = createMemoryStore()
    await seedWorld(source)
    const archive = new Blob([(await exportBytes(source)) as Uint8Array<ArrayBuffer>])

    const target = createMemoryStore()
    await target.putSettings({ ...settings(), T0: T0 - 5 })
    await target.putNodes([node('old-1', 'Old world')])
    const before = await snapshot(target)

    const putBlob = target.putBlob.bind(target)
    let failures = 1
    vi.spyOn(target, 'putBlob').mockImplementation(async (input) => {
      if (failures-- > 0) throw new Error('disk full')
      return putBlob(input)
    })
    const err = await importArchive(target, archive, { backup: memoryBackup(), now: NOW }).catch((e) => e)
    expect((err as ArchiveError).code).toBe('import-failed')
    expect((err as ArchiveError).backupName).toMatch(/^pre-import-/)
    expect((err as Error).message).toMatch(/restored/)
    expect(await snapshot(target)).toEqual(before)
  })
})

describe('OPFS backup target', () => {
  it('fails cleanly (no hang, no write) when OPFS refuses the backup', async () => {
    const source = createMemoryStore()
    await seedWorld(source)
    const archive = new Blob([(await exportBytes(source)) as Uint8Array<ArrayBuffer>])
    const target = createMemoryStore()
    await target.putNodes([node('old-1', 'Old world')])
    const spies = spyMutators(target)
    const brokenRoot = {
      getDirectoryHandle: async () => {
        throw new DOMException('quota', 'QuotaExceededError')
      },
    } as unknown as FileSystemDirectoryHandle
    const err = await importArchive(target, archive, { backup: opfsBackupTarget(brokenRoot), now: NOW }).catch((e) => e)
    expect((err as ArchiveError).code).toBe('backup-failed')
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })
})

describe('zip32 limit', () => {
  it('refuses an export over 4 GiB before writing a byte', async () => {
    const store = createMemoryStore()
    await store.putSettings(settings())
    const huge = { size: ZIP32_MAX_BYTES + 1, type: '', stream: () => new ReadableStream() } as unknown as Blob
    vi.spyOn(store, 'listAssets').mockResolvedValue([imageMeta('huge', ZIP32_MAX_BYTES + 1)])
    vi.spyOn(store, 'getBlob').mockResolvedValue(huge)
    const write = vi.fn()
    const abort = vi.fn()
    const err = await exportArchive(store, { write, close() {}, abort }).catch((e) => e)
    expect((err as ArchiveError).code).toBe('too-large')
    expect((err as Error).message).toMatch(/4 GiB/)
    expect(write).not.toHaveBeenCalled()
  })
})
