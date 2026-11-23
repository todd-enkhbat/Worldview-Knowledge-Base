import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorldDb } from './worldDb.ts'
import type { KnowledgeSnapshot, SearchFilters, SearchHit } from '../src/knowledge/types.ts'
import { buildQmdMirror, qmdResultPath, resolveQmdHits, writeQmdMirror, type QmdMirror } from './qmdMirror.ts'
import { QmdNativeRuntime, QMD_VERSION, qmdInstallation, type NativeQmdHit, type QmdMode } from './qmdRuntime.ts'

const CONFIG_KEY = 'qmd.runtime.v1' // Disposable local integration settings, never source authority or portable credentials.
const empty = (): KnowledgeSnapshot => ({ schemaVersion: 1, revision: 0, sources: [], versions: [], passages: [], imports: [], jobs: [], proposals: [] })
interface QmdConfig { schemaVersion: 1; revision: number; enabled: boolean; sourceIds: string[]; followNewSources?: boolean; mode: QmdMode; updatedAt: number }
export interface QmdSearchResult { revision: number; hits: SearchHit[]; mode: QmdMode; candidates: number; elapsedMs: number; engine: 'qmd'; relevanceOnly: true; omitted: number; trace?: ReturnType<typeof qmdNativeTrace> }
const fingerprint = (mirror: QmdMirror) => createHash('sha256').update(JSON.stringify(mirror.files)).digest('hex')

/** Explain only accepted identities; raw native bodies and rejected evidence never escape. */
export function qmdNativeTrace(rows: readonly NativeQmdHit[], mirror: QmdMirror, hits: readonly SearchHit[], mode: QmdMode) {
  const accepted = new Set(hits.map((hit) => hit.id)), byPath = new Map(mirror.manifest.entries.map((entry) => [entry.path, entry]))
  const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const numbers = (value: unknown) => Array.isArray(value) ? value.flatMap((entry) => numeric(entry) === undefined ? [] : [Number(entry)]).slice(0, 64) : []
  return { engineVersion: QMD_VERSION, scoreKind: mode === 'hybrid' ? 'qmd-blend' : 'lexical', evidenceSupport: 'not-assessed', results: rows.flatMap((row, index) => {
    const path = qmdResultPath(row.file, mirror.manifest.collection), entry = path === null ? undefined : byPath.get(path)
    if (!entry || !accepted.has(entry.passageId)) return []
    const explain = row.explain && typeof row.explain === 'object' ? row.explain as Record<string, unknown> : {}, rrf = explain.rrf && typeof explain.rrf === 'object' ? explain.rrf as Record<string, unknown> : {}
    return [{ passageId: entry.passageId, sourceVersionId: entry.versionId, nativeRank: index + 1, score: numeric(row.score), lexicalScores: numbers(explain.ftsScores), semanticScores: numbers(explain.vectorScores), rerankScore: numeric(explain.rerankScore), fusion: mode === 'hybrid' ? { rank: numeric(rrf.rank), baseScore: numeric(rrf.baseScore), topRankBonus: numeric(rrf.topRankBonus), totalScore: numeric(rrf.totalScore) } : undefined }]
  }) }
}

/** Compile only known scope dimensions, never an arbitrary native query/filter expression. */
export function qmdMetadataFilter(filters: SearchFilters): unknown {
  const operands: unknown[] = []
  if (filters.sourceIds) {
    const groups: unknown[] = []
    for (let start = 0; start < filters.sourceIds.length; start += 64) groups.push({ field: 'sourceId', operator: 'in', value: filters.sourceIds.slice(start, start + 64) })
    if (!groups.length) return { field: 'sourceId', operator: 'eq', value: '\u0000-no-source' }
    operands.push(groups.length === 1 ? groups[0] : { operator: 'or', operands: groups })
  }
  if (filters.role) operands.push({ field: 'role', operator: 'eq', value: filters.role })
  if (filters.kinds) operands.push({ field: 'kind', operator: 'in', value: filters.kinds })
  if (filters.authoredAfter !== undefined) operands.push({ field: 'authoredAt', operator: 'gte', value: filters.authoredAfter })
  if (filters.authoredBefore !== undefined) operands.push({ field: 'authoredAt', operator: 'lte', value: filters.authoredBefore })
  return operands.length > 1 ? { operator: 'and', operands } : operands[0]
}

/** Scoped disposable native retrieval. Every native hit is resolved against current authority. */
export class QmdService {
  readonly runtime: QmdNativeRuntime
  private queue: Promise<unknown> = Promise.resolve()
  private active: { mirror: QmdMirror; signature: string; mode: QmdMode } | null = null
  private generation = 0
  private processedStamp = ''
  private busy = false
  private buildingSignature: string | null = null
  private phase: 'disabled' | 'indexing' | 'embedding' | 'ready' | 'failed' = 'disabled'
  private error: string | null = null
  private timer: ReturnType<typeof setInterval> | null
  readonly db: WorldDb
  readonly directory: string
  constructor(db: WorldDb, directory: string, runtime = new QmdNativeRuntime()) {
    this.db = db; this.directory = directory
    this.runtime = runtime
    this.timer = setInterval(() => { void this.reconcile().catch(() => {}) }, 1000)
    this.timer.unref()
    void this.reconcile().catch(() => {})
  }
  private config(): QmdConfig | undefined { return this.db.getKv<QmdConfig>(CONFIG_KEY) }
  private sourceIds(config: QmdConfig): string[] | undefined { return config.followNewSources ? undefined : config.sourceIds }
  private stamp(): string { return JSON.stringify([this.db.db.prepare('PRAGMA data_version').get(), this.db.db.prepare('SELECT total_changes() AS n').get()]) }
  private scope() {
    if (this.db.getKv('importInProgress')) throw new Error('QMD is unavailable during workspace recovery.')
    return { snapshot: this.db.getKv<KnowledgeSnapshot>('knowledge.v1') ?? empty(), liveNodeIds: new Set(this.db.listNodes().filter((node) => node.deletedAt === null && !node.corpusExcluded).map((node) => node.id)) }
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> { const next = this.queue.catch(() => {}).then(action); this.queue = next; return next }

  async status() {
    const config = this.config(), installation = await qmdInstallation(this.runtime.runtimeRoot, this.runtime.cacheRoot)
    return { ...installation, enabled: config?.enabled ?? false, sourceIds: config?.sourceIds ?? [], followNewSources: config?.followNewSources ?? false, mode: config?.mode ?? 'lexical', phase: this.phase, busy: this.busy, error: this.error, indexedPassages: this.active?.mirror.files.length ?? 0, indexedSources: new Set(this.active?.mirror.manifest.entries.map((entry) => entry.sourceId) ?? []).size, indexedRevision: this.active?.mirror.manifest.corpusRevision ?? null, corpusRevision: this.db.getKnowledgeRevision(), progress: this.runtime.progress }
  }

  async configure(sourceIds: string[], mode: QmdMode, followNewSources = false) {
    const { snapshot } = this.scope()
    if (!followNewSources && !sourceIds.length || sourceIds.length > 1000 || sourceIds.some((id) => !snapshot.sources.some((source) => source.id === id && !source.deleted && !source.excluded && source.aiAllowed))) throw new Error('Choose 1–1000 included AI-permitted sources, or explicitly follow all current and future AI-permitted captures.')
    const previous = this.config(), revision = previous?.revision ?? 0
    const config: QmdConfig = { schemaVersion: 1, revision: revision + 1, enabled: true, sourceIds: [...new Set(sourceIds)], followNewSources, mode, updatedAt: Date.now() }
    if (!this.db.compareAndSwapKv(CONFIG_KEY, config, revision)) throw new Error('QMD settings changed. Refresh and retry.')
    this.generation++; this.runtime.stop('QMD scope changed.'); this.active = null; this.processedStamp = ''; this.busy = false; this.buildingSignature = null
    await this.reconcile()
    return this.status()
  }

  async disable() {
    const previous = this.config(), revision = previous?.revision ?? 0
    if (!this.db.compareAndSwapKv(CONFIG_KEY, { schemaVersion: 1, revision: revision + 1, enabled: false, sourceIds: [], mode: 'lexical', updatedAt: Date.now() }, revision)) throw new Error('QMD settings changed. Refresh and retry.')
    this.generation++; this.runtime.stop('QMD was disabled.'); this.active = null
    await this.enqueue(async () => { await this.runtime.destroy(this.directory); this.phase = 'disabled'; this.busy = false; this.error = null })
    return this.status()
  }

  /** Cheap change detection also catches same-revision restores and direct watcher commits. */
  async reconcile(): Promise<void> {
    const config = this.config(), stamp = this.stamp()
    if (stamp === this.processedStamp) return
    if (!config?.enabled || this.db.getKv('importInProgress')) {
      this.generation++; this.runtime.stop('The workspace was replaced or QMD was disabled.'); this.active = null; this.busy = false
      this.processedStamp = stamp
      await this.enqueue(async () => { await this.runtime.destroy(this.directory); this.phase = 'disabled'; this.error = null })
      return
    }
    const { snapshot, liveNodeIds } = this.scope()
    let mirror: QmdMirror
    try { mirror = buildQmdMirror(snapshot, { liveNodeIds, filters: { sourceIds: this.sourceIds(config) }, maxBytes: 64 * 1024 * 1024 }) }
    catch (error) { this.generation++; this.runtime.stop(); this.active = null; this.busy = false; this.phase = 'failed'; this.error = error instanceof Error ? error.message : String(error); this.processedStamp = stamp; await this.enqueue(() => this.runtime.destroy(this.directory)); throw error }
    const signature = fingerprint(mirror)
    if (this.busy && this.buildingSignature === signature) return
    if (this.active?.signature === signature && this.active.mode === config.mode) { this.active.mirror.manifest.corpusRevision = snapshot.revision; this.processedStamp = stamp; return }
    const token = ++this.generation
    // Drop the old model process before erasing its mirror/index. Cached originals and
    // vectors are disposable and never kept as a parallel history of revoked evidence.
    this.runtime.stop('Source policy or versions changed. QMD is rebuilding.'); this.active = null; this.busy = true; this.buildingSignature = signature; this.phase = 'indexing'; this.error = null
    await this.enqueue(async () => {
      try {
        await this.runtime.destroy(this.directory)
        if (token !== this.generation) return
        await mkdir(this.directory, { recursive: true })
        const mirrorDirectory = join(this.directory, 'mirror')
        await writeQmdMirror(mirrorDirectory, mirror)
        if (token !== this.generation) return
        this.phase = config.mode === 'hybrid' ? 'embedding' : 'indexing'
        await this.runtime.request('open', { directory: mirrorDirectory, dbPath: join(this.directory, 'index.sqlite'), collection: mirror.manifest.collection, mode: config.mode }, 15 * 60_000)
        const latest = this.scope(), current = buildQmdMirror(latest.snapshot, { liveNodeIds: latest.liveNodeIds, filters: { sourceIds: this.sourceIds(config) } })
        if (token !== this.generation || this.config()?.revision !== config.revision || fingerprint(current) !== signature) { this.runtime.stop(); await this.runtime.destroy(this.directory); return }
        this.active = { mirror, signature, mode: config.mode }; this.phase = 'ready'; this.processedStamp = this.stamp()
      } catch (error) {
        if (token === this.generation) { this.error = error instanceof Error ? error.message : String(error); this.phase = 'failed'; this.processedStamp = this.stamp() }
        throw error
      } finally { if (token === this.generation) { this.busy = false; this.buildingSignature = null } }
    })
  }

  async search(query: string, filters: SearchFilters = {}, opts: { mode?: QmdMode; candidates?: number; signal?: AbortSignal } = {}): Promise<QmdSearchResult> {
    const config = this.config()
    if (!config?.enabled) throw new Error('Select sources and build the local QMD index in Sources & activity first.')
    if (filters.includeHistory) throw new Error('QMD searches current versions. Use original passage search for explicit history.')
    await this.reconcile()
    const active = this.active, token = this.generation
    if (!active) throw new Error(this.error ?? 'QMD is rebuilding its disposable index. Retry when it is ready.')
    const mode = opts.mode ?? config.mode
    if (mode === 'hybrid' && active.mode !== 'hybrid') throw new Error('Build the hybrid QMD index before requesting local AI retrieval.')
    const sourceIds = filters.sourceIds ? config.followNewSources ? filters.sourceIds : filters.sourceIds.filter((id) => config.sourceIds.includes(id)) : this.sourceIds(config)
    const scope = { ...filters, sourceIds, aiOnly: true, includeHistory: false, limit: Math.min(50, Math.max(1, filters.limit ?? 20)) }
    const candidates = [10, 20, 40].includes(opts.candidates ?? 20) ? opts.candidates ?? 20 : 20
    if (sourceIds && !sourceIds.length || filters.kinds && !filters.kinds.length || !active.mirror.files.length) return { revision: this.db.getKnowledgeRevision(), hits: [], mode, candidates, elapsedMs: 0, engine: 'qmd', relevanceOnly: true, omitted: 0 }
    const start = performance.now()
    const rows = await this.runtime.request<NativeQmdHit[]>('search', { query: query.trim().slice(0, 2000), mode, candidates, collection: active.mirror.manifest.collection, limit: scope.limit, filter: qmdMetadataFilter({ ...scope, sourceIds: filters.sourceIds ? sourceIds : undefined }) }, 300_000, opts.signal)
    if (token !== this.generation || this.config()?.revision !== config.revision) throw new Error('QMD scope changed while searching. Retry in the current workspace.')
    const latest = this.scope()
    const hits = resolveQmdHits(rows, active.mirror, latest.snapshot, { liveNodeIds: latest.liveNodeIds, filters: scope })
    return { revision: latest.snapshot.revision, hits, mode, candidates, elapsedMs: performance.now() - start, engine: 'qmd', relevanceOnly: true, omitted: rows.length - hits.length, trace: qmdNativeTrace(rows, active.mirror, hits, mode) }
  }

  close() { if (this.timer) clearInterval(this.timer); this.timer = null; this.generation++; this.runtime.stop('The app service closed.') }
}
