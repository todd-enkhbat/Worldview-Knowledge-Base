import type { KnowledgeSnapshot } from './types.ts'
import type { NodeRecord } from '../domain/types.ts'

/** Obsidian path/link behavior informed by the MIT Obsidian format references and
 * smixs's exact-path/unique-suffix resolver; implemented for Worldview without I/O. */
export interface VaultReference {
  target: string
  alias?: string
  heading?: string
  block?: string
  embed: boolean
  start: number
  end: number
  raw: string
}
export interface VaultCandidate { id: string; path: string; aliases?: readonly string[] }
export type VaultResolution = { status: 'resolved'; id: string; path: string } | { status: 'missing' | 'ambiguous' | 'invalid'; candidates: string[] }

/** Normalize vault-relative paths without ever interpreting a filesystem path. */
export function normalizeVaultPath(path: string): string | null {
  const parts: string[] = []
  for (const part of path.normalize('NFC').replaceAll('\\', '/').replace(/^\/+/, '').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) return null; parts.pop() }
    else if (part.includes('\0')) return null
    else parts.push(part)
  }
  return parts.join('/')
}
const withoutMd = (path: string) => path.replace(/\.(?:md|markdown)$/i, '')
const lower = (value: string) => value.toLocaleLowerCase('en')

export function resolveVaultLink(fromPath: string, rawTarget: string, candidates: readonly VaultCandidate[]): VaultResolution {
  const from = normalizeVaultPath(fromPath)
  const targetText = rawTarget.trim().replace(/\.(?:md|markdown)$/i, '')
  if (!from || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(targetText)) return { status: 'invalid', candidates: [] }
  if (!targetText) {
    const self = candidates.find((item) => normalizeVaultPath(item.path) === from)
    return self ? { status: 'resolved', id: self.id, path: self.path } : { status: 'missing', candidates: [] }
  }
  const directory = from.split('/').slice(0, -1).join('/')
  const target = normalizeVaultPath(targetText)
  const relative = normalizeVaultPath(`${directory ? `${directory}/` : ''}${targetText}`)
  if (target === null && relative === null) return { status: 'invalid', candidates: [] }
  const unique = (items: readonly VaultCandidate[]): VaultResolution | null => {
    const byId = [...new Map(items.map((item) => [item.id, item])).values()]
    return byId.length === 1 ? { status: 'resolved', id: byId[0].id, path: byId[0].path } : byId.length ? { status: 'ambiguous', candidates: byId.map((item) => item.path).sort() } : null
  }
  const normalized = candidates.flatMap((item) => { const path = normalizeVaultPath(item.path); return path ? [{ ...item, normalized: withoutMd(path) }] : [] })
  const explicitRelative = /^\.\.?\//.test(targetText)
  const first = explicitRelative ? relative : target
  if (first !== null) {
    const exact = unique(normalized.filter((item) => item.normalized === first))
    if (exact) return exact
    const folded = unique(normalized.filter((item) => lower(item.normalized) === lower(first)))
    if (folded) return folded
  }
  if (!explicitRelative && relative && relative !== target) {
    const match = unique(normalized.filter((item) => item.normalized === relative))
    if (match) return match
  }
  if (target && target.includes('/')) return unique(normalized.filter((item) => lower(item.normalized).endsWith(`/${lower(target)}`))) ?? { status: 'missing', candidates: [] }
  if (explicitRelative) return { status: 'missing', candidates: [] }
  const bare = lower(target ?? targetText)
  return unique(normalized.filter((item) => lower(item.normalized.split('/').at(-1) ?? '') === bare || item.aliases?.some((alias) => lower(alias) === bare))) ?? { status: 'missing', candidates: [] }
}

/** References inside code fences, inline code and Obsidian comments are literal text. */
export function extractVaultLinks(text: string): VaultReference[] {
  const excluded: [number, number][] = []
  const fences = /^( {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gm
  let open: { char: string; length: number; start: number } | null = null
  for (const match of text.matchAll(fences)) {
    const delimiter = match[2]
    if (!open) open = { char: delimiter[0], length: delimiter.length, start: match.index }
    else if (delimiter[0] === open.char && delimiter.length >= open.length) { excluded.push([open.start, match.index + match[0].length]); open = null }
  }
  if (open) excluded.push([open.start, text.length])
  for (const match of text.matchAll(/%%[\s\S]*?(?:%%|$)|(`+)[^\r\n]*?\1/g)) excluded.push([match.index, match.index + match[0].length])
  const out: VaultReference[] = []
  for (const match of text.matchAll(/(!?)\[\[([^\]\r\n]+)\]\]/g)) {
    if (excluded.some(([start, end]) => match.index >= start && match.index < end)) continue
    const [address, ...aliases] = match[2].split('|')
    const fragmentAt = address.search(/[#^]/)
    const target = (fragmentAt < 0 ? address : address.slice(0, fragmentAt)).trim()
    const fragment = fragmentAt < 0 ? '' : address.slice(fragmentAt)
    const block = /(?:#)?\^(.+)$/.exec(fragment)?.[1]?.trim()
    const heading = fragment.startsWith('#') && !block ? fragment.slice(1).trim() : undefined
    out.push({ target, ...(aliases.length ? { alias: aliases.join('|').trim() } : {}), ...(heading ? { heading } : {}), ...(block ? { block } : {}), embed: !!match[1], start: match.index, end: match.index + match[0].length, raw: match[0] })
  }
  return out
}

function scalar(raw: string): unknown {
  const text = raw.trim()
  if (text.startsWith('"')) { try { return JSON.parse(text) } catch { return text } }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'")
  if (text === 'true' || text === 'false') return text === 'true'
  if (text === 'null' || text === '~') return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text))) return Number(text)
  if (text.startsWith('[') && text.endsWith(']')) {
    try { return JSON.parse(text) } catch { return text.slice(1, -1).split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/).map(scalar) }
  }
  return text
}

/** Flat properties are interpreted conservatively; complete YAML remains in rawFrontmatter. */
export function parseVaultMetadata(text: string): { rawFrontmatter: string; properties: Record<string, unknown>; links: VaultReference[]; bodyStart: number } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  const properties: Record<string, unknown> = {}
  let listKey: string | null = null
  for (const line of (frontmatter?.[1] ?? '').split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && listKey) { (properties[listKey] as unknown[]).push(scalar(item[1])); continue }
    const entry = /^([\p{L}\p{N}_ .-]+):\s*(.*)$/u.exec(line)
    listKey = null
    if (!entry) continue
    if (!entry[2]) { listKey = entry[1]; properties[listKey] = [] }
    else properties[entry[1]] = scalar(entry[2])
  }
  return { rawFrontmatter: frontmatter?.[0] ?? '', properties, links: extractVaultLinks(text), bodyStart: frontmatter?.[0].length ?? 0 }
}

export interface VaultGraphEdge { sourceId: string; targetSourceId: string; sourceNodeId: string; targetNodeId: string; reference: VaultReference }
export interface VaultGraphDiagnostic { sourceId: string; path: string; target: string; reason: 'missing' | 'ambiguous' | 'invalid'; candidates: string[] }

/** Only explicit references produce edges; their existence is not an inferred claim. */
export function vaultGraph(snapshot: KnowledgeSnapshot): { edges: VaultGraphEdge[]; diagnostics: VaultGraphDiagnostic[] } {
  const versions = new Map(snapshot.versions.map((version) => [version.id, version]))
  const current = snapshot.sources.filter((source) => !source.deleted && !source.excluded && source.nodeId).flatMap((source) => {
    const version = versions.get(source.currentVersionId)
    if (!version || !/\.(?:md|markdown)$/i.test(String(version.metadata?.path ?? version.originalName))) return []
    const metadata = parseVaultMetadata(version.text)
    const aliases = metadata.properties.aliases
    return [{ source, version, path: String(version.metadata?.path ?? version.originalName), metadata, aliases: typeof aliases === 'string' ? [aliases] : Array.isArray(aliases) ? aliases.filter((item): item is string => typeof item === 'string') : [] }]
  })
  const candidates = current.map((item) => ({ id: item.source.id, path: item.path, aliases: item.aliases }))
  const scopes = new Map(current.map((item) => [item.source.id, item.version.metadata?.watchedFolderId]))
  const scopedCandidates = new Map<unknown, VaultCandidate[]>()
  for (const candidate of candidates) { const scope = scopes.get(candidate.id); const group = scopedCandidates.get(scope) ?? []; group.push(candidate); scopedCandidates.set(scope, group) }
  const bySource = new Map(current.map((item) => [item.source.id, item]))
  const edges: VaultGraphEdge[] = []
  const diagnostics: VaultGraphDiagnostic[] = []
  for (const item of current) for (const reference of item.metadata.links) {
    if (reference.target && /\.[\w]+$/.test(reference.target) && !/\.(?:md|markdown)$/i.test(reference.target)) continue
    const result = resolveVaultLink(item.path, reference.target, scopedCandidates.get(item.version.metadata?.watchedFolderId) ?? [])
    if (result.status !== 'resolved') diagnostics.push({ sourceId: item.source.id, path: item.path, target: reference.target, reason: result.status, candidates: result.candidates })
    else if (result.id !== item.source.id) {
      const target = bySource.get(result.id)!
      if (!edges.some((edge) => edge.sourceId === item.source.id && edge.targetSourceId === result.id)) edges.push({ sourceId: item.source.id, targetSourceId: result.id, sourceNodeId: item.source.nodeId!, targetNodeId: target.source.nodeId!, reference })
    }
  }
  return { edges, diagnostics }
}

/** Server-side projection for the watcher's single CAS. Only links and update
 * timestamps change; placement, dates, ownership and manually-created links stay intact. */
export function projectVaultGraph(snapshot: KnowledgeSnapshot, records: readonly NodeRecord[], now: number): NodeRecord[] {
  const graph = vaultGraph(snapshot), byNode = new Map(records.map((record) => [record.id, record]))
  const changed: NodeRecord[] = []
  for (const source of snapshot.sources) {
    const node = source.nodeId && byNode.get(source.nodeId)
    if (!node || node.deletedAt !== null || source.deleted || source.excluded) continue
    const previous = source.vaultGraph ?? { links: [], suppressedTargets: [], diagnostics: [] }
    const wanted = graph.edges.filter((edge) => edge.sourceId === source.id && byNode.get(edge.targetNodeId)?.deletedAt === null)
    const suppressed = new Set(previous.suppressedTargets)
    let links = [...node.links]
    for (const old of previous.links) {
      const existing = links.find((link) => link.targetId === old.targetNodeId && link.kind === 'relates' && link.createdAt === old.createdAt)
      if (!existing && wanted.some((edge) => edge.targetSourceId === old.targetSourceId)) suppressed.add(old.targetSourceId)
      if (existing && !wanted.some((edge) => edge.targetSourceId === old.targetSourceId)) links = links.filter((link) => link !== existing)
    }
    const introduced: NonNullable<typeof source.vaultGraph>['links'] = []
    for (const edge of wanted) {
      if (suppressed.has(edge.targetSourceId)) continue
      const existing = links.find((link) => link.targetId === edge.targetNodeId && link.kind === 'relates')
      const owned = previous.links.find((link) => link.targetNodeId === edge.targetNodeId && link.createdAt === existing?.createdAt)
      if (existing) { if (owned) introduced.push(owned); continue }
      links.push({ targetId: edge.targetNodeId, kind: 'relates', createdAt: now })
      introduced.push({ targetSourceId: edge.targetSourceId, targetNodeId: edge.targetNodeId, createdAt: now })
    }
    source.vaultGraph = { links: introduced, suppressedTargets: [...suppressed], diagnostics: graph.diagnostics.filter((item) => item.sourceId === source.id).map(({ target, reason, candidates }) => ({ target, reason, candidates })) }
    if (JSON.stringify(links) !== JSON.stringify(node.links)) { const next = { ...node, links, updatedAt: Math.max(now, node.updatedAt + 1) }; changed.push(next); byNode.set(node.id, next) }
  }
  return changed
}
