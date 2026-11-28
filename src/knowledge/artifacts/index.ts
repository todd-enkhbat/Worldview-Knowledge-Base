import { create } from 'zustand'
import { useWorld } from '../../app/store.ts'
import { compareAndSwapWorldState, createNode, getStore, isRepoReady, softDelete, subscribeRepo, updateNode, useRepoStatus } from '../../data/repo.ts'
import type { WorldStore } from '../../data/WorldStore.ts'
import { knowledgeHash } from '../index.ts'
import type { Authorship, KnowledgeSnapshot } from '../types.ts'
import { artifactHealth, artifactPageView, evidenceState, resolveArtifactEvidence, type ArtifactReadOptions } from './policy.ts'
import { decodeArtifacts } from './schema.ts'
import { artifactFingerprint, normalizeArtifactFingerprints } from './fingerprint.ts'
import { ARTIFACTS_KV, emptyArtifacts, type ArtifactJob, type ArtifactSnapshot, type Claim, type ClaimRevision, type EvidenceRef, type KnowledgePage, type PageKind, type PageRevision } from './types.ts'

export * from './types.ts'
export * from './policy.ts'
export { decodeArtifacts, parseClaimDate } from './schema.ts'

const GENERATOR = 'worldview-extractive-v1'
const MAX_SOURCES = 32
const STAGE_SOURCES = 4
const MAX_EVIDENCE = 128
const emptyKnowledge = (): KnowledgeSnapshot => ({ schemaVersion: 1, revision: 0, sources: [], versions: [], passages: [], imports: [], proposals: [], jobs: [] })
export const useArtifacts = create<ArtifactSnapshot & { loaded: boolean; busy: boolean; error: string | null; sourceRevision: number }>()(() => ({ ...emptyArtifacts(), loaded: false, busy: false, error: null, sourceRevision: 0 }))
let boundStore: WorldStore | null = null
let epoch = 0
let queue: Promise<unknown> = Promise.resolve()
let timer: ReturnType<typeof setTimeout> | null = null
let running: Promise<void> | null = null
const cleanup: (() => void)[] = []
const uid = () => crypto.randomUUID()
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const matches = (store: WorldStore, generation = epoch) => isRepoReady() && getStore() === store && boundStore === store && generation === epoch
const titleOf = (value: string) => { const text = value.trim(); if (!text || text.length > 200) throw new Error('Give this page a title of 1 to 200 characters.'); return text }
const bodyOf = (value: string) => { const text = value.trim(); if (!text || text.length > 100_000) throw new Error('Write between 1 and 100,000 characters.'); return text }
const claimFingerprint = (pageId: string, text: string, _author: Authorship | null) => artifactFingerprint(pageId, 'claim', text)
const pageFingerprint = (pageId: string, text: string) => artifactFingerprint(pageId, 'page', text)

function publish(snapshot: ArtifactSnapshot, sourceRevision?: number): void { useArtifacts.setState({ ...snapshot, loaded: true, error: null, ...(sourceRevision === undefined ? {} : { sourceRevision }) }) }
async function knowledge(store: WorldStore): Promise<KnowledgeSnapshot> { return await store.getKv<KnowledgeSnapshot>('knowledge.v1') ?? emptyKnowledge() }
function activity(snapshot: ArtifactSnapshot, pageId: string, targetId: string, action: string, detail = '') { snapshot.activity.push({ id: uid(), pageId, targetId, action, detail, recordedAt: Date.now() }) }
function pageOf(snapshot: ArtifactSnapshot, id: string) { const page = snapshot.pages.find((entry) => entry.id === id && entry.archivedAt === null); if (!page) throw new Error('This knowledge page is no longer available.'); return page }
function validEvidence(refs: readonly EvidenceRef[], corpus: KnowledgeSnapshot, opts: { current?: boolean; allowEmpty?: boolean; aiOnly?: boolean } = {}): EvidenceRef[] {
  if (refs.length > MAX_EVIDENCE || !refs.length && !opts.allowEmpty) throw new Error('Choose supporting source passages before saving this interpretation.')
  const unique = [...new Map(refs.map((ref) => [`${ref.passageId}:${ref.sourceVersionId}:${ref.relation}`, ref])).values()]
  const state = evidenceState(unique, corpus, { aiOnly: opts.aiOnly })
  if (state.restricted) throw new Error('One of these source passages is unavailable under the current policy.')
  if (opts.current && state.stale) throw new Error('A source changed. Inspect its current version before accepting this interpretation.')
  return structuredClone(unique)
}

function resetBinding(): void {
  epoch++
  if (timer) clearTimeout(timer)
  timer = null
  for (const stop of cleanup.splice(0)) stop()
  boundStore = null
  useArtifacts.setState({ ...emptyArtifacts(), loaded: false, busy: false, error: null, sourceRevision: 0 })
}

export async function initializeArtifacts(): Promise<void> {
  if (!isRepoReady()) return
  const store = getStore()
  if (boundStore !== store) {
    resetBinding()
    boundStore = store
    cleanup.push(subscribeRepo((change) => {
      if (!matches(store)) return
      if (change.type === 'wipe' || change.type === 'import') {
        epoch++
        if (timer) clearTimeout(timer)
        timer = null
        useArtifacts.setState({ ...emptyArtifacts(), loaded: false, error: null })
        void refreshArtifacts().catch((error) => useArtifacts.setState({ error: message(error) }))
      } else if (change.type === 'kv' && change.keys.includes(ARTIFACTS_KV)) void refreshArtifacts().catch((error) => useArtifacts.setState({ error: message(error) }))
      else if (change.type === 'kv' && change.keys.includes('knowledge.v1') || change.type === 'nodes') {
        void reconcileArtifactDependencies().catch((error) => useArtifacts.setState({ error: message(error) }))
      }
    }))
    cleanup.push(useRepoStatus.subscribe((status, previous) => {
      if (!status.ready && boundStore === store) resetBinding()
      else if (previous.interruptedImport && !status.interruptedImport) void reconcileArtifactDependencies().catch((error) => useArtifacts.setState({ error: message(error) }))
    }))
  }
  await refreshArtifacts()
}

export async function refreshArtifacts(): Promise<void> {
  if (!isRepoReady()) return
  const store = getStore(), generation = epoch
  const snapshot = decodeArtifacts(await store.getKv(ARTIFACTS_KV))
  const corpus = snapshot.pages.some((page) => page.sourceIds.length) ? await knowledge(store) : emptyKnowledge()
  if (matches(store, generation) && snapshot.revision >= useArtifacts.getState().revision) { publish(snapshot, corpus.revision); schedule() }
}

function mutate<T>(change: (snapshot: ArtifactSnapshot, corpus: KnowledgeSnapshot) => T | Promise<T>): Promise<T> {
  if (!isRepoReady()) return Promise.reject(new Error('Open the workspace before changing knowledge pages.'))
  const store = getStore(), generation = epoch
  const task = queue.catch(() => {}).then(async () => {
    if (!matches(store, generation)) throw new Error('The workspace changed before this knowledge update. Open the page again.')
    if (!useRepoStatus.getState().writer) throw new Error('This workspace is read only.')
    if (useRepoStatus.getState().interruptedImport) throw new Error('Finish restore recovery before changing knowledge pages.')
    useArtifacts.setState({ busy: true, error: null })
    try {
      const [snapshot, corpus] = await Promise.all([store.getKv(ARTIFACTS_KV).then(decodeArtifacts), knowledge(store)])
      const expected = snapshot.revision
      await normalizeArtifactFingerprints(snapshot)
      const result = await change(snapshot, corpus)
      if (!matches(store, generation)) throw new Error('The workspace changed during this knowledge update.')
      snapshot.revision++
      await compareAndSwapWorldState(ARTIFACTS_KV, snapshot, expected)
      if (matches(store, generation)) publish(snapshot, corpus.revision)
      return structuredClone(result)
    } catch (error) {
      if (matches(store, generation)) { await refreshArtifacts().catch(() => {}); useArtifacts.setState({ error: message(error) }) }
      throw error
    } finally { if (matches(store, generation)) useArtifacts.setState({ busy: false }) }
  })
  queue = task
  return task
}

async function inputHash(page: KnowledgePage, snapshot: ArtifactSnapshot, corpus: KnowledgeSnapshot): Promise<string> {
  const correction = snapshot.pageRevisions.filter((revision) => revision.pageId === page.id && revision.manual && revision.status === 'accepted').at(-1)
  return knowledgeHash(JSON.stringify([GENERATOR, page.id, page.title, page.kind, page.question, page.sourceIds.map((id) => { const source = corpus.sources.find((entry) => entry.id === id); return [id, source?.currentVersionId, source?.excluded, source?.deleted, source?.aiAllowed] }), correction?.id]))
}
async function appendJob(snapshot: ArtifactSnapshot, corpus: KnowledgeSnapshot, page: KnowledgePage): Promise<ArtifactJob> {
  if (!page.sourceIds.length) throw new Error('Select sources to generate an evidence draft. Manual pages do not need generation.')
  const hash = await inputHash(page, snapshot, corpus)
  const existing = snapshot.jobs.find((job) => job.pageId === page.id && job.inputHash === hash && job.status !== 'cancelled')
  if (existing) return existing
  const now = Date.now()
  const job: ArtifactJob = { id: uid(), pageId: page.id, status: 'queued', sourceIds: [...page.sourceIds], inputHash: hash, generator: GENERATOR, checkpoint: 0, total: page.sourceIds.length, createdAt: now, updatedAt: now, attempts: 0, error: null, outputRevisionId: null, draftEvidence: [] }
  snapshot.jobs.push(job)
  activity(snapshot, page.id, job.id, 'generation-queued', 'Local extractive draft; no model is called.')
  return job
}

export async function createKnowledgePage(input: { title: string; kind?: PageKind; sourceIds?: readonly string[]; question?: string | null; contentMd?: string }): Promise<KnowledgePage> {
  await initializeArtifacts()
  const title = titleOf(input.title), ids = [...new Set(input.sourceIds ?? [])]
  if (ids.length > MAX_SOURCES) throw new Error(`A maintained page supports up to ${MAX_SOURCES} selected sources. Split a larger project into topic pages.`)
  const page = await mutate(async (snapshot, corpus) => {
    if (ids.some((id) => !corpus.sources.some((source) => source.id === id && !source.excluded && !source.deleted))) throw new Error('A selected source is unavailable.')
    const now = Date.now()
    const page: KnowledgePage = { id: uid(), title, kind: input.kind ?? 'topic', sourceIds: ids, question: input.question?.trim() || null, currentRevisionId: null, projectedNodeId: null, createdAt: now, updatedAt: now, archivedAt: null }
    snapshot.pages.push(page)
    if (input.contentMd?.trim()) {
      const revision: PageRevision = { id: uid(), pageId: page.id, previousRevisionId: null, contentMd: bodyOf(input.contentMd), evidence: [], recordedAt: now, acceptedAt: now, status: 'accepted', manual: true, inputHash: '', generator: 'manual', correction: input.contentMd.trim() }
      snapshot.pageRevisions.push(revision); page.currentRevisionId = revision.id
    }
    activity(snapshot, page.id, page.id, 'created', page.kind)
    if (ids.length && !input.contentMd?.trim()) await appendJob(snapshot, corpus, page)
    return page
  })
  schedule()
  return page
}

export function editKnowledgePage(pageId: string, contentMd: string, refs?: readonly EvidenceRef[]): Promise<PageRevision> {
  const text = bodyOf(contentMd)
  return mutate((snapshot, corpus) => {
    const page = pageOf(snapshot, pageId), prior = snapshot.pageRevisions.find((item) => item.id === page.currentRevisionId)
    const evidence = validEvidence(refs ?? prior?.evidence ?? [], corpus, { allowEmpty: true })
    const now = Date.now(), revision: PageRevision = { id: uid(), pageId, previousRevisionId: page.currentRevisionId, contentMd: text, evidence, recordedAt: now, acceptedAt: now, status: 'accepted', manual: true, inputHash: prior?.inputHash ?? '', generator: 'manual', correction: text }
    snapshot.pageRevisions.push(revision); page.currentRevisionId = revision.id; page.updatedAt = now
    activity(snapshot, pageId, revision.id, 'manual-edit', 'Your wording is retained as a regeneration constraint.')
    return revision
  })
}

export function reviewPageRevision(id: string, action: 'accept' | 'reject' | 'undo' | 'withdraw'): Promise<void> {
  return mutate(async (snapshot, corpus) => {
    const revision = snapshot.pageRevisions.find((item) => item.id === id)
    if (!revision) throw new Error('This page revision is unavailable.')
    const page = pageOf(snapshot, revision.pageId)
    const fp = await pageFingerprint(page.id, revision.contentMd)
    const undoWithdrawal = action === 'undo' && revision.status === 'withdrawn'
    if (action === 'accept') {
      if (snapshot.tombstones.some((item) => item.pageId === page.id && item.fingerprint === fp && item.reason === 'withdrawn')) throw new Error('This page wording was withdrawn. Undo that withdrawal explicitly or write a correction.')
      validEvidence(revision.evidence, corpus, { current: true, allowEmpty: revision.manual })
      revision.status = 'accepted'; revision.acceptedAt = Date.now(); page.currentRevisionId = revision.id
    } else if (action === 'reject') { revision.status = 'rejected'; if (page.currentRevisionId === id) page.currentRevisionId = revision.previousRevisionId }
    else if (action === 'undo') { if (revision.status === 'withdrawn') { validEvidence(revision.evidence, corpus, { current: true, allowEmpty: revision.manual }); revision.status = 'accepted'; page.currentRevisionId = revision.id } else { revision.status = 'proposed'; if (page.currentRevisionId === id) page.currentRevisionId = revision.previousRevisionId } }
    else { revision.status = 'withdrawn'; if (page.currentRevisionId === id) page.currentRevisionId = null }
    if (action === 'reject' || action === 'withdraw') snapshot.tombstones.push({ id: uid(), pageId: page.id, fingerprint: fp, reason: action === 'reject' ? 'rejected' : 'withdrawn', recordedAt: Date.now() })
    if (action === 'undo') snapshot.tombstones = snapshot.tombstones.filter((item) => !(item.pageId === page.id && item.fingerprint === fp && (undoWithdrawal || item.reason === 'rejected')))
    page.updatedAt = Date.now()
    activity(snapshot, page.id, id, `page-${action}`)
  })
}

export function queuePageGeneration(pageId: string): Promise<ArtifactJob> { return mutate((snapshot, corpus) => appendJob(snapshot, corpus, pageOf(snapshot, pageId))).then((job) => { schedule(); return job }) }
export function setArtifactJobState(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  return mutate((snapshot) => { const job = snapshot.jobs.find((entry) => entry.id === id); if (!job) throw new Error('This knowledge job is unavailable.'); job.status = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'queued'; job.updatedAt = Date.now(); if (action === 'resume') job.error = null; activity(snapshot, job.pageId, id, `job-${action}`) }).then(() => schedule())
}

export function proposeClaim(input: { pageId: string; text: string; evidence: readonly EvidenceRef[]; attributedTo?: Authorship | null; eventAt?: number | null; validFrom?: number | null; validUntil?: number | null; decision?: boolean }): Promise<ClaimRevision> {
  const text = bodyOf(input.text)
  return mutate(async (snapshot, corpus) => {
    const page = pageOf(snapshot, input.pageId)
    if (input.decision && page.kind !== 'project') throw new Error('Decisions must belong to a project page.')
    const evidence = validEvidence(input.evidence, corpus, { allowEmpty: input.decision })
    validateInterval(input)
    const fp = await claimFingerprint(input.pageId, text, input.attributedTo ?? null)
    if (snapshot.tombstones.some((item) => item.pageId === input.pageId && item.fingerprint === fp)) throw new Error('This exact interpretation was rejected or withdrawn. Write an explicit correction rather than silently reviving it.')
    let claim = snapshot.claims.find((item) => item.pageId === input.pageId && item.fingerprint === fp)
    if (!claim) { claim = { id: uid(), pageId: input.pageId, currentRevisionId: null, fingerprint: fp, createdAt: Date.now() }; snapshot.claims.push(claim) }
    if (input.decision) claim.decision = true
    const revision = makeClaimRevision(claim, text, evidence, corpus, { ...input, manual: true, inputHash: '' })
    snapshot.claimRevisions.push(revision); activity(snapshot, input.pageId, revision.id, 'claim-proposed')
    return revision
  })
}

export function trackProjectDecision(claimId: string): Promise<void> {
  return mutate((snapshot, corpus) => {
    const claim = snapshot.claims.find(item => item.id === claimId)
    if (!claim || !claim.currentRevisionId) throw new Error('Accept a statement before tracking it as a decision.')
    const page = pageOf(snapshot, claim.pageId)
    const view = artifactPageView(snapshot, corpus, page.id)
    if (page.kind !== 'project' || !view?.claims.some(item => item.claim.id === claimId)) throw new Error('This statement is unavailable on an active project page.')
    if (claim.decision) return
    claim.decision = true
    activity(snapshot, page.id, claim.id, 'decision-tracked')
  })
}

function validateInterval(input: { validFrom?: number | null; validUntil?: number | null; eventAt?: number | null }) {
  if ([input.validFrom, input.validUntil, input.eventAt].some((time) => time !== undefined && time !== null && !Number.isFinite(time))) throw new Error('Claim dates must be explicit finite dates or unknown.')
  if (input.validFrom != null && input.validUntil != null && input.validUntil < input.validFrom) throw new Error('Validity cannot end before it begins.')
}
function makeClaimRevision(claim: Claim, text: string, evidence: EvidenceRef[], corpus: KnowledgeSnapshot, opts: { attributedTo?: Authorship | null; eventAt?: number | null; validFrom?: number | null; validUntil?: number | null; manual: boolean; inputHash: string }): ClaimRevision {
  const authored = evidence.map((ref) => resolveArtifactEvidence(ref, corpus)?.authoredAt ?? null)
  return { id: uid(), claimId: claim.id, previousRevisionId: claim.currentRevisionId, text, attributedTo: opts.attributedTo ?? null, evidence, recordedAt: Date.now(), acceptedAt: null, sourceAuthoredAt: authored.length && authored.every((time) => time === authored[0]) ? authored[0] : null, eventAt: opts.eventAt ?? null, validFrom: opts.validFrom ?? null, validUntil: opts.validUntil ?? null, status: 'proposed', manual: opts.manual, inputHash: opts.inputHash }
}
export function reviseClaim(claimId: string, input: { text: string; evidence: readonly EvidenceRef[]; attributedTo?: Authorship | null; eventAt?: number | null; validFrom?: number | null; validUntil?: number | null }): Promise<ClaimRevision> {
  const text = bodyOf(input.text); validateInterval(input)
  return mutate((snapshot, corpus) => {
    const claim = snapshot.claims.find((item) => item.id === claimId); if (!claim) throw new Error('This claim is unavailable.')
    pageOf(snapshot, claim.pageId)
    const revision = makeClaimRevision(claim, text, validEvidence(input.evidence, corpus, { allowEmpty: claim.decision }), corpus, { ...input, manual: true, inputHash: '' })
    snapshot.claimRevisions.push(revision); activity(snapshot, claim.pageId, revision.id, 'claim-correction-proposed')
    return revision
  })
}

export function reviewClaim(id: string, action: 'accept' | 'reject' | 'undo' | 'withdraw'): Promise<void> {
  return mutate(async (snapshot, corpus) => {
    const revision = snapshot.claimRevisions.find((item) => item.id === id); if (!revision) throw new Error('This claim revision is unavailable.')
    const claim = snapshot.claims.find((item) => item.id === revision.claimId)!; pageOf(snapshot, claim.pageId)
    const fp = await claimFingerprint(claim.pageId, revision.text, revision.attributedTo)
    const undoWithdrawal = action === 'undo' && revision.status === 'withdrawn'
    const allowEmpty = claim.decision && revision.manual
    if (action === 'accept') {
      if (claim.decision && (revision.status !== 'proposed' || revision.previousRevisionId !== claim.currentRevisionId)) throw new Error('The decision changed while this revision was in review. Propose an update from the current wording.')
      if (snapshot.tombstones.some((item) => item.pageId === claim.pageId && item.fingerprint === fp && item.reason === 'withdrawn')) throw new Error('This interpretation was withdrawn. Propose a different explicit correction.')
      validEvidence(revision.evidence, corpus, { current: true, allowEmpty }); revision.status = 'accepted'; revision.acceptedAt = Date.now(); claim.currentRevisionId = revision.id
    } else if (action === 'undo') {
      if (claim.decision && undoWithdrawal && claim.currentRevisionId !== null) throw new Error('A newer decision has already been accepted. Propose an update from its current wording.')
      if (revision.status === 'withdrawn') { validEvidence(revision.evidence, corpus, { current: true, allowEmpty }); revision.status = 'accepted'; claim.currentRevisionId = revision.id }
      else { revision.status = 'proposed'; if (claim.currentRevisionId === id) claim.currentRevisionId = revision.previousRevisionId }
      snapshot.tombstones = snapshot.tombstones.filter((item) => !(item.pageId === claim.pageId && (item.fingerprint === fp || undoWithdrawal && item.fingerprint === claim.fingerprint) && (undoWithdrawal || item.reason === 'rejected')))
    } else {
      revision.status = action === 'reject' ? 'rejected' : 'withdrawn'
      if (claim.currentRevisionId === id) claim.currentRevisionId = action === 'withdraw' ? null : revision.previousRevisionId
      if (!snapshot.tombstones.some((item) => item.pageId === claim.pageId && item.fingerprint === fp && item.reason === (action === 'reject' ? 'rejected' : 'withdrawn'))) snapshot.tombstones.push({ id: uid(), pageId: claim.pageId, fingerprint: fp, reason: action === 'reject' ? 'rejected' : 'withdrawn', recordedAt: Date.now() })
      if (action === 'withdraw' && fp !== claim.fingerprint && !snapshot.tombstones.some((item) => item.pageId === claim.pageId && item.fingerprint === claim.fingerprint && item.reason === 'withdrawn')) snapshot.tombstones.push({ id: uid(), pageId: claim.pageId, fingerprint: claim.fingerprint, reason: 'withdrawn', recordedAt: Date.now() })
    }
    activity(snapshot, claim.pageId, id, `claim-${action}`)
  })
}

export async function promoteAnswer(input: { title: string; question: string; answer: string; evidence: readonly EvidenceRef[]; sourceIds?: readonly string[] }): Promise<KnowledgePage> {
  await initializeArtifacts()
  return mutate((snapshot, corpus) => {
    const evidence = validEvidence(input.evidence, corpus, { current: true, aiOnly: true })
    const ids = [...new Set(evidence.flatMap((ref) => resolveArtifactEvidence(ref, corpus)?.sourceId ?? []))]
    const selected = input.sourceIds ? [...new Set(input.sourceIds)] : ids
    if (ids.some((id) => !selected.includes(id)) || selected.some((id) => !corpus.sources.some((source) => source.id === id && !source.excluded && !source.deleted && source.aiAllowed))) throw new Error('The answer evidence is outside this source scope.')
    const now = Date.now(), page: KnowledgePage = { id: uid(), title: titleOf(input.title), kind: 'answer', sourceIds: selected, question: input.question.trim(), currentRevisionId: null, projectedNodeId: null, createdAt: now, updatedAt: now, archivedAt: null }
    const revision: PageRevision = { id: uid(), pageId: page.id, previousRevisionId: null, contentMd: bodyOf(input.answer), evidence, recordedAt: now, acceptedAt: now, status: 'accepted', manual: true, inputHash: '', generator: 'user-promoted-answer', correction: input.answer.trim() }
    page.currentRevisionId = revision.id; snapshot.pages.push(page); snapshot.pageRevisions.push(revision); activity(snapshot, page.id, revision.id, 'answer-promoted', input.question)
    return page
  })
}

export async function readKnowledgePage(pageId: string, opts: ArtifactReadOptions = {}) {
  if (!isRepoReady() || useRepoStatus.getState().interruptedImport) return null
  const store = getStore(), generation = epoch
  if (await store.getKv('importInProgress')) return null
  const [snapshot, corpus] = await Promise.all([store.getKv(ARTIFACTS_KV).then(decodeArtifacts), knowledge(store)])
  if (!matches(store, generation) || await store.getKv('importInProgress')) return null
  return artifactPageView(snapshot, corpus, pageId, opts)
}

export async function projectKnowledgePage(pageId: string): Promise<string> {
  const store = getStore(), generation = epoch
  const view = await readKnowledgePage(pageId)
  if (!matches(store, generation) || !view?.revision || view.restricted) throw new Error('Accept an accessible page revision before showing it in the world.')
  const contentMd = `[Open this maintained knowledge page](#/knowledge?page=${encodeURIComponent(pageId)}).\n\nThis world object is a reference. Its evidence and interpretation remain in the knowledge reader.`
  const current = view.page.projectedNodeId ? useWorld.getState().nodes.get(view.page.projectedNodeId) ?? useWorld.getState().excluded.get(view.page.projectedNodeId) : null
  let nodeId: string
  if (current) { await updateNode(current.id, { title: view.page.title, contentMd, corpusExcluded: false }, { keepAnchor: true }); nodeId = current.id }
  else nodeId = (await createNode({ archetype: view.page.kind === 'entity' ? 'entity' : 'document', title: view.page.title, contentMd, tags: ['knowledge', view.page.kind], provenance: { source: 'file', ref: `worldview:artifact:${pageId}`, keptAt: Date.now() } })).id
  try { await mutate((snapshot) => { pageOf(snapshot, pageId).projectedNodeId = nodeId; activity(snapshot, pageId, nodeId, 'shown-in-world', 'Reference only; no source text was duplicated.') }) }
  catch (error) { if (!current) await softDelete(nodeId).catch(() => {}); throw error }
  return nodeId
}

export function archiveKnowledgePage(pageId: string, archived = true): Promise<void> {
  return mutate((snapshot) => { const page = snapshot.pages.find((page) => page.id === pageId); if (!page) throw new Error('This page is unavailable.'); page.archivedAt = archived ? Date.now() : null; if (archived) for (const job of snapshot.jobs) if (job.pageId === pageId && ['queued', 'running', 'paused'].includes(job.status)) job.status = 'cancelled'; activity(snapshot, pageId, pageId, archived ? 'archived' : 'restored') }).then(() => reconcileArtifactDependencies())
}

function schedule() {
  if (timer || running || !isRepoReady() || !useRepoStatus.getState().writer || useRepoStatus.getState().interruptedImport) return
  if (!useArtifacts.getState().jobs.some((job) => job.status === 'queued' || job.status === 'running')) return
  timer = setTimeout(() => { timer = null; void runArtifactJobs({ maxStages: 1 }).catch((error) => useArtifacts.setState({ error: message(error) })) }, 40)
}

/** Reconcile metadata only; reads independently enforce policy even before this task runs. */
export async function reconcileArtifactDependencies(): Promise<void> {
  if (!isRepoReady() || boundStore !== getStore() || !useRepoStatus.getState().writer || useRepoStatus.getState().interruptedImport) return
  if (useArtifacts.getState().loaded && !useArtifacts.getState().pages.some((page) => page.sourceIds.length || page.projectedNodeId)) return
  const store = getStore(), generation = epoch
  const [snapshot, corpus] = await Promise.all([store.getKv(ARTIFACTS_KV).then(decodeArtifacts), knowledge(store)])
  if (!matches(store, generation)) return
  if (snapshot.revision >= useArtifacts.getState().revision) publish(snapshot, corpus.revision)
  const changes: { pageId: string; excluded: boolean }[] = []
  for (const page of snapshot.pages) if (page.projectedNodeId) {
    const view = artifactPageView(snapshot, corpus, page.id), node = useWorld.getState().nodes.get(page.projectedNodeId) ?? useWorld.getState().excluded.get(page.projectedNodeId)
    const excluded = !view || view.restricted || !view.revision
    if (node && !!node.corpusExcluded !== excluded) changes.push({ pageId: page.id, excluded })
  }
  for (const change of changes) { if (!matches(store, generation)) return; const id = snapshot.pages.find((page) => page.id === change.pageId)?.projectedNodeId; if (id) await updateNode(id, { corpusExcluded: change.excluded }, { keepAnchor: true }) }
  if (!matches(store, generation)) return
  const stale = snapshot.pages.filter((page) => page.archivedAt === null && page.sourceIds.length && artifactPageView(snapshot, corpus, page.id)?.stale)
  if (stale.some((page) => !snapshot.jobs.some((job) => job.pageId === page.id && ['queued', 'running', 'paused'].includes(job.status)))) await mutate(async (latest, current) => { for (const page of stale) if (latest.pages.some((entry) => entry.id === page.id && entry.archivedAt === null)) await appendJob(latest, current, pageOf(latest, page.id)) })
  schedule()
}

function firstStatement(text: string): string { return text.replace(/^#{1,6}\s+/gm, '').trim().split(/(?<=[.!?])\s|\n\s*\n/u)[0].slice(0, 2000).trim() }
async function generationStage(): Promise<boolean> {
  if (!isRepoReady() || !boundStore || useRepoStatus.getState().interruptedImport) return false
  const jobId = useArtifacts.getState().jobs.find((job) => job.status === 'queued' || job.status === 'running')?.id
  if (!jobId) return false
  await mutate(async (snapshot, corpus) => {
    const job = snapshot.jobs.find((item) => item.id === jobId)
    if (!job || !['queued', 'running'].includes(job.status)) return
    const page = snapshot.pages.find((entry) => entry.id === job.pageId && entry.archivedAt === null)
    if (!page) { job.status = 'cancelled'; return }
    if (await inputHash(page, snapshot, corpus) !== job.inputHash) { job.status = 'cancelled'; job.error = 'A source changed before this output could be published. Generate a draft from current sources.'; return }
    if (job.sourceIds.some((id) => !corpus.sources.some((source) => source.id === id && !source.deleted && !source.excluded && source.aiAllowed))) { job.status = 'paused'; job.error = 'A source is excluded or AI access is off. The original is preserved; change access or choose other sources before resuming.'; return }
    if (job.status === 'queued') job.attempts++
    job.status = 'running'
    for (const id of job.sourceIds.slice(job.checkpoint, job.checkpoint + STAGE_SOURCES)) {
      const source = corpus.sources.find((source) => source.id === id)!
      for (const passage of corpus.passages.filter((passage) => passage.sourceId === id && passage.versionId === source.currentVersionId).slice(0, 4)) if (job.draftEvidence.length < MAX_EVIDENCE) job.draftEvidence.push({ passageId: passage.id, sourceVersionId: passage.versionId, relation: 'context' })
      job.checkpoint++
    }
    job.updatedAt = Date.now()
    if (job.checkpoint < job.total) return
    const evidence = validEvidence(job.draftEvidence, corpus, { current: true, aiOnly: true })
    const correction = snapshot.pageRevisions.filter((revision) => revision.pageId === page.id && revision.manual && revision.status === 'accepted').at(-1)?.contentMd
    const lines = [`# ${page.title}`, '', 'This is a local extractive draft. Statements below are attributed source excerpts, not verified beliefs.', ...(page.question ? ['', `Question: ${page.question}`] : []), ...(correction ? ['', '## Your saved wording', correction] : [])]
    for (const ref of evidence) {
      const passage = resolveArtifactEvidence(ref, corpus, { aiOnly: true })!
      lines.push('', `### ${passage.title} · ${passage.role}`, `> ${passage.text.replace(/\n/g, '\n> ')}`, `[Read retained evidence](#/library?passage=${encodeURIComponent(passage.id)})`)
    }
    const revision: PageRevision = { id: uid(), pageId: page.id, previousRevisionId: page.currentRevisionId, contentMd: lines.join('\n').slice(0, 100_000), evidence, recordedAt: Date.now(), acceptedAt: null, status: 'proposed', manual: false, inputHash: job.inputHash, generator: GENERATOR, correction: correction ?? null }
    const pageFp = await pageFingerprint(page.id, revision.contentMd)
    if (snapshot.tombstones.some((item) => item.pageId === page.id && item.fingerprint === pageFp)) { job.status = 'complete'; job.error = null; activity(snapshot, page.id, job.id, 'review-decision-preserved', 'An unchanged rejected or withdrawn draft was not proposed again.'); return }
    snapshot.pageRevisions.push(revision)
    for (const ref of evidence.slice(0, 12)) {
      const passage = resolveArtifactEvidence(ref, corpus, { aiOnly: true })!, text = firstStatement(passage.text)
      if (text.length < 8) continue
      const fp = await claimFingerprint(page.id, text, passage.role)
      if (snapshot.tombstones.some((tombstone) => tombstone.pageId === page.id && tombstone.fingerprint === fp)) continue
      let claim = snapshot.claims.find((claim) => claim.pageId === page.id && claim.fingerprint === fp)
      if (!claim) { claim = { id: uid(), pageId: page.id, currentRevisionId: null, fingerprint: fp, createdAt: Date.now() }; snapshot.claims.push(claim) }
      if (claim.decision || snapshot.claimRevisions.some((entry) => entry.claimId === claim!.id && (entry.inputHash === job.inputHash || entry.manual && entry.status === 'accepted'))) continue
      snapshot.claimRevisions.push(makeClaimRevision(claim, text, [{ ...ref, relation: 'supports' }], corpus, { attributedTo: passage.role, manual: false, inputHash: job.inputHash }))
    }
    job.status = 'complete'; job.outputRevisionId = revision.id; job.error = null
    activity(snapshot, page.id, revision.id, 'draft-ready', `${evidence.length} exact evidence passages. Review before this enters agent context.`)
  })
  return true
}

export function runArtifactJobs(opts: { maxStages?: number } = {}): Promise<void> {
  if (running) return running
  if (!isRepoReady() || !boundStore) return Promise.resolve()
  const store = getStore(), generation = epoch
  running = (async () => {
    for (let stage = 0; stage < (opts.maxStages ?? 256); stage++) {
      if (!matches(store, generation)) break
      try { if (!await generationStage()) break }
      catch (error) {
        if (!matches(store, generation)) break
        const id = useArtifacts.getState().jobs.find((job) => job.status === 'running' || job.status === 'queued')?.id
        if (id && isRepoReady() && !useRepoStatus.getState().interruptedImport) await mutate((snapshot) => { const job = snapshot.jobs.find((entry) => entry.id === id); if (job) { job.status = 'failed'; job.error = message(error); job.updatedAt = Date.now() } }).catch(() => {})
        throw error
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  })().finally(() => { running = null; schedule() })
  return running
}

export async function knowledgePageHealth() { const store = getStore(), generation = epoch, [snapshot, corpus] = await Promise.all([store.getKv(ARTIFACTS_KV).then(decodeArtifacts), knowledge(store)]); if (!matches(store, generation)) throw new Error('The workspace changed while knowledge health was loading.'); return artifactHealth(snapshot, corpus) }
export function resetArtifacts(): void { resetBinding(); queue = Promise.resolve() }
import.meta.hot?.dispose(resetArtifacts)
