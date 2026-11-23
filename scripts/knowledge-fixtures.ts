import { createHash, randomUUID } from 'node:crypto'
import type { KnowledgeSnapshot } from '../src/knowledge/types.ts'

/** Synthetic retained evidence; no personal workspace is opened by the benchmarks. */
export function knowledgeFixture(count: number): { snapshot: KnowledgeSnapshot; original: Uint8Array; queries: string[] } {
  const snapshot: KnowledgeSnapshot = { schemaVersion: 1, revision: 1, sources: [], versions: [], passages: [], imports: [], proposals: [], jobs: [] }
  const originals: string[] = []
  const topics = ['navigation', 'architecture', 'ecology', 'acoustics', 'history', 'logistics', 'astronomy', 'materials']
  for (let i = 0; i < count; i++) {
    const sourceId = randomUUID(), versionId = randomUUID(), passageId = randomUUID(), topic = topics[i % topics.length]
    const title = `${topic} field note ${i}`
    const text = `Field note ${i} records ${topic} evidence for the amber lighthouse research project. Reserve capacity is ${12 + i % 37} hours. The team inspected records and retained the original measurements. A source citation distinguishes observed facts from proposed explanations. Follow up with a second measurement before changing the design. Locator beacon${i} identifies this particular observation.`
    snapshot.sources.push({ id: sourceId, externalId: `fixture/note-${i}.md`, title, kind: 'document', currentVersionId: versionId, createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: true, tags: [topic] })
    snapshot.versions.push({ id: versionId, sourceId, text, contentHash: createHash('sha256').update(text).digest('hex'), originalBlobId: 'fixture-original', originalName: 'fixture.jsonl', createdAt: 1, authoredAt: 1, origin: 'import', metadata: { record: i } })
    snapshot.passages.push({ id: passageId, sourceId, versionId, title, text, start: 0, end: text.length, role: i % 9 === 0 ? 'third-party' : 'human', authoredAt: 1 })
    originals.push(JSON.stringify({ title, text }))
  }
  return { snapshot, original: new TextEncoder().encode(originals.join('\n') + '\n'), queries: ['amber lighthouse', 'navigation reserve capacity', `beacon${Math.floor(count / 2)}`, 'source citation proposed explanations', 'architecture original measurements'] }
}

export function timingSummary(samples: readonly number[]): { samples: number; p50Ms: number; p95Ms: number; minMs: number; maxMs: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  if (!sorted.length) throw new Error('A timing summary requires at least one observation.')
  const rounded = (number: number) => Math.round(number * 1000) / 1000
  return { samples: sorted.length, p50Ms: rounded(sorted[Math.ceil(sorted.length * 0.5) - 1]), p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]), minMs: rounded(sorted[0]), maxMs: rounded(sorted[sorted.length - 1]) }
}
