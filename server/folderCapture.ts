import { constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { makeNodeDraft, slugify, validateNode } from '../src/domain/validate.ts'
import { placeAnchor, toPlacedAnchors } from '../src/domain/placement.ts'
import type { AssetMeta, NodeRecord } from '../src/domain/types.ts'
import type { ImportReceipt, KnowledgeSnapshot, ParsedSource, SourceVersion } from '../src/knowledge/types.ts'
import { parseKnowledgeText, splitPassages } from '../src/knowledge/parsers.ts'
import { topicWords } from '../src/knowledge/retrieval.ts'
import { projectVaultGraph } from '../src/knowledge/vault.ts'
import { extractPdfText } from './extractText.ts'
import type { WorldDb } from './worldDb.ts'
import type { ChangeBus } from './changes.ts'

const MAX_FOLDERS = 8
export const MAX_WATCH_FILE_BYTES = 16 * 1024 * 1024
const MAX_SCAN_BYTES = 128 * 1024 * 1024
const MAX_SCAN_FILES = 4000
const MAX_SCAN_CHANGES = 100
const SUPPORTED = new Set(['.md', '.markdown', '.canvas', '.base', '.txt', '.text', '.json', '.csv', '.tsv', '.html', '.htm', '.xml', '.yaml', '.yml', '.log', '.pdf', '.docx'])
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage'])
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const nodeDigest = (node: NodeRecord) => hash(JSON.stringify({ title: node.title, text: node.contentMd }))
const within = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`)
const blank = (): KnowledgeSnapshot => ({ schemaVersion: 1, revision: 0, sources: [], versions: [], passages: [], imports: [], proposals: [], jobs: [] })

interface FileState { hash: string; missing: boolean; error?: string; attempts?: number; retryAt?: number; sourceIds?: string[] }
export interface CapturedFolder {
  id: string
  path: string
  paused: boolean
  status: 'watching' | 'scanning' | 'paused' | 'limited' | 'error' | 'deferred'
  mode: 'events' | 'polling'
  lastScanAt: number | null
  files: number
  indexed: number
  excluded: number
  missing: number
  errors: string[]
  exclusions: string[]
  error?: string
}
interface FolderState extends CapturedFolder { entries: Record<string, FileState> }
interface Registry { version: 1; folders: FolderState[] }
interface StagedFile { path: string; hash: string; blobId: string; bytes: number; mime: string; parsed: ParsedSource[]; error?: string }

export interface FolderCaptureOptions {
  dataDir: string
  db: WorldDb
  bus: ChangeBus
  pollMs?: number
  debounceMs?: number
}

export class FolderCaptureError extends Error {
  readonly status: number
  constructor(message: string, status = 400) { super(message); this.name = 'FolderCaptureError'; this.status = status }
}

/** Device-local registration is separate from the portable corpus and its backups. */
export class FolderCapture {
  private readonly options: FolderCaptureOptions
  private readonly registryPath: string
  private readonly blobDir: string
  private registry: Registry = { version: 1, folders: [] }
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private readonly poll: ReturnType<typeof setInterval>
  private closed = false

  constructor(options: FolderCaptureOptions) {
    mkdirSync(resolve(options.dataDir), { recursive: true })
    this.options = { ...options, dataDir: realpathSync(resolve(options.dataDir)) }
    this.registryPath = join(this.options.dataDir, 'capture-folders.json')
    this.blobDir = join(this.options.dataDir, 'blobs')
    if (existsSync(this.registryPath)) {
      try {
        const raw = readFileSync(this.registryPath, 'utf8')
        if (raw.length > 4 * 1024 * 1024) throw new Error('registry too large')
        const data = JSON.parse(raw) as Registry
        if (data.version !== 1 || !Array.isArray(data.folders)) throw new Error('unsupported registry')
        if (data.folders.length > MAX_FOLDERS || data.folders.some((folder) => !folder || typeof folder.id !== 'string' || typeof folder.path !== 'string' || !isAbsolute(folder.path) || folder.path === dirname(folder.path) || basename(folder.path).startsWith('.') || SKIP_DIRS.has(basename(folder.path)) || within(this.options.dataDir, folder.path) || typeof folder.paused !== 'boolean' || !folder.entries || typeof folder.entries !== 'object' || Array.isArray(folder.entries) || !Array.isArray(folder.errors) || !Array.isArray(folder.exclusions))) throw new Error('invalid folder registration')
        this.registry.folders = data.folders
      } catch { throw new FolderCaptureError('The local folder registry is invalid. Repair capture-folders.json before enabling folder capture.', 503) }
    }
    for (const folder of this.registry.folders) if (!folder.paused) { this.startWatcher(folder); this.schedule(folder.id) }
    this.poll = setInterval(() => { for (const folder of this.registry.folders) if (!folder.paused) this.schedule(folder.id) }, options.pollMs ?? 60_000)
    this.poll.unref?.()
  }

  list(): CapturedFolder[] { return this.registry.folders.map(({ entries: _, ...folder }) => structuredClone(folder)) }

  async add(path: string): Promise<CapturedFolder> {
    if (this.closed) throw new FolderCaptureError('Folder capture is closed.', 503)
    if (!this.options.db.getSettings()?.firstRunComplete) throw new FolderCaptureError('Complete workspace setup before watching a folder.', 409)
    if (!isAbsolute(path) || path.length > 4096) throw new FolderCaptureError('Enter an absolute local folder path.')
    const canonical = await realpath(path).catch(() => { throw new FolderCaptureError('That local folder could not be opened. Check the path and permissions.') })
    if (canonical === dirname(canonical) || basename(canonical).startsWith('.') || SKIP_DIRS.has(basename(canonical)) || within(this.options.dataDir, canonical)) throw new FolderCaptureError('Choose a notes folder outside the app data directory, hidden system folders and dependency folders.')
    if (!(await lstat(canonical)).isDirectory()) throw new FolderCaptureError('Choose a folder rather than a file.')
    if (this.registry.folders.length >= MAX_FOLDERS) throw new FolderCaptureError(`At most ${MAX_FOLDERS} local folders can be watched.`)
    if (this.registry.folders.some((folder) => within(folder.path, canonical) || within(canonical, folder.path))) throw new FolderCaptureError('That folder overlaps an existing watched folder.')
    // Re-registering the same canonical path reconnects its retained sources.
    const identity = hash(canonical)
    const id = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-5${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`
    const folder: FolderState = { id, path: canonical, paused: false, status: 'scanning', mode: 'polling', lastScanAt: null, files: 0, indexed: 0, excluded: 0, missing: 0, errors: [], exclusions: [], entries: {} }
    this.registry.folders.push(folder)
    this.saveRegistry()
    this.startWatcher(folder)
    await this.scan(folder.id)
    return this.folder(folder.id)
  }

  async pause(id: string, paused: boolean): Promise<CapturedFolder> {
    const folder = this.folder(id)
    folder.paused = paused
    folder.status = paused ? 'paused' : 'scanning'
    this.stopWatcher(id)
    this.saveRegistry()
    if (!paused) { this.startWatcher(folder); await this.scan(id) }
    return this.folder(id)
  }

  remove(id: string): void {
    const folder = this.folder(id)
    folder.paused = true
    this.stopWatcher(id)
    this.registry.folders = this.registry.folders.filter((f) => f.id !== id)
    this.saveRegistry()
  }

  async scan(id: string): Promise<void> {
    const folder = this.folder(id)
    if (this.closed || folder.paused) return
    const current = this.running.get(id)
    if (current) { this.again.add(id); return current }
    const action = this.sweep(folder).catch((error: unknown) => {
      if (this.closed || folder.paused || !this.registry.folders.includes(folder)) return
      folder.status = 'error'
      folder.error = error instanceof Error ? error.message : String(error)
      this.saveRegistry()
    }).finally(() => {
      this.running.delete(id)
      if (this.again.delete(id) && !this.closed && !folder.paused) this.schedule(id)
    })
    this.running.set(id, action)
    return action
  }

  async retry(id: string): Promise<void> {
    const folder = this.folder(id)
    for (const entry of Object.values(folder.entries)) if (entry.error) { entry.attempts = 0; entry.retryAt = 0 }
    return this.scan(id)
  }

  close(): void {
    this.closed = true
    clearInterval(this.poll)
    for (const id of this.watchers.keys()) this.stopWatcher(id)
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private folder(id: string): FolderState {
    const folder = this.registry.folders.find((f) => f.id === id)
    if (!folder) throw new FolderCaptureError('Watched folder not found.', 404)
    return folder
  }

  private saveRegistry(): void {
    if (this.closed) return
    mkdirSync(this.options.dataDir, { recursive: true })
    const temporary = `${this.registryPath}.tmp`
    writeFileSync(temporary, JSON.stringify(this.registry), { mode: 0o600 })
    renameSync(temporary, this.registryPath)
  }

  private startWatcher(folder: FolderState): void {
    if (this.closed || folder.paused || this.watchers.has(folder.id)) return
    try {
      // A shallow event watcher cannot recurse into symlinks or unbounded dependency
      // trees. The bounded periodic sweep also detects changes in nested folders.
      const watcher = watch(folder.path, { persistent: false }, () => this.schedule(folder.id))
      watcher.on('error', () => { this.stopWatcher(folder.id); folder.mode = 'polling'; this.schedule(folder.id) })
      this.watchers.set(folder.id, watcher)
      folder.mode = 'events'
    } catch { folder.mode = 'polling' }
  }

  private stopWatcher(id: string): void {
    this.watchers.get(id)?.close()
    this.watchers.delete(id)
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
  }

  private schedule(id: string): void {
    if (this.closed || this.timers.has(id)) return
    const timer = setTimeout(() => {
      this.timers.delete(id)
      if (this.registry.folders.some((folder) => folder.id === id && !folder.paused)) void this.scan(id)
    }, this.options.debounceMs ?? 350)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  private async sweep(folder: FolderState): Promise<void> {
    if (this.deferForRestore(folder)) return
    folder.status = 'scanning'
    folder.error = undefined
    folder.errors = []
    folder.exclusions = []
    folder.excluded = 0
    const found: string[] = []
    let count = 0
    let limited = false
    const exclude = (path: string, reason: string) => { folder.excluded++; if (folder.exclusions.length < 50) folder.exclusions.push(`${path}: ${reason}`) }
    const walk = async (path: string, depth = 0): Promise<void> => {
      if (depth > 12) { exclude(relative(folder.path, path), 'maximum folder depth reached'); limited = true; return }
      const entries = await readdir(path, { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (++count > MAX_SCAN_FILES) { limited = true; return }
        const full = join(path, entry.name)
        const name = relative(folder.path, full)
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name) || within(this.options.dataDir, full)) { exclude(name, 'hidden, dependency, build or application data'); continue }
        if (entry.isSymbolicLink()) { exclude(name, 'symbolic links are not followed'); continue }
        if (entry.isDirectory()) {
          try { await walk(full, depth + 1) } catch { folder.errors.push(`${name}: directory could not be read`); limited = true }
        } else if (entry.isFile()) {
          if (!SUPPORTED.has(extname(entry.name).toLowerCase())) exclude(name, 'unsupported format')
          else found.push(full)
        }
        if (limited && count > MAX_SCAN_FILES) return
      }
    }
    const actualRoot = await realpath(folder.path)
    if (actualRoot !== folder.path) throw new Error('The registered folder now resolves somewhere else. Remove and register the intended folder again.')
    await walk(folder.path)
    if (this.closed || folder.paused || !this.registry.folders.includes(folder)) return
    if (this.deferForRestore(folder)) return
    folder.files = found.length
    const seen = new Set(found.map((path) => relative(folder.path, path)))
    if (!limited) for (const [path, state] of Object.entries(folder.entries)) state.missing = !seen.has(path)
    folder.missing = Object.values(folder.entries).filter((entry) => entry.missing).length
    const staged: StagedFile[] = []
    let scanBytes = 0
    for (const path of found) {
      if (this.closed || folder.paused) return
      if (this.deferForRestore(folder)) return
      const name = relative(folder.path, path)
      try {
        const previous = folder.entries[name]
        if (this.wasPurged(previous)) { previous!.error = 'A previously captured source was deleted. Stop and register this folder again only if you intend to restore it.'; folder.errors.push(`${name}: ${previous!.error}`); continue }
        const canonical = await realpath(path)
        if (!within(folder.path, canonical) || canonical !== path) { exclude(name, 'path is no longer inside the registered folder'); continue }
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        let bytes: Uint8Array
        try {
          const stat = await file.stat()
          if (!stat.isFile()) { exclude(name, 'not an ordinary file'); continue }
          if (stat.size > MAX_WATCH_FILE_BYTES) { exclude(name, 'larger than the 16 MiB capture limit'); continue }
          if (scanBytes + stat.size > MAX_SCAN_BYTES) { limited = true; break }
          bytes = new Uint8Array(await file.readFile())
          if (bytes.length > MAX_WATCH_FILE_BYTES) { exclude(name, 'file grew past the capture limit'); continue }
          scanBytes += bytes.length
        } finally { await file.close() }
        if (await realpath(path) !== canonical) { exclude(name, 'path changed during capture'); continue }
        if (this.closed || folder.paused || !this.registry.folders.includes(folder)) return
        if (this.deferForRestore(folder)) return
        if (this.wasPurged(previous)) { previous!.error = 'A previously captured source was deleted. Capture stopped for this file.'; folder.errors.push(`${name}: ${previous!.error}`); continue }
        const digest = hash(bytes)
        if (previous?.hash === digest && (!previous.error || (previous.attempts ?? 0) >= 3 || (previous.retryAt ?? 0) > Date.now())) { previous.missing = false; if (previous.error) folder.errors.push(`${name}: ${previous.error}`); continue }
        if (staged.length >= MAX_SCAN_CHANGES) { limited = true; this.again.add(folder.id); break }
        const blobId = `knowledge-${digest}`
        await mkdir(this.blobDir, { recursive: true })
        if (this.closed || folder.paused || this.deferForRestore(folder)) return
        const blobPath = join(this.blobDir, blobId)
        if (!existsSync(blobPath)) {
          const temporary = `${blobPath}.${randomUUID()}.tmp`
          await writeFile(temporary, bytes, { mode: 0o600 })
          if (this.closed || folder.paused || this.deferForRestore(folder)) { await rm(temporary, { force: true }); return }
          await rename(temporary, blobPath)
        }
        const mime = extname(path).toLowerCase() === '.pdf' ? 'application/pdf' : extname(path).toLowerCase() === '.json' ? 'application/json' : 'text/plain'
        if (this.closed || folder.paused || this.deferForRestore(folder)) return
        let parsed: ParsedSource[] = []
        let error: string | undefined
        try { parsed = await this.parse(bytes, name, mime) } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
        staged.push({ path: name, hash: digest, blobId, bytes: bytes.length, mime, parsed, error })
      } catch (error) { folder.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (this.closed || folder.paused || !this.registry.folders.includes(folder)) return
    if (this.deferForRestore(folder)) return
    if (staged.length && !this.commit(folder, staged)) return
    folder.lastScanAt = Date.now()
    folder.indexed = Object.values(folder.entries).filter((entry) => !entry.missing && !entry.error).length
    folder.errors = folder.errors.slice(-50)
    folder.status = folder.errors.length ? 'error' : limited ? 'limited' : 'watching'
    if (limited) folder.error = 'This sweep reached a file, depth, byte or change limit. Coverage is partial; narrow the folder or rescan.'
    if (folder.errors.length) folder.error = `${folder.errors.length} item(s) need attention. Originals already captured remain available.`
    this.saveRegistry()
  }

  private deferForRestore(folder: FolderState): boolean {
    // Both ZIP and directory restores use this marker while the ledger may be empty.
    // A temporary absence during replacement is never a permanent-deletion tombstone.
    if (this.options.db.getKv('importInProgress') === undefined) return false
    folder.status = 'deferred'
    folder.error = 'Capture is waiting for the current workspace restore to finish. It will resume automatically.'
    this.saveRegistry()
    return true
  }

  private wasPurged(previous: FileState | undefined): boolean {
    if (!previous?.sourceIds?.length) return false
    // The source index and restore marker change in the same SQLite transactions as
    // the ledger. One statement sees a coherent state without loading every passage.
    const state = this.options.db.db.prepare(`
      SELECT EXISTS(SELECT 1 FROM kv WHERE key = 'importInProgress') AS restoring,
        EXISTS(SELECT 1 FROM json_each(?) wanted LEFT JOIN knowledge_sources s
          ON s.id = wanted.value WHERE s.id IS NULL) AS purged
    `).get(JSON.stringify(previous.sourceIds)) as { restoring: number; purged: number }
    return !state.restoring && !!state.purged
  }

  private async parse(bytes: Uint8Array, path: string, mime: string): Promise<ParsedSource[]> {
    if (extname(path).toLowerCase() === '.pdf') {
      const extracted = await extractPdfText(bytes)
      if (extracted.text.length > MAX_WATCH_FILE_BYTES) throw new Error('Extracted PDF text exceeds the local capture limit. Original retained.')
      const parsed = parseKnowledgeText(extracted.text, `${path}.txt`, 'text/plain')[0]
      parsed.externalId = `document:${path}`
      parsed.title = basename(path, extname(path))
      parsed.metadata = { path, pages: extracted.pages }
      return [parsed]
    }
    if (extname(path).toLowerCase() === '.docx') {
      const xml = unzipSync(bytes, { filter: (file) => { if (file.name !== 'word/document.xml') return false; if (file.originalSize > MAX_WATCH_FILE_BYTES) throw new Error('Expanded Word text exceeds the local capture limit. Original retained.'); return true } })['word/document.xml']
      if (!xml) throw new Error('DOCX has no document text. Original retained.')
      const text = strFromU8(xml).replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      const parsed = parseKnowledgeText(text, `${path}.txt`, 'text/plain')[0]
      parsed.externalId = `document:${path}`
      parsed.title = basename(path, extname(path))
      return [parsed]
    }
    return parseKnowledgeText(new TextDecoder('utf-8', { fatal: true }).decode(bytes), path, mime)
  }

  private commit(folder: FolderState, staged: StagedFile[]): boolean {
    if (this.deferForRestore(folder)) return false
    const db = this.options.db
    const settings = db.getSettings()
    if (!settings?.firstRunComplete) throw new Error('Complete workspace setup before folder capture can import sources.')
    const raw = db.getKv('knowledge.v1') as KnowledgeSnapshot | undefined
    if (raw && (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || !Array.isArray(raw.sources))) throw new Error('The knowledge ledger format is not supported by folder capture.')
    const snapshot = structuredClone(raw ?? blank())
    const expected = snapshot.revision
    const allNodes = db.listNodes()
    const byNode = new Map(allNodes.map((node) => [node.id, node]))
    const nodes: NodeRecord[] = []
    const expectedNodes: Record<string, number | null> = {}
    const assets: AssetMeta[] = staged.map((file) => ({ id: file.blobId, kind: 'file', mime: file.mime, bytes: file.bytes, createdAt: Date.now(), nodeId: null }))
    const now = Date.now()
    const receipt: ImportReceipt & { watchedFolderId: string } = { id: randomUUID(), title: `Folder: ${basename(folder.path)}`, watchedFolderId: folder.id, createdAt: now, status: 'running', total: staged.length, saved: 0, unchanged: 0, failed: 0, errors: [], fileBlobIds: staged.map((file) => file.blobId), checkpoint: 0, items: [] }
    for (const file of staged) {
      const sourceIds: string[] = []
      let changed = false
      let error = file.error || (this.wasPurged(folder.entries[file.path]) ? 'A captured source was deleted during the scan. Automatic restoration is blocked.' : undefined)
      if (!error) for (const parsed of file.parsed) {
        const externalId = `watch:${folder.id}:${parsed.externalId}`
        let source = snapshot.sources.find((s) => s.externalId === externalId)
        if (!source) { source = { id: randomUUID(), externalId, title: parsed.title.slice(0, 200) || basename(file.path), kind: parsed.kind, nodeId: randomUUID(), currentVersionId: '', createdAt: now, updatedAt: now, excluded: false, aiAllowed: true, tags: topicWords(parsed.text), pendingProjection: true }; snapshot.sources.push(source) }
        sourceIds.push(source.id)
        const digest = hash(JSON.stringify({ text: parsed.text, messages: parsed.messages.map(({ id, parentId, role, authoredAt, start, end }) => ({ id, parentId, role, authoredAt, start, end })) }))
        const previous = snapshot.versions.find((v) => v.id === source.currentVersionId)
        if (previous?.contentHash === digest) continue
        const wasPending = source.pendingProjection
        const version: SourceVersion = { id: randomUUID(), sourceId: source.id, contentHash: digest, originalBlobId: file.blobId, originalName: file.path, text: parsed.text, createdAt: now, authoredAt: parsed.authoredAt, origin: 'import', previousVersionId: previous?.id, metadata: { ...parsed.metadata, watchedFolderId: folder.id, path: file.path } }
        snapshot.versions.push(version)
        source.currentVersionId = version.id
        source.title = parsed.title.slice(0, 200) || basename(file.path)
        source.updatedAt = now
        source.tags = topicWords(parsed.text)
        source.pendingProjection = true
        snapshot.passages.push(...splitPassages(parsed).map((part) => ({ id: randomUUID(), sourceId: source!.id, versionId: version.id, nodeId: source!.nodeId, title: source!.title, text: part.text, start: part.start, end: part.end, role: part.role, authoredAt: part.authoredAt, messageId: part.id, parentId: part.parentId, locator: part.locator })))
        const current = source.nodeId ? byNode.get(source.nodeId) : undefined
        if (current && source.projectionDigest && source.projectionDigest !== nodeDigest(current)) source.projectionEdited = true
        if (current?.deletedAt !== null && current?.deletedAt !== undefined || !current && previous && !wasPending) { source.deleted = true; source.pendingProjection = false }
        else if (!source.deleted && !source.excluded && source.nodeId) {
          let node: NodeRecord
          if (current) {
            const edited = source.projectionEdited || source.projectionDigest && source.projectionDigest !== nodeDigest(current)
            source.projectionEdited = !!edited
            node = edited ? current : { ...current, title: source.title, contentMd: parsed.text, updatedAt: Math.max(now, current.updatedAt + 1) }
          } else {
            node = makeNodeDraft('document', { id: source.nodeId, title: source.title, contentMd: parsed.text, tags: source.tags, temporalOrigin: Math.max(settings.T0, Math.min(parsed.authoredAt ?? now, now)), provenance: { source: 'file', ref: file.path, keptAt: now } }, { now })
            node.slug = slugify(node.title, allNodes.map((n) => n.slug))
            node.anchorXZ = placeAnchor(node, toPlacedAnchors(allNodes.filter((n) => n.deletedAt === null), settings), settings)
            const validation = validateNode(node, { settings, now, others: allNodes })
            if (!validation.ok) { error = `Source retained; projection needs repair: ${validation.errors.map((e) => e.message).join('; ')}`; source.pendingProjection = true; continue }
            allNodes.push(node)
          }
          source.projectionDigest = nodeDigest(node)
          source.pendingProjection = false
          if (node !== current) { if (!(node.id in expectedNodes)) expectedNodes[node.id] = current?.updatedAt ?? null; nodes.push(node); byNode.set(node.id, node) }
        }
        changed = true
      }
      receipt.items.push({ path: file.path, blobId: file.blobId, mime: file.mime, status: error ? 'failed' : changed ? 'saved' : 'unchanged', sourceIds, ...(error ? { error } : {}) })
      if (error) { receipt.failed++; receipt.errors.push(`${file.path}: ${error}`) } else if (changed) receipt.saved++; else receipt.unchanged++
      receipt.checkpoint++
    }
    receipt.status = receipt.failed ? receipt.failed === receipt.total ? 'failed' : 'partial' : 'complete'
    snapshot.imports.push(receipt)
    snapshot.jobs.push({ id: randomUUID(), kind: 'import', title: receipt.title, status: receipt.failed ? 'failed' : 'complete', createdAt: now, updatedAt: now, completed: receipt.total, total: receipt.total, importId: receipt.id, ...(receipt.failed ? { error: `${receipt.failed} file(s) need retry.` } : {}) })
    const changedIds = new Set(receipt.items.flatMap((item) => item.sourceIds))
    const candidates = snapshot.sources.filter((source) => source.nodeId && !source.deleted && !source.excluded)
    const pairs = new Set(snapshot.proposals.map((proposal) => [proposal.sourceNodeId, proposal.targetNodeId].sort().join(':')))
    let proposed = 0
    for (const source of candidates.filter((source) => changedIds.has(source.id))) {
      for (const other of candidates) {
        if (proposed >= 40) break
        if (source.id === other.id || pairs.has([source.nodeId!, other.nodeId!].sort().join(':'))) continue
        const overlap = source.tags.filter((tag) => other.tags.includes(tag))
        if (overlap.length < 2) continue
        const evidencePassageIds = [source, other].flatMap((s) => snapshot.passages.filter((p) => p.sourceId === s.id && p.versionId === s.currentVersionId && overlap.some((tag) => p.text.toLocaleLowerCase().includes(tag))).slice(0, 1).map((p) => p.id))
        if (evidencePassageIds.length !== 2) continue
        snapshot.proposals.push({ id: randomUUID(), title: `Connect ${source.title} and ${other.title}`, explanation: `Both sources mention ${overlap.join(', ')}. This is a lexical suggestion from local folder capture, not a verified claim.`, status: 'proposed', sourceNodeId: source.nodeId!, targetNodeId: other.nodeId!, evidencePassageIds })
        pairs.add([source.nodeId!, other.nodeId!].sort().join(':'))
        proposed++
      }
    }
    for (const projected of projectVaultGraph(snapshot, [...byNode.values()], now)) {
      const original = allNodes.find((node) => node.id === projected.id)
      if (!(projected.id in expectedNodes)) expectedNodes[projected.id] = original?.updatedAt ?? null
      const index = nodes.findIndex((node) => node.id === projected.id)
      if (index < 0) nodes.push(projected); else nodes[index] = projected
    }
    snapshot.revision++
    if (!db.compareAndSwapKnowledge(snapshot, expected, nodes, expectedNodes, assets)) {
      if (this.deferForRestore(folder)) return false
      this.again.add(folder.id)
      throw new Error('The workspace changed during capture. No newer work was overwritten; rescan retries the retained files.')
    }
    for (const [i, file] of staged.entries()) {
      const item = receipt.items[i]
      const previous = folder.entries[file.path]
      const attempts = previous?.hash === file.hash ? (previous.attempts ?? 0) + 1 : 1
      folder.entries[file.path] = { hash: file.hash, missing: false, sourceIds: item.sourceIds.length ? item.sourceIds : previous?.sourceIds, ...(item.error ? { error: item.error, attempts, retryAt: Date.now() + 30_000 * 2 ** attempts } : {}) }
      if (item.error) folder.errors.push(`${file.path}: ${item.error}`)
    }
    this.options.bus.publish({ v: 1, from: 'folder-capture', change: { type: 'kv', keys: ['knowledge.v1'] } })
    if (nodes.length) this.options.bus.publish({ v: 1, from: 'folder-capture', change: { type: 'nodes', ids: nodes.map((node) => node.id) } })
    return true
  }
}

/** A local filesystem endpoint is never exposed through a hosted account or a rebound host. */
export function authorizeFolderRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false
  const host = req.headers.host
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host) || req.headers['sec-fetch-site'] === 'cross-site') return false
  let target: URL
  try { target = new URL(`${(req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'}://${host}`) } catch { return false }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || Number(target.port || (target.protocol === 'https:' ? 443 : 80)) !== req.socket.localPort) return false
  const origin = req.headers.origin
  const safe = req.method === 'GET' || req.method === 'HEAD'
  if ((!safe && !origin) || (origin && origin !== target.origin)) return false
  return safe || typeof req.headers['x-wv-client'] === 'string' && req.headers['x-wv-client'].length > 0
}

export async function handleFolderRequest(capture: FolderCapture, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  if (!authorizeFolderRequest(req)) return send(403, { available: false, error: 'Folder capture is available only to the local app origin.' })
  const segments = (req.url ?? '').split('?', 1)[0].split('/').filter(Boolean)
  const id = segments[3]
  const method = req.method ?? 'GET'
  try {
    if (method === 'GET' && !id) return send(200, { available: true, folders: capture.list(), limits: { maxFolders: MAX_FOLDERS, maxFileBytes: MAX_WATCH_FILE_BYTES, maxFilesPerSweep: MAX_SCAN_FILES } })
    if (method === 'DELETE' && id) { capture.remove(id); return send(200, { available: true, folders: capture.list() }) }
    let raw = ''
    for await (const chunk of req) { raw += String(chunk); if (Buffer.byteLength(raw) > 8192) throw new FolderCaptureError('Request is too large.', 413) }
    let body: Record<string, unknown> = {}
    if (raw) { try { const parsed: unknown = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); body = parsed as Record<string, unknown> } catch { throw new FolderCaptureError('Request is not a valid JSON object.') } }
    if (method === 'POST' && !id && typeof body.path === 'string') { await capture.add(body.path); return send(201, { available: true, folders: capture.list() }) }
    if (method === 'PATCH' && id && typeof body.paused === 'boolean') { await capture.pause(id, body.paused); return send(200, { available: true, folders: capture.list() }) }
    if (method === 'POST' && id && segments[4] === 'scan') { await capture.retry(id); return send(200, { available: true, folders: capture.list() }) }
    return send(400, { error: 'Choose a folder, pause/resume it, rescan or remove its registration.' })
  } catch (error) { send(error instanceof FolderCaptureError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) }) }
}
