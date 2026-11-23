import { createHash } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { KnowledgeSnapshot, SearchFilters, SearchHit } from '../src/knowledge/types.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export interface QmdMirrorEntry { path: string; sourceId: string; versionId: string; passageId: string; textHash: string }
export interface QmdMirror {
  manifest: { schemaVersion: 1; corpusRevision: number; collection: string; policyHash: string; scope: SearchFilters; entries: QmdMirrorEntry[] }
  files: { path: string; text: string }[]
}
export interface QmdMirrorOptions { liveNodeIds: ReadonlySet<string>; filters?: SearchFilters; maxBytes?: number }

export function qmdResultPath(file: unknown, collection: string): string | null {
  if (typeof file !== 'string') return null
  if (!file.startsWith('qmd://')) return file
  try { const url = new URL(file); return url.hostname === collection ? decodeURIComponent(url.pathname.slice(1)) : null } catch { return null }
}

/** A disposable read projection, never another writable memory authority. */
export function buildQmdMirror(snapshot: KnowledgeSnapshot, options: QmdMirrorOptions): QmdMirror {
  const filters = { ...options.filters, aiOnly: true, includeHistory: false }
  const selected = filters.sourceIds ? new Set(filters.sourceIds) : null
  const sources = new Map(snapshot.sources.filter((source) => !source.excluded && !source.deleted && source.aiAllowed && (!source.nodeId || options.liveNodeIds.has(source.nodeId)) && (!selected || selected.has(source.id)) && (!filters.kinds || filters.kinds.includes(source.kind))).map((source) => [source.id, source]))
  const versions = new Map(snapshot.versions.map((version) => [version.id, version]))
  const policyHash = hash(JSON.stringify([...sources.values()].map((source) => [source.id, source.currentVersionId]).sort()))
  const mirror: QmdMirror = { manifest: { schemaVersion: 1, corpusRevision: snapshot.revision, collection: `worldview-${policyHash.slice(0, 16)}`, policyHash, scope: filters, entries: [] }, files: [] }
  let bytes = 0
  for (const passage of snapshot.passages) {
    const source = sources.get(passage.sourceId), version = versions.get(passage.versionId)
    if (!source || !version || version.sourceId !== source.id || source.currentVersionId !== version.id || !Number.isSafeInteger(passage.start) || !Number.isSafeInteger(passage.end) || passage.start < 0 || passage.end < passage.start || passage.end > version.text.length || version.text.slice(passage.start, passage.end) !== passage.text) continue
    if (filters.role && passage.role !== filters.role || filters.authoredAfter !== undefined && (passage.authoredAt === null || passage.authoredAt < filters.authoredAfter) || filters.authoredBefore !== undefined && (passage.authoredAt === null || passage.authoredAt > filters.authoredBefore)) continue
    const path = `${hash(JSON.stringify([source.id, version.id, passage.id]))}.md`
    const metadata = { sourceId: source.id, versionId: version.id, passageId: passage.id, role: passage.role, kind: source.kind, ...(passage.authoredAt !== null ? { authoredAt: passage.authoredAt } : {}) }
    const text = `---\nworldview_source: ${JSON.stringify(source.id)}\nworldview_version: ${JSON.stringify(version.id)}\nworldview_passage: ${JSON.stringify(passage.id)}\nqmd:\n  metadata: ${JSON.stringify(metadata)}\n---\n# ${passage.title}\n\n${passage.text}\n`
    bytes += Buffer.byteLength(text)
    if (bytes > (options.maxBytes ?? 64 * 1024 * 1024)) throw new Error('The selected QMD mirror exceeds 64 MiB. Select a smaller source scope before exporting.')
    mirror.files.push({ path, text })
    mirror.manifest.entries.push({ path, sourceId: source.id, versionId: version.id, passageId: passage.id, textHash: hash(passage.text) })
  }
  return mirror
}

export function qmdMirrorZip(mirror: QmdMirror): Uint8Array<ArrayBuffer> {
  const entries = Object.fromEntries(mirror.files.map((file) => [file.path, strToU8(file.text)]))
  entries['worldview-manifest.json'] = strToU8(JSON.stringify(mirror.manifest, null, 2))
  entries['README.txt'] = strToU8('Disposable Worldview search mirror. Index only the .md files. Native QMD and model weights are separate opt-in installations. Re-export after source-policy changes. Treat result IDs as hints: resolve them through Worldview before presenting evidence. Never edit this mirror as source authority.\n')
  return zipSync(entries, { level: 6 })
}

export async function writeQmdMirror(directory: string, mirror: QmdMirror): Promise<void> {
  await mkdir(directory, { recursive: true })
  if ((await readdir(directory)).length) throw new Error('A QMD mirror must be written into a new empty directory; existing files were left untouched.')
  for (const file of mirror.files) await writeFile(join(directory, file.path), file.text, { flag: 'wx' })
  await writeFile(join(directory, 'worldview-manifest.json'), JSON.stringify(mirror.manifest, null, 2), { flag: 'wx' })
}

/** Native snippets/short docids are untrusted. Return only freshly verified full-identity passages. */
export function resolveQmdHits(rows: readonly { file?: string; score?: number }[], mirror: QmdMirror, current: KnowledgeSnapshot, options: QmdMirrorOptions): SearchHit[] {
  const allowed = buildQmdMirror(current, { ...options, filters: { ...mirror.manifest.scope, ...options.filters } })
  const permitted = new Map(allowed.manifest.entries.map((entry) => [entry.passageId, entry]))
  const original = new Map(mirror.manifest.entries.map((entry) => [entry.path, entry]))
  const passages = new Map(current.passages.map((passage) => [passage.id, passage]))
  const seen = new Set<string>(), hits: SearchHit[] = []
  for (const row of rows) {
    const path = qmdResultPath(row.file, mirror.manifest.collection)
    if (path === null) continue
    const entry = original.get(path), latest = entry ? permitted.get(entry.passageId) : undefined
    if (!entry || !latest || entry.versionId !== latest.versionId || entry.sourceId !== latest.sourceId || entry.textHash !== latest.textHash || seen.has(entry.passageId)) continue
    const passage = passages.get(entry.passageId)
    if (!passage) continue
    seen.add(entry.passageId)
    hits.push({ ...passage, score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : 0 })
  }
  return hits.slice(0, options.filters?.limit ?? 30)
}
