// Opt-in: WORLDVIEW_KNOWLEDGE_BENCH=1 npm test -- tests/perf/knowledgeBench.test.ts
// Actual application commands over HTTP; normal test runs skip this longer measurement.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cpus, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createApiHandler } from '../../server/api.ts'
import { openWorldDb } from '../../server/worldDb.ts'
import { createHttpStore } from '../../src/data/httpStore.ts'
import { closeRepo, completeFirstRun, initRepo } from '../../src/data/repo.ts'
import { captureThought, initializeKnowledge, resetKnowledge, searchKnowledge, waitForKnowledgeJobs } from '../../src/knowledge/index.ts'
import { knowledgeFixture, timingSummary } from '../../scripts/knowledge-fixtures.ts'

it.skipIf(process.env.WORLDVIEW_KNOWLEDGE_BENCH !== '1')('measures complete application capture/search commands with 1k/10k/50k retained sources', async () => {
  const nativeFetch = globalThis.fetch, rows: Record<string, unknown>[] = [], samples = Number(process.env.WORLDVIEW_BENCH_SAMPLES ?? 30)
  const sizes = (process.env.WORLDVIEW_BENCH_SIZES ?? '1000,10000,50000').split(',').map(Number)
  if (!Number.isSafeInteger(samples) || samples < 5 || samples > 1000 || sizes.some((size) => !Number.isSafeInteger(size) || size < 1 || size > 100_000)) throw new Error('Use 5–1000 samples and corpus sizes from 1 to 100000.')
  const captureBytes = Number(process.env.WORLDVIEW_BENCH_CAPTURE_BYTES ?? 0)
  if (!Number.isSafeInteger(captureBytes) || captureBytes < 0 || captureBytes > 10240) throw new Error('Benchmark capture size must be from 0 (default note) to 10240 bytes.')
  for (const size of sizes) {
    const directory = await mkdtemp(join(tmpdir(), 'worldview-command-bench-')), blobDir = join(directory, 'blobs')
    await mkdir(blobDir)
    const db = openWorldDb(join(directory, 'world.sqlite')), server = createServer(createApiHandler({ db, blobDir }))
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => nativeFetch(typeof input === 'string' && input.startsWith('/') ? origin + input : input, init))
      resetKnowledge()
      await initRepo({ store: createHttpStore({ base: `${origin}/api` }) })
      await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
      const fixture = knowledgeFixture(size)
      await writeFile(join(blobDir, 'fixture-original'), fixture.original)
      db.putAssetMeta({ id: 'fixture-original', kind: 'file', bytes: fixture.original.length, mime: 'application/x-ndjson', createdAt: 1, nodeId: null })
      db.putKv('knowledge.v1', fixture.snapshot)
      await initializeKnowledge()
      process.stdout.write(`Command benchmark initialized ${size} sources.\n`)
      const captures: number[] = [], searches: number[] = [], organization: number[] = []
      for (let sample = 0; sample < samples + 3; sample++) {
        const note = `Benchmark thought ${sample}: amber lighthouse observation confirms reserve capacity. ${'Retain the original words and attribution with the source. '.repeat(6)}`
        const text = captureBytes ? (note + 'Additional retained evidence for this original observation. '.repeat(200)).slice(0, captureBytes - 1) + 'X' : note
        if (captureBytes) expect(new TextEncoder().encode(text).length).toBe(captureBytes)
        let start = performance.now()
        const node = await captureThought(text)
        const captureMs = performance.now() - start
        if (sample === 0) process.stdout.write(`First ${size}-source capture returned after ${captureMs.toFixed(1)} ms.\n`)
        expect(db.getNode(node.id)?.contentMd).toBe(text.trim())
        start = performance.now(); await waitForKnowledgeJobs(); const organizationMs = performance.now() - start
        if (sample === 0) process.stdout.write(`First ${size}-source organization drain returned after ${organizationMs.toFixed(1)} ms.\n`)
        if (sample >= 3) { captures.push(captureMs); organization.push(organizationMs) }
      }
      for (let sample = 0; sample < samples + 3; sample++) {
        const start = performance.now(), hits = await searchKnowledge(fixture.queries[sample % fixture.queries.length], { aiOnly: true, limit: 20 })
        if (sample >= 3) searches.push(performance.now() - start)
        expect(hits.length).toBeGreaterThan(0)
        expect(hits.every((hit) => hit.versionId && hit.sourceId)).toBe(true)
      }
      const row = { sources: size, captureThought: timingSummary(captures), searchKnowledge: timingSummary(searches), organizationDrainAfterCapture: timingSummary(organization) }
      rows.push(row)
      process.stdout.write(`${size} sources: captureThought p50/p95 ${row.captureThought.p50Ms}/${row.captureThought.p95Ms} ms; searchKnowledge ${row.searchKnowledge.p50Ms}/${row.searchKnowledge.p95Ms} ms\n`)
    } finally {
      resetKnowledge(); await closeRepo(); vi.unstubAllGlobals()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close(); await rm(directory, { recursive: true, force: true })
    }
  }
  await mkdir('bench-results', { recursive: true })
  await writeFile(`bench-results/knowledge-commands-${new Date().toISOString().slice(0, 10)}${captureBytes ? `-${captureBytes}b` : ''}.json`, JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model, os: `${platform()} ${release()}`, samples, captureTextBytes: captureBytes || '430–431 bytes after trimming', methodology: 'Actual captureThought and searchKnowledge application commands through initialized repository and localhost HTTP over durable temporary SQLite. Includes original retention, version/passage creation, cached ledger read, Immer drafts, client diff, pending/published projection phases, repository world updates, and final command resolution. Background organization is drained between captures and reported separately. Three warmups excluded. Synthetic one-passage source corpus; initial sources are unprojected documents, captured thoughts become world nodes. No browser rendering, inference, embeddings or native QMD measured.', results: rows }, null, 2) + '\n')
}, 300_000)
