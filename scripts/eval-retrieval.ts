import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KnowledgeIndex } from '../server/knowledgeIndex.ts'
import { rankKnowledge } from '../src/knowledge/retrieval.ts'
import { eligibleEvidence } from '../src/knowledge/evidencePolicy.ts'
import { buildEvidencePacket } from '../src/knowledge/contextPacket.ts'
import { artifactContext } from '../src/knowledge/artifacts/policy.ts'
import { emptyArtifacts, type ArtifactSnapshot, type PageKind, type ReviewState } from '../src/knowledge/artifacts/types.ts'
import type { Authorship, KnowledgeSnapshot, SearchFilters, SearchHit, SourceKind } from '../src/knowledge/types.ts'

interface FixturePassage { id: string; text: string; role: Authorship; authoredAt: string | null; repeat?: number; invalidOffset?: boolean }
interface FixtureVersion { id: string; passages: FixturePassage[] }
interface FixtureSource { id: string; title: string; kind: SourceKind; aiAllowed?: boolean; excluded?: boolean; deleted?: boolean; versions: FixtureVersion[] }
interface FixtureContext { id: string; kind: PageKind; title: string; content: string; status: ReviewState; sourceIds: string[]; passageIds: string[] }
type FixtureFilters = Omit<SearchFilters, 'authoredAfter' | 'authoredBefore'> & { authoredAfter?: string; authoredBefore?: string }
interface EvalQuestion {
  id: string; question: string; query: string; relevance: Record<string, number>; filters?: FixtureFilters
  requiredPassageIds?: string[]; forbiddenPassageIds?: string[]; forbiddenPacketPassageIds?: string[]; expectEmpty?: boolean
  mutation?: { sourceId: string; aiAllowed?: boolean; excluded?: boolean; deleted?: boolean }; cachedBeforeMutation?: boolean
  packet?: { maxBytes?: number; requiredContextIds?: string[]; forbiddenContextIds?: string[]; minEvidenceOmissions?: number; minContextOmissions?: number }
}
export interface RetrievalEvalFixture { schemaVersion: 1; description: string; cutoff: number; sources: FixtureSource[]; contexts: FixtureContext[]; questions: EvalQuestion[] }
interface SourceMetrics { recall: number; reciprocalRank: number; ndcg: number; sourceRanking: string[] }
export interface EvalCaseResult {
  id: string; question: string; query: string; filters: SearchFilters; relevantSources: Record<string, number>
  retrievedPassageIds: string[]; sourceRanking: string[]; metrics: Omit<SourceMetrics, 'sourceRanking'> | null
  packet: { evidenceIds: string[]; contextIds: string[]; evidenceOmissions: number; contextOmissions: number; bytes: number; maxBytes: number }
  checks: Record<string, boolean>; failures: string[]
}
interface EvalEngineResult { engine: string; questions: number; rankedQuestions: number; abstentionQuestions: number; correctAbstentions: number; recallAtK: number; mrrAtK: number; ndcgAtK: number; invariantChecks: number; invariantFailures: number; cases: EvalCaseResult[] }

/** Every source gets one ranked position, even when many matching passages belong to it. */
export function sourceRankingMetrics(hits: readonly Pick<SearchHit, 'sourceId'>[], relevance: Readonly<Record<string, number>>, cutoff: number): SourceMetrics {
  const sourceRanking = [...new Set(hits.map((hit) => hit.sourceId))].slice(0, cutoff)
  const relevant = Object.keys(relevance).filter((id) => relevance[id] > 0)
  const first = sourceRanking.findIndex((id) => relevance[id] > 0)
  const gain = (grade: number, index: number) => (2 ** grade - 1) / Math.log2(index + 2)
  const dcg = sourceRanking.reduce((sum, id, index) => sum + gain(relevance[id] ?? 0, index), 0)
  const ideal = relevant.map((id) => relevance[id]).sort((a, b) => b - a).slice(0, cutoff).reduce((sum, grade, index) => sum + gain(grade, index), 0)
  return { sourceRanking, recall: relevant.length ? sourceRanking.filter((id) => relevance[id] > 0).length / relevant.length : 0, reciprocalRank: first < 0 ? 0 : 1 / (first + 1), ndcg: ideal ? dcg / ideal : 0 }
}

export async function loadRetrievalEvalFixture(): Promise<RetrievalEvalFixture> {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/retrieval-eval.v1.json', import.meta.url), 'utf8')) as RetrievalEvalFixture
  if (fixture.schemaVersion !== 1 || fixture.questions.length !== 50 || new Set(fixture.questions.map((q) => q.id)).size !== 50) throw new Error('The evaluation requires exactly fifty distinct fixture questions.')
  const sources = new Set(fixture.sources.map((source) => source.id))
  const passages = new Set(fixture.sources.flatMap((source) => source.versions.flatMap((version) => version.passages.map((passage) => passage.id))))
  for (const q of fixture.questions) {
    if (Object.keys(q.relevance).some((id) => !sources.has(id)) || [...q.requiredPassageIds ?? [], ...q.forbiddenPassageIds ?? [], ...q.forbiddenPacketPassageIds ?? []].some((id) => !passages.has(id))) throw new Error(`Unknown fixture relevance or citation identity in ${q.id}.`)
  }
  return fixture
}

export function buildEvalCorpus(fixture: RetrievalEvalFixture): KnowledgeSnapshot {
  const snapshot: KnowledgeSnapshot = { schemaVersion: 1, revision: 1, sources: [], versions: [], passages: [], imports: [], jobs: [], proposals: [] }
  const recordedAt = Date.UTC(2026, 10, 23)
  for (const source of fixture.sources) {
    snapshot.sources.push({ id: source.id, externalId: `synthetic:${source.id}`, title: source.title, kind: source.kind, currentVersionId: source.versions.at(-1)!.id, createdAt: recordedAt, updatedAt: recordedAt, excluded: source.excluded ?? false, aiAllowed: source.aiAllowed ?? true, deleted: source.deleted ?? false, tags: [] })
    for (const [index, version] of source.versions.entries()) {
      let text = ''
      for (const passage of version.passages) {
        const body = passage.text.repeat(passage.repeat ?? 1), start = text.length
        text += body
        snapshot.passages.push({ id: passage.id, sourceId: source.id, versionId: version.id, title: source.title, text: body, start: passage.invalidOffset ? start + 1 : start, end: text.length, role: passage.role, authoredAt: passage.authoredAt === null ? null : Date.parse(passage.authoredAt), locator: `synthetic fixture paragraph ${version.passages.indexOf(passage) + 1}` })
        text += '\n\n'
      }
      snapshot.versions.push({ id: version.id, sourceId: source.id, contentHash: `synthetic:${version.id}`, originalBlobId: `synthetic-original:${version.id}`, originalName: `${source.id}.md`, text, createdAt: recordedAt + index, authoredAt: null, origin: 'import', previousVersionId: source.versions[index - 1]?.id })
    }
  }
  return snapshot
}

export function buildEvalArtifacts(fixture: RetrievalEvalFixture, snapshot: KnowledgeSnapshot): ArtifactSnapshot {
  const artifacts = emptyArtifacts()
  for (const context of fixture.contexts) {
    const revisionId = `${context.id}-revision`, now = Date.UTC(2026, 10, 23)
    artifacts.pages.push({ id: context.id, title: context.title, kind: context.kind, sourceIds: context.sourceIds, question: null, currentRevisionId: context.status === 'accepted' ? revisionId : null, projectedNodeId: null, createdAt: now, updatedAt: now, archivedAt: null })
    artifacts.pageRevisions.push({ id: revisionId, pageId: context.id, previousRevisionId: null, contentMd: context.content, evidence: context.passageIds.map((id) => { const passage = snapshot.passages.find((item) => item.id === id)!; return { passageId: id, sourceVersionId: passage.versionId, relation: 'context' } }), recordedAt: now, acceptedAt: context.status === 'accepted' ? now : null, status: context.status, manual: true, inputHash: 'synthetic-fixture', generator: 'manual', correction: context.content })
  }
  return artifacts
}

function filtersFor(question: EvalQuestion): SearchFilters {
  const { authoredAfter, authoredBefore, ...filters } = question.filters ?? {}
  return { aiOnly: true, ...filters, ...(authoredAfter ? { authoredAfter: Date.parse(authoredAfter) } : {}), ...(authoredBefore ? { authoredBefore: Date.parse(authoredBefore) } : {}) }
}
function exactCitation(hit: SearchHit, snapshot: KnowledgeSnapshot): boolean {
  const version = snapshot.versions.find((version) => version.id === hit.versionId && version.sourceId === hit.sourceId)
  const original = snapshot.passages.find((passage) => passage.id === hit.id && passage.versionId === hit.versionId)
  return !!version && !!original && Number.isSafeInteger(hit.start) && Number.isSafeInteger(hit.end) && hit.start >= 0 && hit.end >= hit.start && version.text.slice(hit.start, hit.end) === hit.text && original.role === hit.role && original.authoredAt === hit.authoredAt && original.locator === hit.locator
}

/** Runs production lexical and packet code only. No model, remote service or upstream installer is invoked. */
export async function runRetrievalEvaluation(input?: RetrievalEvalFixture) {
  const fixture = input ?? await loadRetrievalEvalFixture()
  const original = buildEvalCorpus(fixture), artifacts = buildEvalArtifacts(fixture, original)
  const engines: EvalEngineResult[] = []
  for (const engine of ['sqlite-fts5', 'portable-lexical'] as const) {
    const database = engine === 'sqlite-fts5' ? new DatabaseSync(':memory:') : null
    database?.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, deleted_at INTEGER)')
    const index = database ? new KnowledgeIndex(database) : null
    const search = (snapshot: KnowledgeSnapshot, question: EvalQuestion, filters: SearchFilters) => {
      if (!index) return rankKnowledge(snapshot, question.query, filters)
      index.update(snapshot)
      return index.search(question.query, filters).hits
    }
    const cases: EvalCaseResult[] = []
    try {
      for (const question of fixture.questions) {
        const filters = filtersFor(question), snapshot = structuredClone(original)
        const cached = question.cachedBeforeMutation ? search(original, question, filters) : []
        const cachedContext = question.cachedBeforeMutation ? artifactContext(artifacts, original, { sourceIds: filters.sourceIds }) : []
        if (question.mutation) { const { sourceId, ...policy } = question.mutation; Object.assign(snapshot.sources.find((source) => source.id === sourceId)!, policy); snapshot.revision++ }
        const hits = search(snapshot, question, filters)
        const candidates = [...new Map([...hits, ...cached].map((hit) => [hit.id, hit])).values()]
        const context = [...new Map([...artifactContext(artifacts, snapshot, { sourceIds: filters.sourceIds }), ...cachedContext].map((entry) => [entry.id, entry])).values()]
        const packet = buildEvidencePacket(question.question, snapshot, candidates, context, { filters, maxBytes: question.packet?.maxBytes })
        const rendered = JSON.parse(packet.rendered) as { evidence: { id: string; text: string; citationUrl: string }[]; context: { id: string; content: string }[] }
        const hitIds = hits.map((hit) => hit.id), evidenceIds = packet.evidence.map((hit) => hit.id), contextIds = packet.context.map((entry) => entry.id)
        const valid = candidates.filter((hit) => eligibleEvidence(snapshot, hit, { ...filters, aiOnly: true }))
        const checks: Record<string, boolean> = {
          exactSourceVersionOffsetsAndAttribution: hits.every((hit) => exactCitation(hit, snapshot)),
          currentPolicyAndRoleDateSourceScope: hits.every((hit) => eligibleEvidence(snapshot, hit, filters)),
          requiredEvidenceRetrieved: (question.requiredPassageIds ?? []).every((id) => hitIds.includes(id)),
          forbiddenEvidenceOmitted: (question.forbiddenPassageIds ?? []).every((id) => !hitIds.includes(id)),
          absentEvidenceAbstention: !question.expectEmpty || hits.length === 0,
          deliveryRechecksCurrentPolicy: packet.evidence.every((hit) => eligibleEvidence(snapshot, hit, { ...filters, aiOnly: true })) && (question.forbiddenPacketPassageIds ?? []).every((id) => !evidenceIds.includes(id)),
          deliveredExactCitations: packet.evidence.every((hit) => exactCitation(hit, snapshot) && hit.citationUrl === `#/library?passage=${encodeURIComponent(hit.id)}`),
          renderedEvidenceEqualsDelivery: rendered.evidence.length === packet.evidence.length && rendered.evidence.every((hit, i) => hit.id === packet.evidence[i].id && hit.text === packet.evidence[i].text && hit.citationUrl === packet.evidence[i].citationUrl),
          renderedContextEqualsDelivery: rendered.context.length === packet.context.length && rendered.context.every((entry, i) => entry.id === packet.context[i].id && entry.content === packet.context[i].content),
          requiredApprovedContextDelivered: (question.packet?.requiredContextIds ?? []).every((id) => contextIds.includes(id)),
          unapprovedOrRestrictedContextOmitted: (question.packet?.forbiddenContextIds ?? []).every((id) => !contextIds.includes(id)) && packet.context.every((entry) => entry.evidence.every((ref) => { const passage = snapshot.passages.find((passage) => passage.id === ref.passageId && passage.versionId === ref.sourceVersionId); return !!passage && eligibleEvidence(snapshot, passage, { ...filters, aiOnly: true }) })),
          byteBudgetMeasured: new TextEncoder().encode(packet.rendered).byteLength === packet.bytes && packet.bytes <= packet.maxBytes,
          evidenceOmissionsAccounted: packet.omitted.evidenceCount === valid.length - packet.evidence.length && packet.omitted.evidenceCount >= (question.packet?.minEvidenceOmissions ?? 0),
          contextOmissionsReported: packet.omitted.contextCount >= (question.packet?.minContextOmissions ?? 0),
        }
        const { sourceRanking, ...metrics } = sourceRankingMetrics(hits, question.relevance, fixture.cutoff)
        cases.push({ id: question.id, question: question.question, query: question.query, filters, relevantSources: question.relevance, retrievedPassageIds: hitIds, sourceRanking, metrics: Object.keys(question.relevance).length ? metrics : null, packet: { evidenceIds, contextIds, evidenceOmissions: packet.omitted.evidenceCount, contextOmissions: packet.omitted.contextCount, bytes: packet.bytes, maxBytes: packet.maxBytes }, checks, failures: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name) })
      }
    } finally { database?.close() }
    const ranked = cases.filter((result) => result.metrics !== null)
    const average = (key: keyof Omit<SourceMetrics, 'sourceRanking'>) => ranked.reduce((sum, result) => sum + result.metrics![key], 0) / ranked.length
    const abstentions = cases.filter((result) => Object.keys(result.relevantSources).length === 0)
    engines.push({ engine, questions: cases.length, rankedQuestions: ranked.length, abstentionQuestions: abstentions.length, correctAbstentions: abstentions.filter((result) => result.retrievedPassageIds.length === 0).length, recallAtK: average('recall'), mrrAtK: average('reciprocalRank'), ndcgAtK: average('ndcg'), invariantChecks: cases.reduce((sum, result) => sum + Object.keys(result.checks).length, 0), invariantFailures: cases.reduce((sum, result) => sum + result.failures.length, 0), cases })
  }
  return { schemaVersion: 1, fixture: 'tests/fixtures/retrieval-eval.v1.json', description: fixture.description, cutoff: fixture.cutoff, generatedAt: new Date().toISOString(), limitations: ['Synthetic fixtures measure regression behavior on known evidence, not real-user retrieval quality.', 'No semantic model or answer generation is evaluated; answer faithfulness and belief correctness remain unassessed.', 'Source-level rankings deduplicate passages by full source identity. MRR and graded nDCG use cutoff 5. Empty relevance cases are scored as abstention, outside ranking averages.', 'Context delivery means the exact approved text is present in the rendered provider packet; it does not claim that a model attended to or followed it.'], engines }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const report = await runRetrievalEvaluation()
  const output = process.argv[2] ?? fileURLToPath(new URL('../docs/evaluations/retrieval-eval.v1.json', import.meta.url))
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  for (const engine of report.engines) console.log(`${engine.engine}: n=${engine.questions}, source recall@5=${engine.recallAtK.toFixed(4)}, MRR@5=${engine.mrrAtK.toFixed(4)}, nDCG@5=${engine.ndcgAtK.toFixed(4)}, abstentions=${engine.correctAbstentions}/${engine.abstentionQuestions}, invariant failures=${engine.invariantFailures}/${engine.invariantChecks}`)
  console.log(`Detailed report: ${output}`)
  if (report.engines.some((engine) => engine.invariantFailures > 0)) process.exitCode = 1
}
