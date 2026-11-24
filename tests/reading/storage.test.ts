import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesSink, exportArchive, importArchive } from '../../src/data/archive.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, handleRemoteChange, initRepo, useRepoStatus, wipeWorld } from '../../src/data/repo.ts'
import { captureThought, initializeKnowledge, resetKnowledge, useKnowledge } from '../../src/knowledge/index.ts'
import { addHighlight, addReadingNote, assignTopics, connectReading, createFolder, createTopic, decodeReading, defaultReadingItem, deleteFolder, disconnectReading, emptyReading, initializeReading, READING_KV, recordReadingProgress, refreshReading, removeHighlight, removeReadingNote, renameFolder, resetReading, updateHighlight, updateReadingItem, updateReadingNote, updateTopic, useReading, type ReadingSnapshot } from '../../src/reading/store.ts'
import { addPdfHighlight, bulkUpdateReadingItems, removePdfHighlight, removeReadingView, saveReadingView, updatePdfHighlight } from '../../src/reading/store.ts'

beforeEach(() => { vi.stubGlobal('Blob', NodeBlob); resetReading() })
afterEach(async () => { resetReading(); resetKnowledge(); await closeRepo(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function open(store = createMemoryStore()) {
  await initRepo({ store })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  await initializeKnowledge(); await initializeReading()
  return store
}
async function source(text = 'The copper orchard decision belongs here.') {
  await captureThought(text)
  const entry = useKnowledge.getState().sources.at(-1)!
  const version = useKnowledge.getState().versions.find((row) => row.id === entry.currentVersionId)!
  return { source: entry, version }
}

describe('durable local reading archive', () => {
  it('files a batch in one revision and rejects unavailable members without a partial move', async () => {
    const store = await open(), first = await source(), second = await source('A different retained record.'), folder = await createFolder('Filed together'), topic = await createTopic('Shared topic')
    const prior = useReading.getState().revision
    await bulkUpdateReadingItems([first.source.id, second.source.id], { folderId: folder.id }, { addTopicId: topic.id })
    expect(useReading.getState().revision).toBe(prior + 1)
    expect(useReading.getState().items.map((item) => [item.folderId, item.topicIds])).toEqual([[folder.id, [topic.id]], [folder.id, [topic.id]]])
    const before = await store.getKv(READING_KV)
    await expect(bulkUpdateReadingItems([first.source.id, 'missing'], { favorite: true })).rejects.toThrow(/no longer available/)
    expect(await store.getKv(READING_KV)).toEqual(before)
  })

  it('retains validated saved views through a reload and rejects unsupported filters', async () => {
    const store = await open()
    const view = await saveReadingView({ name: 'My evidence', query: 'copper orchard', filter: 'highlights', folderId: null, topic: '', view: 'list', sort: 'opened' })
    resetReading(); await initializeReading()
    expect(useReading.getState().savedViews).toEqual([view])
    const before = await store.getKv(READING_KV)
    await expect(saveReadingView({ ...view, filter: 'unsupported' })).rejects.toThrow(/unsupported format/)
    expect(await store.getKv(READING_KV)).toEqual(before)
    await removeReadingView(view.id)
    expect(useReading.getState().savedViews).toEqual([])
  })

  it('retains version-bound PDF page annotations independently of extracted UTF16 offsets', async () => {
    await open(); const first = await source(), second = await source('Other extracted PDF wording')
    const input = { sourceId: first.source.id, versionId: first.version.id, page: 3, quote: 'Visible PDF text with a different reading order', rects: [{ x: .1, y: .2, width: .4, height: .025 }] }
    const saved = await addPdfHighlight(input)
    await updatePdfHighlight(saved.id, { color: 'blue', note: 'An exact page location.' })
    resetReading(); await initializeReading()
    expect(useReading.getState().pdfHighlights?.[0]).toMatchObject({ ...input, color: 'blue', note: 'An exact page location.' })
    await expect(addPdfHighlight({ ...input, versionId: second.version.id })).rejects.toThrow(/PDF version/)
    await expect(addPdfHighlight({ ...input, rects: [{ x: .9, y: .2, width: .4, height: .1 }] })).rejects.toThrow(/PDF page/)
    await removePdfHighlight(saved.id)
    expect(useReading.getState().pdfHighlights).toEqual([])
  })
  it('serializes concurrent commands, deduplicates folders/topics, and reparents without deleting any source text', async () => {
    const store = await open(), original = await source()
    const [parent, duplicate] = await Promise.all([createFolder('Research'), createFolder(' research ')])
    expect(duplicate.id).toBe(parent.id)
    const child = await createFolder('Articles', parent.id), nested = await createFolder('Nested', child.id)
    await updateReadingItem(original.source.id, { folderId: child.id, favorite: true })
    const topic = await createTopic('Storage')
    expect((await createTopic(' storage ')).id).toBe(topic.id)
    await assignTopics(original.source.id, [topic.id, topic.id])
    await renameFolder(parent.id, 'My research'); await updateTopic(topic.id, { name: 'Local storage' })
    await deleteFolder(child.id)
    expect(useReading.getState().folders.find((row) => row.id === child.id)?.deletedAt).toBeTypeOf('number')
    expect(useReading.getState().folders.find((row) => row.id === nested.id)?.parentId).toBe(parent.id)
    expect(useReading.getState().items[0]).toMatchObject({ folderId: parent.id, favorite: true, topicIds: [topic.id], status: 'unread' })
    const corpus = await store.getKv<{ versions: { id: string; text: string }[] }>('knowledge.v1')
    expect(corpus!.versions.find((row) => row.id === original.version.id)?.text).toBe(original.version.text)
    resetReading(); await initializeReading()
    expect(useReading.getState().folders.find((row) => row.id === parent.id)?.name).toBe('My research')
  })

  it('never marks a source read merely by opening it; threshold and explicit status are deliberate', async () => {
    await open(); const entry = await source()
    expect(defaultReadingItem(entry.source.id)).toMatchObject({ status: 'unread', progress: 0, readAt: null, lastOpenedAt: null })
    await recordReadingProgress(entry.source.id, { progress: 0, position: 0 })
    expect(useReading.getState().items[0]).toMatchObject({ status: 'unread', readAt: null, lastOpenedAt: expect.any(Number) })
    await recordReadingProgress(entry.source.id, { progress: .6, position: 412 })
    expect(useReading.getState().items[0]).toMatchObject({ status: 'reading', progress: .6, position: 412, readAt: null })
    await recordReadingProgress(entry.source.id, { progress: .2, position: 50 })
    expect(useReading.getState().items[0]).toMatchObject({ status: 'reading', progress: .6, position: 50, readAt: null })
    await recordReadingProgress(entry.source.id, { progress: .9, position: 800 })
    expect(useReading.getState().items[0]).toMatchObject({ status: 'read', readAt: expect.any(Number) })
    await updateReadingItem(entry.source.id, { status: 'unread', activeReadMs: 12000, following: true })
    expect(useReading.getState().items[0]).toMatchObject({ status: 'unread', progress: 0, readAt: null, activeReadMs: 12000, following: true })
    await updateReadingItem(entry.source.id, { status: 'read' })
    expect(useReading.getState().items[0]).toMatchObject({ status: 'read', progress: 1 })
    await expect(recordReadingProgress(entry.source.id, { progress: 2 })).rejects.toThrow(/invalid/)
  })

  it('anchors highlights to exact retained version offsets, rejects forged context and keeps historical annotations', async () => {
    const store = await open(), entry = await source(), start = entry.version.text.indexOf('copper')
    const input = { sourceId: entry.source.id, versionId: entry.version.id, start, end: start + 6, quote: 'copper', prefix: 'The ', suffix: ' orchard', note: 'An exact annotation.' }
    const saved = await addHighlight(input)
    expect((await addHighlight(input)).id).toBe(saved.id)
    expect(useReading.getState().highlights).toHaveLength(1)
    await updateHighlight(saved.id, { note: 'My revised comment', color: 'blue' })
    await expect(addHighlight({ ...input, quote: 'forged' })).rejects.toThrow(/no longer matches/)
    await expect(addHighlight({ ...input, prefix: 'not this prefix' })).rejects.toThrow(/context/)
    const corpus = await store.getKv<{ sources: { id: string; currentVersionId: string }[]; versions: unknown[] }>('knowledge.v1')
    corpus!.sources.find((row) => row.id === entry.source.id)!.currentVersionId = 'new-version'
    await store.putKv('knowledge.v1', corpus)
    resetReading(); await initializeReading()
    expect(useReading.getState().highlights[0]).toMatchObject({ versionId: entry.version.id, quote: 'copper', note: 'My revised comment', color: 'blue' })
    await removeHighlight(saved.id); expect(useReading.getState().highlights).toEqual([])
  })

  it('retains notes and graph relations, validates source/topic endpoints and deduplicates reverse related edges', async () => {
    await open(); const first = await source(), second = await source('Another retained source.')
    const note = await addReadingNote(first.source.id, 'A local reading note')
    await updateReadingNote(note.id, 'Updated personal annotation')
    const topic = await createTopic('Interpretation')
    const link = await connectReading({ from: { kind: 'source', id: first.source.id }, to: { kind: 'topic', id: topic.id }, relation: 'related' })
    expect((await connectReading({ from: link.to, to: link.from, relation: 'related' })).id).toBe(link.id)
    await connectReading({ from: { kind: 'source', id: first.source.id }, to: { kind: 'source', id: second.source.id }, relation: 'supports' })
    await expect(connectReading({ from: link.from, to: link.from, relation: 'related' })).rejects.toThrow(/different/)
    await expect(connectReading({ from: link.from, to: { kind: 'topic', id: 'missing' }, relation: 'related' })).rejects.toThrow(/no longer available/)
    await expect(updateReadingItem('world-record-id-is-not-a-source', {})).rejects.toThrow(/source/)
    await disconnectReading(link.id); await removeReadingNote(note.id)
    expect(useReading.getState().notes).toEqual([]); expect(useReading.getState().connections).toHaveLength(1)
  })

  it('keeps the winning CAS revision and rolls back a failed save without pretending success', async () => {
    const store = await open(), winner: ReadingSnapshot = { ...emptyReading(), revision: 1, folders: [{ id: 'winner', name: 'Other writer', parentId: null, createdAt: 1 }] }
    store.compareAndSwapKv = async () => { await store.putKv(READING_KV, winner); return false }
    await expect(createFolder('Losing folder')).rejects.toThrow(/no newer changes were overwritten/)
    expect(await store.getKv(READING_KV)).toEqual(winner)
    expect(useReading.getState().folders.map((row) => row.name)).toEqual(['Other writer'])
    expect(useReading.getState().busy).toBe(false); expect(useReading.getState().error).toContain('no newer changes')
  })

  it('refuses corrupted data and read-only writes without replacing the retained snapshot', async () => {
    const store = await open(), corrupt = { ...emptyReading(), schemaVersion: 99 }
    await store.putKv(READING_KV, corrupt)
    await expect(refreshReading()).rejects.toThrow(/unsupported format/)
    await expect(createTopic('Must not overwrite corruption')).rejects.toThrow(/unsupported format/)
    expect(await store.getKv(READING_KV)).toEqual(corrupt)
    await store.putKv(READING_KV, emptyReading()); await refreshReading()
    useRepoStatus.setState({ writer: false })
    await expect(createFolder('Read only')).rejects.toThrow(/read only/)
    expect(await store.getKv(READING_KV)).toEqual(emptyReading())
    expect(() => decodeReading({ ...emptyReading(), folders: [{ id: 'cycle', name: 'Cycle', parentId: 'cycle', createdAt: 0 }] })).toThrow(/unsupported/)
  })

  it('prevents queued work and late reads from leaking across an account/store switch', async () => {
    const previous = await open(); await createFolder('Previous account')
    const read = previous.getKv.bind(previous); let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    previous.getKv = async <T>(key: string) => { if (key === READING_KV) await gate; return read<T>(key) }
    const stale = createFolder('Must not enter the new account'); void stale.catch(() => {})
    await closeRepo(); const next = await open()
    await createFolder('Next account only')
    release(); await expect(stale).rejects.toThrow(/workspace changed/)
    expect(useReading.getState().folders.map((row) => row.name)).toEqual(['Next account only'])
    expect((await next.getKv<ReadingSnapshot>(READING_KV))!.folders.map((row) => row.name)).toEqual(['Next account only'])
    expect((await read<ReadingSnapshot>(READING_KV))!.folders.map((row) => row.name)).toEqual(['Previous account'])
  })

  it('refreshes remote changes and clears state after wiping the same store', async () => {
    const store = await open(), incoming = { ...emptyReading(), revision: 1, topics: [{ id: 'remote', name: 'Remote retained topic', createdAt: 1 }] }
    const activeStore = getStore()
    await store.putKv(READING_KV, incoming)
    await handleRemoteChange({ type: 'kv', keys: [READING_KV] })
    await vi.waitFor(() => expect(useReading.getState().topics).toEqual(incoming.topics))
    await wipeWorld({ confirm: true })
    await vi.waitFor(() => expect(useReading.getState().topics).toEqual([]))
    expect(getStore()).toBe(activeStore)
  })

  it('rejects pending writes across a replacement generation even when the store object is reused', async () => {
    const store = await open(), read = store.getKv.bind(store)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    store.getKv = async <T>(key: string) => { if (key === READING_KV) await gate; return read<T>(key) }
    const stale = createTopic('Must not reappear after wipe'); void stale.catch(() => {})
    await wipeWorld({ confirm: true })
    await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
    release(); await expect(stale).rejects.toThrow(/workspace changed/)
    await refreshReading()
    expect(useReading.getState().topics).toEqual([])
    expect(await read(READING_KV)).toBeUndefined()
  })

  it('round-trips folders, exact highlight comments, notes, progress and graph through a portable archive', async () => {
    const store = await open(), entry = await source(), folder = await createFolder('Portable archive'), topic = await createTopic('Recovered topic')
    await updateReadingItem(entry.source.id, { folderId: folder.id, favorite: true, topicIds: [topic.id], following: true })
    await recordReadingProgress(entry.source.id, { progress: .5, position: 321 })
    const start = entry.version.text.indexOf('copper')
    await addHighlight({ sourceId: entry.source.id, versionId: entry.version.id, start, end: start + 6, quote: 'copper', note: 'Keep this exact comment.' })
    await addReadingNote(entry.source.id, 'A portable personal note.')
    await connectReading({ from: { kind: 'source', id: entry.source.id }, to: { kind: 'topic', id: topic.id }, relation: 'builds-on' })
    const expected = await store.getKv(READING_KV), sink = bytesSink()
    await exportArchive(store, sink)
    const restored = createMemoryStore()
    await importArchive(restored, new NodeBlob([sink.bytes().slice()]), { allowWithoutBackup: true })
    expect(await restored.getKv(READING_KV)).toEqual(expected)
    await closeRepo(); await initRepo({ store: restored }); await initializeReading()
    expect(useReading.getState().highlights[0].note).toBe('Keep this exact comment.')
    expect(useReading.getState().items[0]).toMatchObject({ progress: .5, position: 321, folderId: folder.id, topicIds: [topic.id] })
  })
})
