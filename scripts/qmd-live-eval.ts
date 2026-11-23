/** Run the installed local models against consent-free synthetic fixtures only. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { openWorldDb } from '../server/worldDb.ts'
import { QmdService } from '../server/qmdService.ts'
import { qmdInstallation, QMD_CACHE_ROOT } from '../server/qmdRuntime.ts'
import { buildEvalCorpus, loadRetrievalEvalFixture, sourceRankingMetrics } from './eval-retrieval.ts'
import { eligibleEvidence } from '../src/knowledge/evidencePolicy.ts'
import type { SearchFilters } from '../src/knowledge/types.ts'

const directory = await mkdtemp(join(tmpdir(), 'worldview-qmd-eval-')), db = openWorldDb(':memory:')
const service = new QmdService(db, join(directory, 'qmd'))
const hashFile = async (path: string) => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer); return hash.digest('hex') }
try {
  const fixture = await loadRetrievalEvalFixture(), corpus = buildEvalCorpus(fixture)
  db.putKv('knowledge.v1', corpus)
  const ids = corpus.sources.filter((source) => !source.deleted && !source.excluded && source.aiAllowed).map((source) => source.id)
  const indexStart = performance.now(); await service.configure(ids, 'hybrid'); const indexMs = performance.now() - indexStart
  const cases: unknown[] = []
  for (const question of fixture.questions) {
    if (question.mutation || question.filters?.includeHistory || question.filters?.aiOnly === false) { cases.push({ id: question.id, skipped: 'Historical/non-AI-local/mutation cases are covered by authoritative policy tests; native QMD indexes current AI-permitted sources only.' }); continue }
    const { authoredAfter, authoredBefore, ...rest } = question.filters ?? {}
    const filters: SearchFilters = { ...rest, aiOnly: true, limit: 10, ...(authoredAfter ? { authoredAfter: Date.parse(authoredAfter) } : {}), ...(authoredBefore ? { authoredBefore: Date.parse(authoredBefore) } : {}) }
    for (const [mode, candidates] of [['lexical', 10], ['hybrid', 10], ['hybrid', 20], ['hybrid', 40]] as const) {
      const result = await service.search(question.query, filters, { mode, candidates })
      const metrics = Object.values(question.relevance).some((grade) => grade > 0) ? sourceRankingMetrics(result.hits, question.relevance, 5) : null
      const exact = result.hits.every((hit) => eligibleEvidence(corpus, hit, { ...filters, aiOnly: true }))
      cases.push({ id: question.id, question: question.question, query: question.query, mode, candidates, elapsedMs: result.elapsedMs, expectedSources: question.relevance, expectedEmpty: question.expectEmpty ?? false, actualEmpty: result.hits.length === 0, metrics, exactAndAuthorized: exact, hits: result.hits.map(({ id, sourceId, versionId, score }) => ({ id, sourceId, versionId, score })), trace: result.trace })
      if (!exact) throw new Error(`Invalid or unauthorized evidence in QMD question ${question.id}.`)
    }
    console.log(`QMD completed fixture ${question.id}/50`)
  }
  const models = await qmdInstallation()
  const modelProvenance = await Promise.all(models.models.map(async (model) => ({ ...model, sha256: await hashFile(join(QMD_CACHE_ROOT, 'qmd/models', model.file)) })))
  const measured = cases.filter((entry): entry is { mode: string; candidates: number; elapsedMs: number; metrics: { recall: number; reciprocalRank: number; ndcg: number } | null; expectedEmpty: boolean; actualEmpty: boolean; exactAndAuthorized: boolean } => !!entry && typeof entry === 'object' && 'mode' in entry)
  const summaries = [['lexical', 10], ['hybrid', 10], ['hybrid', 20], ['hybrid', 40]].map(([mode, candidates]) => {
    const rows = measured.filter((row) => row.mode === mode && row.candidates === candidates), ranked = rows.filter((row) => row.metrics), negatives = rows.filter((row) => row.expectedEmpty)
    const timing = rows.map((row) => row.elapsedMs).sort((a, b) => a - b)
    return { mode, candidates, queries: rows.length, recallAt5: ranked.reduce((sum, row) => sum + row.metrics!.recall, 0) / ranked.length, mrrAt5: ranked.reduce((sum, row) => sum + row.metrics!.reciprocalRank, 0) / ranked.length, ndcgAt5: ranked.reduce((sum, row) => sum + row.metrics!.ndcg, 0) / ranked.length, exactAuthorized: rows.every((row) => row.exactAndAuthorized), negativeQueries: negatives.length, emptyOnNegativeQueries: negatives.filter((row) => row.actualEmpty).length, latencyMs: { p50: timing[Math.floor(timing.length * .5)], p95: timing[Math.min(timing.length - 1, Math.ceil(timing.length * .95) - 1)] } }
  })
  await mkdir('docs/evaluations', { recursive: true })
  const report = { measuredAt: new Date().toISOString(), package: `@tobilu/qmd@${models.version}`, hardware: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, memoryBytes: totalmem() }, sourceFixture: 'tests/fixtures/retrieval-eval.v1.json', indexMs, index: await service.status(), models: modelProvenance, methodology: 'Actual local embedding, query expansion and reranking. One per-query run for candidate10/20/40, in that order; later candidates reuse local expansion/reranker caches. Timings are descriptive, not controlled cold/warm benchmark claims. Only current AI-permitted source passages are mirrored; historical, non-AI-local and mutation cases are explicitly skipped here and covered by policy tests. Synthetic relevance labels are source-level, conventional recall/MRR/nDCG at5. Nearest-neighbor results for absent evidence are not asserted to establish facts; negative-query behavior is reported separately.', summaries, cases }
  const path = 'docs/evaluations/qmd-live-2026-11-23.json'
  await writeFile(path, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ report: path, indexMs, summaries }, null, 2))
} finally { service.close(); db.close(); await rm(directory, { recursive: true, force: true }) }
