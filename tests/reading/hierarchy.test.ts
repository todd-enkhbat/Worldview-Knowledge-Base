import { Blob as NodeBlob } from 'node:buffer'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeRepo, completeFirstRun, initRepo } from '../../src/data/repo.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { bytesSink, exportArchive, importArchive } from '../../src/data/archive.ts'
import { initializeKnowledge, resetKnowledge } from '../../src/knowledge/index.ts'
import { createFolder, initializeReading, resetReading, updateFolder, useReading } from '../../src/reading/store.ts'
import { folderTrail } from '../../src/reading/hierarchy.ts'

beforeEach(() => { vi.stubGlobal('Blob', NodeBlob); resetReading() })
afterEach(async () => { resetReading(); resetKnowledge(); await closeRepo(); vi.unstubAllGlobals() })
async function open() { const store = createMemoryStore(); await initRepo({ store }); await completeFirstRun({ T0: Date.UTC(1990,0,1), start: 'empty' }); await initializeKnowledge(); await initializeReading(); return store }
it('keeps mixed page types through deep nesting, reload, and moves without cycles', async () => {
  const store = await open(); let parent: string | null = null
  for (let i = 0; i < 25; i++) parent = (await createFolder('Level ' + i, parent, { kind: (['folder','section','note','concept'] as const)[i % 4], typeLabel: i === 8 ? 'Question' : '' })).id
  const folders = useReading.getState().folders
  expect(folderTrail(folders, parent)).toHaveLength(25)
  const before = await store.getKv('reading.v1')
  await expect(updateFolder(folders[0].id, { parentId: parent })).rejects.toThrow('descendants')
  expect(await store.getKv('reading.v1')).toEqual(before)
  await updateFolder(parent!, { parentId: folders[1].id, description: 'A nested concept page.' })
  resetReading(); await initializeReading()
  expect(folderTrail(useReading.getState().folders, parent)).toHaveLength(3)
  expect(useReading.getState().folders.at(-1)?.description).toBe('A nested concept page.')
})
it('rejects invalid appearance and same-level name collisions atomically', async () => {
  const store = await open(), first = await createFolder('Books'), other = await createFolder('Elsewhere'), child = await createFolder('Books', other.id)
  const before = await store.getKv('reading.v1')
  await expect(updateFolder(child.id, { parentId: null })).rejects.toThrow('already exists')
  await expect(updateFolder(first.id, { coverPosition: 101 })).rejects.toThrow('invalid')
  await expect(updateFolder(first.id, { coverAssetId: 'https://evil.test/image.svg' })).rejects.toThrow('invalid')
  expect(await store.getKv('reading.v1')).toEqual(before)
})
it('exports and restores custom folder imagery, text and positioning with original bytes', async () => {
  const store = await open(), bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'))
  const id = 'writing-' + createHash('sha256').update(bytes).digest('hex')
  await store.putBlob({ meta: { id, kind: 'image', mime: 'image/png', bytes: bytes.length, createdAt: Date.now(), nodeId: null }, data: bytes })
  const page = await createFolder('My books', null, { kind: 'section', coverAssetId: id, iconAssetId: id, coverPosition: 72, description: 'Reading and questions.' })
  const sink = bytesSink(); await exportArchive(store, sink)
  await importArchive(store, new Blob([sink.bytes().slice().buffer]), { allowWithoutBackup: true })
  resetReading(); await initializeReading()
  expect(useReading.getState().folders.find(folder => folder.id === page.id)).toMatchObject({ coverAssetId: id, iconAssetId: id, coverPosition: 72, kind: 'section', description: 'Reading and questions.' })
  expect(new Uint8Array(await (await store.getBlob(id))!.arrayBuffer())).toEqual(bytes)
})
it('connects concept pages and notes filed beneath them to existing topic views', async () => {
  await open()
  const { captureThought, useKnowledge } = await import('../../src/knowledge/index.ts')
  const { updateReadingItem } = await import('../../src/reading/store.ts')
  await captureThought('The relationship between agency and fortune.')
  const source = useKnowledge.getState().sources.at(-1)!
  const concept = await createFolder('Virtù', null, { kind: 'concept' })
  const child = await createFolder('Questions', concept.id, { kind: 'section' })
  await updateReadingItem(source.id, { folderId: child.id })
  expect(useReading.getState().topics.find(topic => topic.id === concept.linkedTopicId)?.name).toBe('Virtù')
  expect(useReading.getState().items.find(item => item.sourceId === source.id)?.topicIds).toContain(concept.linkedTopicId)
  await updateFolder(concept.id, { name: 'Agency and fortune' })
  expect(useReading.getState().topics.find(topic => topic.id === concept.linkedTopicId)?.name).toBe('Agency and fortune')
})
