import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import 'fake-indexeddb/auto'
import { unzipSync, zipSync } from 'fflate'
import { createHttpStore } from '../../src/data/httpStore.ts'
import { withSync } from '../../src/data/locks.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { openIdbStore } from '../../src/data/idbStore.ts'
import { blobSink, exportArchive, importArchive, readArchive, type BackupTarget } from '../../src/data/archive.ts'
import { exportDirectoryBundle, readDirectoryBundle, restoreDirectoryBundle, type BundleReader, type BundleWriter } from '../../src/data/directoryBundle.ts'
import { readWorldSnapshot } from '../../src/data/worldSnapshot.ts'
import { WorldStateConflictError } from '../../src/data/worldState.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { hashBytes } from '../../src/data/hash.ts'
import { SCHEMA_VERSION } from '../../src/domain/types.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import { startTestEngine } from '../helpers/engine.ts'

const ledger = (revision: number): KnowledgeSnapshot => ({ schemaVersion: 1, revision, sources: [], versions: [], passages: [], imports: [], proposals: [], jobs: [] })

function bundleFiles(): BundleWriter & BundleReader {
  const files = new Map<string, Blob>()
  return {
    exists: async (path) => files.has(path),
    async write(path, data) { files.set(path, new Blob([data.slice()])) },
    async remove(path) { files.delete(path) },
    async read(path) { const file = files.get(path); if (!file) throw new Error(`Missing ${path}`); return file },
  }
}

describe('point-in-time world backup reads', () => {
  it.each(['archive', 'directory', 'empty directory'])('refuses %s replacement when folder capture commits after backup and before reset', async (format) => {
    const engine = await startTestEngine()
    const source = createMemoryStore()
    const settings = { T0: Date.UTC(2000, 0, 1), yPerYear: 12, stepsPerYear: 600, physicsSeed: 123, qualityTier: 'auto' as const, firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: Date.now(), schemaVersion: SCHEMA_VERSION }
    await source.putSettings(settings)
    const incoming = makeNodeDraft('document', { title: 'Incoming replacement' })
    await source.putNode(incoming)
    const archive = blobSink()
    await exportArchive(source, archive)
    const files = bundleFiles()
    await exportDirectoryBundle(source, files)
    const empty = format === 'empty directory'
    const before = makeNodeDraft('document', { title: 'Before capture', temporalOrigin: Date.UTC(2026, 0, 1), anchorXZ: [40, 20] })
    if (!empty) {
      engine.db.putSettings(settings)
      engine.db.putNodes([before])
      engine.db.putKv('knowledge.v1', ledger(1))
    }
    const original = new TextEncoder().encode('The newly captured original must survive.')
    const meta = { id: 'late-original', kind: 'file' as const, mime: 'text/plain', bytes: original.length, createdAt: Date.now(), nodeId: before.id }
    const next = { ...before, title: 'After capture', updatedAt: before.updatedAt + 1, attachments: [{ id: 'late-attachment', kind: 'file' as const, name: 'late.txt', mime: meta.mime, bytes: meta.bytes, blobId: meta.id, createdAt: meta.createdAt }] }
    let resets = 0
    const store = createHttpStore({ base: engine.base, fetch: async (input, init) => {
      if (String(input).endsWith('/world/reset')) {
        resets++
        expect(resets).toBe(1)
        expect(JSON.parse(String(init?.body))).toMatchObject({ expectedKnowledgeRevision: empty ? 0 : 1 })
        writeFileSync(join(engine.blobDir, meta.id), original)
        expect(engine.db.compareAndSwapKnowledge(ledger(empty ? 1 : 2), empty ? 0 : 1, [next], { [before.id]: empty ? null : before.updatedAt }, [meta])).toBe(true)
      }
      return fetch(input, init)
    } })
    const backups = new Map<string, Blob>()
    const backup: BackupTarget = {
      async write(name, fill) { const sink = blobSink(); await fill(sink); backups.set(name, sink.blob()) },
      async prune() {},
      async read(name) { return backups.get(name) },
    }
    const restoring = format === 'archive'
      ? importArchive(store, archive.blob(), { backup })
      : restoreDirectoryBundle(store, files, { replace: true, backup: async () => { const reader = bundleFiles(); await exportDirectoryBundle(store, reader); return { name: 'before', reader } } })
    await expect(restoring).rejects.toBeInstanceOf(WorldStateConflictError)
    expect(resets).toBe(1)
    expect(await store.getKv('importInProgress')).toBeUndefined()
    expect(await store.getKv('knowledge.v1')).toMatchObject({ revision: empty ? 1 : 2 })
    expect((await store.getNode(before.id))?.title).toBe('After capture')
    expect(await store.getNode(incoming.id)).toBeUndefined()
    expect(await (await store.getBlob(meta.id))?.text()).toBe(new TextDecoder().decode(original))
    store.close()
  })

  it.each(['memory', 'indexeddb'])('checks the reset revision inside the %s mutation before clearing anything', async (kind) => {
    const store = kind === 'memory' ? createMemoryStore() : await openIdbStore({ name: `guarded-reset-${crypto.randomUUID()}`, opfsRoot: null })
    try {
      const node = makeNodeDraft('document', { title: 'Latest capture' })
      await store.putNode(node)
      await store.putKv('knowledge.v1', ledger(1))
      await expect(store.resetWithKv('importInProgress', { startedAt: Date.now() }, [], 0)).rejects.toBeInstanceOf(WorldStateConflictError)
      expect((await store.getNode(node.id))?.title).toBe('Latest capture')
      expect(await store.getKv('importInProgress')).toBeUndefined()
      await store.resetWithKv('importInProgress', { startedAt: Date.now() }, [], 1)
      expect(await store.getNode(node.id)).toBeUndefined()
      expect(await store.getKv('importInProgress')).toBeDefined()
    } finally { store.close() }
  })

  it.each(['archive', 'directory'])('keeps %s metadata consistent when a watcher commits immediately after the HTTP snapshot response', async (format) => {
    const engine = await startTestEngine()
    engine.db.putSettings({ T0: Date.UTC(2000, 0, 1), yPerYear: 12, stepsPerYear: 600, physicsSeed: 123, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: Date.now(), schemaVersion: SCHEMA_VERSION })
    const before = makeNodeDraft('document', { title: 'Before capture', contentMd: 'The version being backed up.', temporalOrigin: Date.UTC(2026, 0, 1), anchorXZ: [40, 20] })
    engine.db.putNodes([before])
    engine.db.putKv('knowledge.v1', ledger(1))
    const requests: string[] = []
    let committed = false
    const http = createHttpStore({ base: engine.base, fetch: async (input, init) => {
      const path = String(input)
      requests.push(path)
      const response = await fetch(input, init)
      if (path.endsWith('/world/snapshot') && !committed) {
        committed = true
        const next = { ...before, title: 'After capture', contentMd: 'A newer background version.', updatedAt: before.updatedAt + 1 }
        expect(engine.db.compareAndSwapKnowledge(ledger(2), 1, [next], { [before.id]: before.updatedAt })).toBe(true)
      }
      return response
    } })
    const store = withSync(http, { sync: null, canWrite: () => true })
    let result: { nodes: { title: string }[]; kv: Record<string, unknown> }
    if (format === 'archive') {
      const sink = blobSink()
      await exportArchive(store, sink)
      result = await readArchive(sink.blob())
    } else {
      const files = bundleFiles()
      await exportDirectoryBundle(store, files, { chunkBytes: 2048 })
      result = await readDirectoryBundle(files)
    }
    expect(result.nodes[0].title).toBe('Before capture')
    expect(result.kv['knowledge.v1']).toMatchObject({ revision: 1 })
    expect(engine.db.getNode(before.id)?.title).toBe('After capture')
    expect(engine.db.getKv('knowledge.v1')).toMatchObject({ revision: 2 })
    expect(requests).toEqual([`${engine.base}/world/snapshot`])
    store.close()
  })

  it('copies memory metadata atomically and refuses portable snapshots of device-only keys', async () => {
    const store = createMemoryStore()
    const before = makeNodeDraft('idea', { title: 'Old state' })
    await store.putNode(before)
    await store.putKv('knowledge.v1', ledger(1))
    const pending = readWorldSnapshot(store)
    await store.putNode({ ...before, title: 'New state' })
    await store.putKv('knowledge.v1', ledger(2))
    const snapshot = await pending
    expect(snapshot.nodes[0].title).toBe('Old state')
    expect(snapshot.kv['knowledge.v1']).toMatchObject({ revision: 1 })
    snapshot.nodes[0].title = 'An isolated copy'
    expect((await store.getNode(before.id))?.title).toBe('New state')
    await expect(readWorldSnapshot(store, ['autoBackupDir'])).rejects.toThrow(/portable/)
  })

  it('does not complete an archive when a referenced original is unavailable', async () => {
    const store = createMemoryStore()
    const node = makeNodeDraft('document', { title: 'A retained original', attachments: [{ id: 'attachment', kind: 'file', name: 'original.txt', mime: 'text/plain', bytes: 3, blobId: 'missing-original', createdAt: Date.now() }] })
    await store.putNode(node)
    await expect(exportArchive(store, blobSink())).rejects.toThrow(/Referenced original/)
  })

  it.each(['archive', 'directory'])('retains a %s voice original before any transcript source exists', async (format) => {
    const store = createMemoryStore(), restored = createMemoryStore()
    const bytes = new TextEncoder().encode('original voice bytes'), hash = await hashBytes(bytes), blobId = `voice-${hash}`
    const receipt = { schemaVersion: 1, revision: 1, entries: [{ id: 'voice', blobId, hash, bytes: bytes.length, status: 'captured' }] }
    await store.putKv('voiceInbox.v1', receipt)
    const files = bundleFiles()
    if (format === 'archive') await expect(exportArchive(store, blobSink())).rejects.toThrow(/Referenced original/)
    else await expect(exportDirectoryBundle(store, files)).rejects.toThrow(/original/)
    await store.putBlob({ meta: { id: blobId, kind: 'file', bytes: bytes.length, mime: 'audio/webm', createdAt: 1, nodeId: null }, data: bytes })
    if (format === 'archive') {
      const sink = blobSink(); await exportArchive(store, sink)
      await importArchive(restored, sink.blob(), { allowWithoutBackup: true })
    } else {
      const retained = bundleFiles(); await exportDirectoryBundle(store, retained)
      await restoreDirectoryBundle(restored, retained)
    }
    expect(await restored.getKv('voiceInbox.v1')).toEqual(receipt)
    expect(await (await restored.getBlob(blobId))?.text()).toBe('original voice bytes')
    store.close(); restored.close()
  })

  it.each(['archive', 'directory'])('refuses a %s voice original whose bytes changed without changing its length', async (format) => {
    const store = createMemoryStore(), original = new TextEncoder().encode('original voice bytes'), corrupted = new TextEncoder().encode('modified voice bytes')
    const hash = await hashBytes(original), blobId = `voice-${hash}`
    await store.putKv('voiceInbox.v1', { schemaVersion: 1, revision: 1, entries: [{ id: 'voice', blobId, hash, bytes: original.length, status: 'captured' }] })
    await store.putBlob({ meta: { id: blobId, kind: 'file', bytes: original.length, mime: 'audio/webm', createdAt: 1, nodeId: null }, data: corrupted })
    if (format === 'archive') await expect(exportArchive(store, blobSink())).rejects.toThrow(/SHA-256/)
    else await expect(exportDirectoryBundle(store, bundleFiles())).rejects.toThrow(/SHA-256/)
    store.close()
  })

  it.each(['archive', 'directory'])('rejects a tampered %s voice original even with a freshly valid container checksum', async (format) => {
    const store = createMemoryStore(), original = new TextEncoder().encode('original voice bytes'), corrupted = new TextEncoder().encode('modified voice bytes')
    const hash = await hashBytes(original), blobId = `voice-${hash}`, assetPath = `assets/${blobId}`
    await store.putKv('voiceInbox.v1', { schemaVersion: 1, revision: 1, entries: [{ id: 'voice', blobId, hash, bytes: original.length, status: 'captured' }] })
    await store.putBlob({ meta: { id: blobId, kind: 'file', bytes: original.length, mime: 'audio/webm', createdAt: 1, nodeId: null }, data: original })
    if (format === 'archive') {
      const sink = blobSink(); await exportArchive(store, sink)
      const entries = unzipSync(new Uint8Array(await sink.blob().arrayBuffer()))
      entries[assetPath] = corrupted
      await expect(readArchive(new Blob([zipSync(entries)]))).rejects.toThrow(/SHA-256/)
    } else {
      const files = bundleFiles(); await exportDirectoryBundle(store, files)
      const manifest = JSON.parse(await (await files.read('manifest.json')).text()) as { entries: { path: string; parts: { path: string; sha256: string }[] }[] }
      const part = manifest.entries.find((entry) => entry.path === assetPath)!.parts[0]
      await files.write(part.path, corrupted)
      part.sha256 = await hashBytes(corrupted)
      await files.write('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)))
      await expect(readDirectoryBundle(files)).rejects.toThrow(/SHA-256/)
    }
    store.close()
  })

  it('holds one IndexedDB read transaction while another write is queued', async () => {
    const store = await openIdbStore({ name: `snapshot-${crypto.randomUUID()}`, opfsRoot: null })
    try {
      const before = makeNodeDraft('idea', { title: 'Before queued write' })
      await store.putNode(before)
      await store.putKv('knowledge.v1', ledger(1))
      const pending = readWorldSnapshot(store)
      await Promise.all([store.putNode({ ...before, title: 'After queued write' }), store.putKv('knowledge.v1', ledger(2))])
      const snapshot = await pending
      expect(snapshot.nodes[0].title).toBe('Before queued write')
      expect(snapshot.kv['knowledge.v1']).toMatchObject({ revision: 1 })
      expect((await store.getNode(before.id))?.title).toBe('After queued write')
    } finally { store.close() }
  })

  it('limits the HTTP snapshot endpoint to portable state keys', async () => {
    const engine = await startTestEngine()
    const result = await fetch(`${engine.base}/world/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: ['autoBackupDir'] }) })
    expect(result.status).toBe(400)
  })
})
