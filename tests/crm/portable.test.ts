import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { blobSink, exportArchive, readArchive } from '../../src/data/archive.ts'
import { exportDirectoryBundle, readDirectoryBundle, type BundleReader, type BundleWriter } from '../../src/data/directoryBundle.ts'
import { hashBytes } from '../../src/data/hash.ts'
import { createCrmRecord, emptyCrm } from '../../src/crm/model.ts'
import { openWorldDb } from '../../server/worldDb.ts'

const directory = (): BundleReader & BundleWriter => {
  const files = new Map<string, Blob>()
  return { exists: async path => files.has(path), write: async (path, bytes) => { files.set(path, new Blob([bytes.slice()])) }, remove: async path => { files.delete(path) }, read: async path => { const file = files.get(path); if (!file) throw new Error('Missing original'); return file } }
}

describe('CRM backup originals and device exclusions', () => {
  it.each(['archive', 'directory'])('round-trips archived CRM source originals in %s and excludes account credentials', async format => {
    const store = createMemoryStore(), bytes = new TextEncoder().encode('Original contact export'), assetId = 'crm-file-' + await hashBytes(bytes)
    await store.putBlob({ meta: { id: assetId, kind: 'file', mime: 'application/json', bytes: bytes.length, createdAt: 1, nodeId: null }, data: bytes })
    const snapshot = emptyCrm(); snapshot.people.push(createCrmRecord('people', { id: 'p', fullName: 'Person', archivedAt: 1000, sourceRefs: [{ provider: 'folk', accountId: 'workspace', externalId: 'p', originalAssetId: assetId }] }))
    await store.putKv('crm.v1', snapshot); await store.putKv('crm-google.private', { refreshToken: 'must-not-export' })
    let restored
    if (format === 'archive') { const sink = blobSink(); await exportArchive(store, sink); restored = await readArchive(sink.blob()) }
    else { const files = directory(); await exportDirectoryBundle(store, files, { chunkBytes: 17 }); restored = await readDirectoryBundle(files) }
    expect(restored.kv['crm.v1']).toEqual(snapshot); expect(restored.kv['crm-google.private']).toBeUndefined()
    expect(restored.assets.some(asset => asset.id === assetId)).toBe(true)
  })
  it.each(['archive', 'directory'])('rejects corrupted CRM source bytes before completing a %s backup', async format => {
    const store = createMemoryStore(), assetId = 'crm-file-' + 'a'.repeat(64), bytes = new TextEncoder().encode('Corrupted original')
    await store.putBlob({ meta: { id: assetId, kind: 'file', mime: 'application/json', bytes: bytes.length, createdAt: 1, nodeId: null }, data: bytes })
    const snapshot = emptyCrm(); snapshot.imports.push(createCrmRecord('imports', { originalAssetIds: [assetId] }))
    await store.putKv('crm.v1', snapshot)
    await expect(format === 'archive' ? exportArchive(store, blobSink()) : exportDirectoryBundle(store, directory())).rejects.toThrow('SHA-256')
  })
  it('prevents deleting an original still retained by an archived person', () => {
    const db = openWorldDb(':memory:')
    try {
      const assetId = 'crm-file-' + 'a'.repeat(64); db.putAssetMeta({ id: assetId, kind: 'file', mime: 'application/json', bytes: 10, createdAt: 1, nodeId: null })
      const snapshot = emptyCrm(); snapshot.people.push(createCrmRecord('people', { id: 'p', archivedAt: 1000, sourceRefs: [{ provider: 'folk', accountId: 'workspace', externalId: 'p', originalAssetId: assetId }] }))
      db.putKv('crm.v1', snapshot)
      expect(() => db.deleteAssetMeta(assetId)).toThrow('retained by People')
      expect(db.getAssetMeta(assetId)).toBeDefined()
    } finally { db.close() }
  })
})
