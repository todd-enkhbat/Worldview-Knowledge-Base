import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { bytesSink, exportArchive, importArchive } from '../../src/data/archive.ts'
import { closeRepo, completeFirstRun, emptyTrash, getStore, importWorld, initRepo, softDelete, updateNode, useRepoStatus } from '../../src/data/repo.ts'
import { captureThought, initializeKnowledge, resetKnowledge, setSourcePolicy, syncKnowledgeNodes } from '../../src/knowledge/index.ts'
import { ARTIFACTS_KV, artifactContext, artifactHealth, artifactPageView, createKnowledgePage, decodeArtifacts, editKnowledgePage, initializeArtifacts, parseClaimDate, projectKnowledgePage, proposeClaim, queuePageGeneration, readKnowledgePage, reconcileArtifactDependencies, resetArtifacts, reviewClaim, reviewPageRevision, reviseClaim, runArtifactJobs, setArtifactJobState, useArtifacts, type EvidenceRef } from '../../src/knowledge/artifacts/index.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

beforeEach(async () => {
  resetArtifacts(); resetKnowledge()
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  await initializeKnowledge(); await initializeArtifacts()
})
afterEach(async () => { resetArtifacts(); resetKnowledge(); await closeRepo(); vi.restoreAllMocks() })

async function thought(text: string) {
  const node = await captureThought(text)
  const corpus = await getStore().getKv<KnowledgeSnapshot>('knowledge.v1')
  const source = corpus!.sources.find((source) => source.nodeId === node.id)!
  const passage = corpus!.passages.find((passage) => passage.sourceId === source.id && passage.versionId === source.currentVersionId)!
  return { node, source, passage, ref: { passageId: passage.id, sourceVersionId: passage.versionId, relation: 'supports' } satisfies EvidenceRef }
}
async function drain() { for (let i = 0; i < 20 && useArtifacts.getState().jobs.some((job) => job.status === 'queued' || job.status === 'running'); i++) await runArtifactJobs() }
async function corpus() { return (await getStore().getKv<KnowledgeSnapshot>('knowledge.v1'))! }
async function changed(id: string, text: string) { await updateNode(id, { contentMd: text }, { keepAnchor: true }); await syncKnowledgeNodes([...useWorld.getState().nodes.values(), ...useWorld.getState().excluded.values(), ...useWorld.getState().trash.values()]); await reconcileArtifactDependencies() }

describe('maintained knowledge pages', () => {
  it('builds a real three-source extractive pilot, requires review, and carries exact evidence into accepted context', async () => {
    const inputs = await Promise.all([thought('Amber launch is approved for November 29. The budget review is complete.'), thought('The entropy model requires another experiment. We have not approved its explanation.'), thought('The lighthouse battery reserve is eighteen hours. Keep the source measurement.')])
    const page = await createKnowledgePage({ title: 'Amber lighthouse', kind: 'project', sourceIds: inputs.map((input) => input.source.id), question: 'What was approved and what remains uncertain?' })
    await drain()
    const state = useArtifacts.getState(), view = await readKnowledgePage(page.id)
    expect(view?.revision).toBeNull()
    expect(view?.proposed).toHaveLength(1)
    expect(view?.proposed[0].evidence).toHaveLength(3)
    expect(view?.proposed[0].contentMd).toContain('local extractive draft')
    expect(artifactContext(state, await corpus())).toEqual([])
    await reviewPageRevision(view!.proposed[0].id, 'accept')
    const accepted = artifactContext(useArtifacts.getState(), await corpus())
    expect(accepted).toHaveLength(1)
    expect(accepted[0].evidence.map((ref) => ref.passageId).sort()).toEqual(inputs.map((input) => input.passage.id).sort())
    expect(useArtifacts.getState().claimRevisions.every((revision) => revision.status === 'proposed')).toBe(true)
    expect(accepted[0].content).toContain('not verified beliefs')
  })

  it('retains accepted claim revisions, explicit opposition, independent times and validity without rewriting the source', async () => {
    const first = await thought('I approve the original launch decision.'), second = await thought('The later experiment opposes the original explanation.')
    const page = await createKnowledgePage({ title: 'Changing explanation', kind: 'topic', sourceIds: [first.source.id, second.source.id], contentMd: 'My project notes.' })
    const originalText = (await corpus()).versions.find((version) => version.id === first.passage.versionId)!.text
    const old = await proposeClaim({ pageId: page.id, text: 'The first explanation was my preference.', evidence: [first.ref], attributedTo: 'human', validFrom: Date.UTC(2026, 0, 1) })
    await reviewClaim(old.id, 'accept')
    const revised = await reviseClaim(old.claimId, { text: 'I now prefer the second explanation after the experiment.', evidence: [{ ...first.ref, relation: 'context' }, { ...second.ref, relation: 'opposes' }], attributedTo: 'human', validFrom: Date.UTC(2026, 1, 1), eventAt: Date.UTC(2026, 0, 31) })
    await reviewClaim(revised.id, 'accept')
    const state = useArtifacts.getState()
    expect(state.claimRevisions.find((revision) => revision.id === old.id)?.text).toBe(old.text)
    expect(revised.recordedAt).not.toBe(revised.validFrom)
    expect(revised.eventAt).not.toBe(revised.sourceAuthoredAt)
    expect(revised.evidence.some((ref) => ref.relation === 'opposes')).toBe(true)
    expect((await readKnowledgePage(page.id))?.claims[0].revision.text).toContain('now prefer')
    expect((await corpus()).versions.find((version) => version.id === first.passage.versionId)?.text).toBe(originalText)
    await reviewClaim(revised.id, 'undo')
    expect((await readKnowledgePage(page.id))?.claims[0].revision.id).toBe(old.id)
  })

  it('keeps rejected and withdrawn interpretations from returning after changed inputs or restart', async () => {
    const input = await thought('The battery reserve is eighteen hours. Original measurement.')
    const page = await createKnowledgePage({ title: 'Battery reserve', sourceIds: [input.source.id] })
    await drain()
    const proposed = useArtifacts.getState().claimRevisions[0]
    await reviewClaim(proposed.id, 'reject')
    await changed(input.node.id, 'The battery reserve is eighteen hours. A second measurement agrees.')
    await queuePageGeneration(page.id); await drain()
    expect(useArtifacts.getState().claimRevisions.filter((revision) => revision.text === proposed.text)).toHaveLength(1)
    const latest = await corpus(), versionId = latest.sources.find((source) => source.id === input.source.id)!.currentVersionId
    const corrected = await reviseClaim(proposed.claimId, { text: 'I treat eighteen hours as a provisional measurement.', evidence: [{ passageId: latest.passages.find((passage) => passage.sourceId === input.source.id && passage.versionId === versionId)!.id, sourceVersionId: versionId, relation: 'supports' }] })
    await reviewClaim(corrected.id, 'accept'); await reviewClaim(corrected.id, 'withdraw')
    const store = getStore(); resetArtifacts(); await closeRepo(); await initRepo({ store }); await initializeArtifacts()
    expect((await readKnowledgePage(page.id, { atTime: Date.now() + 1 }))?.claims).toEqual([])
    expect(useArtifacts.getState().tombstones.some((item) => item.reason === 'withdrawn')).toBe(true)
  })

  it('requires explicit withdrawal undo and does not erase it when an older acceptance is undone', async () => {
    const input = await thought('Withdrawal test evidence remains current.')
    const page = await createKnowledgePage({ title: 'Review decisions', sourceIds: [input.source.id] }); await drain()
    const original = useArtifacts.getState().claimRevisions[0]
    await reviewClaim(original.id, 'accept')
    const corrected = await reviseClaim(original.claimId, { text: 'This is my explicit corrected interpretation.', evidence: [input.ref] })
    await reviewClaim(corrected.id, 'accept'); await reviewClaim(corrected.id, 'withdraw')
    await reviewClaim(original.id, 'undo')
    expect((await readKnowledgePage(page.id))?.claims).toEqual([])
    expect(useArtifacts.getState().tombstones.filter((item) => item.reason === 'withdrawn')).toHaveLength(2)
    await expect(reviewClaim(corrected.id, 'accept')).rejects.toThrow(/withdrawn/)
    await reviewClaim(corrected.id, 'undo')
    expect((await readKnowledgePage(page.id))?.claims[0].revision.id).toBe(corrected.id)
    const revision = useArtifacts.getState().pageRevisions[0]
    await reviewPageRevision(revision.id, 'accept'); await reviewPageRevision(revision.id, 'withdraw')
    await expect(reviewPageRevision(revision.id, 'accept')).rejects.toThrow(/withdrawn/)
    await reviewPageRevision(revision.id, 'undo')
    expect((await readKnowledgePage(page.id))?.revision?.id).toBe(revision.id)
  })

  it('atomically removes permanently deleted source wording from derived history and backups while retaining hashed decisions and world pins', async () => {
    const secret = 'VIOLET_PRIVATE_74', input = await thought(`${secret} records the provisional launch decision.`)
    const page = await createKnowledgePage({ title: `${secret} project`, sourceIds: [input.source.id] }); await drain()
    const revision = useArtifacts.getState().pageRevisions[0]
    await reviewPageRevision(revision.id, 'accept')
    const claim = useArtifacts.getState().claimRevisions[0]
    await reviewClaim(claim.id, 'withdraw')
    const projected = await projectKnowledgePage(page.id)
    await updateNode(projected, { fieldAnchorXZ: [71, 92] }, { keepAnchor: true })
    const before = await getStore().getKv(ARTIFACTS_KV)
    expect(JSON.stringify(before)).toContain(secret)
    await softDelete(input.node.id); await emptyTrash({ confirm: true })
    await syncKnowledgeNodes([...useWorld.getState().nodes.values(), ...useWorld.getState().excluded.values(), ...useWorld.getState().trash.values()])
    await initializeArtifacts()
    const state = decodeArtifacts(await getStore().getKv(ARTIFACTS_KV))
    expect(JSON.stringify(state)).not.toContain(secret)
    expect(state.pages.find((item) => item.id === page.id)?.archivedAt).not.toBeNull()
    expect(state.tombstones.some((item) => item.reason === 'withdrawn')).toBe(true)
    expect(state.tombstones.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.fingerprint))).toBe(true)
    expect((await readKnowledgePage(page.id, { atTime: Date.now() + 1 }))).toBeNull()
    expect(artifactContext(state, await corpus())).toEqual([])
    expect(useWorld.getState().excluded.get(projected)).toMatchObject({ title: 'Deleted source reference', fieldAnchorXZ: [71, 92] })
    expect(await getStore().getBlob((await corpus()).versions[0]?.originalBlobId ?? 'missing')).toBeUndefined()
    const sink = bytesSink(); await exportArchive(getStore(), sink)
    const restored = createMemoryStore(); await importArchive(restored, new Blob([sink.bytes().slice()]), { allowWithoutBackup: true })
    expect(JSON.stringify(await restored.getKv(ARTIFACTS_KV))).not.toContain(secret)
    resetArtifacts(); await closeRepo(); await initRepo({ store: restored }); await initializeArtifacts()
    expect(useArtifacts.getState().pages.find((item) => item.id === page.id)?.title).toBe('Deleted source reference')
    expect((await readKnowledgePage(page.id))).toBeNull()
  })

  it('preserves a manual correction when a changed source produces a proposed replacement', async () => {
    const input = await thought('The first experiment supports explanation A.')
    const page = await createKnowledgePage({ title: 'Experiment', sourceIds: [input.source.id] }); await drain()
    await reviewPageRevision(useArtifacts.getState().pageRevisions[0].id, 'accept')
    const manual = await editKnowledgePage(page.id, 'My correction: the measurement is provisional, not a verified explanation.')
    await changed(input.node.id, 'The second experiment supports explanation B.')
    await queuePageGeneration(page.id); await drain()
    const view = await readKnowledgePage(page.id)
    expect(view?.revision?.id).toBe(manual.id)
    expect(view?.stale).toBe(true)
    expect(view?.proposed.at(-1)?.contentMd).toContain(manual.contentMd)
    expect(view?.proposed.at(-1)?.contentMd).toContain('second experiment')
    expect(artifactContext(useArtifacts.getState(), await corpus())).toEqual([])
    expect(artifactHealth(useArtifacts.getState(), await corpus()).stalePages).toContain(page.id)
  })

  it('enforces current source policy on current/history reads and AI context, then restores identity and pins', async () => {
    const input = await thought('Sensitive project evidence remains attributed.')
    const page = await createKnowledgePage({ title: 'Private project', sourceIds: [input.source.id] }); await drain()
    await reviewPageRevision(useArtifacts.getState().pageRevisions[0].id, 'accept')
    const nodeId = await projectKnowledgePage(page.id)
    await updateNode(nodeId, { fieldAnchorXZ: [43, 91] }, { keepAnchor: true })
    expect(useWorld.getState().nodes.get(nodeId)?.contentMd).not.toContain('Sensitive project evidence')
    await setSourcePolicy(input.source.id, { aiAllowed: false }); await reconcileArtifactDependencies()
    expect((await readKnowledgePage(page.id))?.revision).not.toBeNull()
    expect(artifactContext(useArtifacts.getState(), await corpus())).toEqual([])
    await setSourcePolicy(input.source.id, { excluded: true }); await reconcileArtifactDependencies()
    expect((await readKnowledgePage(page.id, { atTime: Date.now() }))?.restricted).toBe(true)
    expect(useWorld.getState().excluded.get(nodeId)?.fieldAnchorXZ).toEqual([43, 91])
    await setSourcePolicy(input.source.id, { excluded: false, aiAllowed: true }); await reconcileArtifactDependencies()
    expect(useWorld.getState().nodes.get(nodeId)?.fieldAnchorXZ).toEqual([43, 91])
    expect(artifactContext(useArtifacts.getState(), await corpus())).toHaveLength(1)
  })

  it('persists bounded generation checkpoints and pause/resume across a real repository reopen', async () => {
    const inputs = []
    for (let i = 0; i < 6; i++) inputs.push(await thought(`Experiment ${i} records a separate source observation.`))
    const page = await createKnowledgePage({ title: 'Six experiments', sourceIds: inputs.map((input) => input.source.id) })
    const job = useArtifacts.getState().jobs.find((job) => job.pageId === page.id)!
    await setArtifactJobState(job.id, 'pause'); await runArtifactJobs({ maxStages: 1 })
    expect(useArtifacts.getState().jobs[0].checkpoint).toBe(0)
    await setArtifactJobState(job.id, 'resume'); await runArtifactJobs({ maxStages: 1 })
    expect(useArtifacts.getState().jobs[0]).toMatchObject({ checkpoint: 4, status: 'running' })
    const store = getStore(); resetArtifacts(); await closeRepo(); await initRepo({ store }); await initializeArtifacts(); await drain()
    expect(useArtifacts.getState().jobs[0]).toMatchObject({ checkpoint: 6, status: 'complete' })
    expect(useArtifacts.getState().pageRevisions).toHaveLength(1)
  })

  it('backs up page history, claim decisions, jobs and withdrawal tombstones with originals', async () => {
    const input = await thought('The archive contains evidence for this page.')
    const page = await createKnowledgePage({ title: 'Recovery', sourceIds: [input.source.id] }); await drain()
    const claim = useArtifacts.getState().claimRevisions[0]; await reviewClaim(claim.id, 'withdraw')
    const sink = bytesSink(); await exportArchive(getStore(), sink)
    const restored = createMemoryStore(); await importArchive(restored, new Blob([sink.bytes().slice()]), { allowWithoutBackup: true })
    expect(await restored.getKv(ARTIFACTS_KV)).toEqual(await getStore().getKv(ARTIFACTS_KV))
    const state = decodeArtifacts(await restored.getKv(ARTIFACTS_KV)), restoredCorpus = (await restored.getKv<KnowledgeSnapshot>('knowledge.v1'))!
    expect(artifactPageView(state, restoredCorpus, page.id)?.claims).toEqual([])
    expect(await restored.getBlob(restoredCorpus.versions[0].originalBlobId)).toBeDefined()
  })

  it('invalidates pending dependency reads across a same-store archive replacement', async () => {
    const empty = bytesSink(); await exportArchive(getStore(), empty)
    const input = await thought('This pre-restore source must not republish its page.')
    await createKnowledgePage({ title: 'Before restore', sourceIds: [input.source.id], contentMd: 'Pre-restore wording.' })
    const store = getStore(), original = store.getKv.bind(store)
    let entered!: () => void, release!: () => void
    const reading = new Promise<void>((resolve) => { entered = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    let first = true
    store.getKv = async <T,>(key: string) => {
      const value = await original<T>(key)
      if (key === ARTIFACTS_KV && first) { first = false; entered(); await held }
      return value
    }
    const pending = reconcileArtifactDependencies()
    await reading
    store.getKv = original
    try {
      await importWorld(new Blob([empty.bytes().slice()]), { allowWithoutBackup: true })
      await initializeArtifacts()
      expect(useArtifacts.getState().pages).toEqual([])
      release(); await pending
      expect(useArtifacts.getState().pages).toEqual([])
      expect(useArtifacts.getState().revision).toBe(0)
    } finally { release(); store.getKv = original }
  })

  it('accepts user-approved profile wording without fabricating source evidence and respects scope', async () => {
    const profile = await createKnowledgePage({ title: 'My working preferences', kind: 'profile', contentMd: 'I prefer concise explanations with source citations.' })
    expect(artifactContext(useArtifacts.getState(), await corpus())[0]).toMatchObject({ id: profile.id, kind: 'profile', evidence: [] })
    const input = await thought('Project A has one approved scope.')
    const page = await createKnowledgePage({ title: 'Project A', kind: 'project', sourceIds: [input.source.id], contentMd: 'My project note.' })
    expect(artifactPageView(useArtifacts.getState(), await corpus(), page.id, { sourceIds: [] })).toBeNull()
  })

  it('leaves newer decisions intact on CAS conflict and blocks read-only changes', async () => {
    const store = getStore(), original = store.compareAndSwapKv.bind(store)
    store.compareAndSwapKv = async (key, value, expected) => key === ARTIFACTS_KV ? false : original(key, value, expected)
    await expect(createKnowledgePage({ title: 'Conflicting page', contentMd: 'Must not persist.' })).rejects.toThrow(/no newer changes/)
    expect(await store.getKv(ARTIFACTS_KV)).toBeUndefined()
    store.compareAndSwapKv = original
    useRepoStatus.setState({ writer: false })
    await expect(createKnowledgePage({ title: 'Read only', contentMd: 'Must not persist.' })).rejects.toThrow(/read only/)
  })

  it('rejects ambiguous or invalid dates and keeps an unknown validity separate from capture time', () => {
    expect(parseClaimDate('')).toBeNull()
    expect(parseClaimDate('2026-11-23')).toBe(Date.UTC(2026, 10, 23))
    expect(() => parseClaimDate('11/23/2026')).toThrow(/unambiguous/)
    expect(() => parseClaimDate('2026-02-30')).toThrow(/does not exist/)
  })
})
