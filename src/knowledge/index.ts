import { create } from 'zustand'
import { Immer, current, freeze, isDraft, type Draft } from 'immer'
import { unzipSync, strFromU8 } from 'fflate'
import { useWorld } from '../app/store.ts'
import { commitKnowledgeState, createNode, getStore, getWorldGeneration, isRepoReady, link, unlink, retainWorldBlob, updateNode, useRepoStatus } from '../data/repo.ts'
import type { WorldStore } from '../data/WorldStore.ts'
import type { NodeRecord } from '../domain/types.ts'
import { CLIENT_ID } from '../data/serverSync.ts'
import { searchCorpusSemantic } from '../ai/corpusSemantic.ts'
import { useSemantic } from '../ai/semanticIndex.ts'
import { parseKnowledgeText, splitPassages } from './parsers.ts'
import { rankKnowledge, topicWords } from './retrieval.ts'
import { OrganizationIndex } from './organization.ts'
import { diffKnowledgeSnapshots, KNOWLEDGE_COLLECTIONS, type KnowledgeCommitOptions } from './storage.ts'
import { isArtifactProjection } from './derived.ts'
import { purgeArtifactSources } from './artifacts/purge.ts'
import { ARTIFACTS_KV, type ArtifactSnapshot } from './artifacts/types.ts'
import type { VoiceSnapshot } from '../capture/voiceInbox.ts'
import { assertPortableImportAllowed, portableIdentity, portablePassages, sourceForParsed } from './portableIdentity.ts'
import { vaultGraph } from './vault.ts'
import { preparePortableCollections } from './portableCollections.ts'
import { fuseEvidence, retrievalCoverage, useRetrievalTrace } from './retrievalTrace.ts'
import { searchNativeQmd } from './qmd.ts'
import { eligibleEvidence } from './evidencePolicy.ts'
import type { Authorship, ImportReceipt, KnowledgeSnapshot, KnowledgeSource, ParsedSource, SearchFilters, SearchHit, SourceVersion } from './types.ts'

export type * from './types.ts'
export { parseKnowledgeText, splitPassages } from './parsers.ts'
export { rankKnowledge, topicWords } from './retrieval.ts'

export const KNOWLEDGE_KV = 'knowledge.v1'
const empty = (): KnowledgeSnapshot => ({ schemaVersion: 1, revision: 0, sources: [], versions: [], passages: [], imports: [], proposals: [], jobs: [] })
interface KnowledgeState extends KnowledgeSnapshot { loaded: boolean; busy: boolean; error: string | null }
export const useKnowledge = create<KnowledgeState>()(() => ({ ...empty(), loaded: false, busy: false, error: null }))
let boundStore: WorldStore | null = null
let queue: Promise<unknown> = Promise.resolve()
const cancelledJobs = new Set<string>()
let nodeDigests = new WeakMap<NodeRecord, string | Promise<string>>()
let organizationIndex = new OrganizationIndex()
let organizationGeneration = 0
let organizationTimer: ReturnType<typeof setTimeout> | null = null
let organizationRun: Promise<void> | null = null
let drainingOrganization = false
const commandDrafts = new Immer({ autoFreeze: false })
let cachedSnapshot: KnowledgeSnapshot | null = null
const draftBases = new WeakMap<object, KnowledgeSnapshot>()
const draftScopes = new WeakMap<object, { store: WorldStore; generation: number }>()
let activeWriteDrafts: KnowledgeSnapshot[] | null = null

function plain<T extends object>(value: T): T { return isDraft(value) ? current(value as Draft<T>) : value }
function owned<T extends object>(value: T): T { return structuredClone(plain(value)) }

function resetDerivedCaches(): void {
  nodeDigests = new WeakMap()
  organizationIndex = new OrganizationIndex()
  organizationGeneration++
  if (organizationTimer) clearTimeout(organizationTimer)
  organizationTimer = null
  organizationRun = null
}

export async function knowledgeHash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value.slice()
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function publish(snapshot: KnowledgeSnapshot): void {
  useKnowledge.setState({ ...plain(snapshot), loaded: true, error: null })
}

async function readSnapshot(force = false): Promise<KnowledgeSnapshot> {
  const store = getStore()
  if (boundStore !== store) {
    boundStore = store
    cachedSnapshot = null
    resetDerivedCaches()
    useKnowledge.setState({ ...empty(), loaded: false, error: null })
  }
  const candidate = cachedSnapshot
  if (!force && candidate && store.getKnowledgeRevision && await store.getKnowledgeRevision() === candidate.revision) {
    if (!isRepoReady() || getStore() !== store) throw new Error('The active workspace changed while sources were loading.')
    return candidate
  }
  const data = await store.getKv<KnowledgeSnapshot>(KNOWLEDGE_KV)
  if (!isRepoReady() || getStore() !== store) throw new Error('The active workspace changed while sources were loading.')
  if (!data) return (cachedSnapshot = empty())
  if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !['sources', 'versions', 'passages', 'imports', 'proposals', 'jobs'].every((key) => Array.isArray(data[key as keyof KnowledgeSnapshot]))) throw new Error('The knowledge ledger has an unsupported or invalid format. Restore a verified backup before changing it.')
  // WorldStore reads already return private copies (IDB structured-clones, HTTP parses
  // JSON, and the memory adapter clones). A second full-corpus clone delays capture.
  // current(draft) can otherwise copy unread, unfrozen branches recursively. Freeze
  // our private cache once so unchanged evidence retains identity across commands.
  return (cachedSnapshot = freeze(data, true))
}

async function readWriteSnapshot(): Promise<KnowledgeSnapshot> {
  if (!activeWriteDrafts) throw new Error('Knowledge changes require a serialized command.')
  const base = await readSnapshot()
  const draft = commandDrafts.createDraft(base) as KnowledgeSnapshot
  draftBases.set(draft, base)
  draftScopes.set(draft, { store: getStore(), generation: getWorldGeneration() })
  activeWriteDrafts.push(draft)
  return draft
}

async function persist(snapshot: KnowledgeSnapshot, state?: KnowledgeCommitOptions['state'], projections?: Pick<KnowledgeCommitOptions, 'nodes' | 'expectedNodes'>): Promise<void> {
  assertDraftScope(snapshot)
  const expected = snapshot.revision
  snapshot.revision++
  try {
    if (useRepoStatus.getState().interruptedImport) throw new Error('Complete workspace recovery before changing sources.')
    const before = draftBases.get(snapshot) ?? cachedSnapshot ?? empty()
    const material = { ...plain(snapshot) }
    // New objects inserted into a draft can still be held by the command. Own changed
    // rows at publication, while unchanged text/rows retain identity for small deltas.
    for (const collection of KNOWLEDGE_COLLECTIONS) {
      if (material[collection] === before[collection]) continue
      const previous = new Map(before[collection].map((row) => [row.id, row]))
      ;(material as unknown as Record<string, unknown>)[collection] = material[collection].map((row) => previous.get(row.id) === row ? row : owned(row))
    }
    // New command-owned rows were cloned above; freezing this published snapshot
    // must not freeze the mutable source/version handles used by a later stage.
    freeze(material, true)
    const delta = diffKnowledgeSnapshots(before, material)
    await commitKnowledgeState(delta, { expectedRevision: expected, idempotencyKey: crypto.randomUUID(), state, ...projections }, material)
    cachedSnapshot = material
    draftBases.set(snapshot, material)
    publish(material)
    scheduleOrganization()
  } catch (error) {
    snapshot.revision = expected
    publish(await readSnapshot(true))
    throw error
  }
}

function serial<T>(action: () => Promise<T>): Promise<T> {
  const requestedStore = isRepoReady() ? getStore() : null
  const generation = getWorldGeneration()
  const result = queue.catch(() => {}).then(async () => {
    if (requestedStore && (!isRepoReady() || getStore() !== requestedStore || getWorldGeneration() !== generation)) throw new Error('The workspace changed before this source command could run.')
    const drafts: KnowledgeSnapshot[] = []
    activeWriteDrafts = drafts
    useKnowledge.setState({ busy: true, error: null })
    try { return await action() } catch (error) {
      useKnowledge.setState({ error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      for (const draft of drafts) commandDrafts.finishDraft(draft)
      if (activeWriteDrafts === drafts) activeWriteDrafts = null
      useKnowledge.setState({ busy: false })
    }
  })
  queue = result
  return result
}

function assertDraftScope(snapshot: KnowledgeSnapshot): void {
  const scope = draftScopes.get(snapshot)
  if (scope && (!isRepoReady() || getStore() !== scope.store || getWorldGeneration() !== scope.generation)) throw new Error('The workspace changed before this source command could finish.')
}

export function resetKnowledge(): void {
  boundStore = null
  cachedSnapshot = null
  queue = Promise.resolve()
  cancelledJobs.clear()
  resetDerivedCaches()
  useRetrievalTrace.setState({ run: null })
  useKnowledge.setState({ ...empty(), loaded: false, busy: false, error: null })
}

export function initializeKnowledge(opts: { migrateChat?: boolean } = {}): Promise<void> {
  return serial(async () => {
    if (!isRepoReady()) return
    const snapshot = await readWriteSnapshot()
    publish(snapshot)
    if (useRepoStatus.getState().interruptedImport) return
    if (!useRepoStatus.getState().writer) return
    if (opts.migrateChat) await migrateLegacyChat(snapshot)
    for (const source of snapshot.sources) {
      if (!source.nodeId || source.deleted) continue
      const world = useWorld.getState()
      const node = world.nodes.get(source.nodeId) ?? world.excluded.get(source.nodeId)
      if (node && !!node.corpusExcluded !== source.excluded) await updateNode(node.id, { corpusExcluded: source.excluded }, { keepAnchor: true })
    }
    for (const source of snapshot.sources.filter((s) => s.pendingProjection && !s.deleted && !s.excluded)) await projectSource(snapshot, source)
    if (snapshot.sources.some((s) => s.pendingProjection)) return
    // Import receipts retain original bytes; interrupted work can be resumed explicitly.
    let changed = false
    for (const receipt of snapshot.imports.filter((r) => r.status === 'running')) {
      receipt.status = 'partial'
      receipt.errors.push('Import interrupted. Retry resumes from the retained original files.')
      for (const job of snapshot.jobs.filter((j) => j.importId === receipt.id && j.status === 'running')) { job.status = 'failed'; job.error = 'Interrupted; retry is available.'; job.updatedAt = Date.now() }
      changed = true
    }
    if (changed) await persist(snapshot)
    else publish(snapshot)
    scheduleOrganization()
  })
}

export function refreshKnowledge(): Promise<void> {
  return serial(async () => { if (isRepoReady()) { publish(await readSnapshot(true)); scheduleOrganization() } })
}

async function saveOriginal(bytes: Uint8Array, mime: string): Promise<string> {
  const store = getStore(), generation = getWorldGeneration()
  const hash = await knowledgeHash(bytes)
  const id = `knowledge-${hash}`
  await retainWorldBlob({ meta: { id, kind: 'file', mime: mime || 'application/octet-stream', bytes: bytes.byteLength, createdAt: Date.now(), nodeId: null }, data: bytes }, { store, generation })
  return id
}

async function migrateLegacyChat(snapshot: KnowledgeSnapshot): Promise<void> {
  const legacy = await getStore().getKv<{ history?: { role?: string; content?: unknown }[] }>('chat.v1')
  if (!Array.isArray(legacy?.history)) return
  const messages: ParsedSource['messages'] = []
  let text = ''
  for (const [turn, message] of legacy.history.entries()) {
    if (message.role !== 'user') continue
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : []
    const authored = blocks.flatMap((raw: unknown) => {
      if (!raw || typeof raw !== 'object') return []
      const block = raw as { type?: unknown; text?: unknown }
      if (block.type !== 'text' || typeof block.text !== 'string' || /^\[(?:world|ui[:\]])/.test(block.text)) return []
      return [block.text]
    }).join('\n')
    if (!authored.trim()) continue
    if (text) text += '\n\n'
    const start = text.length
    text += authored
    messages.push({ id: `legacy-turn-${turn}`, text: authored, role: 'human', authoredAt: null, start, end: text.length })
  }
  if (!messages.length) return
  const parsed: ParsedSource = { externalId: 'legacy-chat:chat.v1', title: 'Previous chat: your messages', kind: 'conversation', text, messages, authoredAt: null, metadata: { indexedRoles: ['human'], omittedDueToDerivedContext: true, note: 'Assistant answers, hidden application context and tool results are preserved in the original but not indexed; their source dependencies are unknown.' } }
  let source = snapshot.sources.find((s) => s.externalId === parsed.externalId)
  const current = snapshot.versions.find((v) => v.id === source?.currentVersionId)
  const hash = await knowledgeHash(JSON.stringify({ text: parsed.text, messages: parsed.messages.map(({ id, parentId, role, authoredAt, start, end }) => ({ id, parentId, role, authoredAt, start, end })) }))
  if (current?.contentHash === hash) return
  const original = await saveOriginal(new TextEncoder().encode(JSON.stringify(legacy)), 'application/json')
  if (!source) {
    source = { id: crypto.randomUUID(), externalId: parsed.externalId, title: parsed.title, kind: 'conversation', currentVersionId: '', createdAt: Date.now(), updatedAt: Date.now(), excluded: false, aiAllowed: true, tags: topicWords(text) }
    snapshot.sources.push(source)
  }
  await addVersion(snapshot, source, parsed, original, 'legacy-chat.v1.json', 'legacy')
  await persist(snapshot)
}

function nodeDigest(node: NodeRecord): Promise<string> {
  const cached = nodeDigests.get(node)
  if (cached) return typeof cached === 'string' ? Promise.resolve(cached) : cached
  const digest = knowledgeHash(JSON.stringify({ title: node.title, text: node.contentMd })).then((value) => { nodeDigests.set(node, value); return value }, (error: unknown) => { nodeDigests.delete(node); throw error })
  nodeDigests.set(node, digest)
  return digest
}

function queueOrganization(snapshot: KnowledgeSnapshot, sourceIds: readonly string[]): void {
  const ids = sourceIds.filter((id) => snapshot.sources.some((source) => source.id === id && source.nodeId && !source.excluded && !source.deleted))
  if (!ids.length) return
  let job = snapshot.jobs.findLast((job) => job.kind === 'organize' && (job.status === 'queued' || job.status === 'running'))
  if (!job) {
    job = { id: crypto.randomUUID(), kind: 'organize', title: 'Find related sources', status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), completed: 0, total: 0, sourceIds: [] }
    snapshot.jobs.push(job)
  }
  job.sourceIds ??= []
  const pending = new Set(job.sourceIds.slice(job.completed))
  for (const id of ids) if (!pending.has(id)) { job.sourceIds.push(id); pending.add(id) }
  job.total = job.sourceIds.length
  job.updatedAt = Date.now()
}

function hasOrganizationWork(): boolean {
  return useKnowledge.getState().jobs.some((job) => job.kind === 'organize' && (job.status === 'queued' || job.status === 'running'))
}

function scheduleOrganization(): void {
  if (drainingOrganization || organizationTimer || organizationRun || !isRepoReady() || !useRepoStatus.getState().writer || useRepoStatus.getState().interruptedImport || !hasOrganizationWork()) return
  organizationTimer = setTimeout(() => {
    organizationTimer = null
    void runOrganizationStage().catch((error: unknown) => {
      if (isRepoReady()) useKnowledge.setState({ error: error instanceof Error ? error.message : String(error) })
    })
  }, 25)
}

function runOrganizationStage(): Promise<void> {
  if (organizationRun) return organizationRun
  const gen = organizationGeneration
  const store = isRepoReady() ? getStore() : null
  const index = organizationIndex
  let selectedId: string | null = null
  const active = () => gen === organizationGeneration && isRepoReady() && getStore() === store && useRepoStatus.getState().writer && !useRepoStatus.getState().interruptedImport && (!selectedId || !useKnowledge.getState().jobs.some((job) => job.id === selectedId && job.status === 'cancelled'))
  const run = (async () => {
    if (!active()) return
    const base = await readSnapshot()
    const selected = base.jobs.find((job) => job.kind === 'organize' && (job.status === 'queued' || job.status === 'running'))
    if (!selected || !active()) return
    selectedId = selected.id
    useKnowledge.setState((state) => ({ jobs: state.jobs.map((job) => job.id === selected.id ? { ...job, status: 'running' } : job) }))
    // Preparing a large disposable index yields outside the command queue; capture can
    // commit while this initial pass tokenizes sources.
    if (!await index.prepare(base, active)) return
    await serial(async () => {
      if (!active()) return
      const snapshot = await readWriteSnapshot()
      const job = snapshot.jobs.find((job) => job.id === selected.id)
      if (!job || job.status === 'cancelled' || job.status === 'complete' || !active()) return
      const ids = job.sourceIds ?? []
      const batch = ids.slice(job.completed, job.completed + 32)
      const sourceMap = new Map(snapshot.sources.map((source) => [source.id, source]))
      // A capture may have appended inputs while prepare yielded. Rebuild its terms
      // before advancing the durable cursor, rather than silently skipping that source.
      if (batch.some((id) => { const source = sourceMap.get(id); return source && !source.deleted && !source.excluded && source.nodeId && !index.isPrepared(source) })) return
      index.suggest(snapshot, batch)
      job.completed += batch.length
      job.total = ids.length
      job.status = job.completed >= job.total ? 'complete' : 'running'
      job.updatedAt = Date.now()
      job.error = undefined
      await persist(snapshot)
    })
  })().catch(async (error: unknown) => {
    if (!active() || !selectedId) return
    const message = error instanceof Error ? error.message : String(error)
    try {
      await serial(async () => {
        if (!active()) return
        const snapshot = await readWriteSnapshot()
        const job = snapshot.jobs.find((job) => job.id === selectedId)
        if (!job || job.status === 'complete' || job.status === 'cancelled') return
        job.attempts = (job.attempts ?? 0) + 1
        job.status = job.attempts >= 3 ? 'failed' : 'queued'
        job.error = message
        job.updatedAt = Date.now()
        await persist(snapshot)
      })
    } catch {
      // If even recording an error fails (for example quota exhaustion), stop this
      // runtime's retries. The durable queued job remains recoverable on restart.
      useKnowledge.setState((state) => ({ jobs: state.jobs.map((job) => job.id === selectedId ? { ...job, status: 'failed', error: message } : job), error: message }))
    }
  }).finally(() => {
    if (organizationRun === run) { organizationRun = null; scheduleOrganization() }
  })
  organizationRun = run
  return run
}

/** Explicitly waits for durable organization work rather than relying on UI timing. */
export async function waitForKnowledgeJobs(): Promise<void> {
  drainingOrganization = true
  if (organizationTimer) { clearTimeout(organizationTimer); organizationTimer = null }
  try {
    await queue.catch(() => {})
    if (organizationRun) await organizationRun
    for (let stage = 0; stage < 10000 && isRepoReady() && hasOrganizationWork(); stage++) await runOrganizationStage()
    if (hasOrganizationWork()) throw new Error('Organization is still processing; inspect its activity before continuing.')
  } finally { drainingOrganization = false; scheduleOrganization() }
}

function passagesFor(source: KnowledgeSource, version: SourceVersion, parsed: ParsedSource): void {
  const snapshot = activeSnapshot
  if (!snapshot) throw new Error('No active knowledge transaction')
  snapshot.passages.push(...splitPassages(parsed).map((part) => ({
    id: crypto.randomUUID(), sourceId: source.id, versionId: version.id, nodeId: source.nodeId, title: source.title,
    text: part.text, start: part.start, end: part.end, role: part.role, authoredAt: part.authoredAt,
    messageId: part.id, parentId: part.parentId, locator: part.locator,
  })))
}

// Only the serial command queue sets this while assembling a source version.
let activeSnapshot: KnowledgeSnapshot | null = null

async function addVersion(snapshot: KnowledgeSnapshot, source: KnowledgeSource, parsed: ParsedSource, originalBlobId: string, originalName: string, origin: SourceVersion['origin'], trackOriginalChanges = false): Promise<boolean> {
  const identity = portableIdentity(parsed)
  if (identity) assertPortableImportAllowed(snapshot, [parsed])
  const contentHash = identity?.contentHash ?? await knowledgeHash(JSON.stringify({ text: parsed.text, messages: parsed.messages.map(({ id, parentId, role, authoredAt, start, end }) => ({ id, parentId, role, authoredAt, start, end })) }))
  const current = snapshot.versions.find((v) => v.id === source.currentVersionId)
  const existingVersion = identity && snapshot.versions.find((version) => version.id === identity.versionId)
  if (existingVersion) {
    if (identity.isCurrent && source.currentVersionId !== existingVersion.id) { source.currentVersionId = existingVersion.id; source.updatedAt = Math.max(source.updatedAt, identity.sourceUpdatedAt); source.title = parsed.title; return true }
    return false
  }
  if (!identity && current?.contentHash === contentHash && current.text === parsed.text && (!trackOriginalChanges || current.originalBlobId === originalBlobId)) return false
  const metadata = { ...(parsed.metadata ?? {}) }
  delete metadata.portableIdentity; delete metadata.portablePassages; delete metadata.portableInvestigations
  const version: SourceVersion = { id: identity?.versionId ?? crypto.randomUUID(), sourceId: source.id, contentHash, originalBlobId, originalName, text: parsed.text, createdAt: identity?.createdAt ?? Date.now(), authoredAt: parsed.authoredAt, origin, previousVersionId: identity ? identity.previousVersionId : current?.id, metadata }
  snapshot.versions.push(version)
  source.currentVersionId = version.id
  source.updatedAt = Math.max(version.createdAt, identity?.sourceUpdatedAt ?? version.createdAt)
  source.title = parsed.title.slice(0, 200) || 'Untitled source'
  if (identity) snapshot.passages.push(...portablePassages(parsed, identity).map((passage) => ({ ...passage, sourceId: source.id, versionId: version.id, nodeId: source.nodeId })))
  else {
    activeSnapshot = snapshot
    try { passagesFor(source, version, parsed) } finally { activeSnapshot = null }
  }
  queueOrganization(snapshot, [source.id])
  return true
}

async function projectSource(snapshot: KnowledgeSnapshot, source: KnowledgeSource): Promise<void> {
  assertDraftScope(snapshot)
  const version = snapshot.versions.find((v) => v.id === source.currentVersionId)
  const settings = useWorld.getState().settings
  if (!version || !source.nodeId || !settings || source.deleted || source.excluded) return
  let node = useWorld.getState().nodes.get(source.nodeId) ?? useWorld.getState().excluded.get(source.nodeId)
  if (!node && useWorld.getState().trash.has(source.nodeId)) { source.deleted = true; source.pendingProjection = false; return }
  const tags = source.tags
  const body = version.text
  if (!node) node = await createNode({ id: source.nodeId, archetype: source.kind === 'thought' ? 'idea' : 'document', title: source.title, contentMd: body, tags, temporalOrigin: Math.max(settings.T0, Math.min(version.authoredAt ?? Date.now(), Date.now())), temporalPrecision: 'day', provenance: { source: 'file', ref: version.originalName, keptAt: version.createdAt } }, { announce: false })
  else if (!source.projectionEdited && (node.contentMd !== body || node.title !== source.title)) node = await updateNode(node.id, { contentMd: body, title: source.title }, { keepAnchor: true })
  source.projectionDigest = await nodeDigest(node)
  source.pendingProjection = false
  queueOrganization(snapshot, [source.id])
  await persist(snapshot)
}

async function parsedFile(bytes: Uint8Array, path: string, mime: string): Promise<ParsedSource[]> {
  if (/\.pdf$/i.test(path) || mime === 'application/pdf') {
    const result = await fetch('/api/extract-text', { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-wv-client': CLIENT_ID }, body: new Blob([bytes.slice()], { type: 'application/pdf' }) })
    if (!result.ok) {
      const details = await result.json().catch(() => null) as { error?: unknown } | null
      throw new Error(typeof details?.error === 'string' ? details.error : 'PDF original saved. Retry when the local PDF extractor is available.')
    }
    const extracted = await result.json() as { text?: unknown; pages?: unknown }
    if (typeof extracted.text !== 'string') throw new Error('PDF extraction returned invalid text. Original retained.')
    const source = parseKnowledgeText(extracted.text, `${path}.txt`, 'text/plain')[0]
    source.externalId = `document:${path.normalize('NFC')}`
    source.title = path.split('/').at(-1)?.replace(/\.pdf$/i, '') || path
    source.metadata = { path, pages: extracted.pages }
    return [source]
  }
  if (/\.docx$/i.test(path)) {
    const files = unzipSync(bytes, { filter: (entry) => {
      if (entry.name !== 'word/document.xml') return false
      if (entry.originalSize > 16 * 1024 * 1024) throw new Error('Expanded Word document text exceeds the 16 MiB local indexing limit. Original retained.')
      return true
    } })
    const xml = files['word/document.xml']
    if (!xml) throw new Error('This document has no word/document.xml. Original retained.')
    const decode = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    const text = decode(strFromU8(xml).replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''))
    const parsed = parseKnowledgeText(text, `${path}.txt`, 'text/plain')[0]
    parsed.externalId = `document:${path.normalize('NFC')}`
    parsed.title = path.split('/').at(-1)?.replace(/\.docx$/i, '') || path
    return [parsed]
  }
  return parseKnowledgeText(new TextDecoder('utf-8', { fatal: true }).decode(bytes), path, mime)
}

async function processReceipt(snapshot: KnowledgeSnapshot, receipt: ImportReceipt): Promise<ImportReceipt> {
  receipt.status = 'running'
  receipt.errors = []
  const job = snapshot.jobs.find((j) => j.importId === receipt.id)!
  job.status = 'running'
  job.error = undefined
  await persist(snapshot)
  const pauseRequested = async (): Promise<boolean> => {
    if (!cancelledJobs.has(job.id)) return false
    cancelledJobs.delete(job.id)
    job.status = 'cancelled'
    job.updatedAt = Date.now()
    receipt.status = 'partial'
    receipt.errors.push('Processing paused. Originals already saved; Resume continues unfinished items.')
    await persist(snapshot)
    return true
  }
  for (const [index, item] of receipt.items.entries()) {
    if (await pauseRequested()) return owned(receipt)
    if (item.status === 'saved' || item.status === 'unchanged') continue
    try {
      const original = await getStore().getBlob(item.blobId)
      if (!original) throw new Error('The retained original is missing. Restore it from a backup or import the file again.')
      const parsed = await parsedFile(new Uint8Array(await original.arrayBuffer()), item.path, item.mime)
      const world = useWorld.getState()
      assertPortableImportAllowed(snapshot, parsed, [...world.nodes.keys(), ...world.trash.keys(), ...world.excluded.keys()])
      const importCollections = await preparePortableCollections(parsed, snapshot)
      let changed = false
      for (const document of parsed) {
        if (await pauseRequested()) return owned(receipt)
        const imported = sourceForParsed(snapshot, document, { occupiedNodeIds: [...world.nodes.keys(), ...world.trash.keys(), ...world.excluded.keys()] })
        const source = imported.source
        if (imported.created && !portableIdentity(document)) source.tags = topicWords(document.text)
        const added = await addVersion(snapshot, source, document, item.blobId, item.path, 'import')
        if (!item.sourceIds.includes(source.id)) item.sourceIds.push(source.id)
        if (added || imported.policyChanged) { changed = true; source.pendingProjection = true; await persist(snapshot) }
        if (source.pendingProjection) await projectSource(snapshot, source)
      }
      await importCollections?.()
      item.status = changed ? 'saved' : 'unchanged'
      item.error = undefined
    } catch (error) {
      item.status = 'failed'
      item.error = error instanceof Error ? error.message : String(error)
      receipt.errors.push(`${item.path}: ${item.error}`)
    }
    receipt.checkpoint = index + 1
    receipt.saved = receipt.items.filter((entry) => entry.status === 'saved').length
    receipt.unchanged = receipt.items.filter((entry) => entry.status === 'unchanged').length
    receipt.failed = receipt.items.filter((entry) => entry.status === 'failed').length
    job.completed = receipt.items.filter((entry) => entry.status !== 'queued').length
    job.updatedAt = Date.now()
    await persist(snapshot)
  }
  receipt.failed = receipt.items.filter((item) => item.status === 'failed').length
  await reconcileVaultGraph(snapshot)
  receipt.status = receipt.failed ? receipt.failed === receipt.total ? 'failed' : 'partial' : 'complete'
  job.status = receipt.failed ? 'failed' : 'complete'
  job.error = receipt.failed ? `${receipt.failed} input file(s) need retry.` : undefined
  await persist(snapshot)
  return owned(receipt)
}

/** Explicit references create saved relationships; manual removals suppress regeneration. */
async function reconcileVaultGraph(snapshot: KnowledgeSnapshot): Promise<void> {
  const graph = vaultGraph(snapshot)
  let changed = false
  for (const source of snapshot.sources) {
    if (!source.nodeId || source.deleted || source.excluded) continue
    const node = useWorld.getState().nodes.get(source.nodeId)
    if (!node) continue
    const previous = source.vaultGraph ?? { links: [], suppressedTargets: [], diagnostics: [] }
    const suppressed = new Set(previous.suppressedTargets)
    const wanted = graph.edges.filter((edge) => edge.sourceId === source.id)
    for (const old of previous.links) {
      const existing = node.links.find((edge) => edge.targetId === old.targetNodeId && edge.kind === 'relates' && edge.createdAt === old.createdAt)
      if (!existing && wanted.some((edge) => edge.targetSourceId === old.targetSourceId)) suppressed.add(old.targetSourceId)
      if (existing && !wanted.some((edge) => edge.targetSourceId === old.targetSourceId)) await unlink(node.id, old.targetNodeId, 'relates')
    }
    const introduced: NonNullable<KnowledgeSource['vaultGraph']>['links'] = []
    for (const edge of wanted) {
      if (suppressed.has(edge.targetSourceId)) continue
      const current = useWorld.getState().nodes.get(node.id)!
      const existing = current.links.find((item) => item.targetId === edge.targetNodeId && item.kind === 'relates')
      const ownedLink = previous.links.find((item) => item.targetNodeId === edge.targetNodeId && item.createdAt === existing?.createdAt)
      if (existing) { if (ownedLink) introduced.push(ownedLink); continue }
      await link(node.id, edge.targetNodeId, 'relates')
      const saved = useWorld.getState().nodes.get(node.id)?.links.find((item) => item.targetId === edge.targetNodeId && item.kind === 'relates')
      if (saved) introduced.push({ targetSourceId: edge.targetSourceId, targetNodeId: edge.targetNodeId, createdAt: saved.createdAt })
    }
    const next = { links: introduced, suppressedTargets: [...suppressed], diagnostics: graph.diagnostics.filter((item) => item.sourceId === source.id).map(({ target, reason, candidates }) => ({ target, reason, candidates })) }
    if (JSON.stringify(previous) !== JSON.stringify(next)) { source.vaultGraph = next; changed = true }
  }
  if (changed) await persist(snapshot)
}

export function reconcileKnowledgeVaultGraph(): Promise<void> { return serial(async () => { await reconcileVaultGraph(await readWriteSnapshot()) }) }

export function importKnowledgeFiles(files: readonly File[]): Promise<ImportReceipt> {
  return serial(async () => {
    if (!files.length) throw new Error('Choose at least one file.')
    const snapshot = await readWriteSnapshot()
    const receipt: ImportReceipt = { id: crypto.randomUUID(), title: files.length === 1 ? files[0].name : `${files.length} files`, createdAt: Date.now(), status: 'running', total: files.length, saved: 0, unchanged: 0, failed: 0, errors: [], fileBlobIds: [], checkpoint: 0, items: files.map((file) => ({ path: file.webkitRelativePath || file.name, blobId: '', mime: file.type, status: 'queued', sourceIds: [] })) }
    snapshot.imports.push(receipt)
    snapshot.jobs.push({ id: crypto.randomUUID(), kind: 'import', title: `Import ${receipt.title}`, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), total: files.length, completed: 0, importId: receipt.id })
    await persist(snapshot)
    // Bytes are durable before an item can be parsed or counted as saved.
    for (const [index, file] of files.entries()) {
      try {
        const blobId = await saveOriginal(new Uint8Array(await file.arrayBuffer()), file.type)
        receipt.fileBlobIds.push(blobId)
        receipt.items[index].blobId = blobId
      } catch (error) {
        receipt.items[index].status = 'failed'
        receipt.items[index].error = `Original could not be saved: ${error instanceof Error ? error.message : String(error)}. Add this file again when storage is available.`
      }
      await persist(snapshot)
    }
    return processReceipt(snapshot, receipt)
  })
}

export function retryImport(id: string): Promise<ImportReceipt> {
  return serial(async () => {
    const snapshot = await readWriteSnapshot()
    const receipt = snapshot.imports.find((r) => r.id === id)
    if (!receipt) throw new Error('Import receipt not found.')
    if ('watchedFolderId' in receipt) throw new Error('Retry this import from the watched folder controls.')
    const job = snapshot.jobs.find((j) => j.importId === id)
    if (job) cancelledJobs.delete(job.id)
    return processReceipt(snapshot, receipt)
  })
}

/** Stops processing at a source boundary; already committed originals are retained. */
export function cancelKnowledgeJob(id: string): Promise<void> {
  cancelledJobs.add(id)
  return serial(async () => {
    const snapshot = await readWriteSnapshot()
    const job = snapshot.jobs.find((j) => j.id === id)
    if (!job) throw new Error('Job not found.')
    if (job.status === 'running' || job.status === 'queued') {
      job.status = 'cancelled'
      job.updatedAt = Date.now()
      const receipt = snapshot.imports.find((r) => r.id === job.importId)
      if (receipt) receipt.status = 'partial'
      await persist(snapshot)
    }
    cancelledJobs.delete(id)
  })
}

export async function resumeKnowledgeJob(id: string): Promise<ImportReceipt | void> {
  const job = useKnowledge.getState().jobs.find((j) => j.id === id)
  if (job?.kind === 'organize') return serial(async () => {
    const snapshot = await readWriteSnapshot()
    const current = snapshot.jobs.find((candidate) => candidate.id === id)
    if (!current) throw new Error('Job not found.')
    current.status = 'queued'
    current.attempts = 0
    current.error = undefined
    await persist(snapshot)
  })
  if (!job?.importId) throw new Error('This job has no resumable import.')
  return retryImport(job.importId)
}

export function captureThought(text: string): Promise<NodeRecord> {
  return serial(async () => {
    const body = text.trim()
    if (!body) throw new Error('Write something to save.')
    const snapshot = await readWriteSnapshot()
    const bytes = new TextEncoder().encode(body)
    const blobId = await saveOriginal(bytes, 'text/plain')
    const source: KnowledgeSource = { id: crypto.randomUUID(), externalId: `thought:${crypto.randomUUID()}`, title: body.split('\n')[0].slice(0, 120), kind: 'thought', nodeId: crypto.randomUUID(), currentVersionId: '', createdAt: Date.now(), updatedAt: Date.now(), excluded: false, aiAllowed: true, tags: topicWords(body), pendingProjection: true }
    snapshot.sources.push(source)
    const parsed: ParsedSource = { externalId: source.externalId, title: source.title, kind: 'thought', text: body, messages: [{ text: body, role: 'human', authoredAt: Date.now(), start: 0, end: body.length }], authoredAt: Date.now() }
    await addVersion(snapshot, source, parsed, blobId, 'thought.txt', 'capture')
    await persist(snapshot)
    await projectSource(snapshot, source)
    const node = useWorld.getState().nodes.get(source.nodeId!)
    if (!node) throw new Error('Thought retained in the source ledger. Complete setup to project it into the world.')
    return node
  })
}

function legacyRole(node: NodeRecord): Authorship {
  if (!node.provenance) return 'human'
  if (node.provenance.source === 'chat') return node.provenance.model === 'none' ? 'human' : 'assistant'
  if (node.provenance.source === 'omnibox') return node.provenance.state === 'refined' ? 'assistant' : 'human'
  return 'unknown'
}

/** Publish already-retained capture bytes through the same version/projection commands. */
export function ingestRetainedSource(parsed: ParsedSource, opts: { originalBlobId: string; originalName: string; origin?: SourceVersion['origin']; trackOriginalChanges?: boolean; aiGenerated?: boolean; project?: boolean; shouldWrite?: () => boolean }): Promise<KnowledgeSource> {
  return serial(async () => {
    if (opts.shouldWrite && !opts.shouldWrite()) throw new Error('This capture changed while its transcript was being prepared.')
    const snapshot = await readWriteSnapshot()
    if (!await getStore().getAssetMeta(opts.originalBlobId) || !await getStore().getBlob(opts.originalBlobId)) throw new Error('Save the original capture before publishing its transcript.')
    if (opts.shouldWrite && !opts.shouldWrite()) throw new Error('This capture changed before its transcript could be published.')
    if (!parsed.externalId || typeof parsed.text !== 'string' || !parsed.title.trim()) throw new Error('This retained source has no valid identity or text.')
    const existing = snapshot.sources.find((item) => item.externalId === parsed.externalId)
    if (opts.aiGenerated && existing && (existing.deleted || existing.excluded || !existing.aiAllowed)) throw new Error('AI access was revoked before this transcript could be published.')
    const world = useWorld.getState()
    const imported = sourceForParsed(snapshot, parsed, { occupiedNodeIds: [...world.nodes.keys(), ...world.trash.keys(), ...world.excluded.keys()] })
    const source = imported.source
    if (imported.created && !portableIdentity(parsed)) source.tags = topicWords(parsed.text)
    const changed = await addVersion(snapshot, source, parsed, opts.originalBlobId, opts.originalName, opts.origin ?? 'capture', opts.trackOriginalChanges)
    if (opts.shouldWrite && !opts.shouldWrite()) throw new Error('This capture changed before its transcript could be published.')
    if (changed || imported.policyChanged) {
      if (opts.project !== false) source.pendingProjection = true
      else if (imported.created) { delete source.nodeId; source.pendingProjection = false }
      await persist(snapshot)
    }
    if (opts.project !== false && source.pendingProjection) await projectSource(snapshot, source)
    return owned(source)
  })
}

export function syncKnowledgeNodes(nodes: readonly NodeRecord[]): Promise<void> {
  return serial(async () => {
    if (useRepoStatus.getState().interruptedImport) { publish(await readSnapshot()); return }
    // Events can queue while an import is creating further projections. Reconcile the
    // latest world, not the stale node list captured by the first event in that batch.
    const world = useWorld.getState()
    const records = world.loaded ? [...world.nodes.values(), ...world.excluded.values(), ...world.trash.values()] : nodes
    const snapshot = await readWriteSnapshot()
    const byNode = new Map(snapshot.sources.filter((s) => s.nodeId).map((s) => [s.nodeId!, s]))
    const present = new Set(records.map((n) => n.id))
    let changed = false
    const purgeBlobs = new Set<string>()
    const purgeState: NonNullable<KnowledgeCommitOptions['state']> = []
    const purgeNodes: NodeRecord[] = []
    const expectedPurgeNodes: Record<string, number | null> = {}
    for (const node of records) {
      if (isArtifactProjection(node)) continue
      let source = byNode.get(node.id)
      if (source?.pendingProjection) continue
      if (!source) {
        source = { id: crypto.randomUUID(), externalId: `legacy:${node.id}`, title: node.title, kind: 'legacy', nodeId: node.id, currentVersionId: '', createdAt: node.createdAt, updatedAt: node.updatedAt, excluded: false, aiAllowed: true, tags: [...node.tags], deleted: node.deletedAt !== null }
        snapshot.sources.push(source)
      }
      if (source.deleted !== (node.deletedAt !== null)) { source.deleted = node.deletedAt !== null; changed = true }
      const cachedDigest = nodeDigests.get(node)
      if (typeof cachedDigest === 'string' && source.projectionDigest === cachedDigest) continue
      const digest = typeof cachedDigest === 'string' ? cachedDigest : await nodeDigest(node)
      if (source.projectionDigest === digest) continue
      const bytes = new TextEncoder().encode(JSON.stringify(node))
      const original = await saveOriginal(bytes, 'application/json')
      const parsed: ParsedSource = { externalId: source.externalId, title: node.title, kind: source.kind, text: node.contentMd, messages: [{ text: node.contentMd, role: legacyRole(node), authoredAt: node.temporalOrigin, start: 0, end: node.contentMd.length }], authoredAt: node.temporalOrigin, metadata: { nodeId: node.id, originalRecord: node } }
      const hasVersion = !!source.currentVersionId
      await addVersion(snapshot, source, parsed, original, `${node.slug}.json`, hasVersion ? 'edit' : 'legacy')
      source.projectionDigest = digest
      if (hasVersion) source.projectionEdited = true
      source.tags = [...node.tags]
      changed = true
    }
    const purged = snapshot.sources.filter((source) => source.nodeId && !present.has(source.nodeId) && !source.pendingProjection)
    if (purged.length) {
      const ids = new Set(purged.map((s) => s.id))
      const nodeIds = new Set(purged.map((s) => s.nodeId!))
      for (const version of snapshot.versions) if (ids.has(version.sourceId)) purgeBlobs.add(version.originalBlobId)
      const voice = await getStore().getKv<VoiceSnapshot>('voiceInbox.v1')
      if (voice?.entries.some((entry) => entry.sourceId && ids.has(entry.sourceId) || purgeBlobs.has(entry.blobId))) {
        const entries = voice.entries.filter((entry) => { const remove = !!entry.sourceId && ids.has(entry.sourceId) || purgeBlobs.has(entry.blobId); if (remove) purgeBlobs.add(entry.blobId); return !remove })
        purgeState.push({ key: 'voiceInbox.v1', expectedRevision: voice.revision, value: { ...voice, revision: voice.revision + 1, entries } })
      }
      const artifacts = await getStore().getKv<ArtifactSnapshot>(ARTIFACTS_KV)
      const purgedArtifacts = await purgeArtifactSources(artifacts, ids, plain(snapshot))
      if (purgedArtifacts) {
        purgeState.push({ key: ARTIFACTS_KV, expectedRevision: artifacts!.revision, value: purgedArtifacts.snapshot })
        for (const id of purgedArtifacts.projectedNodeIds) {
          const node = records.find((record) => record.id === id)
          if (!node) continue
          expectedPurgeNodes[id] = node.updatedAt
          purgeNodes.push({ ...node, title: 'Deleted source reference', slug: `deleted-source-${id.slice(0, 8)}`, contentMd: 'This maintained page was removed after permanent source deletion.', corpusExcluded: true, updatedAt: Date.now() })
        }
      }
      snapshot.sources = snapshot.sources.filter((s) => !ids.has(s.id))
      snapshot.versions = snapshot.versions.filter((v) => !ids.has(v.sourceId))
      for (const version of snapshot.versions) if (purgeBlobs.has(version.originalBlobId)) version.originalPurged = true
      snapshot.passages = snapshot.passages.filter((p) => !ids.has(p.sourceId))
      snapshot.proposals = snapshot.proposals.filter((p) => !nodeIds.has(p.sourceNodeId) && !nodeIds.has(p.targetNodeId))
      // A whole export can contain the purged conversation as well as retained ones.
      // Remove that original bundle, and keep only the retained normalized versions.
      for (const receipt of snapshot.imports) {
        let affected = false
        receipt.fileBlobIds = receipt.fileBlobIds.filter((id) => !purgeBlobs.has(id))
        for (const item of receipt.items) {
          item.sourceIds = item.sourceIds.filter((id) => !ids.has(id))
          if (purgeBlobs.has(item.blobId)) {
            item.blobId = ''
            item.status = 'failed'
            item.error = 'Original removed because it contained a permanently deleted source. Import the file again only if you intend to restore its contents.'
            affected = true
          }
        }
        if (affected) {
          receipt.failed = receipt.items.filter((item) => item.status === 'failed').length
          receipt.saved = receipt.items.filter((item) => item.status === 'saved').length
          receipt.unchanged = receipt.items.filter((item) => item.status === 'unchanged').length
          receipt.status = receipt.failed === receipt.total ? 'failed' : 'partial'
          receipt.errors = receipt.items.flatMap((item) => item.error ? [`${item.path}: ${item.error}`] : [])
        }
      }
      changed = true
    }
    if (changed && useRepoStatus.getState().writer) {
      await persist(snapshot, purgeState.length ? purgeState : undefined, purgeNodes.length ? { nodes: purgeNodes, expectedNodes: expectedPurgeNodes } : undefined)
      for (const blobId of purgeBlobs) await getStore().deleteBlob(blobId)
    } else publish(snapshot)
  })
}

export function isKnowledgeNodeAllowed(nodeId: string, aiOnly = true): boolean {
  if (aiOnly && isArtifactProjection(useWorld.getState().nodes.get(nodeId))) return false
  const source = useKnowledge.getState().sources.find((s) => s.nodeId === nodeId)
  return !source || !source.deleted && !source.excluded && (!aiOnly || source.aiAllowed)
}

export async function searchKnowledge(query: string, filters: SearchFilters = {}): Promise<SearchHit[]> {
  if (!isRepoReady()) return []
  const requestedStore = getStore(), generation = getWorldGeneration()
  const currentSearch = () => isRepoReady() && getStore() === requestedStore && getWorldGeneration() === generation
  const started = performance.now()
  const snapshot = await readSnapshot()
  if (!currentSearch()) return []
  publish(snapshot)
  if (filters.engine === 'qmd-lexical' || filters.engine === 'qmd-hybrid') {
    if (!query.trim()) return []
    if (requestedStore.info.kind !== 'sqlite') throw new Error('QMD uses the local SQLite service. Move this browser world to SQLite in Settings before indexing it.')
    const result = await searchNativeQmd(query, filters)
    if (!currentSearch()) return []
    const latest = await readSnapshot()
    if (!currentSearch()) return []
    const byId = new Map(latest.passages.map((passage) => [passage.id, passage]))
    const hits = result.hits.flatMap((hit) => {
      const passage = byId.get(hit.id)
      if (!passage || passage.sourceId !== hit.sourceId || passage.versionId !== hit.versionId || !eligibleEvidence(latest, passage, { ...filters, aiOnly: true })) return []
      const node = passage.nodeId ? useWorld.getState().nodes.get(passage.nodeId) : undefined
      if (passage.nodeId && (!node || node.corpusExcluded || isArtifactProjection(node))) return []
      const score = Number.isFinite(hit.score) ? hit.score : 0
      const native = result.trace?.results?.find((row) => row.passageId === passage.id && row.sourceVersionId === passage.versionId)
      const numbers = (values: unknown) => Array.isArray(values) ? values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).slice(0, 64) : []
      return [{ ...passage, score, trace: { sourceVersionId: passage.versionId, scoreKind: 'qmd' as const, fusedScore: score, relevanceOnly: true as const, contributions: [], ...(native ? { native: { rank: Number.isFinite(native.nativeRank) ? native.nativeRank : undefined, rerankScore: Number.isFinite(native.rerankScore) ? native.rerankScore : undefined, lexicalScores: numbers(native.lexicalScores), semanticScores: numbers(native.semanticScores) } } : {}) } }]
    }).slice(0, filters.limit ?? 30)
    useRetrievalTrace.setState({ run: { query, normalizedQuery: query.normalize('NFKC').trim(), filters: { ...filters, aiOnly: true }, revision: latest.revision, model: 'qmd@2.9.0 · local models', mode: filters.engine, timingsMs: { lexical: 0, semantic: 0, native: result.elapsedMs, total: performance.now() - started }, coverage: retrievalCoverage(latest, { ...filters, aiOnly: true }), results: hits.length, evidenceSupport: 'not-assessed' } })
    return hits
  }
  const finish = async (lexical: SearchHit[]): Promise<SearchHit[]> => {
    const lexicalMs = performance.now() - started
    const semanticStarted = performance.now()
    const semantic = query.includes('"') ? [] : await searchCorpusSemantic(query, snapshot, filters)
    const latest = await readSnapshot()
    if (!currentSearch()) return []
    const changed = latest.revision !== snapshot.revision
    const hits = fuseEvidence(changed ? rankKnowledge(latest, query, filters) : lexical, changed ? [] : semantic, filters.limit ?? 30)
    useRetrievalTrace.setState({ run: { query, normalizedQuery: query.normalize('NFKC').trim(), filters: { ...filters }, revision: latest.revision, model: semantic.length && !changed ? useSemantic.getState().config : null, mode: semantic.length && !changed ? 'hybrid' : 'lexical', timingsMs: { lexical: lexicalMs, semantic: performance.now() - semanticStarted, total: performance.now() - started }, coverage: retrievalCoverage(latest, filters), results: hits.length, evidenceSupport: 'not-assessed' } })
    return hits
  }
  if (getStore().info.kind === 'sqlite' && query.trim()) {
    try {
      const response = await fetch('/api/world/knowledge-search', { method: 'POST', headers: { 'content-type': 'application/json', 'x-wv-client': CLIENT_ID }, body: JSON.stringify({ query, filters }) })
      if (response.ok) {
        const result = await response.json() as { revision: number; hits: SearchHit[] }
        if (result.revision === snapshot.revision && Array.isArray(result.hits)) {
          // Validate against authoritative text and policy, not server-provided citation text.
          const byId = new Map(snapshot.passages.map((p) => [p.id, p]))
          return finish(result.hits.filter((p) => {
            const original = byId.get(p.id)
            const source = snapshot.sources.find((s) => s.id === original?.sourceId)
            const version = snapshot.versions.find((v) => v.id === original?.versionId)
            if (!original || !version || version.sourceId !== original.sourceId || !Number.isSafeInteger(original.start) || !Number.isSafeInteger(original.end) || original.start < 0 || original.end < original.start || original.end > version.text.length) return false
            return !!original && !!source && !!version && !source.deleted && !source.excluded && (!filters.aiOnly || source.aiAllowed) && (!filters.sourceIds || filters.sourceIds.includes(source.id)) && (!filters.kinds || filters.kinds.includes(source.kind)) && (!filters.role || original.role === filters.role) && (filters.authoredAfter === undefined || original.authoredAt !== null && original.authoredAt >= filters.authoredAfter) && (filters.authoredBefore === undefined || original.authoredAt !== null && original.authoredAt <= filters.authoredBefore) && (filters.includeHistory || source.currentVersionId === original.versionId) && version.text.slice(original.start, original.end) === original.text
          }).map((p) => ({ ...byId.get(p.id)!, score: p.score })))
        }
      }
    } catch { /* The local lexical fallback is usable without the service. */ }
  }
  return finish(rankKnowledge(snapshot, query, filters))
}

export async function readKnowledgePassage(id: string, opts: { aiOnly?: boolean; includeHistory?: boolean } = {}): Promise<SearchHit | null> {
  if (!isRepoReady()) return null
  const snapshot = await readSnapshot()
  publish(snapshot)
  const passage = snapshot.passages.find((p) => p.id === id)
  if (!passage) return null
  const source = snapshot.sources.find((s) => s.id === passage.sourceId)
  const version = snapshot.versions.find((v) => v.id === passage.versionId)
  if (!version || version.sourceId !== passage.sourceId || !Number.isSafeInteger(passage.start) || !Number.isSafeInteger(passage.end) || passage.start < 0 || passage.end < passage.start || passage.end > version.text.length) return null
  if (!source || source.excluded || source.deleted || opts.aiOnly && !source.aiAllowed || !opts.includeHistory && source.currentVersionId !== passage.versionId || !version || version.text.slice(passage.start, passage.end) !== passage.text) return null
  return { ...passage, score: 0 }
}

export function setSourcePolicy(id: string, patch: { excluded?: boolean; aiAllowed?: boolean }): Promise<void> {
  return serial(async () => {
    const snapshot = await readWriteSnapshot()
    const source = snapshot.sources.find((s) => s.id === id)
    if (!source) throw new Error('Source not found.')
    if (patch.excluded !== undefined) source.excluded = patch.excluded
    if (patch.aiAllowed !== undefined) source.aiAllowed = patch.aiAllowed
    source.updatedAt = Date.now()
    await persist(snapshot)
    if (source.nodeId) {
      const world = useWorld.getState()
      const node = world.nodes.get(source.nodeId) ?? world.excluded.get(source.nodeId)
      if (node && !!node.corpusExcluded !== source.excluded) await updateNode(node.id, { corpusExcluded: source.excluded }, { keepAnchor: true })
    }
    if (!source.excluded && source.pendingProjection && !source.deleted) await projectSource(snapshot, source)
  })
}

export async function getSourceOriginal(sourceId: string, versionId?: string): Promise<{ blob: Blob; name: string } | null> {
  const snapshot = await readSnapshot()
  const source = snapshot.sources.find((s) => s.id === sourceId)
  if (!source || source.deleted) return null
  const version = snapshot.versions.find((v) => v.sourceId === source.id && v.id === (versionId ?? source.currentVersionId))
  if (!version) return null
  if (version.originalPurged) return null
  const blob = await getStore().getBlob(version.originalBlobId)
  return blob ? { blob, name: version.originalName } : null
}

export function reviewProposal(id: string, action: 'accept' | 'reject' | 'undo'): Promise<void> {
  return serial(async () => {
    const snapshot = await readWriteSnapshot()
    const proposal = snapshot.proposals.find((p) => p.id === id)
    if (!proposal) throw new Error('Proposal not found.')
    let rollback: (() => Promise<unknown>) | null = null
    if (action === 'accept') {
      const sources = [proposal.sourceNodeId, proposal.targetNodeId].map((id) => snapshot.sources.find((s) => s.nodeId === id))
      if (sources.some((source) => !source || source.excluded || source.deleted)) throw new Error('A source is excluded or deleted.')
      if (proposal.evidencePassageIds.some((id) => {
        const passage = snapshot.passages.find((p) => p.id === id)
        const source = sources.find((s) => s?.id === passage?.sourceId)
        return !passage || source?.currentVersionId !== passage.versionId
      })) throw new Error('A source changed after this suggestion. Review its current wording before connecting these records.')
      const node = useWorld.getState().nodes.get(proposal.sourceNodeId)
      if (!node || !useWorld.getState().nodes.has(proposal.targetNodeId)) throw new Error('A related record is no longer available.')
      const existing = node.links.some((l) => l.targetId === proposal.targetNodeId && l.kind === 'relates')
      if (!existing) {
        const linked = await link(proposal.sourceNodeId, proposal.targetNodeId, 'relates', proposal.explanation)
        const added = linked.links.find((l) => l.targetId === proposal.targetNodeId && l.kind === 'relates')!
        proposal.introducedLinkCreatedAt = added.createdAt
        rollback = async () => {
          const current = useWorld.getState().nodes.get(proposal.sourceNodeId)?.links.find((l) => l.targetId === proposal.targetNodeId && l.kind === 'relates')
          if (current?.createdAt === added.createdAt && current.label === proposal.explanation) await unlink(proposal.sourceNodeId, proposal.targetNodeId, 'relates')
        }
      }
      proposal.introducedLink = proposal.introducedLink || !existing
      proposal.status = 'accepted'
    } else {
      const node = useWorld.getState().nodes.get(proposal.sourceNodeId)
      const prior = node?.links.find((l) => l.targetId === proposal.targetNodeId && l.kind === 'relates')
      if (proposal.status === 'accepted' && proposal.introducedLink && prior?.createdAt === proposal.introducedLinkCreatedAt && prior?.label === proposal.explanation) {
        await unlink(proposal.sourceNodeId, proposal.targetNodeId, 'relates')
        rollback = async () => {
          const current = useWorld.getState().nodes.get(proposal.sourceNodeId)
          if (current && !current.links.some((l) => l.targetId === proposal.targetNodeId && l.kind === 'relates')) await updateNode(current.id, { links: [...current.links, prior] }, { keepAnchor: true })
        }
      }
      proposal.introducedLink = false
      proposal.introducedLinkCreatedAt = undefined
      proposal.status = action === 'undo' ? 'proposed' : 'rejected'
    }
    try { await persist(snapshot) } catch (error) {
      if (rollback) await rollback()
      throw error
    }
  })
}
