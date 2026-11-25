import { ARCHETYPES, SCHEMA_VERSION } from '../domain/types.ts'
import type { AssetMeta, InteractionEvent, NodeRecord, WorldSettings } from '../domain/types.ts'
import { validateNode, validateSettings } from '../domain/validate.ts'
import { DEVICE_KV_KEYS, IMPORT_MARKER_KV, WORLD_KV_KEYS } from './archive.ts'
import type { ImportMarker } from './archive.ts'
import { hashBytes, hashJson, hashRecords } from './hash.ts'
import type { WorldStore } from './WorldStore.ts'
import { readWorldSnapshot, voiceOriginalReferences, writingOriginalReferences, bookshelfOriginalReferences, crmOriginalReferences } from './worldSnapshot.ts'
import { stateRevision, WorldStateConflictError } from './worldState.ts'

export const DIRECTORY_BUNDLE_FORMAT = 'worldview-directory-bundle'
export const DIRECTORY_BUNDLE_VERSION = 1
export const MAX_BUNDLE_PART_BYTES = 64 * 1024 * 1024
const MANIFEST = 'manifest.json'
const MAX_MANIFEST_BYTES = MAX_BUNDLE_PART_BYTES
const MAX_METADATA_BYTES = 512 * 1024 * 1024
const encoder = new TextEncoder()
const PHYSICAL_PART = /^parts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9]{8}\.bin$/
const REQUIRED = ['settings.json', 'nodes.jsonl', 'events.jsonl', 'assets.jsonl', 'world-kv.jsonl'] as const

/** Writes must resolve only after the whole file has committed. */
export interface BundleWriter {
  exists(path: string): Promise<boolean>
  write(path: string, data: Uint8Array): Promise<void>
  remove(path: string): Promise<void>
}

/** Returned Blobs must be immutable snapshots, as FileSystemFileHandle.getFile provides. */
export interface BundleReader { read(path: string): Promise<Blob> }

export interface BundlePart { path: string; bytes: number; sha256: string }
export interface BundleEntry { path: string; bytes: number; parts: BundlePart[] }
export interface DirectoryBundleManifest {
  format: typeof DIRECTORY_BUNDLE_FORMAT
  formatVersion: 1
  schemaVersion: number
  exportedAt: number
  chunkBytes: number
  recordsHash: string
  counts: { nodes: number; live: number; trash: number; excluded: number; events: number; assets: number; assetBytes: number; worldKv: number }
  entries: BundleEntry[]
}

export interface BundleProgress { phase: 'export' | 'verify' | 'restore'; done: number; total: number; path?: string }
export interface DirectoryBundleOptions { chunkBytes?: number; now?: number; onProgress?: (progress: BundleProgress) => void }

export class DirectoryBundleError extends Error {
  readonly code: 'exists' | 'invalid' | 'missing' | 'hash' | 'occupied' | 'backup' | 'restore'
  backupName?: string
  constructor(code: DirectoryBundleError['code'], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DirectoryBundleError'
    this.code = code
  }
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
function fail(message: string): never { throw new DirectoryBundleError('invalid', message) }
const assetPath = (id: string) => `assets/${encodeURIComponent(id)}`

function validatePath(path: string): void {
  if (path === MANIFEST || PHYSICAL_PART.test(path)) return
  fail(`Invalid bundle path: ${path}`)
}

async function* rows(values: Iterable<unknown>): AsyncGenerator<Uint8Array> {
  for (const value of values) yield encoder.encode(`${JSON.stringify(value)}\n`)
}

async function* blobChunks(blob: Blob): AsyncGenerator<Uint8Array> {
  const reader = blob.stream().getReader()
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      yield result.value
    }
  } finally { reader.releaseLock() }
}

/** A directory has no ZIP32 entry or total-byte limit; only individual parts are bounded. */
export async function exportDirectoryBundle(store: WorldStore, writer: BundleWriter, opts: DirectoryBundleOptions = {}): Promise<DirectoryBundleManifest> {
  if (await writer.exists(MANIFEST)) throw new DirectoryBundleError('exists', 'This directory already contains a completed bundle. Choose a new backup directory.')
  const chunkBytes = opts.chunkBytes ?? MAX_BUNDLE_PART_BYTES
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_BUNDLE_PART_BYTES) fail('Bundle part size must be between 1 byte and 64 MiB.')
  const { settings, nodes, events, assets, kv: worldKv } = await readWorldSnapshot(store, WORLD_KV_KEYS)
  validateOriginalReferences(nodes, assets)
  const kv: [string, unknown][] = Object.entries(worldKv)
  validateKnowledgeOriginals(Object.fromEntries(kv), assets)
  const voiceHashes = new Map(voiceOriginalReferences(worldKv).map((voice) => [voice.id, voice.hash]))
  for (const id of writingOriginalReferences(worldKv)) voiceHashes.set(id, id.slice('writing-'.length))
  for (const id of bookshelfOriginalReferences(worldKv)) voiceHashes.set(id, id.split('-').at(-1)!)
  for (const id of crmOriginalReferences(worldKv)) voiceHashes.set(id, id.split('-').at(-1)!)
  const runId = crypto.randomUUID()
  let partIndex = 0
  let written = 0
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0)
  const entries: BundleEntry[] = []
  const writeEntry = async (path: string, input: AsyncIterable<Uint8Array>): Promise<void> => {
    const entry: BundleEntry = { path, bytes: 0, parts: [] }
    let buffer = new Uint8Array(chunkBytes)
    let used = 0
    const flush = async () => {
      if (!used) return
      const bytes = buffer.subarray(0, used)
      const partPath = `parts/${runId}/${String(partIndex++).padStart(8, '0')}.bin`
      if (!PHYSICAL_PART.test(partPath)) fail('Bundle part count exceeds the supported path range.')
      const sha256 = await hashBytes(bytes)
      await writer.write(partPath, bytes)
      entry.parts.push({ path: partPath, bytes: used, sha256 })
      entry.bytes += used
      written += used
      opts.onProgress?.({ phase: 'export', done: written, total: Math.max(totalBytes, written), path })
      buffer = new Uint8Array(chunkBytes)
      used = 0
    }
    for await (const bytes of input) {
      for (let offset = 0; offset < bytes.length;) {
        const take = Math.min(bytes.length - offset, chunkBytes - used)
        buffer.set(bytes.subarray(offset, offset + take), used)
        used += take
        offset += take
        if (used === chunkBytes) await flush()
      }
    }
    await flush()
    entries.push(entry)
  }
  try {
    await writeEntry('settings.json', rows([settings]))
    await writeEntry('nodes.jsonl', rows(nodes))
    await writeEntry('events.jsonl', rows(events))
    await writeEntry('assets.jsonl', rows(assets))
    await writeEntry('world-kv.jsonl', rows(kv))
    for (const meta of assets) {
      const original = await store.getBlob(meta.id)
      if (!original || original.size !== meta.bytes) throw new DirectoryBundleError('missing', `Original ${meta.id} is missing or has the wrong byte count. The backup was not completed.`)
      if (voiceHashes.has(meta.id) && await hashBytes(original) !== voiceHashes.get(meta.id)) throw new DirectoryBundleError('hash', 'A retained voice or writing original differs from its SHA-256 receipt. The backup was not completed.')
      await writeEntry(assetPath(meta.id), blobChunks(original))
    }
    const manifest: DirectoryBundleManifest = {
      format: DIRECTORY_BUNDLE_FORMAT, formatVersion: DIRECTORY_BUNDLE_VERSION, schemaVersion: SCHEMA_VERSION,
      exportedAt: opts.now ?? Date.now(), chunkBytes, recordsHash: await hashRecords(nodes),
      counts: { nodes: nodes.length, live: nodes.filter((n) => n.deletedAt === null && !n.corpusExcluded).length, trash: nodes.filter((n) => n.deletedAt !== null).length, excluded: nodes.filter((n) => n.deletedAt === null && n.corpusExcluded).length, events: events.length, assets: assets.length, assetBytes: totalBytes, worldKv: kv.length }, entries,
    }
    const bytes = encoder.encode(JSON.stringify(manifest))
    if (bytes.length > MAX_MANIFEST_BYTES) fail('The bundle manifest exceeds 64 MiB; split this corpus into separate backups.')
    // This is the only commit marker. Partial exports never have a completed manifest.
    await writer.write(MANIFEST, bytes)
    return manifest
  } catch (error) {
    await writer.remove(MANIFEST).catch(() => {})
    throw error
  }
}

function checkManifest(value: unknown): DirectoryBundleManifest {
  if (!object(value) || value.format !== DIRECTORY_BUNDLE_FORMAT || value.formatVersion !== DIRECTORY_BUNDLE_VERSION) fail('This is not a supported Worldview directory bundle.')
  if (!integer(value.schemaVersion) || value.schemaVersion < 1 || value.schemaVersion > SCHEMA_VERSION) fail('This bundle requires a different application data schema.')
  if (!integer(value.exportedAt) || !integer(value.chunkBytes) || value.chunkBytes < 1 || value.chunkBytes > MAX_BUNDLE_PART_BYTES || typeof value.recordsHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.recordsHash) || !Array.isArray(value.entries) || !object(value.counts)) fail('Invalid directory bundle manifest.')
  const counts = value.counts
  if (!['nodes', 'live', 'trash', 'excluded', 'events', 'assets', 'assetBytes', 'worldKv'].every((key) => integer(counts[key]))) fail('Invalid bundle counts.')
  const entryPaths = new Set<string>()
  const partPaths = new Set<string>()
  for (const entry of value.entries) {
    if (!object(entry) || typeof entry.path !== 'string' || !integer(entry.bytes) || !Array.isArray(entry.parts)) fail('Invalid bundle entry.')
    if (!REQUIRED.includes(entry.path as typeof REQUIRED[number]) && !/^assets\/[A-Za-z0-9_.!~*'()%+-]+$/.test(entry.path)) fail(`Unexpected logical bundle entry: ${entry.path}`)
    if (entryPaths.has(entry.path)) fail(`Duplicate bundle entry: ${entry.path}`)
    entryPaths.add(entry.path)
    let bytes = 0
    for (const part of entry.parts) {
      if (!object(part) || typeof part.path !== 'string' || !PHYSICAL_PART.test(part.path) || !integer(part.bytes) || part.bytes < 1 || part.bytes > value.chunkBytes || typeof part.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(part.sha256) || partPaths.has(part.path)) fail('Invalid, unsafe or duplicate bundle part.')
      partPaths.add(part.path)
      bytes += part.bytes
      if (!Number.isSafeInteger(bytes)) fail('Bundle entry exceeds safe byte accounting.')
    }
    if (bytes !== entry.bytes) fail(`Part lengths do not match ${entry.path}.`)
  }
  if (REQUIRED.some((path) => !entryPaths.has(path))) fail('The bundle is missing required metadata.')
  return value as unknown as DirectoryBundleManifest
}

async function jsonRows(blob: Blob, name: string): Promise<unknown[]> {
  if (blob.size > MAX_METADATA_BYTES) fail(`${name} exceeds the supported 512 MiB metadata limit.`)
  const reader = blob.stream().pipeThrough(new TextDecoderStream('utf-8', { fatal: true })).getReader()
  const output: unknown[] = []
  let pending = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (value) pending += value
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.trim()) output.push(JSON.parse(line))
      }
      if (done) break
    }
    if (pending.trim()) output.push(JSON.parse(pending))
  } catch (error) { throw new DirectoryBundleError('invalid', `${name} contains invalid JSON or UTF-8.`, { cause: error }) }
  finally { reader.releaseLock() }
  return output
}

function checkNode(value: unknown): NodeRecord {
  if (!object(value) || typeof value.id !== 'string' || !value.id || typeof value.title !== 'string' || typeof value.slug !== 'string' || typeof value.contentMd !== 'string' || !ARCHETYPES.includes(value.archetype as NodeRecord['archetype']) || !number(value.temporalOrigin) || !Array.isArray(value.anchorXZ) || value.anchorXZ.length !== 2 || !value.anchorXZ.every(number) || !Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string') || !Array.isArray(value.links) || !Array.isArray(value.attachments) || !object(value.thermo) || !number(value.thermo.mass) || !number(value.thermo.temperature) || !(value.deletedAt === null || number(value.deletedAt))) fail('The bundle contains an invalid node record.')
  return value as unknown as NodeRecord
}

function validateOriginalReferences(nodes: readonly NodeRecord[], assets: readonly AssetMeta[]): void {
  const known = new Set(assets.map((asset) => asset.id))
  for (const node of nodes) {
    const references = [
      ...node.attachments.flatMap((attachment) => [attachment.blobId, ...(attachment.thumbBlobId ? [attachment.thumbBlobId] : [])]),
      ...[node.splat?.proxyAssetId, node.splat?.interiorAssetId, node.splat?.thumbAssetId].filter((id): id is string => !!id),
    ]
    for (const id of references) if (!known.has(id)) throw new DirectoryBundleError('missing', `Record ${node.id} refers to missing original asset ${id}. The backup was not completed.`)
  }
}

function validateKnowledgeOriginals(kv: Record<string, unknown>, assets: readonly AssetMeta[]): void {
  for (const id of [...writingOriginalReferences(kv), ...bookshelfOriginalReferences(kv), ...crmOriginalReferences(kv)]) if (!assets.some((asset) => asset.id === id)) throw new DirectoryBundleError('missing', 'A writing original is missing. The bundle was not completed.')
  for (const voice of voiceOriginalReferences(kv)) {
    const asset = assets.find((item) => item.id === voice.id)
    if (!asset || asset.bytes !== voice.bytes) throw new DirectoryBundleError('missing', 'A voice original is missing or differs from its receipt. The bundle was not completed.')
  }
  const knowledge = kv['knowledge.v1']
  if (!object(knowledge) || !Array.isArray(knowledge.versions)) return
  const known = new Set(assets.map((asset) => asset.id))
  for (const version of knowledge.versions) {
    if (!object(version) || typeof version.originalBlobId !== 'string') fail('The knowledge ledger contains an invalid original reference.')
    if (!known.has(version.originalBlobId) && version.originalPurged !== true) throw new DirectoryBundleError('missing', `Source version ${String(version.id)} refers to a missing original. The bundle was not completed.`)
  }
}

function unique<T extends { id: string }>(values: T[], label: string): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) fail(`The bundle contains duplicate ${label} identifiers.`)
}

export interface ParsedDirectoryBundle {
  manifest: DirectoryBundleManifest
  settings: WorldSettings | null
  nodes: NodeRecord[]
  events: InteractionEvent[]
  assets: AssetMeta[]
  kv: Record<string, unknown>
  assetData(id: string): Promise<Blob>
}

/** Verifies every bounded piece, all metadata and the record hash before any store is touched. */
export async function readDirectoryBundle(reader: BundleReader, opts: Pick<DirectoryBundleOptions, 'onProgress'> = {}): Promise<ParsedDirectoryBundle> {
  let raw: Blob
  try { raw = await reader.read(MANIFEST) } catch (error) { throw new DirectoryBundleError('missing', 'No completed manifest.json was found. This backup may be incomplete.', { cause: error }) }
  if (raw.size > MAX_MANIFEST_BYTES) fail('The bundle manifest exceeds 64 MiB.')
  let manifest: DirectoryBundleManifest
  try { manifest = checkManifest(JSON.parse(await raw.text())) } catch (error) {
    if (error instanceof DirectoryBundleError) throw error
    throw new DirectoryBundleError('invalid', 'The manifest is not valid JSON.', { cause: error })
  }
  const files = new Map<string, Blob>()
  const total = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0)
  let done = 0
  for (const entry of manifest.entries) {
    const parts: Blob[] = []
    for (const part of entry.parts) {
      let blob: Blob
      try { blob = await reader.read(part.path) } catch (error) { throw new DirectoryBundleError('missing', `Missing backup part: ${part.path}`, { cause: error }) }
      if (blob.size !== part.bytes || blob.size > MAX_BUNDLE_PART_BYTES) fail(`Invalid byte count in ${part.path}.`)
      if (await hashBytes(blob) !== part.sha256) throw new DirectoryBundleError('hash', `SHA-256 verification failed for ${part.path}. Nothing was restored.`)
      parts.push(blob)
      done += blob.size
      opts.onProgress?.({ phase: 'verify', done, total, path: entry.path })
    }
    files.set(entry.path, new Blob(parts))
  }
  const get = (path: string): Blob => files.get(path) ?? fail(`Missing bundle entry: ${path}`)
  const settingsRows = await jsonRows(get('settings.json'), 'settings.json')
  if (settingsRows.length !== 1) fail('Settings must contain exactly one JSON value.')
  const settings = settingsRows[0]
  if (settings !== null && (!object(settings) || !number(settings.T0) || !number(settings.yPerYear) || !number(settings.stepsPerYear) || !number(settings.physicsSeed) || !number(settings.createdAt) || !integer(settings.schemaVersion))) fail('The bundle has invalid settings.')
  const nodes = (await jsonRows(get('nodes.jsonl'), 'nodes.jsonl')).map(checkNode)
  unique(nodes, 'node')
  const events = (await jsonRows(get('events.jsonl'), 'events.jsonl')).map((value): InteractionEvent => {
    if (!object(value) || typeof value.id !== 'string' || !value.id || !number(value.t) || typeof value.nodeId !== 'string' || !['dwell', 'inspect', 'enter', 'demon-match'].includes(String(value.kind))) fail('The bundle contains an invalid interaction event.')
    return value as unknown as InteractionEvent
  })
  unique(events, 'event')
  const assets = (await jsonRows(get('assets.jsonl'), 'assets.jsonl')).map((value): AssetMeta => {
    if (!object(value) || typeof value.id !== 'string' || !value.id || !['splat-proxy', 'splat-interior', 'splat-thumb', 'image', 'image-thumb', 'text', 'file'].includes(String(value.kind)) || typeof value.mime !== 'string' || !integer(value.bytes) || !number(value.createdAt) || !(value.nodeId === null || typeof value.nodeId === 'string')) fail('The bundle contains invalid asset metadata.')
    if (get(assetPath(value.id)).size !== value.bytes) fail(`Asset byte count differs for ${value.id}.`)
    return value as unknown as AssetMeta
  })
  unique(assets, 'asset')
  const kv: Record<string, unknown> = {}
  for (const row of await jsonRows(get('world-kv.jsonl'), 'world-kv.jsonl')) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !WORLD_KV_KEYS.includes(row[0]) || Object.hasOwn(kv, row[0])) fail('The bundle has invalid or duplicate world-owned state.')
    kv[row[0]] = row[1]
  }
  if (nodes.length && settings === null) fail('A bundle containing records must also include settings.')
  if (settings !== null) {
    const checked = validateSettings(settings as unknown as WorldSettings, Math.max(manifest.exportedAt, Date.now()))
    if (!checked.ok) fail(`Invalid settings: ${checked.errors[0]?.message}`)
    const slugs = new Set<string>()
    const attachmentIds = new Set<string>()
    for (const node of nodes) {
      // Physical spacing and missing historical link targets are not schema corruption.
      // Validate the record independently, then check saved relationships explicitly.
      const checkedNode = validateNode({ ...node, links: [] }, { settings: settings as unknown as WorldSettings, now: Math.max(manifest.exportedAt, Date.now()), others: [] })
      if (!checkedNode.ok) fail(`Invalid record ${node.id}: ${checkedNode.errors[0]?.message}`)
      if (slugs.has(node.slug)) fail(`Duplicate node slug ${node.slug}.`)
      slugs.add(node.slug)
      const relationships = new Set<string>()
      for (const relationship of node.links) {
        if (!object(relationship) || typeof relationship.targetId !== 'string' || relationship.targetId === node.id || !['relates', 'supports', 'contradicts', 'derives', 'influenced-by'].includes(String(relationship.kind)) || !number(relationship.createdAt) || relationship.label !== undefined && typeof relationship.label !== 'string') fail(`Invalid saved relationship on ${node.id}.`)
        const key = `${relationship.targetId}:${relationship.kind}`
        if (relationships.has(key)) fail(`Duplicate saved relationship on ${node.id}.`)
        relationships.add(key)
      }
      for (const attachment of node.attachments) {
        if (!object(attachment) || typeof attachment.id !== 'string' || !attachment.id || attachmentIds.has(attachment.id) || !['image', 'text', 'file'].includes(String(attachment.kind)) || typeof attachment.name !== 'string' || typeof attachment.mime !== 'string' || typeof attachment.blobId !== 'string' || !integer(attachment.bytes) || !number(attachment.createdAt) || attachment.thumbBlobId !== undefined && typeof attachment.thumbBlobId !== 'string') fail(`Invalid attachment on ${node.id}.`)
        attachmentIds.add(attachment.id)
      }
    }
  }
  validateOriginalReferences(nodes, assets)
  validateKnowledgeOriginals(kv, assets)
  for (const voice of voiceOriginalReferences(kv)) if (await hashBytes(get(assetPath(voice.id))) !== voice.hash) throw new DirectoryBundleError('hash', 'A voice original differs from its retained SHA-256 receipt. Nothing was restored.')
  for (const id of writingOriginalReferences(kv)) if (await hashBytes(get(assetPath(id))) !== id.slice('writing-'.length)) throw new DirectoryBundleError('hash', 'A writing original differs from its retained SHA-256 reference. Nothing was restored.')
  for (const id of bookshelfOriginalReferences(kv)) if (await hashBytes(get(assetPath(id))) !== id.split('-').at(-1)) throw new DirectoryBundleError('hash', 'A bookshelf original differs from its SHA-256 reference. Nothing was restored.')
  for (const id of crmOriginalReferences(kv)) if (await hashBytes(get(assetPath(id))) !== id.split('-').at(-1)) throw new DirectoryBundleError('hash', 'A CRM original differs from its SHA-256 reference. Nothing was restored.')
  const actualCounts = { nodes: nodes.length, live: nodes.filter((n) => n.deletedAt === null && !n.corpusExcluded).length, trash: nodes.filter((n) => n.deletedAt !== null).length, excluded: nodes.filter((n) => n.deletedAt === null && n.corpusExcluded).length, events: events.length, assets: assets.length, assetBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0), worldKv: Object.keys(kv).length }
  if (Object.entries(actualCounts).some(([key, value]) => manifest.counts[key as keyof typeof actualCounts] !== value)) fail('The completed bundle counts do not match its content.')
  if (files.size !== REQUIRED.length + assets.length) fail('The bundle contains unlisted or duplicate asset entries.')
  if (await hashRecords(nodes) !== manifest.recordsHash) throw new DirectoryBundleError('hash', 'The node record hash does not match. Nothing was restored.')
  return { manifest, settings: settings as WorldSettings | null, nodes, events, assets, kv, async assetData(id) { return get(assetPath(id)) } }
}

export const verifyDirectoryBundle = readDirectoryBundle

export interface DirectoryRestoreOptions {
  /** Nonempty targets require both explicit replacement and a newly verified backup. */
  replace?: boolean
  backup?: () => Promise<{ name: string; reader: BundleReader }>
  preserveKv?: readonly string[]
  now?: number
  onProgress?: (progress: BundleProgress) => void
}

export interface DirectoryRestoreResult { manifest: DirectoryBundleManifest; nodes: number; events: number; assets: number; backupName: string | null }

export async function restoreDirectoryBundle(store: WorldStore, reader: BundleReader, opts: DirectoryRestoreOptions = {}): Promise<DirectoryRestoreResult> {
  const parsed = await readDirectoryBundle(reader, opts)
  const { settings, nodes, events, assets, kv: currentKv } = await readWorldSnapshot(store, WORLD_KV_KEYS)
  const expectedKnowledgeRevision = stateRevision(currentKv['knowledge.v1'])
  const occupied = settings !== null || nodes.length > 0 || events.length > 0 || assets.length > 0 || Object.keys(currentKv).length > 0
  let backupName: string | null = null
  if (occupied) {
    if (!opts.replace) throw new DirectoryBundleError('occupied', 'Restore defaults to an empty workspace. Explicitly choose replacement to restore over existing data.')
    if (!opts.backup) throw new DirectoryBundleError('backup', 'Replacement requires a verified backup of the current workspace.')
    try {
      const backup = await opts.backup()
      const verified = await readDirectoryBundle(backup.reader)
      // Ensure the callback backed up this workspace, rather than an unrelated empty one.
      if (verified.manifest.recordsHash !== await hashRecords(nodes) || await hashJson(verified.settings) !== await hashJson(settings) || await hashRecords(verified.events) !== await hashRecords(events) || await hashRecords(verified.assets) !== await hashRecords(assets) || await hashJson(verified.kv) !== await hashJson(currentKv)) throw new Error('The backup does not match the current workspace.')
      for (const meta of assets) {
        const original = await store.getBlob(meta.id)
        const entry = verified.manifest.entries.find((entry) => entry.path === assetPath(meta.id))
        if (!original || original.size !== meta.bytes || !entry) throw new Error('A current original is missing from the backup.')
        let offset = 0
        for (const part of entry.parts) {
          if (await hashBytes(original.slice(offset, offset + part.bytes)) !== part.sha256) throw new Error('An original differs from its pre-restore backup.')
          offset += part.bytes
        }
      }
      backupName = backup.name
    } catch (error) { throw new DirectoryBundleError('backup', 'The pre-restore backup could not be verified; existing data was left untouched.', { cause: error }) }
  }
  const kept = await Promise.all((opts.preserveKv ?? DEVICE_KV_KEYS).map(async (key) => [key, await store.getKv(key)] as const))
  const marker: ImportMarker = { backupName, backupKind: 'directory', startedAt: opts.now ?? Date.now() }
  try {
    await store.resetWithKv(IMPORT_MARKER_KV, marker, opts.preserveKv ?? DEVICE_KV_KEYS, expectedKnowledgeRevision >= 0 ? expectedKnowledgeRevision : undefined)
    if (parsed.settings) await store.putSettings(parsed.settings)
    if (parsed.nodes.length) await store.putNodes(parsed.nodes)
    for (const event of parsed.events) await store.appendEvent(event)
    let restored = 0
    for (const meta of parsed.assets) {
      await store.putBlob({ meta, data: await parsed.assetData(meta.id) })
      restored += meta.bytes
      opts.onProgress?.({ phase: 'restore', done: restored, total: parsed.manifest.counts.assetBytes, path: assetPath(meta.id) })
    }
    for (const [key, value] of Object.entries(parsed.kv)) await store.putKv(key, value)
    for (const [key, value] of kept) if (value !== undefined) await store.putKv(key, value)
    await store.deleteKv(IMPORT_MARKER_KV)
  } catch (error) {
    if (error instanceof WorldStateConflictError) throw error
    const failure = new DirectoryBundleError('restore', `Restore was interrupted. ${backupName ? `The previous workspace is retained in ${backupName}.` : 'The original bundle is intact; retry into an empty workspace.'}`, { cause: error })
    if (backupName) failure.backupName = backupName
    throw failure
  }
  return { manifest: parsed.manifest, nodes: parsed.nodes.length, events: parsed.events.length, assets: parsed.assets.length, backupName }
}

async function fileHandle(root: FileSystemDirectoryHandle, path: string, create: boolean): Promise<FileSystemFileHandle> {
  validatePath(path)
  const segments = path.split('/')
  let directory = root
  for (const segment of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(segment, { create })
  return directory.getFileHandle(segments.at(-1)!, { create })
}

export function directoryBundleWriter(handle: FileSystemDirectoryHandle): BundleWriter {
  return {
    async exists(path) {
      try { await fileHandle(handle, path, false); return true } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return false
        throw error
      }
    },
    async write(path, data) {
      const file = await fileHandle(handle, path, true)
      const stream = await file.createWritable()
      try { await stream.write(data.slice()); await stream.close() } catch (error) { await stream.abort().catch(() => {}); throw error }
    },
    async remove(path) {
      validatePath(path)
      const segments = path.split('/')
      let directory = handle
      for (const segment of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(segment)
      await directory.removeEntry(segments.at(-1)!).catch((error: unknown) => { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error })
    },
  }
}

export function directoryBundleReader(handle: FileSystemDirectoryHandle): BundleReader {
  return { async read(path) { return (await fileHandle(handle, path, false)).getFile() } }
}
