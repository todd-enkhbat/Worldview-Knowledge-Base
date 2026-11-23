import type { KnowledgePassage, KnowledgeSnapshot, KnowledgeSource, ParsedSource } from './types.ts'

export interface PortableIdentity {
  sourceId: string; versionId: string; nodeId?: string; contentHash: string; createdAt: number
  sourceCreatedAt: number; sourceUpdatedAt: number; previousVersionId?: string; aiAllowed: boolean; excluded: boolean; tags: string[]; isCurrent?: boolean
}
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const error = () => new Error('The portable source identity or evidence is invalid. Resolve the conflict before importing.')
export function portableIdentity(parsed: ParsedSource): PortableIdentity | null {
  const raw = parsed.metadata?.portableIdentity
  if (raw === undefined) return null
  const value = raw as PortableIdentity
  if (!value || !uuid.test(value.sourceId) || !uuid.test(value.versionId) || value.nodeId !== undefined && !uuid.test(value.nodeId) || !/^[a-f\d]{64}$/i.test(value.contentHash) || !Number.isFinite(value.createdAt) || !Number.isFinite(value.sourceCreatedAt) || !Number.isFinite(value.sourceUpdatedAt) || typeof value.aiAllowed !== 'boolean' || typeof value.excluded !== 'boolean' || !Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== 'string') || value.previousVersionId !== undefined && !uuid.test(value.previousVersionId)) throw error()
  return value
}

/** Only identity assignment and restrictive policy merging; no world coordinates or I/O. */
export function sourceForParsed(snapshot: KnowledgeSnapshot, parsed: ParsedSource, options: { now?: number; occupiedNodeIds?: Iterable<string> } = {}): { source: KnowledgeSource; created: boolean; policyChanged: boolean } {
  assertPortableImportAllowed(snapshot, [parsed], options.occupiedNodeIds)
  const identity = portableIdentity(parsed)
  const existing = snapshot.sources.find((source) => source.externalId === parsed.externalId)
  if (existing) {
    const before = [existing.aiAllowed, existing.excluded]
    if (identity) { existing.aiAllowed &&= identity.aiAllowed; existing.excluded ||= identity.excluded }
    return { source: existing, created: false, policyChanged: before[0] !== existing.aiAllowed || before[1] !== existing.excluded }
  }
  const id = identity?.sourceId ?? crypto.randomUUID(), nodeId = identity?.nodeId ?? crypto.randomUUID()
  if (snapshot.sources.some((source) => source.id === id || source.nodeId === nodeId) || options.occupiedNodeIds && new Set(options.occupiedNodeIds).has(nodeId)) throw new Error('A portable source or world-record UUID already belongs to different content. Nothing was overwritten.')
  const now = options.now ?? Date.now()
  const source: KnowledgeSource = { id, externalId: parsed.externalId, title: parsed.title, kind: parsed.kind, nodeId, currentVersionId: '', createdAt: identity?.sourceCreatedAt ?? now, updatedAt: identity?.sourceUpdatedAt ?? now, excluded: identity?.excluded ?? false, aiAllowed: identity?.aiAllowed ?? true, tags: identity ? [...identity.tags] : [], pendingProjection: true }
  snapshot.sources.push(source)
  return { source, created: true, policyChanged: false }
}

export function portablePassages(parsed: ParsedSource, identity: PortableIdentity): KnowledgePassage[] {
  const rows = parsed.metadata?.portablePassages
  if (!Array.isArray(rows)) throw error()
  const seen = new Set<string>()
  for (const row of rows as KnowledgePassage[]) {
    if (!row || !uuid.test(row.id) || seen.has(row.id) || row.sourceId !== identity.sourceId || row.versionId !== identity.versionId || row.nodeId !== undefined && row.nodeId !== identity.nodeId || typeof row.text !== 'string' || typeof row.title !== 'string' || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || row.start < 0 || row.end < row.start || row.end > parsed.text.length || parsed.text.slice(row.start, row.end) !== row.text || !['human', 'assistant', 'third-party', 'unknown'].includes(row.role) || row.authoredAt !== null && !Number.isFinite(row.authoredAt)) throw error()
    seen.add(row.id)
  }
  return structuredClone(rows) as KnowledgePassage[]
}

export function samePortableEvidence(a: KnowledgePassage, b: KnowledgePassage): boolean {
  return a.text === b.text && a.start === b.start && a.end === b.end && a.role === b.role && a.authoredAt === b.authoredAt && a.messageId === b.messageId && a.parentId === b.parentId && a.locator === b.locator
}

/** Check an entire portable batch for conflicts before its first source is committed. */
export function assertPortableImportAllowed(snapshot: KnowledgeSnapshot, parsed: readonly ParsedSource[], occupiedNodeIds: Iterable<string> = []): void {
  const occupied = new Set(occupiedNodeIds)
  for (const document of parsed) {
    const identity = portableIdentity(document)
    if (!identity) continue
    const target = snapshot.sources.find((source) => source.externalId === document.externalId)
    const sourceId = target?.id ?? identity.sourceId
    if (!target && snapshot.sources.some((source) => source.id === identity.sourceId || source.nodeId === identity.nodeId) || !target && identity.nodeId && occupied.has(identity.nodeId)) throw new Error('A portable source or world-record UUID belongs to different content. Nothing was overwritten.')
    const version = snapshot.versions.find((item) => item.id === identity.versionId)
    if (version && (version.sourceId !== sourceId || version.text !== document.text || version.contentHash !== identity.contentHash)) throw new Error('A portable source-version UUID belongs to different content. Nothing was overwritten.')
    if (identity.isCurrent && target && target.currentVersionId !== identity.versionId && target.updatedAt > identity.sourceUpdatedAt) {
      const current = snapshot.versions.find((item) => item.id === target.currentVersionId)
      if (current?.text !== document.text || current.contentHash !== identity.contentHash) throw new Error('This workspace has a newer source revision. Review the difference before importing an older portable revision.')
    }
    for (const passage of portablePassages(document, identity)) {
      const existing = snapshot.passages.find((item) => item.id === passage.id)
      if (existing && (existing.sourceId !== sourceId || existing.versionId !== identity.versionId || !samePortableEvidence(existing, passage))) throw new Error('A portable passage UUID belongs to different evidence. Nothing was overwritten.')
    }
  }
}
