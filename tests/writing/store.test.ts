import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesSink, exportArchive, importArchive } from '../../src/data/archive.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo, useRepoStatus, wipeWorld } from '../../src/data/repo.ts'
import { getSourceOriginal, initializeKnowledge, resetKnowledge } from '../../src/knowledge/index.ts'
import * as knowledge from '../../src/knowledge/index.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import { captureArticle } from '../../src/reading/captureArticle.ts'
import { addHighlight, resetReading, useReading } from '../../src/reading/store.ts'
import { archiveWritingDocument, createWritingDocument, createWritingFromSource, decodeWriting, defaultWritingAppearance, duplicateWritingDocument, emptyWriting, initializeWriting, plainTextFromWriting, publishWritingDocument, refreshWriting, resetWriting, updateWritingDocument, useWriting, validateWritingContent, writingFromPlainText, WRITING_KV, type WritingSnapshot } from '../../src/writing/store.ts'

beforeEach(() => { resetWriting(); resetKnowledge(); vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No cloud or remote calls are allowed') })) })
afterEach(async () => { resetWriting(); resetKnowledge(); resetReading(); await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function open(store = createMemoryStore()) { await initRepo({ store }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' }); await initializeKnowledge(); await initializeWriting(); return store }
const content = () => writingFromPlainText('The copper orchard grows.\nA second line 🌍.\n\nAnother paragraph.')
const corpus = async () => (await getStore().getKv<KnowledgeSnapshot>('knowledge.v1'))!

describe('durable writing studio', () => {
  it('serializes drafts and preserves full rich content, appearance, archives and independent duplicates without publishing', async () => {
    const store = await open()
    const [one, two] = await Promise.all([createWritingDocument({ title: 'Essay draft', format: 'essay', content: content() }), createWritingDocument({ title: 'Poem draft', format: 'poem' })])
    const saved = await updateWritingDocument(one.id, { appearance: { background: 'waves', waveIntensity: 48, fontFamily: 'mono' }, subtitle: 'My subtitle', byline: 'My byline' }, { expectedUpdatedAt: one.updatedAt })
    const duplicate = await duplicateWritingDocument(saved.id)
    expect(duplicate).toMatchObject({ title: 'Essay draft (copy)', content: saved.content, appearance: saved.appearance, archivedAt: null })
    expect(duplicate.id).not.toBe(saved.id); expect(duplicate.sourceId).toBeUndefined()
    await archiveWritingDocument(two.id)
    resetWriting(); await initializeWriting()
    expect(useWriting.getState().docs.find((doc) => doc.id === two.id)?.archivedAt).toBeTypeOf('number')
    expect(useWriting.getState().docs.find((doc) => doc.id === one.id)?.appearance.waveIntensity).toBe(48)
    expect(await store.getKv('knowledge.v1')).toBeUndefined()
    expect(await store.listNodes()).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses monotonic edit revisions and rejects a stale UI overwrite while preserving the saved revision', async () => {
    await open(); const doc = await createWritingDocument({ content: content() })
    const next = await updateWritingDocument(doc.id, { title: 'First edit' }, { expectedUpdatedAt: doc.updatedAt })
    expect(next.updatedAt).toBeGreaterThan(doc.updatedAt)
    await expect(updateWritingDocument(doc.id, { title: 'Stale second edit' }, { expectedUpdatedAt: doc.updatedAt })).rejects.toThrow(/changed elsewhere/)
    expect(useWriting.getState().docs[0].title).toBe('First edit')
    const unchanged = await updateWritingDocument(doc.id, { title: 'First edit' }, { expectedUpdatedAt: next.updatedAt })
    expect(unchanged.updatedAt).toBe(next.updatedAt)
  })

  it('rejects unsafe CSS, URLs, attributes, media and unsupported/cyclic JSON without replacing valid drafts', async () => {
    const store = await open(), doc = await createWritingDocument({ content: content() }), before = await store.getKv(WRITING_KV)
    for (const patch of [
      { appearance: { pageColor: 'red;background:url(https://evil.example)' } },
      { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bad', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] } },
      { content: { type: 'doc', content: [{ type: 'writingEmbed', attrs: { url: 'https://youtube.com.evil.example/embed/abcdefghijk' } }] } },
      { content: { type: 'doc', content: [{ type: 'writingMedia', attrs: { assetId: `writing-${'a'.repeat(64)}`, kind: 'image', mime: 'image/svg+xml' } }] } },
      { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { constructor: 'not an allowed attribute' } }] } },
    ]) await expect(updateWritingDocument(doc.id, patch as never)).rejects.toThrow()
    const cyclic = { type: 'doc', content: [] as unknown[] }; cyclic.content.push(cyclic)
    expect(() => validateWritingContent(cyclic)).toThrow()
    expect(await store.getKv(WRITING_KV)).toEqual(before)
    expect(plainTextFromWriting(writingFromPlainText('A\n\n\nB\n'))).toBe('A\n\n\nB\n')
  })

  it('retains exact rich originals and human-authored Library versions only on explicit publication', async () => {
    await open(); const doc = await createWritingDocument({ title: 'Copper orchard', content: content(), appearance: { pageColor: '#fff8ed' } })
    const result = await publishWritingDocument(doc.id), first = await corpus()
    expect(first.sources).toHaveLength(1); expect(first.sources[0].nodeId).toBeUndefined()
    expect(first.versions[0]).toMatchObject({ id: result.versionId, sourceId: result.sourceId, text: plainTextFromWriting(doc.content), metadata: { format: 'writing', writingDocumentId: doc.id, content: doc.content, appearance: doc.appearance, writingAssetIds: [] } })
    expect(first.passages.every((passage) => passage.role === 'human')).toBe(true)
    const original = await getSourceOriginal(result.sourceId, result.versionId)
    expect(JSON.parse(await original!.blob.text())).toMatchObject({ format: 'worldview-writing.v1', document: { id: doc.id, content: doc.content, appearance: doc.appearance } })
    expect(await getStore().listNodes()).toEqual([])
    expect((await createWritingFromSource(result.sourceId)).id).toBe(doc.id)
    expect(await publishWritingDocument(doc.id)).toEqual(result)
    expect((await corpus()).versions).toHaveLength(1)
    expect(useWriting.getState().docs[0]).toMatchObject({ sourceId: result.sourceId, publishedUpdatedAt: doc.updatedAt, publishedFingerprint: expect.stringMatching(/^[a-f\d]{64}$/) })
  })

  it('creates appearance-only source revisions while historical text, original bytes and exact highlights remain unchanged', async () => {
    await open(); const doc = await createWritingDocument({ title: 'Style revisions', content: content() }), original = await publishWritingDocument(doc.id)
    const beforeBytes = await (await getSourceOriginal(original.sourceId, original.versionId))!.blob.text()
    await addHighlight({ sourceId: original.sourceId, versionId: original.versionId, start: 4, end: 10, quote: 'copper', note: 'Exact old version.' })
    await updateWritingDocument(doc.id, { appearance: { pageStyle: 'seamless', fontSize: 22 } })
    const revised = await publishWritingDocument(doc.id), snapshot = await corpus()
    expect(revised.sourceId).toBe(original.sourceId); expect(revised.versionId).not.toBe(original.versionId)
    expect(snapshot.versions.map((version) => version.text)).toEqual([plainTextFromWriting(doc.content), plainTextFromWriting(doc.content)])
    expect(await (await getSourceOriginal(original.sourceId, original.versionId))!.blob.text()).toBe(beforeBytes)
    expect(useReading.getState().highlights[0]).toMatchObject({ versionId: original.versionId, quote: 'copper', note: 'Exact old version.' })
    expect(await publishWritingDocument(doc.id)).toEqual(revised)
    expect((await corpus()).versions).toHaveLength(2)
  })

  it('copies a third-party source into a new draft and publishes separately without overwriting the retained article', async () => {
    await open(); const captured = await captureArticle({ title: 'Third-party article', url: 'https://example.org/original', text: 'Third-party exact text.\nKeep this original.' })
    const before = await corpus(), original = before.sources.find((source) => source.id === captured.sourceId)!, originalBytes = await (await getSourceOriginal(original.id))!.blob.text()
    const copy = await createWritingFromSource(original.id)
    expect(copy).toMatchObject({ basedOnSourceId: original.id, baseVersionId: original.currentVersionId }); expect(copy.sourceId).toBeUndefined()
    await updateWritingDocument(copy.id, { content: writingFromPlainText('My separate human rewrite.') })
    const published = await publishWritingDocument(copy.id)
    expect(published.sourceId).not.toBe(original.id)
    const after = await corpus()
    expect(after.sources.find((source) => source.id === original.id)?.currentVersionId).toBe(original.currentVersionId)
    expect(await (await getSourceOriginal(original.id))!.blob.text()).toBe(originalBytes)
    expect(useWriting.getState().docs[0].baseVersionId).toBe(original.currentVersionId)
  })

  it('rolls back failed CAS saves and preserves another writer’s winning draft', async () => {
    const store = await open(), doc = await createWritingDocument({ title: 'Original', content: content() }), snapshot = (await store.getKv<WritingSnapshot>(WRITING_KV))!
    const winner: WritingSnapshot = { ...snapshot, revision: snapshot.revision + 1, docs: [{ ...doc, title: 'Other writer wins', updatedAt: doc.updatedAt + 1 }] }
    store.compareAndSwapKv = async () => { await store.putKv(WRITING_KV, winner); return false }
    await expect(updateWritingDocument(doc.id, { title: 'Losing edit' })).rejects.toThrow(/no newer changes/)
    expect(await store.getKv(WRITING_KV)).toEqual(winner)
    expect(useWriting.getState().docs[0].title).toBe('Other writer wins')
  })

  it('keeps the draft and retained original if publication-link CAS fails, and recovers the same Library version on retry', async () => {
    const store = await open(), doc = await createWritingDocument({ content: content() }), swap = store.compareAndSwapKv.bind(store)
    let fail = true
    store.compareAndSwapKv = async (key, value, revision) => { if (key === WRITING_KV && fail) { fail = false; return false } return swap(key, value, revision) }
    await expect(publishWritingDocument(doc.id)).rejects.toThrow(/no newer changes/)
    expect((await store.getKv<WritingSnapshot>(WRITING_KV))!.docs[0]).toEqual(doc)
    const retained = await corpus()
    expect(retained.versions).toHaveLength(1)
    expect((await getSourceOriginal(retained.sources[0].id))?.blob.size).toBeGreaterThan(0)
    expect(await publishWritingDocument(doc.id)).toEqual({ sourceId: retained.sources[0].id, versionId: retained.versions[0].id })
    expect((await corpus()).versions).toHaveLength(1)
  })

  it('rejects pending publication after account replacement even when the new store reuses the document ID', async () => {
    const previous = await open(), doc = await createWritingDocument({ content: content() }), saved = await previous.getKv(WRITING_KV), settings = await previous.getSettings(), hash = knowledge.knowledgeHash
    let started!: () => void, release!: () => void
    const hashing = new Promise<void>((resolve) => { started = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(knowledge, 'knowledgeHash').mockImplementation(async (value) => { const result = await hash(value); started(); await gate; return result })
    const pending = publishWritingDocument(doc.id); void pending.catch(() => {}); await hashing
    await closeRepo(); const replacement = createMemoryStore(); await replacement.putSettings(settings!); await replacement.putKv(WRITING_KV, saved)
    await initRepo({ store: replacement }); await initializeWriting()
    release(); await expect(pending).rejects.toThrow(/workspace changed/)
    expect(await replacement.listAssets()).toEqual([])
    expect((await replacement.getKv<WritingSnapshot>(WRITING_KV))!.docs[0].sourceId).toBeUndefined()
    expect((await previous.getKv<WritingSnapshot>(WRITING_KV))!.docs[0]).toEqual(doc)
  })

  it('rechecks the authoritative draft after retaining bytes so a concurrent edit is not published stale', async () => {
    const store = await open(), doc = await createWritingDocument({ content: content() }), put = store.putBlob.bind(store)
    let started!: () => void, release!: () => void
    const retaining = new Promise<void>((resolve) => { started = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
    store.putBlob = async (input) => { await put(input); started(); await gate }
    const pending = publishWritingDocument(doc.id); void pending.catch(() => {}); await retaining
    const snapshot = (await store.getKv<WritingSnapshot>(WRITING_KV))!
    const newer = { ...snapshot, revision: snapshot.revision + 1, docs: [{ ...doc, title: 'A concurrent writer’s new title', updatedAt: doc.updatedAt + 1 }] }
    await store.putKv(WRITING_KV, newer)
    release(); await expect(pending).rejects.toThrow(/changed while its original/)
    expect(await store.getKv(WRITING_KV)).toEqual(newer)
    expect(await store.getKv('knowledge.v1')).toBeUndefined()
    expect(await store.listAssets()).toHaveLength(1)
    expect(useWriting.getState().docs[0].title).toBe('A concurrent writer’s new title')
  })

  it('fails closed on corrupted snapshots and read-only workspaces, and clears on same-store wipe', async () => {
    const store = await open(), corrupt = { ...emptyWriting(), schemaVersion: 22 }
    await store.putKv(WRITING_KV, corrupt)
    await expect(refreshWriting()).rejects.toThrow(/unsupported/)
    await expect(createWritingDocument()).rejects.toThrow(/unsupported/)
    expect(await store.getKv(WRITING_KV)).toEqual(corrupt)
    await store.putKv(WRITING_KV, emptyWriting()); await refreshWriting()
    useRepoStatus.setState({ writer: false }); await expect(createWritingDocument()).rejects.toThrow(/read only/)
    useRepoStatus.setState({ writer: true }); await createWritingDocument({ title: 'Before wipe' })
    await wipeWorld({ confirm: true }); await vi.waitFor(() => expect(useWriting.getState().docs).toEqual([]))
    expect(() => decodeWriting({ ...emptyWriting(), docs: [{ appearance: defaultWritingAppearance() }] })).toThrow()
  })

  it('includes every historical media/background reference in publication metadata', async () => {
    await open(); const media = `writing-${'a'.repeat(64)}`, background = `writing-${'b'.repeat(64)}`
    const doc = await createWritingDocument({ content: { type: 'doc', content: [{ type: 'writingMedia', attrs: { assetId: media, kind: 'image', mime: 'image/png', name: 'local.png', alt: 'My image', caption: 'My retained caption', width: 'wide' } }] }, appearance: { background: 'image', backgroundAssetId: background } })
    const first = await publishWritingDocument(doc.id)
    await updateWritingDocument(doc.id, { content: writingFromPlainText('Media removed from the new draft.'), appearance: { backgroundAssetId: null, background: 'solid' } }); await publishWritingDocument(doc.id)
    const snapshot = await corpus()
    expect(snapshot.versions.find((version) => version.id === first.versionId)?.metadata?.writingAssetIds).toEqual([media, background].sort())
    expect(snapshot.versions.at(-1)?.metadata?.writingAssetIds).toEqual([])
  })

  it('round-trips drafts and published rich originals through the portable world archive', async () => {
    const store = await open(), doc = await createWritingDocument({ title: 'Portable writing', content: content() }), saved = await publishWritingDocument(doc.id)
    const sink = bytesSink(); await exportArchive(store, sink)
    const restored = createMemoryStore(); await importArchive(restored, new NodeBlob([sink.bytes().slice()]), { allowWithoutBackup: true })
    expect(await restored.getKv(WRITING_KV)).toEqual(await store.getKv(WRITING_KV))
    await closeRepo(); await initRepo({ store: restored }); await initializeKnowledge(); await initializeWriting()
    expect(useWriting.getState().docs[0].id).toBe(doc.id)
    expect(JSON.parse(await (await getSourceOriginal(saved.sourceId, saved.versionId))!.blob.text()).document.content).toEqual(doc.content)
  })
})
