import { File as NodeFile } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeRepo, completeFirstRun, getStore, initRepo, useRepoStatus, wipeWorld } from '../../src/data/repo.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { MAX_CRM_COMMENT_FILE_BYTES, MAX_CRM_PORTRAIT_BYTES, retainCrmCommentFiles, retainCrmPortrait } from '../../src/crm/commentMedia.ts'

const file = (text = 'A private original', name = 'original.txt') => new NodeFile([text], name, { type: 'text/plain' }) as unknown as File
beforeEach(async () => { vi.stubGlobal('crypto', webcrypto); await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: 0, start: 'empty' }) })
afterEach(async () => { await closeRepo(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('keeps exact originals under content hashes with clean display names and deduplicates identical bytes', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  const [first] = await retainCrmCommentFiles([file('A private original', '../research.txt')])
  const [second] = await retainCrmCommentFiles([file('A private original', 'renamed.md')])
  expect(first.assetId).toMatch(/^crm-file-[a-f0-9]{64}$/)
  expect(second.assetId).toBe(first.assetId)
  expect(first.name).not.toContain('/')
  expect(await (await getStore().getBlob(first.assetId))!.text()).toBe('A private original')
  expect(await getStore().listAssets()).toHaveLength(1)
  expect((await getStore().getAssetMeta(first.assetId))!.kind).toBe('file')
  expect(fetcher).not.toHaveBeenCalled()
})

it('rejects an oversized or excessive batch before storing any part of it', async () => {
  const oversized = file(); Object.defineProperty(oversized, 'size', { value: MAX_CRM_COMMENT_FILE_BYTES + 1 })
  await expect(retainCrmCommentFiles([file(), oversized])).rejects.toThrow('32 MiB')
  await expect(retainCrmCommentFiles(Array.from({ length: 9 }, () => file()))).rejects.toThrow('8 files')
  await expect(retainCrmCommentFiles([file('')])).rejects.toThrow('Empty files')
  expect(await getStore().listAssets()).toEqual([])
})

it('refuses a late file read after replacement of the same active store', async () => {
  const chosen = file(), original = await chosen.arrayBuffer(); let release: (bytes: ArrayBuffer) => void = () => {}
  const read = vi.spyOn(chosen, 'arrayBuffer').mockImplementation(() => new Promise(resolve => { release = resolve }))
  const pending = retainCrmCommentFiles([chosen]); await vi.waitFor(() => expect(read).toHaveBeenCalled())
  await wipeWorld({ confirm: true }); release(original)
  await expect(pending).rejects.toThrow('workspace changed')
  expect(await getStore().listAssets()).toEqual([])
})

it('keeps read-only windows and cancelled composer sessions from retaining new files', async () => {
  await expect(retainCrmCommentFiles([file()], { shouldWrite: () => false })).rejects.toThrow('workspace changed')
  useRepoStatus.setState({ writer: false })
  await expect(retainCrmCommentFiles([file()])).rejects.toThrow('writer window')
  expect(await getStore().listAssets()).toEqual([])
})

it('retains content-addressed raster portraits and rejects HTML, SVG, and oversized files before a profile edit', async () => {
  const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,1])
  const image = new NodeFile([png], 'portrait.png', { type: 'image/png' }) as unknown as File
  const portrait = await retainCrmPortrait(image)
  expect(portrait).toMatchObject({ assetId: expect.stringMatching(/^crm-avatar-[a-f0-9]{64}$/), name: 'portrait.png', mime: 'image/png', bytes: png.length })
  expect(new Uint8Array(await (await getStore().getBlob(portrait.assetId))!.arrayBuffer())).toEqual(png)
  expect((await getStore().getAssetMeta(portrait.assetId))!.kind).toBe('image')
  await expect(retainCrmPortrait(file('<html><script>alert(1)</script></html>', 'fake.png'))).rejects.toThrow('real PNG')
  await expect(retainCrmPortrait(file('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'fake.png'))).rejects.toThrow('HTML and SVG')
  const oversized = file(); Object.defineProperty(oversized, 'size', { value: MAX_CRM_PORTRAIT_BYTES + 1 })
  await expect(retainCrmPortrait(oversized)).rejects.toThrow('12 MiB')
  expect(await getStore().listAssets()).toHaveLength(1)
})
