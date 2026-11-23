import type { KnowledgeSnapshot, SearchFilters, SearchHit } from './types.ts'
import type { ArtifactContextEntry } from './artifacts/policy.ts'
import { eligibleEvidence } from './evidencePolicy.ts'

export interface EvidencePacket {
  schemaVersion: 1; question: string; scope: SearchFilters; revision: number
  context: ArtifactContextEntry[]
  evidence: (SearchHit & { citationUrl: string })[]
  omitted: { evidence: string[]; context: string[]; evidenceCount: number; contextCount: number }
  maxBytes: number; bytes: number; rendered: string
  budgetUnit: 'utf8-bytes'; modelTokens: number | null
}
const size = (text: string) => new TextEncoder().encode(text).byteLength

export function renderEvidencePacket(packet: Pick<EvidencePacket, 'question' | 'scope' | 'revision' | 'context' | 'evidence' | 'omitted'>): string {
  return JSON.stringify({ question: packet.question, scope: packet.scope, revision: packet.revision,
    context: packet.context.map((entry) => ({ id: entry.id, kind: entry.kind, title: entry.title, revisionId: entry.revisionId, content: entry.content, evidence: entry.evidence })),
    evidence: packet.evidence.map((hit) => ({ id: hit.id, sourceId: hit.sourceId, versionId: hit.versionId, title: hit.title, role: hit.role, authoredAt: hit.authoredAt, locator: hit.locator, start: hit.start, end: hit.end, text: hit.text, citationUrl: hit.citationUrl })), omitted: packet.omitted })
}

/** Progressive rendered-size budgeting informed by Claude-Mem ContextBudget (Apache-2.0), independently implemented here.
 * No character-to-token equivalence is assumed; callers can supply the actual tokenizer.
 */
export function buildEvidencePacket(question: string, snapshot: KnowledgeSnapshot, hits: readonly SearchHit[], context: readonly ArtifactContextEntry[], opts: { filters?: SearchFilters; maxBytes?: number; maxModelTokens?: number; countTokens?: (text: string) => number } = {}): EvidencePacket {
  const maxBytes = Math.max(1024, Math.min(64 * 1024, Math.floor(opts.maxBytes ?? 16 * 1024)))
  const packet: EvidencePacket = { schemaVersion: 1, question: question.slice(0, 2000), scope: { ...opts.filters, aiOnly: true }, revision: snapshot.revision, context: [], evidence: [], omitted: { evidence: [], context: [], evidenceCount: 0, contextCount: 0 }, maxBytes, bytes: 0, rendered: '', budgetUnit: 'utf8-bytes', modelTokens: null }
  const fits = () => { const rendered = renderEvidencePacket(packet); return size(rendered) <= maxBytes && (!opts.countTokens || opts.maxModelTokens === undefined || opts.countTokens(rendered) <= opts.maxModelTokens) }
  const policy = { ...opts.filters, aiOnly: true }
  const valid = hits.filter((hit) => eligibleEvidence(snapshot, hit, policy))
  // Exact evidence takes priority; never shorten a quote while retaining its old offsets.
  for (const hit of valid) {
    packet.evidence.push({ ...hit, citationUrl: `#/library?passage=${encodeURIComponent(hit.id)}` })
    if (!fits()) { packet.evidence.pop(); packet.omitted.evidence.push(hit.id); packet.omitted.evidenceCount++ }
  }
  const ordered = context.filter((entry) => entry.evidence.every((ref) => (() => {
    const passage = snapshot.passages.find((hit) => hit.id === ref.passageId && hit.versionId === ref.sourceVersionId)
    return !!passage && eligibleEvidence(snapshot, passage, policy)
  })())).sort((a, b) => Number(b.kind === 'profile') - Number(a.kind === 'profile'))
  for (const entry of ordered) { packet.context.push(entry); if (!fits()) { packet.context.pop(); packet.omitted.context.push(entry.id); packet.omitted.contextCount++ } }
  // Omission IDs have a cost too. Keep bounded counts instead of overflowing on huge lists.
  while (!fits() && packet.omitted.evidence.length) packet.omitted.evidence.pop()
  while (!fits() && packet.omitted.context.length) packet.omitted.context.pop()
  while (!fits() && packet.question.length) packet.question = packet.question.slice(0, Math.floor(packet.question.length * .75))
  if (!fits()) throw new Error('The evidence budget is too small for this source scope. Narrow the source selection or increase the budget.')
  packet.rendered = renderEvidencePacket(packet); packet.bytes = size(packet.rendered)
  packet.modelTokens = opts.countTokens ? opts.countTokens(packet.rendered) : null
  return packet
}
