import type { KnowledgePassage, KnowledgeSnapshot, KnowledgeSource, ParsedSource, SourceKind, SourceVersion } from './types.ts'
import type { SavedInvestigation } from '../workspace/collections.ts'
import type { NodeRecord } from '../domain/types.ts'
import { noteFileName } from '../data/obsidian.ts'
import { extractVaultLinks, parseVaultMetadata, resolveVaultLink } from './vault.ts'
import { validateWorkspaceContext } from '../workspace/state.ts'

export interface PortableSource { source: KnowledgeSource; versions: SourceVersion[]; passages: KnowledgePassage[] }
export interface PortableKnowledge { format: 'worldview-portable'; schemaVersion: 1; exportedAt: number; sources: PortableSource[]; investigations: SavedInvestigation[] }
export interface PortableOptions { sourceIds?: readonly string[]; aiOnly?: boolean; includeHistory?: boolean; records?: readonly NodeRecord[]; now?: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const kinds = new Set<SourceKind>(['thought', 'document', 'chatgpt', 'claude', 'obsidian', 'legacy', 'conversation'])
const roles = new Set(['human', 'assistant', 'third-party', 'unknown'])
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const dateValue = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value)
const fail = (): never => { throw new Error('This portable knowledge file is incomplete or has invalid identities or evidence offsets. Nothing was imported.') }

/** Validate the entire package before returning any source for mutation. */
export function readPortableKnowledge(value: unknown): PortableKnowledge {
  if (!object(value) || value.format !== 'worldview-portable' || value.schemaVersion !== 1 || !Array.isArray(value.sources) || value.sources.length > 5000 || !Array.isArray(value.investigations) || typeof value.exportedAt !== 'number' || !Number.isFinite(value.exportedAt)) return fail()
  const sourceIds = new Set<string>(), externalIds = new Set<string>(), nodeIds = new Set<string>(), versionIds = new Set<string>(), passageIds = new Set<string>()
  for (const raw of value.sources) {
    if (!object(raw) || !object(raw.source) || !Array.isArray(raw.versions) || !raw.versions.length || !Array.isArray(raw.passages)) return fail()
    const source = raw.source
    if (typeof source.id !== 'string' || !uuid.test(source.id) || sourceIds.has(source.id) || typeof source.currentVersionId !== 'string' || typeof source.externalId !== 'string' || !source.externalId || typeof source.title !== 'string' || !source.title || !kinds.has(source.kind as SourceKind) || typeof source.aiAllowed !== 'boolean' || typeof source.excluded !== 'boolean' || !Array.isArray(source.tags) || source.tags.some((tag) => typeof tag !== 'string') || !Number.isFinite(source.createdAt) || !Number.isFinite(source.updatedAt) || source.nodeId !== undefined && (typeof source.nodeId !== 'string' || !uuid.test(source.nodeId))) return fail()
    if (externalIds.has(source.externalId) || source.nodeId && nodeIds.has(source.nodeId as string)) return fail()
    sourceIds.add(source.id); externalIds.add(source.externalId); if (source.nodeId) nodeIds.add(source.nodeId as string)
    const versions = new Map<string, SourceVersion>()
    for (const row of raw.versions) {
      if (!object(row) || typeof row.id !== 'string' || !uuid.test(row.id) || versionIds.has(row.id) || row.sourceId !== source.id || typeof row.text !== 'string' || typeof row.contentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(row.contentHash) || typeof row.originalBlobId !== 'string' || typeof row.originalName !== 'string' || !['import', 'capture', 'edit', 'legacy'].includes(String(row.origin)) || !dateValue(row.authoredAt) || typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt) || row.metadata !== undefined && !object(row.metadata)) return fail()
      if (row.previousVersionId !== undefined && (typeof row.previousVersionId !== 'string' || !uuid.test(row.previousVersionId))) return fail()
      versionIds.add(row.id); versions.set(row.id, row as unknown as SourceVersion)
    }
    if (!versions.has(source.currentVersionId)) return fail()
    for (const row of raw.passages) {
      if (!object(row) || typeof row.id !== 'string' || !uuid.test(row.id) || passageIds.has(row.id) || row.sourceId !== source.id || typeof row.versionId !== 'string' || !versions.has(row.versionId) || typeof row.title !== 'string' || typeof row.text !== 'string' || !Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || (row.start as number) < 0 || (row.end as number) < (row.start as number) || !roles.has(String(row.role)) || !dateValue(row.authoredAt) || row.nodeId !== undefined && row.nodeId !== source.nodeId || row.messageId !== undefined && typeof row.messageId !== 'string' || row.parentId !== undefined && typeof row.parentId !== 'string' || row.locator !== undefined && typeof row.locator !== 'string') return fail()
      const version = versions.get(row.versionId)!
      if ((row.end as number) > version.text.length || version.text.slice(row.start as number, row.end as number) !== row.text) return fail()
      passageIds.add(row.id)
    }
  }
  const collectionIds = new Set<string>()
  for (const raw of value.investigations) {
    if (!object(raw) || typeof raw.id !== 'string' || !uuid.test(raw.id) || collectionIds.has(raw.id) || typeof raw.title !== 'string' || !raw.title.trim() || typeof raw.query !== 'string' || !Number.isFinite(raw.updatedAt) || !Array.isArray(raw.sourceIds) || raw.sourceIds.some((id) => typeof id !== 'string' || !sourceIds.has(id)) || !Array.isArray(raw.questions) || raw.questions.some((question) => typeof question !== 'string') || raw.deletedAt !== undefined && raw.deletedAt !== null && !Number.isFinite(raw.deletedAt)) return fail()
    const filters = validateWorkspaceContext(raw)
    if (filters.role !== raw.role || filters.sourceKind !== raw.sourceKind || filters.authoredAfter !== raw.authoredAfter || filters.authoredBefore !== raw.authoredBefore || filters.query !== raw.query || filters.sourceIds.length !== raw.sourceIds.length) return fail()
    collectionIds.add(raw.id)
  }
  return structuredClone(value) as unknown as PortableKnowledge
}

function messagesFor(version: SourceVersion, passages: readonly KnowledgePassage[]): ParsedSource['messages'] {
  if (!passages.some((passage) => passage.messageId || passage.role !== 'unknown')) return []
  const grouped = new Map<string, KnowledgePassage[]>()
  for (const passage of passages) {
    const key = passage.messageId ?? `${passage.role}:${passage.authoredAt}`
    const rows = grouped.get(key) ?? []; rows.push(passage); grouped.set(key, rows)
  }
  return [...grouped.values()].map((rows) => {
    const first = rows[0], start = Math.min(...rows.map((row) => row.start)), end = Math.max(...rows.map((row) => row.end))
    return { id: first.messageId, parentId: first.parentId, role: first.role, authoredAt: first.authoredAt, start, end, text: version.text.slice(start, end) }
  }).sort((a, b) => a.start - b.start)
}

export function parsePortableKnowledge(value: unknown): ParsedSource[] {
  const portable = readPortableKnowledge(value)
  const parsed: ParsedSource[] = portable.sources.flatMap(({ source, versions, passages }) => [...versions].sort((a, b) => Number(a.id === source.currentVersionId) - Number(b.id === source.currentVersionId) || a.createdAt - b.createdAt).map((version) => {
    const located = passages.filter((passage) => passage.versionId === version.id)
    const metadata = { ...(version.metadata ?? {}) }
    delete metadata.portableIdentity; delete metadata.portablePassages
    return { externalId: source.externalId, title: source.title, kind: source.kind, text: version.text, authoredAt: version.authoredAt, messages: messagesFor(version, located), metadata: { ...metadata, portableIdentity: { sourceId: source.id, versionId: version.id, ...(source.nodeId ? { nodeId: source.nodeId } : {}), createdAt: version.createdAt, sourceCreatedAt: source.createdAt, sourceUpdatedAt: source.updatedAt, previousVersionId: version.previousVersionId, contentHash: version.contentHash, aiAllowed: source.aiAllowed, excluded: source.excluded, tags: source.tags, isCurrent: version.id === source.currentVersionId }, portablePassages: located } }
  }))
  if (parsed.length && portable.investigations.length) parsed[0].metadata = { ...parsed[0].metadata, portableInvestigations: portable.investigations }
  return parsed
}

function selectedSources(snapshot: KnowledgeSnapshot, options: PortableOptions): KnowledgeSource[] {
  return snapshot.sources.filter((source) => !source.deleted && !source.excluded && (!options.aiOnly || source.aiAllowed) && (!options.sourceIds || options.sourceIds.includes(source.id)))
}

export function portableKnowledge(snapshot: KnowledgeSnapshot, investigations: readonly SavedInvestigation[], options: PortableOptions = {}): PortableKnowledge {
  const sources = selectedSources(snapshot, options)
  if (sources.length > 5000) throw new Error('Export up to 5,000 sources at a time, or use the verified folder backup for the full record.')
  const ids = new Set(sources.map((source) => source.id))
  const exported: PortableKnowledge = { format: 'worldview-portable', schemaVersion: 1, exportedAt: options.now ?? Date.now(), sources: sources.map((source) => {
    const versions = snapshot.versions.filter((version) => version.sourceId === source.id && (options.includeHistory || version.id === source.currentVersionId)).map((version) => {
      const metadata = { ...(version.metadata ?? {}) }; delete metadata.portableIdentity; delete metadata.portablePassages
      return { ...version, metadata }
    })
    const versionIds = new Set(versions.map((version) => version.id))
    return { source: { ...source }, versions, passages: snapshot.passages.filter((passage) => passage.sourceId === source.id && versionIds.has(passage.versionId)) }
  }), investigations: investigations.filter((item) => !item.deletedAt && (!item.sourceIds.length || item.sourceIds.some((id) => ids.has(id)))).map((item) => ({ ...item, sourceIds: item.sourceIds.filter((id) => ids.has(id)), questions: [...item.questions] })) }
  return readPortableKnowledge(exported)
}

export function portableNotePath(source: Pick<KnowledgeSource, 'id' | 'title'>): string { return `notes/${noteFileName(source.title)}--${source.id}.md` }

function markdown(source: KnowledgeSource, version: SourceVersion, passages: readonly KnowledgePassage[], renderedBody?: string): string {
  const original = parseVaultMetadata(version.text)
  const authors = [...new Set(passages.map((passage) => passage.role))]
  const header = [
    '---', `title: ${JSON.stringify(source.title)}`, 'worldview_format: "source-note-v1"', `worldview_source_id: ${JSON.stringify(source.id)}`, `worldview_version_id: ${JSON.stringify(version.id)}`,
    `worldview_external_id: ${JSON.stringify(source.externalId)}`, `worldview_source_kind: ${JSON.stringify(source.kind)}`, `worldview_ai_allowed: ${source.aiAllowed}`, `worldview_authorship: ${JSON.stringify(authors.length === 1 ? authors[0] : 'mixed')}`,
    `worldview_authored_at: ${version.authoredAt === null ? 'null' : JSON.stringify(new Date(version.authoredAt).toISOString())}`, `tags: ${JSON.stringify(source.tags)}`,
    `worldview_original_frontmatter: ${JSON.stringify(original.rawFrontmatter)}`,
    ...Object.entries(original.properties).filter(([key]) => !['title', 'tags'].includes(key) && /^[\p{L}\p{N}_-]+$/u.test(key) && !key.startsWith('worldview_')).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), '---', '',
  ]
  return header.join('\n') + (renderedBody ?? version.text.slice(original.bodyStart))
}

/** A Canvas is an independent 2D presentation; no simulation coordinates are exported or read. */
export function investigationCanvas(investigation: SavedInvestigation, sources: readonly KnowledgeSource[], records: readonly NodeRecord[] = []): string {
  const scoped = sources.filter((source) => !investigation.sourceIds.length || investigation.sourceIds.includes(source.id))
  const nodes: Record<string, unknown>[] = scoped.map((source, index) => ({ id: source.id, type: 'file', file: portableNotePath(source), x: index % 4 * 400, y: Math.floor(index / 4) * 220, width: 360, height: 170 }))
  nodes.push({ id: `question-${investigation.id}`, type: 'text', text: `# ${investigation.title}\n\nQuestion: ${investigation.query}\n\n${investigation.questions.map((question) => `- ${question}`).join('\n')}`, x: 0, y: -280, width: 760, height: 220 })
  const byNode = new Map(scoped.flatMap((source) => source.nodeId ? [[source.nodeId, source] as const] : []))
  const edges = records.flatMap((record) => { const source = byNode.get(record.id); return source ? record.links.flatMap((link) => { const target = byNode.get(link.targetId); return target ? [{ id: `edge-${source.id}-${target.id}-${link.kind}`, fromNode: source.id, toNode: target.id, label: link.kind, toEnd: 'arrow' }] : [] }) : [] })
  return JSON.stringify({ nodes, edges }, null, 2)
}

/** Conservative Bases subset: filters and a table; no formula execution. */
export function investigationBase(investigation: SavedInvestigation): string {
  const expressions = ['file.ext == "md"', 'worldview_format == "source-note-v1"']
  if (investigation.sourceKind !== 'all') expressions.push(`worldview_source_kind == ${JSON.stringify(investigation.sourceKind)}`)
  if (investigation.role !== 'all') expressions.push(`worldview_authorship == ${JSON.stringify(investigation.role)}`)
  if (investigation.authoredAfter) expressions.push(`worldview_authored_at >= ${JSON.stringify(investigation.authoredAfter)}`)
  if (investigation.authoredBefore) expressions.push(`worldview_authored_at <= ${JSON.stringify(`${investigation.authoredBefore}T23:59:59.999Z`)}`)
  const lines = [`# Original search: ${JSON.stringify(investigation.query)}`, 'filters:', '  all:', ...expressions.map((expression) => `    - ${JSON.stringify(expression)}`)]
  if (investigation.sourceIds.length) lines.push('    - any:', ...investigation.sourceIds.map((id) => `        - ${JSON.stringify(`worldview_source_id == ${JSON.stringify(id)}`)}`))
  lines.push('views:', '  - type: table', `    name: ${JSON.stringify(investigation.title)}`, '    order:', '      - file.name', '      - worldview_source_kind', '      - worldview_authored_at', '      - worldview_source_id', '')
  return lines.join('\n')
}

export function buildPortableKnowledge(snapshot: KnowledgeSnapshot, investigations: readonly SavedInvestigation[], options: PortableOptions = {}): Map<string, string> {
  const portable = portableKnowledge(snapshot, investigations, options)
  const files = new Map<string, string>()
  files.set('worldview-sources.json', JSON.stringify(portable, null, 2))
  const sources = portable.sources.map((item) => item.source)
  const linkDiagnostics: { sourceId: string; target: string; reason: string; candidates: string[] }[] = []
  const currentSources = portable.sources.map((item) => ({ ...item, current: item.versions.find((version) => version.id === item.source.currentVersionId)! }))
  for (const item of portable.sources) {
    for (const version of item.versions) files.set(`sources/${item.source.id}/${version.id}.txt`, version.text)
    const current = item.versions.find((version) => version.id === item.source.currentVersionId)!
    const fromPath = String(current.metadata?.path ?? current.originalName)
    const candidates = currentSources.filter((candidate) => candidate.current.metadata?.watchedFolderId === current.metadata?.watchedFolderId).map((candidate) => {
      const aliases = parseVaultMetadata(candidate.current.text).properties.aliases
      return { id: candidate.source.id, path: String(candidate.current.metadata?.path ?? candidate.current.originalName), aliases: typeof aliases === 'string' ? [aliases] : Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === 'string') : [] }
    })
    let body = current.text.slice(parseVaultMetadata(current.text).bodyStart)
    for (const reference of extractVaultLinks(body).reverse()) {
      const result = resolveVaultLink(fromPath, reference.target, candidates)
      if (result.status !== 'resolved') { linkDiagnostics.push({ sourceId: item.source.id, target: reference.target, reason: result.status, candidates: result.candidates }); continue }
      const target = sources.find((source) => source.id === result.id)!
      const locator = reference.block ? `#^${reference.block}` : reference.heading ? `#${reference.heading}` : ''
      const replacement = `${reference.embed ? '!' : ''}[[${portableNotePath(target)}${locator}${reference.alias === undefined ? '' : `|${reference.alias}`}]]`
      body = body.slice(0, reference.start) + replacement + body.slice(reference.end)
    }
    files.set(portableNotePath(item.source), markdown(item.source, current, item.passages.filter((passage) => passage.versionId === current.id), body))
  }
  files.set('link-diagnostics.json', JSON.stringify(linkDiagnostics, null, 2))
  const collections = portable.investigations.length ? portable.investigations : [{ id: 'all-record', title: 'Worldview record', query: '', questions: [], sourceIds: sources.map((source) => source.id), role: 'all' as const, sourceKind: 'all', authoredAfter: '', authoredBefore: '', updatedAt: portable.exportedAt }]
  for (const investigation of collections) {
    const name = `${noteFileName(investigation.title)}--${investigation.id}`
    files.set(`investigations/${name}.canvas`, investigationCanvas(investigation, sources, options.records))
    files.set(`investigations/${name}.base`, investigationBase(investigation))
  }
  files.set('README.md', '# Worldview portable knowledge\n\nOpen this folder as an Obsidian vault. Readable notes rewrite resolvable wikilinks to their exported paths; unresolved or ambiguous references remain unchanged and are listed in link-diagnostics.json. Canvas maps use their own 2D layout. Bases files use a conservative table/filter subset. The complete search questions and source scope are retained in worldview-sources.json.\n\nReimport worldview-sources.json through Sources to preserve source/version/passage identities and saved investigations. Exact retained text is also under sources/. Binary originals and full recovery state belong to the verified backup, not this text export.\n')
  const bytes = [...files.values()].reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0)
  if (bytes > 64 * 1024 * 1024 || files.size > 60000) throw new Error('This portable text export exceeds 64 MiB. Select a smaller investigation or use a verified folder backup.')
  return files
}
