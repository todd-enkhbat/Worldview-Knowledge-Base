// node scripts/bench-knowledge.ts [--samples 30] [--sizes 1000,10000,50000]
// Durable SQLite + localhost HTTP capture/search path. No UI/model timing is implied.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { createApiHandler } from '../server/api.ts'
import { openWorldDb } from '../server/worldDb.ts'
import { createHttpStore } from '../src/data/httpStore.ts'
import { makeNodeDraft } from '../src/domain/validate.ts'
import { diffKnowledgeSnapshots } from '../src/knowledge/storage.ts'
import type { KnowledgeSnapshot, SearchHit } from '../src/knowledge/types.ts'
import { knowledgeFixture, timingSummary } from './knowledge-fixtures.ts'

const option = (key: string, fallback: string) => { const index = process.argv.indexOf(key); return index < 0 ? fallback : process.argv[index + 1] ?? fallback }
const samples = Number(option('--samples', '30')), sizes = option('--sizes', '1000,10000,50000').split(',').map(Number)
if (!Number.isSafeInteger(samples) || samples < 5 || samples > 1000 || sizes.some((size) => !Number.isSafeInteger(size) || size < 1 || size > 100_000)) throw new Error('Use 5–1000 samples and corpus sizes from 1 to 100000.')
const results: Record<string, unknown>[] = []
console.log(`Knowledge storage/API benchmark: ${process.version}; ${cpus()[0]?.model}; ${samples} measured samples per operation.`)
for (const size of sizes) {
  const directory = await mkdtemp(join(tmpdir(), 'worldview-knowledge-bench-')), blobDir = join(directory, 'blobs')
  await mkdir(blobDir)
  const db = openWorldDb(join(directory, 'world.sqlite')), server = createServer(createApiHandler({ db, blobDir }))
  let store: ReturnType<typeof createHttpStore> | undefined
  try {
    const fixture = knowledgeFixture(size)
    const seedStart = performance.now()
    await writeFile(join(blobDir, 'fixture-original'), fixture.original)
    db.putAssetMeta({ id: 'fixture-original', kind: 'file', bytes: fixture.original.length, mime: 'application/x-ndjson', createdAt: 1, nodeId: null })
    db.putKv('knowledge.v1', fixture.snapshot)
    const seedMs = performance.now() - seedStart
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
    store = createHttpStore({ base })
    let snapshot = fixture.snapshot
    const capture: number[] = [], diff: number[] = [], searchHttp: number[] = [], searchSqlite: number[] = [], revisions: number[] = [], deltaBytes: number[] = []
    const search = async (query: string) => {
      const response = await fetch(`${base}/world/knowledge-search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, filters: { aiOnly: true, limit: 20 } }) })
      if (!response.ok) throw new Error(`Search failed: ${response.status}`)
      const result = await response.json() as { revision: number; hits: SearchHit[] }
      if (!result.hits.length) throw new Error(`Fixture query returned no evidence: ${query}`)
      return result
    }
    // Warm transport/SQLite paths separately from the measured samples.
    await store.getKnowledgeRevision!()
    for (const query of fixture.queries) await search(query)
    for (let sample = 0; sample < samples + 3; sample++) {
      const start = performance.now(), now = Date.now()
      const text = `Captured benchmark observation ${sample}. Amber lighthouse reserve inspection confirms a new evidence record. ${'Retain the exact original and its human attribution. '.repeat(6)}`
      const id = randomUUID(), versionId = randomUUID(), passageId = randomUUID(), blobId = randomUUID()
      const node = makeNodeDraft('idea', { title: `Capture ${sample}`, contentMd: text, anchorXZ: [40, 20], temporalOrigin: now })
      const bytes = new TextEncoder().encode(text), meta = { id: blobId, kind: 'file' as const, bytes: bytes.length, mime: 'text/plain', createdAt: now, nodeId: node.id }
      await store.putBlob({ meta, data: bytes })
      const revision = await store.getKnowledgeRevision!()
      if (revision !== snapshot.revision) throw new Error('The isolated benchmark corpus changed unexpectedly.')
      const next: KnowledgeSnapshot = { ...snapshot, revision: revision + 1,
        sources: [...snapshot.sources, { id, externalId: `capture:${id}`, kind: 'thought', title: node.title, currentVersionId: versionId, nodeId: node.id, createdAt: now, updatedAt: now, excluded: false, aiAllowed: true, tags: [] }],
        versions: [...snapshot.versions, { id: versionId, sourceId: id, text, contentHash: createHash('sha256').update(bytes).digest('hex'), originalBlobId: blobId, originalName: 'thought.txt', createdAt: now, authoredAt: now, origin: 'capture' }],
        passages: [...snapshot.passages, { id: passageId, sourceId: id, versionId, nodeId: node.id, text, title: node.title, start: 0, end: text.length, authoredAt: now, role: 'human' }],
      }
      const diffStart = performance.now(), delta = diffKnowledgeSnapshots(snapshot, next), diffMs = performance.now() - diffStart
      const options = { expectedRevision: revision, idempotencyKey: randomUUID(), nodes: [node], expectedNodes: { [node.id]: null }, assets: [meta] }
      if (!await store.commitKnowledge!(delta, options)) throw new Error('Benchmark capture unexpectedly conflicted.')
      if (sample >= 3) { capture.push(performance.now() - start); diff.push(diffMs); deltaBytes.push(Buffer.byteLength(JSON.stringify({ delta, options }))) }
      snapshot = next
    }
    for (let sample = 0; sample < samples; sample++) {
      const query = fixture.queries[sample % fixture.queries.length]
      let start = performance.now(); const direct = db.searchKnowledge(query, { aiOnly: true, limit: 20 }); searchSqlite.push(performance.now() - start)
      if (!direct.hits.length) throw new Error('SQLite fixture search returned no evidence.')
      start = performance.now(); await search(query); searchHttp.push(performance.now() - start)
      start = performance.now(); if (await store.getKnowledgeRevision!() !== snapshot.revision) throw new Error('Revision mismatch'); revisions.push(performance.now() - start)
    }
    const item = { sources: size, seedMs: Math.round(seedMs), originalBytes: fixture.original.length, initialLogicalJsonBytes: Buffer.byteLength(JSON.stringify(fixture.snapshot)), capture: timingSummary(capture), clientDiff: timingSummary(diff), searchHttp: timingSummary(searchHttp), searchSqlite: timingSummary(searchSqlite), revisionHttp: timingSummary(revisions), captureDeltaBytes: { min: Math.min(...deltaBytes), max: Math.max(...deltaBytes) }, verifiedCapturedRows: samples + 3 }
    results.push(item)
    console.log(`${size} sources: capture p50/p95 ${item.capture.p50Ms}/${item.capture.p95Ms} ms; HTTP search ${item.searchHttp.p50Ms}/${item.searchHttp.p95Ms} ms; delta ${item.captureDeltaBytes.min}–${item.captureDeltaBytes.max} B.`)
  } finally {
    store?.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}
await mkdir('bench-results', { recursive: true })
const file = `bench-results/knowledge-${new Date().toISOString().slice(0, 10)}.json`
await writeFile(file, JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model, os: `${platform()} ${release()}`, memoryBytes: totalmem(), samples, methodology: 'Synthetic current-version corpus, one passage per source, exact retained NDJSON original; durable temporary SQLite. Capture includes creation, blob HTTP retention, cheap revision read, full client identity diff, atomic delta+node+asset HTTP commit, and FTS publication. Three capture warmups excluded. Search uses five rotating exact/phrase/common queries; HTTP includes JSON response parsing. No browser rendering, embeddings, QMD native runtime, or model quality is measured.', nativeQmd: 'Not installed or executed by this benchmark. See scripts/compare-qmd.ts for explicit opt-in lexical comparison.', results }, null, 2) + '\n')
console.log(`Wrote ${file}; all temporary databases/originals removed.`)
