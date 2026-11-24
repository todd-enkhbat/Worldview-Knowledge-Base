import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, initRepo } from '../../src/data/repo.ts'
import { initializeKnowledge, resetKnowledge } from '../../src/knowledge/index.ts'
import { archiveWritingDocument, createWritingDocument, initializeWriting, publishWritingDocument, resetWriting, restoreWritingPublishedVersion, restoreWritingRevision, saveWritingSnapshot, updateWritingDocument, useWriting, writingFromPlainText } from '../../src/writing/store.ts'
import { decodeWritingHistory, readWritingHistory, WRITING_HISTORY_KV } from '../../src/writing/history.ts'
import { referencedWorldAssets, readWorldSnapshot } from '../../src/data/worldSnapshot.ts'
import { bytesSink, exportArchive, importArchive } from '../../src/data/archive.ts'

beforeEach(async () => { resetWriting(); resetKnowledge(); vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Cloud calls are disabled') })); await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' }); await initializeKnowledge(); await initializeWriting() })
afterEach(async () => { resetWriting(); resetKnowledge(); await closeRepo(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('retains an earlier draft automatically, throttles checkpoints, and restores a named milestone without losing the current draft', async () => {
  const doc = await createWritingDocument({ title: 'Opening', content: writingFromPlainText('First idea'), topicIds: ['tag:thermodynamics'] })
  const edited = await updateWritingDocument(doc.id, { content: writingFromPlainText('A second idea') }, { expectedUpdatedAt: doc.updatedAt })
  expect((await readWritingHistory()).entries).toHaveLength(1)
  const snapshot = await saveWritingSnapshot(doc.id, 'The argument')
  const latest = await updateWritingDocument(doc.id, { title: 'A later title', content: writingFromPlainText('Third idea'), topicIds: [] })
  expect((await readWritingHistory()).entries).toHaveLength(2)
  const restored = await restoreWritingRevision(doc.id, snapshot!.id, latest.updatedAt)
  expect(restored.content).toEqual(edited.content); expect(restored.title).toBe('Opening'); expect(restored.topicIds).toEqual(['tag:thermodynamics'])
  const history = await readWritingHistory()
  expect(history.entries.at(-1)).toMatchObject({ kind: 'restore', document: { title: 'A later title', content: latest.content } })
  expect(restored.updatedAt).toBeGreaterThan(latest.updatedAt)
  await expect(restoreWritingRevision(doc.id, snapshot!.id, latest.updatedAt)).rejects.toThrow(/changed/)
  expect(fetch).not.toHaveBeenCalled(); expect(await getStore().listNodes()).toEqual([])
})

it('restores published rich writing into its own draft and keeps the old publication immutable', async () => {
  const doc = await createWritingDocument({ title: 'Published essay', content: writingFromPlainText('Evidence from the first draft'), appearance: { background: 'waves' } })
  const publication = await publishWritingDocument(doc.id)
  const later = await updateWritingDocument(doc.id, { content: writingFromPlainText('A changed ending'), appearance: { background: 'dots' } })
  const restored = await restoreWritingPublishedVersion(doc.id, publication.versionId, later.updatedAt)
  expect(restored.sourceId).toBe(publication.sourceId); expect(restored.content).toEqual(doc.content); expect(restored.appearance.background).toBe('waves')
  expect(await publishWritingDocument(doc.id)).toEqual(publication)
  expect((await readWritingHistory()).entries.some((entry) => entry.kind === 'restore' && entry.document.appearance.background === 'dots')).toBe(true)
})

it('moves drafts to recoverable Trash and restores the same identity, rich text, topics, and history after reopening', async () => {
  const doc = await createWritingDocument({ title: 'Keep this', content: writingFromPlainText('Not permanently deleted'), topicIds: ['topic-one'] })
  await saveWritingSnapshot(doc.id, 'Before filing')
  await archiveWritingDocument(doc.id)
  resetWriting(); await initializeWriting()
  expect(useWriting.getState().docs[0].archivedAt).toBeTypeOf('number')
  const restored = await archiveWritingDocument(doc.id, false)
  expect(restored).toMatchObject({ id: doc.id, archivedAt: null, topicIds: ['topic-one'], content: doc.content })
  expect((await readWritingHistory()).entries.some((entry) => entry.label === 'Before filing')).toBe(true)
})

it('round trips snapshot-only media with the portable world even after the live draft removes it', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])
  const { writingMediaHash } = await import('../../src/writing/media.ts')
  const id = `writing-${await writingMediaHash(bytes)}`
  await getStore().putBlob({ meta: { id, kind: 'image', mime: 'image/png', bytes: bytes.byteLength, createdAt: Date.now(), nodeId: null }, data: bytes })
  const doc = await createWritingDocument({ title: 'Illustrated milestone', content: { type: 'doc', content: [{ type: 'writingMedia', attrs: { assetId: id, kind: 'image', mime: 'image/png', name: 'retained.png', width: 'normal' } }] } })
  await saveWritingSnapshot(doc.id, 'Keep the original image')
  await updateWritingDocument(doc.id, { content: writingFromPlainText('The new draft has no image') })
  expect(referencedWorldAssets(await readWorldSnapshot(getStore())).has(id)).toBe(true)
  const sink = bytesSink(); await exportArchive(getStore(), sink); const bundle = sink.bytes()
  await importArchive(getStore(), new NodeBlob([new Uint8Array(bundle).buffer]) as unknown as Blob, { allowWithoutBackup: true })
  expect(new Uint8Array(await (await getStore().getBlob(id))!.arrayBuffer())).toEqual(bytes)
  expect((await readWritingHistory()).entries.find((entry) => entry.label === 'Keep the original image')?.document.content).toEqual(doc.content)
})

it('rejects corrupt or stale history rather than overwriting retained snapshots', async () => {
  expect(() => decodeWritingHistory({ schemaVersion: 1, revision: 0, entries: [{ id: 'x' }] })).toThrow(/history/)
  const doc = await createWritingDocument({ content: writingFromPlainText('Safe current draft') })
  await getStore().putKv(WRITING_HISTORY_KV, { schemaVersion: 9, revision: 3, entries: [] })
  await expect(updateWritingDocument(doc.id, { title: 'Do not overwrite' })).rejects.toThrow(/history/)
  expect(useWriting.getState().docs[0].title).toBe(doc.title)
  expect(await getStore().getKv(WRITING_HISTORY_KV)).toMatchObject({ schemaVersion: 9, revision: 3 })
})
