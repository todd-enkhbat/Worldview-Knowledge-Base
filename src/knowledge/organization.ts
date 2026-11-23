import { topicWords } from './retrieval.ts'
import type { KnowledgeSnapshot, KnowledgeSource } from './types.ts'

interface CachedTerms { versionId: string; title: string; terms: string[] }
const pairKey = (a: string, b: string) => a < b ? `${a}\0${b}` : `${b}\0${a}`

/** Disposable lexical candidate index. Durable jobs and review decisions live in the ledger. */
export class OrganizationIndex {
  private readonly sources = new Map<string, CachedTerms>()
  private readonly byTerm = new Map<string, string[]>()

  isPrepared(source: KnowledgeSource): boolean {
    const cached = this.sources.get(source.id)
    return cached?.versionId === source.currentVersionId && cached.title === source.title
  }

  private remove(id: string): void {
    const previous = this.sources.get(id)
    if (!previous) return
    for (const term of previous.terms) {
      const next = this.byTerm.get(term)?.filter((sourceId) => sourceId !== id) ?? []
      if (next.length) this.byTerm.set(term, next)
      else this.byTerm.delete(term)
    }
    this.sources.delete(id)
  }

  /** Tokenize changed sources only, yielding regularly so capture can continue meanwhile. */
  async prepare(snapshot: KnowledgeSnapshot, active: () => boolean = () => true): Promise<boolean> {
    const eligible = snapshot.sources.filter((source) => source.nodeId && !source.excluded && !source.deleted)
    const ids = new Set(eligible.map((source) => source.id))
    for (const id of this.sources.keys()) if (!ids.has(id)) this.remove(id)
    const versions = new Map(snapshot.versions.map((version) => [version.id, version]))
    let changed = 0
    for (const source of eligible) {
      if (!active()) return false
      const previous = this.sources.get(source.id)
      if (previous?.versionId === source.currentVersionId && previous.title === source.title) continue
      this.remove(source.id)
      const text = versions.get(source.currentVersionId)?.text
      if (text === undefined) continue
      const terms = topicWords(`${source.title}\n${text}`, 12)
      this.sources.set(source.id, { versionId: source.currentVersionId, title: source.title, terms })
      for (const term of terms) {
        const bucket = this.byTerm.get(term) ?? []
        bucket.push(source.id)
        // Recommendations inspect a bounded recent candidate pool for each term.
        if (bucket.length > 64) bucket.shift()
        this.byTerm.set(term, bucket)
      }
      if (++changed % 48 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    return active()
  }

  /** Only the requested changed sources produce suggestions; accepted/rejected pairs persist. */
  suggest(snapshot: KnowledgeSnapshot, sourceIds: readonly string[]): number {
    const sources = new Map(snapshot.sources.filter((source) => source.nodeId && !source.pendingProjection && !source.excluded && !source.deleted).map((source) => [source.id, source]))
    const passages = new Map<string, typeof snapshot.passages>()
    for (const passage of snapshot.passages) {
      const key = `${passage.sourceId}\0${passage.versionId}`
      const group = passages.get(key) ?? []
      group.push(passage)
      passages.set(key, group)
    }
    const known = new Map(snapshot.proposals.map((proposal) => [pairKey(proposal.sourceNodeId, proposal.targetNodeId), proposal]))
    let changed = 0
    for (const id of sourceIds) {
      const source = sources.get(id)
      const cached = this.sources.get(id)
      if (!source || !cached || cached.versionId !== source.currentVersionId || cached.title !== source.title) continue
      const candidates = new Map<string, { source: KnowledgeSource; terms: string[] }>()
      for (const term of cached.terms) {
        for (const candidateId of this.byTerm.get(term) ?? []) {
          if (candidateId === id) continue
          const other = sources.get(candidateId)
          if (!other || this.sources.get(candidateId)?.versionId !== other.currentVersionId) continue
          const entry = candidates.get(candidateId) ?? { source: other, terms: [] }
          entry.terms.push(term)
          candidates.set(candidateId, entry)
        }
      }
      for (const { source: other, terms } of [...candidates.values()].sort((a, b) => b.terms.length - a.terms.length || a.source.id.localeCompare(b.source.id)).slice(0, 3)) {
        if (terms.length < 2) continue
        const key = pairKey(source.nodeId!, other.nodeId!)
        const existing = known.get(key)
        if (existing && existing.status !== 'proposed') continue
        const evidence = [source, other].flatMap((item) => (passages.get(`${item.id}\0${item.currentVersionId}`) ?? []).find((passage) => terms.some((term) => passage.text.toLocaleLowerCase('en').includes(term)))?.id ?? [])
        if (evidence.length !== 2) continue
        const explanation = `Both sources mention ${terms.slice(0, 4).join(', ')}. This is a lexical suggestion, not a verified claim.`
        if (existing) {
          if (existing.explanation !== explanation || existing.evidencePassageIds.join() !== evidence.join()) {
            existing.explanation = explanation
            existing.evidencePassageIds = evidence
            changed++
          }
          continue
        }
        const proposal = { id: crypto.randomUUID(), title: `Connect ${source.title} and ${other.title}`, explanation, status: 'proposed' as const, sourceNodeId: source.nodeId!, targetNodeId: other.nodeId!, evidencePassageIds: evidence }
        snapshot.proposals.push(proposal)
        known.set(key, proposal)
        changed++
      }
    }
    return changed
  }
}
