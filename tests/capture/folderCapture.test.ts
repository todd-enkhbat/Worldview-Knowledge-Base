import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FolderCapture, MAX_WATCH_FILE_BYTES, authorizeFolderRequest } from '../../server/folderCapture.ts'
import { openWorldDb } from '../../server/worldDb.ts'
import { ChangeBus } from '../../server/changes.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import { SCHEMA_VERSION } from '../../src/domain/types.ts'
import { makeNodeDraft } from '../../src/domain/validate.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function fixture(pollMs = 60_000, debounceMs = 10_000) {
  const root = mkdtempSync(join(tmpdir(), 'wv-folder-capture-'))
  const data = join(root, 'data')
  const notes = join(root, 'notes')
  mkdirSync(notes)
  const db = openWorldDb(join(data, 'world.sqlite'))
  db.putSettings({ T0: Date.UTC(2000, 0, 1), yPerYear: 12, stepsPerYear: 600, physicsSeed: 123, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: Date.now(), schemaVersion: SCHEMA_VERSION })
  const bus = new ChangeBus()
  const capture = new FolderCapture({ dataDir: data, db, bus, pollMs, debounceMs })
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }) }, () => { capture.close(); bus.close() })
  const snapshot = () => db.getKv('knowledge.v1') as KnowledgeSnapshot
  return { root, data, notes, db, bus, capture, snapshot }
}

describe('continuous local folder capture', () => {
  it('captures real edits without a browser and resumes persisted registration after a service restart', async () => {
    const f = fixture(35, 5)
    writeFileSync(join(f.notes, 'journal.md'), '# Quiet project\nInitial aurora thought.')
    const folder = await f.capture.add(f.notes)
    expect(f.snapshot().sources).toHaveLength(1)
    expect(f.db.listNodes()).toHaveLength(1)
    const sourceId = f.snapshot().sources[0].id
    const nodeId = f.snapshot().sources[0].nodeId
    writeFileSync(join(f.notes, 'journal.md'), '# Quiet project\nRevised aurora plan.')
    await vi.waitFor(() => expect(f.snapshot().versions).toHaveLength(2), { timeout: 3000 })
    expect(f.snapshot().sources[0]).toMatchObject({ id: sourceId, nodeId })
    expect(f.db.getNode(nodeId!)?.contentMd).toContain('Revised aurora')
    expect(f.snapshot().jobs.at(-1)).toMatchObject({ status: 'complete' })
    const version = f.snapshot().versions.at(-1)!
    expect(readFileSync(join(f.data, 'blobs', version.originalBlobId), 'utf8')).toContain('Revised aurora')
    f.capture.close()
    writeFileSync(join(f.notes, 'journal.md'), '# Quiet project\nAn edit while the service was closed.')
    const resumed = new FolderCapture({ dataDir: f.data, db: f.db, bus: f.bus, pollMs: 35, debounceMs: 5 })
    cleanup.push(() => resumed.close())
    expect(resumed.list()[0].id).toBe(folder.id)
    await vi.waitFor(() => expect(f.snapshot().versions).toHaveLength(3), { timeout: 3000 })
    expect(f.snapshot().sources).toHaveLength(1)
  })

  it('keeps exact identity on repeat scans and re-registration, pauses capture, and retains originals when a file goes missing', async () => {
    const f = fixture()
    const file = join(f.notes, 'thought.txt')
    writeFileSync(file, 'The violet observatory plan.')
    const folder = await f.capture.add(f.notes)
    const original = f.snapshot().sources[0]
    await f.capture.scan(folder.id)
    expect(f.snapshot().versions).toHaveLength(1)
    await f.capture.pause(folder.id, true)
    writeFileSync(file, 'The updated violet observatory plan.')
    await f.capture.scan(folder.id)
    expect(f.snapshot().versions).toHaveLength(1)
    await f.capture.pause(folder.id, false)
    expect(f.snapshot().versions).toHaveLength(2)
    f.capture.remove(folder.id)
    const again = await f.capture.add(f.notes)
    expect(again.id).toBe(folder.id)
    expect(f.snapshot().sources).toHaveLength(1)
    expect(f.snapshot().sources[0].id).toBe(original.id)
    expect(f.snapshot().versions).toHaveLength(2)
    rmSync(file)
    await f.capture.scan(folder.id)
    expect(f.capture.list()[0].missing).toBe(1)
    expect(f.db.getNode(original.nodeId!)?.deletedAt).toBeNull()
    expect(f.snapshot().versions).toHaveLength(2)
  })

  it('preserves a user-edited projection and placement while storing a new immutable original version', async () => {
    const f = fixture()
    writeFileSync(join(f.notes, 'note.md'), '# A source\nOriginal wording.')
    const folder = await f.capture.add(f.notes)
    const source = f.snapshot().sources[0]
    const node = f.db.getNode(source.nodeId!)!
    f.db.putNodes([{ ...node, title: 'My interpretation', contentMd: 'A user correction.', fieldAnchorXZ: [27, -19], updatedAt: node.updatedAt + 1 }])
    writeFileSync(join(f.notes, 'note.md'), '# A source\nUpdated external wording.')
    await f.capture.scan(folder.id)
    expect(f.db.getNode(node.id)).toMatchObject({ title: 'My interpretation', contentMd: 'A user correction.', fieldAnchorXZ: [27, -19], anchorXZ: node.anchorXZ })
    expect(f.snapshot().versions.at(-1)?.text).toContain('Updated external wording')
    expect(f.snapshot().sources[0].projectionEdited).toBe(true)
  })

  it('excludes hidden/dependency/symlink/oversized inputs and does not read outside the registered root', async () => {
    const f = fixture()
    writeFileSync(join(f.notes, 'allowed.md'), 'Allowed notes.')
    writeFileSync(join(f.notes, '.private.md'), 'Hidden secret.')
    writeFileSync(join(f.root, 'outside.md'), 'Outside secret.')
    mkdirSync(join(f.notes, 'node_modules'))
    writeFileSync(join(f.notes, 'node_modules', 'dependency.md'), 'Dependency secret.')
    symlinkSync(join(f.root, 'outside.md'), join(f.notes, 'linked.md'))
    writeFileSync(join(f.notes, 'too-large.txt'), Buffer.alloc(MAX_WATCH_FILE_BYTES + 1))
    const folder = await f.capture.add(f.notes)
    expect(f.snapshot().sources).toHaveLength(1)
    expect(JSON.stringify(f.snapshot())).not.toContain('Outside secret')
    expect(JSON.stringify(f.snapshot())).not.toContain('Hidden secret')
    expect(f.capture.list()[0]).toMatchObject({ indexed: 1, excluded: 4 })
    await expect(f.capture.add(join(f.notes, 'node_modules'))).rejects.toThrow(/dependency/)
    await expect(f.capture.add(f.data)).rejects.toThrow(/outside/)
    expect(f.capture.list()[0].id).toBe(folder.id)
  })

  it('retains a failed input and retries its repaired contents without fabricating an indexed source', async () => {
    const f = fixture()
    const path = join(f.notes, 'conversation.json')
    writeFileSync(path, 'invalid json')
    const folder = await f.capture.add(f.notes)
    expect(f.snapshot().sources).toEqual([])
    expect(f.snapshot().imports[0]).toMatchObject({ status: 'failed', failed: 1, watchedFolderId: folder.id })
    expect(f.db.getAssetMeta(f.snapshot().imports[0].fileBlobIds[0])).toBeDefined()
    expect(f.capture.list()[0].status).toBe('error')
    writeFileSync(path, JSON.stringify({ journal: 'A repaired source.' }))
    await f.capture.retry(folder.id)
    expect(f.snapshot().sources).toHaveLength(1)
    expect(f.snapshot().imports.at(-1)?.status).toBe('complete')
    expect(f.capture.list()[0].status).toBe('watching')
  })

  it('does not resurrect a permanently deleted source when its watched file changes', async () => {
    const f = fixture()
    const file = join(f.notes, 'deleted.md')
    writeFileSync(file, 'A source later deleted from the workspace.')
    const folder = await f.capture.add(f.notes)
    const source = f.snapshot().sources[0]
    f.db.deleteNode(source.nodeId!)
    const snapshot = f.snapshot()
    f.db.putKv('knowledge.v1', { ...snapshot, revision: snapshot.revision + 1, sources: [], versions: [], passages: [] })
    writeFileSync(file, 'A changed source must not silently restore that deletion.')
    await f.capture.scan(folder.id)
    expect(f.snapshot().sources).toEqual([])
    expect(f.db.listNodes()).toEqual([])
    expect(f.capture.list()[0].status).toBe('error')
    expect(f.capture.list()[0].error).toContain('attention')
  })

  it.each(['zip', 'directory'])('defers during a %s restore without mistaking its temporarily empty ledger for deletion', async (kind) => {
    const f = fixture()
    const file = join(f.notes, 'restore.md')
    writeFileSync(file, 'The original watched thought.')
    const folder = await f.capture.add(f.notes)
    const original = f.snapshot()
    const settings = f.db.getSettings()!
    const nodes = f.db.listNodes()
    const assets = f.db.listAssets()
    f.db.resetWithKv('importInProgress', { startedAt: Date.now(), backupName: 'before-restore', backupKind: kind })
    writeFileSync(file, 'An external edit made during restore.')
    await f.capture.scan(folder.id)
    expect(f.snapshot()).toBeUndefined()
    expect(f.db.listNodes()).toEqual([])
    expect(f.db.listAssets()).toEqual([])
    expect(f.capture.list()[0].status).toBe('deferred')
    f.db.putSettings(settings)
    f.db.putNodes(nodes)
    for (const asset of assets) f.db.putAssetMeta(asset)
    f.db.putKv('knowledge.v1', original)
    await f.capture.scan(folder.id)
    expect(f.snapshot().revision).toBe(original.revision)
    f.db.deleteKv('importInProgress')
    await f.capture.scan(folder.id)
    expect(f.snapshot().sources[0].id).toBe(original.sources[0].id)
    expect(f.snapshot().versions).toHaveLength(2)
    expect(f.db.getNode(original.sources[0].nodeId!)?.contentMd).toContain('external edit made during restore')
    expect(f.capture.list()[0].status).toBe('watching')
  })

  it('rechecks the restore marker inside the atomic commit when restoration starts after staging', async () => {
    const f = fixture()
    const file = join(f.notes, 'racing.md')
    writeFileSync(file, 'A previously captured version.')
    const folder = await f.capture.add(f.notes)
    const original = f.snapshot()
    const assetCount = f.db.listAssets().length
    writeFileSync(file, 'A staged version awaiting a safe commit.')
    const commit = f.db.compareAndSwapKnowledge.bind(f.db)
    const spy = vi.spyOn(f.db, 'compareAndSwapKnowledge').mockImplementationOnce((...args) => {
      f.db.putKv('importInProgress', { startedAt: Date.now(), backupName: null })
      return commit(...args)
    })
    await f.capture.scan(folder.id)
    expect(f.snapshot().revision).toBe(original.revision)
    expect(f.snapshot().versions).toHaveLength(1)
    expect(f.db.listAssets()).toHaveLength(assetCount)
    expect(f.db.getNode(original.sources[0].nodeId!)?.contentMd).toBe('A previously captured version.')
    expect(f.capture.list()[0].status).toBe('deferred')
    spy.mockRestore()
    f.db.deleteKv('importInProgress')
    await f.capture.scan(folder.id)
    expect(f.snapshot().versions).toHaveLength(2)
    expect(f.capture.list()[0].status).toBe('watching')
  })
})

describe('capture transaction and origin protection', () => {
  it('refuses stale ledger or record writes and placement changes atomically', () => {
    const f = fixture()
    const initial: KnowledgeSnapshot = { schemaVersion: 1, revision: 0, sources: [], versions: [], passages: [], imports: [], proposals: [], jobs: [] }
    const node = makeNodeDraft('document', { title: 'Current user record', anchorXZ: [40, 20] })
    expect(f.db.compareAndSwapKnowledge({ ...initial, revision: 1 }, 0, [node], { [node.id]: null })).toBe(true)
    const concurrent = { ...node, contentMd: 'Newer user edit.', updatedAt: node.updatedAt + 1 }
    f.db.putNodes([concurrent])
    expect(f.db.compareAndSwapKnowledge({ ...initial, revision: 2 }, 1, [{ ...node, contentMd: 'Stale source.' }], { [node.id]: node.updatedAt })).toBe(false)
    expect(f.db.compareAndSwapKnowledge({ ...initial, revision: 2 }, 1, [{ ...concurrent, fieldAnchorXZ: [99, 99] }], { [node.id]: concurrent.updatedAt })).toBe(false)
    expect(f.db.compareAndSwapKnowledge({ ...initial, revision: 1 }, 0, [], {})).toBe(false)
    expect(f.db.getNode(node.id)?.contentMd).toBe('Newer user edit.')
    expect(f.snapshot().revision).toBe(1)
  })

  it('requires a loopback peer, exact localhost origin/host and explicit mutation header', () => {
    const request = (patch: Record<string, unknown> = {}) => ({ method: 'POST', socket: { remoteAddress: '127.0.0.1', localPort: 5173 }, headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'x-wv-client': 'test' }, ...patch }) as unknown as IncomingMessage
    expect(authorizeFolderRequest(request())).toBe(true)
    expect(authorizeFolderRequest(request({ headers: { host: 'evil.example:5173', origin: 'http://evil.example:5173', 'x-wv-client': 'test' } }))).toBe(false)
    expect(authorizeFolderRequest(request({ headers: { host: 'localhost:5173', origin: 'https://evil.example', 'x-wv-client': 'test' } }))).toBe(false)
    expect(authorizeFolderRequest(request({ headers: { host: 'localhost:5173', 'x-wv-client': 'test' } }))).toBe(false)
    expect(authorizeFolderRequest(request({ headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } }))).toBe(false)
    expect(authorizeFolderRequest(request({ socket: { remoteAddress: '10.0.0.8', localPort: 5173 } }))).toBe(false)
    expect(authorizeFolderRequest(request({ headers: { host: 'evil@localhost:5173', origin: 'http://localhost:5173', 'x-wv-client': 'test' } }))).toBe(false)
    expect(authorizeFolderRequest(request({ method: 'GET', headers: { host: 'localhost:5173' } }))).toBe(true)
  })

  it('projects explicit path links during a browser-free atomic sweep and preserves manual removals and pins', async () => {
    const f = fixture()
    mkdirSync(join(f.notes, 'Work'))
    writeFileSync(join(f.notes, 'Read.md'), 'Read [[Work/Plan#Budget|the plan]] and [[Missing]].')
    writeFileSync(join(f.notes, 'Work/Plan.md'), '# Budget\nThe reserve is eighteen hours.')
    const folder = await f.capture.add(f.notes)
    const reader = f.snapshot().sources.find((source) => source.externalId.endsWith(':document:Read.md'))!
    const plan = f.snapshot().sources.find((source) => source.externalId.endsWith(':obsidian:Work/Plan.md'))!
    const node = f.db.getNode(reader.nodeId!)!
    expect(node.links).toContainEqual(expect.objectContaining({ targetId: plan.nodeId, kind: 'relates' }))
    f.db.putNodes([{ ...node, links: [], fieldAnchorXZ: [32, -19], updatedAt: node.updatedAt + 1 }])
    writeFileSync(join(f.notes, 'Read.md'), 'Updated [[Work/Plan#Budget|the plan]].')
    await f.capture.scan(folder.id)
    const after = f.db.getNode(reader.nodeId!)!
    expect(after.links).toEqual([])
    expect(after.fieldAnchorXZ).toEqual([32, -19])
    expect(after.anchorXZ).toEqual(node.anchorXZ)
    expect(after.temporalOrigin).toBe(node.temporalOrigin)
    expect(f.snapshot().sources.find((source) => source.id === reader.id)?.vaultGraph?.suppressedTargets).toContain(plan.id)
  })
})
