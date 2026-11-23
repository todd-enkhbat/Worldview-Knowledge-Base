import { describe, expect, it, vi } from 'vitest'
import { DIRECTORY_BUNDLE_FORMAT, exportDirectoryBundle, readDirectoryBundle, restoreDirectoryBundle } from '../../src/data/directoryBundle.ts'
import type { BundleReader, BundleWriter, DirectoryBundleManifest } from '../../src/data/directoryBundle.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { defaultSettings } from '../../src/data/repo.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { hashBytes, hashRecords } from '../../src/data/hash.ts'
import { IMPORT_MARKER_KV, WORLD_KV_KEYS } from '../../src/data/archive.ts'
import type { WorldStore } from '../../src/data/WorldStore.ts'

function directory() {
  const files = new Map<string, Uint8Array<ArrayBuffer>>()
  const writer: BundleWriter = {
    async exists(path) { return files.has(path) },
    async write(path, data) { files.set(path, data.slice()) },
    async remove(path) { files.delete(path) },
  }
  const reader: BundleReader = { async read(path) { const bytes = files.get(path); if (!bytes) throw new Error(`Missing ${path}`); return new Blob([bytes]) } }
  return { files, writer, reader }
}

async function populate(store: WorldStore) {
  const now = Date.now()
  await store.putSettings(defaultSettings(Date.UTC(1990, 0, 1), now))
  const live = makeNodeDraft('document', { title: 'A retained source', contentMd: 'The original text includes astronomy and thermal evidence.', temporalOrigin: Date.UTC(2020, 0, 1) }, { now })
  const trash = makeNodeDraft('idea', { title: 'A trashed thought', deletedAt: now, temporalOrigin: Date.UTC(2020, 0, 2) }, { now })
  const excluded = makeNodeDraft('memory', { title: 'An excluded memory', corpusExcluded: true, temporalOrigin: Date.UTC(2020, 0, 3), fieldAnchorXZ: [22, 33] }, { now })
  live.links.push({ targetId: excluded.id, kind: 'relates', createdAt: now, label: 'A saved explanation' })
  Object.assign(live, { futureExtension: { preserve: true, version: 7 } })
  const media = Uint8Array.from({ length: 73 }, (_, index) => index % 256)
  await store.putBlob({ meta: { id: 'media-original', kind: 'file', mime: 'video/mp4', bytes: media.byteLength, createdAt: now, nodeId: live.id }, data: media })
  await store.putBlob({ meta: { id: 'empty-original', kind: 'file', mime: 'application/octet-stream', bytes: 0, createdAt: now, nodeId: null }, data: new Uint8Array() })
  live.attachments.push({ id: crypto.randomUUID(), name: 'recording.mp4', kind: 'file', mime: 'video/mp4', bytes: media.byteLength, blobId: 'media-original', createdAt: now })
  await store.putNodes([live, trash, excluded])
  await store.appendEvent({ id: crypto.randomUUID(), t: now, kind: 'inspect', nodeId: live.id })
  await store.putKv('chat.v1', { history: [{ role: 'user', content: 'My full conversation' }], cards: { pending: [{ status: 'open' }] } })
  await store.putKv('knowledge.v1', { schemaVersion: 1, revision: 1, sources: [], versions: [], passages: [], imports: [], proposals: [], jobs: [] })
  await store.putKv('workspace.v1', { query: 'astronomy', sourceIds: ['source-1'], scrollPosition: 73 })
  await store.putKv('ai.usage', { tokens: 5 })
  await store.putKv('overlay.landauerPaid', 19)
  return { live, trash, excluded, media }
}

async function rewriteEntry(bundle: ReturnType<typeof directory>, manifest: DirectoryBundleManifest, path: string, text: string) {
  const entry = manifest.entries.find((entry) => entry.path === path)!
  const bytes = new TextEncoder().encode(text)
  const prefix = entry.parts[0]?.path.split('/').slice(0, 2).join('/') ?? manifest.entries.flatMap((e) => e.parts)[0].path.split('/').slice(0, 2).join('/')
  entry.parts = []
  entry.bytes = bytes.length
  for (let offset = 0, index = 0; offset < bytes.length; offset += manifest.chunkBytes, index++) {
    const data = bytes.slice(offset, offset + manifest.chunkBytes)
    const partPath = `${prefix}/${String(99000000 + index).padStart(8, '0')}.bin`
    bundle.files.set(partPath, data)
    entry.parts.push({ path: partPath, bytes: data.length, sha256: await hashBytes(data) })
  }
  bundle.files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
}

describe('segmented directory bundles', () => {
  it('restores full world state, unknown extensions, pins, trash and segmented original bytes into a fresh store', async () => {
    const source = createMemoryStore()
    const { media } = await populate(source)
    const bundle = directory()
    const manifest = await exportDirectoryBundle(source, bundle.writer, { chunkBytes: 16 })
    expect(manifest.format).toBe(DIRECTORY_BUNDLE_FORMAT)
    expect(manifest.counts).toMatchObject({ nodes: 3, live: 1, trash: 1, excluded: 1, assets: 2, assetBytes: 73, worldKv: 5 })
    const original = manifest.entries.find((entry) => entry.path === 'assets/media-original')!
    expect(original.parts.map((part) => part.bytes)).toEqual([16, 16, 16, 16, 9])
    expect(manifest.entries.flatMap((entry) => entry.parts).every((part) => part.bytes <= 16)).toBe(true)
    const parsed = await readDirectoryBundle(bundle.reader)
    expect(await hashRecords(parsed.nodes)).toBe(await hashRecords(await source.listNodes()))
    const target = createMemoryStore()
    await target.putKv('autoBackupDir', { device: 'keep this handle' })
    const restored = await restoreDirectoryBundle(target, bundle.reader)
    expect(restored.nodes).toBe(3)
    expect(await target.listNodes()).toEqual(await source.listNodes())
    expect(await target.listEvents()).toEqual(await source.listEvents())
    expect(await target.listAssets()).toEqual(await source.listAssets())
    for (const key of WORLD_KV_KEYS) expect(await target.getKv(key)).toEqual(await source.getKv(key))
    expect(await target.getKv('autoBackupDir')).toEqual({ device: 'keep this handle' })
    expect(await target.getKv(IMPORT_MARKER_KV)).toBeUndefined()
    expect(new Uint8Array(await (await target.getBlob('media-original'))!.arrayBuffer())).toEqual(media)
    expect((await target.getBlob('empty-original'))?.size).toBe(0)
  })

  it('rejects corrupted pieces, unsafe paths and invalid schema before invoking any mutation', async () => {
    const source = createMemoryStore()
    await populate(source)
    const bundle = directory()
    const manifest = await exportDirectoryBundle(source, bundle.writer, { chunkBytes: 512 })
    const part = manifest.entries[0].parts[0]
    const original = bundle.files.get(part.path)!
    bundle.files.set(part.path, Uint8Array.from(original, (byte, index) => index ? byte : byte ^ 1))
    const target = createMemoryStore()
    const writes = vi.spyOn(target, 'putKv')
    await expect(restoreDirectoryBundle(target, bundle.reader)).rejects.toThrow(/SHA-256/)
    expect(writes).not.toHaveBeenCalled()
    bundle.files.set(part.path, original)
    const unsafe = structuredClone(manifest)
    unsafe.entries[0].parts[0].path = '../outside-the-directory'
    bundle.files.set('manifest.json', new TextEncoder().encode(JSON.stringify(unsafe)))
    await expect(restoreDirectoryBundle(target, bundle.reader)).rejects.toThrow(/unsafe|Invalid/)
    expect(writes).not.toHaveBeenCalled()
    bundle.files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
    const nodes = await source.listNodes()
    Object.assign(nodes[0], { visibility: 'invalid-visibility' })
    await rewriteEntry(bundle, manifest, 'nodes.jsonl', nodes.map((node) => JSON.stringify(node)).join('\n'))
    await expect(restoreDirectoryBundle(target, bundle.reader)).rejects.toThrow(/visibility/)
    expect(writes).not.toHaveBeenCalled()
  })

  it('never publishes a completed manifest after missing originals or failed part writes', async () => {
    const source = createMemoryStore()
    await populate(source)
    const missing = directory()
    vi.spyOn(source, 'getBlob').mockResolvedValueOnce(undefined)
    await expect(exportDirectoryBundle(source, missing.writer, { chunkBytes: 64 })).rejects.toThrow(/missing|wrong byte/)
    expect(missing.files.has('manifest.json')).toBe(false)
    const broken = directory()
    const write = broken.writer.write
    let writes = 0
    broken.writer.write = async (path, bytes) => { if (++writes === 3) throw new Error('disk full'); await write(path, bytes) }
    await expect(exportDirectoryBundle(source, broken.writer, { chunkBytes: 64 })).rejects.toThrow('disk full')
    expect(broken.files.has('manifest.json')).toBe(false)
  })

  it('rejects orphaned attachment metadata and refuses overwriting an existing completed backup', async () => {
    const source = createMemoryStore()
    const { live } = await populate(source)
    await source.deleteBlob('media-original')
    await expect(exportDirectoryBundle(source, directory().writer)).rejects.toThrow(/missing original/)
    live.attachments = []
    await source.putNode(live)
    const bundle = directory()
    await exportDirectoryBundle(source, bundle.writer)
    const old = bundle.files.get('manifest.json')!
    await expect(exportDirectoryBundle(source, bundle.writer)).rejects.toThrow(/already contains/)
    expect(bundle.files.get('manifest.json')).toEqual(old)
  })

  it('requires explicit replacement and an independently verified matching backup before reset', async () => {
    const source = createMemoryStore()
    await populate(source)
    const incoming = directory()
    await exportDirectoryBundle(source, incoming.writer, { chunkBytes: 256 })
    const target = createMemoryStore()
    await target.putKv('workspace.v1', { existing: true })
    const reset = vi.spyOn(target, 'resetWithKv')
    await expect(restoreDirectoryBundle(target, incoming.reader)).rejects.toThrow(/empty workspace/)
    await expect(restoreDirectoryBundle(target, incoming.reader, { replace: true })).rejects.toThrow(/verified backup/)
    expect(reset).not.toHaveBeenCalled()
    const invalidBackup = directory()
    await expect(restoreDirectoryBundle(target, incoming.reader, { replace: true, backup: async () => ({ name: 'bad', reader: invalidBackup.reader }) })).rejects.toThrow(/could not be verified/)
    expect(reset).not.toHaveBeenCalled()
    const previous = directory()
    const restored = await restoreDirectoryBundle(target, incoming.reader, { replace: true, backup: async () => { await exportDirectoryBundle(target, previous.writer); return { name: 'previous-workspace', reader: previous.reader } } })
    expect(restored.backupName).toBe('previous-workspace')
    expect(reset).toHaveBeenCalledOnce()
    expect((await readDirectoryBundle(previous.reader)).kv['workspace.v1']).toEqual({ existing: true })
    expect(await target.getKv('workspace.v1')).toEqual(await source.getKv('workspace.v1'))
  })

  it('retains the interrupted-import marker and verified backup when writing a replacement fails', async () => {
    const source = createMemoryStore()
    await populate(source)
    const incoming = directory()
    await exportDirectoryBundle(source, incoming.writer, { chunkBytes: 256 })
    const target = createMemoryStore()
    await target.putKv('workspace.v1', { existing: true })
    const prior = directory()
    vi.spyOn(target, 'putNodes').mockRejectedValueOnce(new Error('Interrupted database write'))
    await expect(restoreDirectoryBundle(target, incoming.reader, { replace: true, backup: async () => { await exportDirectoryBundle(target, prior.writer); return { name: 'previous-workspace', reader: prior.reader } } })).rejects.toThrow(/Restore was interrupted/)
    expect(await target.getKv(IMPORT_MARKER_KV)).toMatchObject({ backupName: 'previous-workspace', backupKind: 'directory' })
    expect((await readDirectoryBundle(prior.reader)).kv['workspace.v1']).toEqual({ existing: true })
  })

  it('fails visibly for a missing source original while allowing an explicitly purged original', async () => {
    const source = createMemoryStore()
    await source.putKv('knowledge.v1', { schemaVersion: 1, revision: 1, versions: [{ id: 'version-1', originalBlobId: 'missing-original' }] })
    const bundle = directory()
    await expect(exportDirectoryBundle(source, bundle.writer)).rejects.toThrow(/missing original/)
    expect(bundle.files.has('manifest.json')).toBe(false)
    await source.putKv('knowledge.v1', { schemaVersion: 1, revision: 2, versions: [{ id: 'version-1', originalBlobId: 'missing-original', originalPurged: true }] })
    await exportDirectoryBundle(source, bundle.writer, { chunkBytes: 128 })
    expect((await readDirectoryBundle(bundle.reader)).kv['knowledge.v1']).toEqual(await source.getKv('knowledge.v1'))
  })

  it('rejects a valid but mismatched backup before replacing the current workspace', async () => {
    const source = createMemoryStore()
    await populate(source)
    const incoming = directory()
    await exportDirectoryBundle(source, incoming.writer, { chunkBytes: 256 })
    const target = createMemoryStore()
    await target.putKv('workspace.v1', { query: 'the actual current context' })
    const unrelated = createMemoryStore()
    await unrelated.putKv('workspace.v1', { query: 'a different context with identical metadata counts' })
    const wrong = directory()
    await exportDirectoryBundle(unrelated, wrong.writer)
    const reset = vi.spyOn(target, 'resetWithKv')
    await expect(restoreDirectoryBundle(target, incoming.reader, { replace: true, backup: async () => ({ name: 'wrong-workspace', reader: wrong.reader }) })).rejects.toThrow(/could not be verified/)
    expect(reset).not.toHaveBeenCalled()
    expect(await target.getKv('workspace.v1')).toEqual({ query: 'the actual current context' })
  })
})
