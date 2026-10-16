import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { bytesSink, exportArchive, importArchive } from '../../src/data/archive.ts'
import { hashRecords } from '../../src/data/hash.ts'
import { createHttpStore, probeEngine } from '../../src/data/httpStore.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { buildDemoWorld } from '../../src/data/seed/demo.ts'
import { SCHEMA_VERSION, type NodeRecord, type WorldSettings } from '../../src/domain/types.ts'
import { serverVectorStore } from '../../src/ai/vectorStore.ts'
import { EMBED_DIM, truncateNormalize } from '../../src/ai/embedText.ts'
import { startTestEngine } from '../helpers/engine.ts'

const T0 = Date.UTC(1990, 4, 17)
const NOW = Date.UTC(2026, 9, 16)

const settings: WorldSettings = {
  T0,
  yPerYear: 12,
  stepsPerYear: 600,
  physicsSeed: 42,
  qualityTier: 'auto',
  firstRunComplete: true,
  lastBackupAt: null,
  autoBackupEnabled: false,
  createdAt: NOW,
  schemaVersion: SCHEMA_VERSION,
}

function unit(seed: number): Float32Array {
  const v = new Float32Array(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) v[i] = Math.sin(seed * 12.9898 + i * 78.233)
  return truncateNormalize(v, EMBED_DIM)
}

describe('SQLite engine: migration fidelity', () => {
  it('a world copied from IndexedDB-shaped storage into SQLite through the archive keeps its records hash', async () => {
    const source = createMemoryStore()
    const demo = buildDemoWorld(T0, NOW)
    // Exercise every optional field and an unknown future key.
    const extra = {
      ...demo[0],
      id: '00000000-0000-4000-8000-00000000beef',
      slug: 'extra-fields',
      provenance: { source: 'omnibox', state: 'refined', raw: 'typed text', refinedAt: NOW },
      referenceDate: { epochMs: Date.UTC(1872, 0, 1), precision: 'year', label: 'H-theorem' },
      futureField: { nested: [1, 'two', null] },
    } as unknown as NodeRecord
    await source.putSettings(settings)
    await source.putNodes([...demo, extra])
    await source.appendEvent({ id: 'e1', t: NOW, kind: 'inspect', nodeId: extra.id, amplitude: 0.5 })
    await source.putBlob({ meta: { id: 'b1', kind: 'image', mime: 'image/png', bytes: 3, createdAt: NOW, nodeId: extra.id }, data: new Uint8Array([1, 2, 3]) })

    const sink = bytesSink()
    const exported = await exportArchive(source, sink, { now: NOW })
    const engine = await startTestEngine()
    const target = createHttpStore({ base: engine.base })
    const imported = await importArchive(target, new Blob([sink.bytes() as Uint8Array<ArrayBuffer>]), { allowWithoutBackup: true, now: NOW })

    expect(imported.nodes).toBe(demo.length + 1)
    expect(await hashRecords(await target.listNodes())).toBe(exported.manifest.recordsHash)
    expect(await hashRecords(await target.listNodes())).toBe(await hashRecords(await source.listNodes()))
    expect(await target.getSettings()).toEqual(settings)
    expect(await target.listEvents()).toEqual(await source.listEvents())
    expect([...new Uint8Array(await (await target.getBlob('b1'))!.arrayBuffer())]).toEqual([1, 2, 3])
    const back = await target.getNode(extra.id)
    expect(back).toEqual(extra)

    // And back again: SQLite → archive → a fresh store is still the same world.
    const sink2 = bytesSink()
    await exportArchive(target, sink2, { now: NOW })
    const again = createMemoryStore()
    await importArchive(again, new Blob([sink2.bytes() as Uint8Array<ArrayBuffer>]), { allowWithoutBackup: true, now: NOW })
    expect(await hashRecords(await again.listNodes())).toBe(exported.manifest.recordsHash)
  })

  it('reports health, and probeEngine fails soft when nothing listens', async () => {
    const engine = await startTestEngine()
    expect(await probeEngine(engine.base)).toEqual({ ok: true, engine: 'sqlite', embeddingDim: 512, refine: false })
    expect(await probeEngine('http://127.0.0.1:9/api', fetch, 500)).toBeNull()
  })
})

describe('SQLite engine: vector index (sqlite-vec)', () => {
  it('stores, replaces, ranks by cosine and deletes 512-d embeddings', async () => {
    const engine = await startTestEngine()
    const vs = serverVectorStore(engine.base)
    const a = unit(1)
    const b = unit(2)
    const c = unit(3)
    await vs.put('a', a, 'h1')
    await vs.put('b', b, 'h1')
    await vs.put('c', c, 'h1')
    await vs.put('a', a, 'h2') // upsert
    expect((await vs.meta()).find((m) => m.id === 'a')?.hash).toBe('h2')
    const hits = await vs.knn(a, 2)
    expect(hits[0].id).toBe('a')
    expect(hits[0].distance).toBeLessThan(1e-5)
    expect(hits).toHaveLength(2)
    const all = await vs.all()
    expect([...all.keys()].sort()).toEqual(['a', 'b', 'c'])
    expect(Array.from(all.get('b')!)).toEqual(Array.from(b))
    await vs.delete('b')
    expect((await vs.knn(b, 5)).map((h) => h.id)).not.toContain('b')
    // Embeddings are derived: a world wipe keeps them, an explicit clear removes them.
    await createHttpStore({ base: engine.base }).wipe()
    expect((await vs.meta()).length).toBe(2)
    await vs.clear()
    expect(await vs.meta()).toEqual([])
  })

  it('rejects vectors of the wrong size', async () => {
    const engine = await startTestEngine()
    const res = await fetch(`${engine.base}/embeddings/x`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vector: [1, 2, 3], hash: 'h', model: 'm' }),
    })
    expect(res.status).toBe(400)
  })
})
