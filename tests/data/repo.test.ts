import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { ReadOnlyError } from '../../src/data/locks.ts'
import type { WriterLock } from '../../src/data/locks.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import {
  DEFAULT_AMPLITUDE,
  RepoValidationError,
  addAttachment,
  closeRepo,
  completeFirstRun,
  createNode,
  emptyTrash,
  initRepo,
  link,
  logEvent,
  moveAnchor,
  purgeExpiredTrash,
  relayoutWorld,
  removeAttachment,
  restore,
  softDelete,
  unlink,
  updateNode,
  updateSettings,
  useRepoStatus,
} from '../../src/data/repo.ts'
import type { WorldStore } from '../../src/data/WorldStore.ts'
import { MS_PER_YEAR, SIGMA, TRASH_RETENTION_MS } from '../../src/domain/constants.ts'
import { anchorY } from '../../src/domain/placement.ts'
import type { NodeRecord } from '../../src/domain/types.ts'

const DAY = 86_400_000
const T0 = Date.UTC(1990, 4, 17)
const START = Date.UTC(2026, 9, 14, 12)
let now = START
let store: WorldStore

const yearsAfterT0 = (y: number) => T0 + y * MS_PER_YEAR
const lastToast = () => useApp.getState().toasts.at(-1)!

function dist3(a: NodeRecord, b: NodeRecord): number {
  return Math.hypot(a.anchorXZ[0] - b.anchorXZ[0], anchorY(a, { T0 }) - anchorY(b, { T0 }), a.anchorXZ[1] - b.anchorXZ[1])
}

beforeEach(async () => {
  now = START
  useWorld.getState().hydrate(null, [])
  useApp.setState({ toasts: [], selectedId: null })
  store = createMemoryStore()
  await initRepo({ store, now: () => now })
  await completeFirstRun({ T0, start: 'empty' })
})

afterEach(async () => {
  await closeRepo()
})

describe('repo: first run', () => {
  it('persists settings and hydrates useWorld', async () => {
    const s = await store.getSettings()
    expect(s).toMatchObject({ T0, firstRunComplete: true, yPerYear: 12, stepsPerYear: 600, lastBackupAt: null })
    expect(useWorld.getState().settings).toEqual(s)
    expect(useRepoStatus.getState()).toMatchObject({ ready: true, writer: true, fallback: false })
    await expect(completeFirstRun({ T0, start: 'demo' })).rejects.toThrow(/already complete/)
  })

  it('can start from the demo world', async () => {
    await closeRepo()
    useWorld.getState().hydrate(null, [])
    store = createMemoryStore()
    await initRepo({ store, now: () => now })
    await completeFirstRun({ T0, start: 'demo' })
    expect(useWorld.getState().nodes.size).toBeGreaterThanOrEqual(28)
    expect((await store.listNodes()).length).toBe(useWorld.getState().nodes.size)
  })
})

describe('repo: create', () => {
  it('places, validates, persists, selects and toasts with a working undo', async () => {
    const n = await createNode({ archetype: 'idea', title: '  Landauer  ', tags: ['information'], temporalOrigin: yearsAfterT0(23) })
    expect(n.title).toBe('Landauer')
    expect(n.slug).toBe('landauer')
    expect(Math.hypot(...n.anchorXZ)).toBeGreaterThan(0)
    expect(await store.getNode(n.id)).toEqual(n)
    expect(useWorld.getState().nodes.get(n.id)).toEqual(n)
    expect(useApp.getState().selectedId).toBe(n.id)
    expect(lastToast().message).toBe('Created Landauer')

    await lastToast().undo()
    expect(await store.getNode(n.id)).toBeUndefined()
    expect(useWorld.getState().nodes.has(n.id)).toBe(false)
    expect(useApp.getState().selectedId).toBeNull()
  })

  it('keeps σ between anchors and unique slugs', async () => {
    const made: NodeRecord[] = []
    for (let i = 0; i < 12; i++) made.push(await createNode({ archetype: 'memory', title: 'Same day', tags: ['time'], temporalOrigin: yearsAfterT0(20) }))
    for (let i = 0; i < made.length; i++) for (let j = i + 1; j < made.length; j++) expect(dist3(made[i], made[j])).toBeGreaterThanOrEqual(SIGMA)
    expect(new Set(made.map((m) => m.slug)).size).toBe(12)
    expect(made[1].slug).toBe('same-day-2')
  })

  it('rejects invalid drafts without persisting anything', async () => {
    const before = useWorld.getState().revision
    await expect(createNode({ archetype: 'idea', title: 'Too early', temporalOrigin: T0 - DAY })).rejects.toBeInstanceOf(RepoValidationError)
    await expect(createNode({ archetype: 'idea', title: '   ' })).rejects.toBeInstanceOf(RepoValidationError)
    await expect(createNode({ archetype: 'idea', title: 'Too late', temporalOrigin: START + 6 * MS_PER_YEAR })).rejects.toThrow(/future/)
    expect(await store.listNodes()).toEqual([])
    expect(useWorld.getState().revision).toBe(before)
    expect(useApp.getState().toasts).toEqual([])
  })

  it('rolls the optimistic update back when the write fails', async () => {
    vi.spyOn(store, 'putNode').mockRejectedValueOnce(new Error('quota exceeded'))
    await expect(createNode({ archetype: 'idea', title: 'Doomed' })).rejects.toThrow('quota exceeded')
    expect(useWorld.getState().nodes.size).toBe(0)
    expect(useApp.getState().toasts).toEqual([])
  })
})

describe('repo: update and move', () => {
  async function five() {
    const out: NodeRecord[] = []
    for (const [i, tag] of ['entropy', 'time', 'memory', 'information', 'symmetry'].entries()) {
      out.push(await createNode({ archetype: 'idea', title: `Idea ${i}`, tags: [tag, 'shared'], temporalOrigin: yearsAfterT0(10 + i) }))
    }
    return out
  }

  it('a primary-tag change re-places only that node; other edits keep the anchor', async () => {
    const nodes = await five()
    const target = nodes[2]
    const content = await updateNode(target.id, { contentMd: 'new words', tags: ['memory', 'other-secondary'] })
    expect(content.anchorXZ).toEqual(target.anchorXZ)

    const retagged = await updateNode(target.id, { tags: ['phenomenology', 'shared'] })
    expect(retagged.anchorXZ).not.toEqual(target.anchorXZ)
    for (const n of nodes) {
      if (n.id === target.id) continue
      expect((await store.getNode(n.id))!.anchorXZ).toEqual(n.anchorXZ)
    }
    // anchorXZ in a patch is ignored: dragging is moveAnchor.
    const ignored = await updateNode(target.id, { anchorXZ: [500, 500] })
    expect(ignored.anchorXZ).toEqual(retagged.anchorXZ)
  })

  it('a date change keeps XZ', async () => {
    const [a] = await five()
    const moved = await updateNode(a.id, { temporalOrigin: yearsAfterT0(25) })
    expect(moved.anchorXZ).toEqual(a.anchorXZ)
    expect(moved.temporalOrigin).toBe(yearsAfterT0(25))
  })

  it('moveAnchor sets XZ, snaps a drop within σ of another node, and rejects a drop deep inside a crowd', async () => {
    const nodes = await five()
    const free = await moveAnchor(nodes[0].id, [80, -40])
    expect(free.anchorXZ).toEqual([80, -40])

    // Same date as nodes[1], dropped right on top of it: snapped to ≥ σ away.
    await updateNode(nodes[0].id, { temporalOrigin: nodes[1].temporalOrigin })
    const snapped = await moveAnchor(nodes[0].id, [nodes[1].anchorXZ[0] + 0.5, nodes[1].anchorXZ[1]])
    expect(dist3(snapped, nodes[1])).toBeGreaterThanOrEqual(SIGMA)
    expect(Math.hypot(snapped.anchorXZ[0] - nodes[1].anchorXZ[0], snapped.anchorXZ[1] - nodes[1].anchorXZ[1])).toBeLessThanOrEqual(2 * SIGMA + 0.5)
  })

  it('link and unlink', async () => {
    const [a, b] = await five()
    const linked = await link(a.id, b.id, 'supports', 'because')
    expect(linked.links).toEqual([{ targetId: b.id, kind: 'supports', label: 'because', createdAt: now }])
    expect((await link(a.id, b.id, 'supports')).links).toHaveLength(1)
    await expect(link(a.id, a.id)).rejects.toThrow(/itself/)
    expect((await unlink(a.id, b.id)).links).toEqual([])
  })
})

describe('repo: trash', () => {
  it('soft delete goes to the trash with an undo toast', async () => {
    const n = await createNode({ archetype: 'document', title: 'Notes' })
    await softDelete(n.id)
    expect(useWorld.getState().trash.has(n.id)).toBe(true)
    expect(useWorld.getState().nodes.has(n.id)).toBe(false)
    expect((await store.getNode(n.id))!.deletedAt).toBe(now)
    expect(useApp.getState().selectedId).toBeNull()
    expect(lastToast().message).toBe('Deleted Notes')

    await lastToast().undo()
    expect(useWorld.getState().nodes.has(n.id)).toBe(true)
    expect((await store.getNode(n.id))!.deletedAt).toBeNull()
  })

  it('restore resolves a σ conflict with a node created meanwhile', async () => {
    const a = await createNode({ archetype: 'idea', title: 'A', temporalOrigin: yearsAfterT0(5) })
    await softDelete(a.id)
    const b = await createNode({ archetype: 'idea', title: 'B', temporalOrigin: yearsAfterT0(5) })
    await moveAnchor(b.id, a.anchorXZ)
    const back = await restore(a.id)
    expect(dist3(back, useWorld.getState().nodes.get(b.id)!)).toBeGreaterThanOrEqual(SIGMA)
  })

  it('purges after 30 days with the node’s blobs and the links pointing at it', async () => {
    const keep = await createNode({ archetype: 'idea', title: 'Keeper' })
    const gone = await createNode({ archetype: 'idea', title: 'Goner' })
    await link(keep.id, gone.id, 'relates')
    await addAttachment(gone.id, new Blob(['some notes']), 'notes.txt')
    expect(await store.listAssets()).toHaveLength(1)
    await softDelete(gone.id)

    now += TRASH_RETENTION_MS - 1
    expect(await purgeExpiredTrash()).toEqual([])
    now += 1
    expect(await purgeExpiredTrash()).toEqual([gone.id])
    expect(await store.getNode(gone.id)).toBeUndefined()
    expect(useWorld.getState().trash.size).toBe(0)
    expect(await store.listAssets()).toEqual([])
    expect((await store.getNode(keep.id))!.links).toEqual([])
    expect(useWorld.getState().nodes.get(keep.id)!.links).toEqual([])
  })

  it('emptyTrash requires an explicit confirm', async () => {
    const n = await createNode({ archetype: 'idea', title: 'X' })
    await softDelete(n.id)
    await expect(emptyTrash({ confirm: false })).rejects.toThrow(/confirm/)
    expect(useWorld.getState().trash.size).toBe(1)
    expect(await emptyTrash({ confirm: true })).toEqual([n.id])
    expect(await store.listNodes()).toEqual([])
  })
})

describe('repo: settings and relayout', () => {
  it('updateSettings validates and refuses T0 changes', async () => {
    const s = await updateSettings({ qualityTier: 'low', autoBackupEnabled: true })
    expect(s.qualityTier).toBe('low')
    expect((await store.getSettings())!.qualityTier).toBe('low')
    await expect(updateSettings({ T0: T0 + DAY })).rejects.toThrow(/relayoutWorld/)
    await expect(updateSettings({ physicsSeed: -1 })).rejects.toBeInstanceOf(RepoValidationError)
    expect(useWorld.getState().settings!.physicsSeed).toBe(s.physicsSeed)
  })

  it('relayoutWorld reports records that would fall outside instead of clamping', async () => {
    const early = await createNode({ archetype: 'memory', title: 'Childhood', temporalOrigin: yearsAfterT0(3) })
    const mid = await createNode({ archetype: 'idea', title: 'Later', temporalOrigin: yearsAfterT0(20) })
    const later = yearsAfterT0(10)
    const report = await relayoutWorld(later)
    expect(report.applied).toBe(false)
    expect(report.outOfRange.map((r) => r.id)).toEqual([early.id])
    expect(report.outOfRange[0].issues[0].field).toBe('temporalOrigin')
    expect(useWorld.getState().settings!.T0).toBe(T0)
    expect((await store.getNode(early.id))!.temporalOrigin).toBe(early.temporalOrigin)

    const dryRun = await relayoutWorld(T0 - 365 * DAY, { apply: false })
    expect(dryRun).toMatchObject({ applied: false, outOfRange: [] })
    expect(useWorld.getState().settings!.T0).toBe(T0)

    const ok = await relayoutWorld(T0 - 365 * DAY)
    expect(ok.applied).toBe(true)
    expect((await store.getSettings())!.T0).toBe(T0 - 365 * DAY)
    expect((await store.getNode(mid.id))!.anchorXZ).toEqual(mid.anchorXZ)

    const future = await relayoutWorld(START + DAY)
    expect(future.applied).toBe(false)
    expect(future.settingsIssues.length).toBeGreaterThan(0)
  })
})

describe('repo: attachments', () => {
  it('stores text as-is and images with sniffed metadata', async () => {
    const n = await createNode({ archetype: 'document', title: 'Notebook' })
    const text = await addAttachment(n.id, new Blob(['# Ledger\nkT ln 2\n']), 'ledger.md')
    expect(text).toMatchObject({ kind: 'text', name: 'ledger.md', mime: 'text/markdown', bytes: 17 })
    expect(text.thumbBlobId).toBeUndefined()
    expect(await (await store.getBlob(text.blobId))!.text()).toBe('# Ledger\nkT ln 2\n')
    expect(await store.getAssetMeta(text.blobId)).toMatchObject({ kind: 'text', nodeId: n.id, mime: 'text/markdown' })

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
    const img = await addAttachment(n.id, new Blob([png], { type: '' }), 'C:\\photos\\board.bin')
    // Content wins over the extension; no OffscreenCanvas in Node, so no thumbnail.
    expect(img).toMatchObject({ kind: 'image', mime: 'image/png', name: 'board.bin', bytes: png.length })
    expect(useWorld.getState().nodes.get(n.id)!.attachments.map((a) => a.id)).toEqual([text.id, img.id])

    await expect(addAttachment(n.id, new Blob([new Uint8Array([0, 1, 2, 3, 0, 0, 0])]), 'blob.bin')).rejects.toThrow(/Unsupported/)

    const after = await removeAttachment(n.id, text.id)
    expect(after.attachments.map((a) => a.id)).toEqual([img.id])
    expect(await store.getBlob(text.blobId)).toBeUndefined()
  })

  it('removes the written blob when the record update fails', async () => {
    const n = await createNode({ archetype: 'document', title: 'Notebook' })
    vi.spyOn(store, 'putNode').mockRejectedValueOnce(new Error('disk'))
    await expect(addAttachment(n.id, new Blob(['x']), 'x.txt')).rejects.toThrow('disk')
    expect(await store.listAssets()).toEqual([])
    expect(useWorld.getState().nodes.get(n.id)!.attachments).toEqual([])
  })
})

describe('repo: events and writer lock', () => {
  it('logEvent appends with default amplitudes', async () => {
    const n = await createNode({ archetype: 'memory', title: 'Train' })
    for (const kind of ['dwell', 'inspect', 'enter', 'demon-match'] as const) {
      now += 1000
      await logEvent(kind, n.id)
    }
    now += 1000
    const e = await logEvent('demon-match', n.id, { demonId: 'd', bits: 2, amplitude: 0.7 })
    const events = await store.listEvents()
    expect(events.slice(0, 4).map((x) => x.amplitude)).toEqual([0.5, 1, 2, 0.25])
    expect(DEFAULT_AMPLITUDE).toEqual({ dwell: 0.5, inspect: 1, enter: 2, 'demon-match': 0.25 })
    expect(e).toMatchObject({ kind: 'demon-match', demonId: 'd', bits: 2, amplitude: 0.7, t: now })
  })

  it('refuses writes in a read-only tab', async () => {
    await closeRepo()
    const listeners = new Set<(w: boolean) => void>()
    const lock: WriterLock = {
      isWriter: false,
      supported: true,
      ready: Promise.resolve(false),
      onChange: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      release() {},
    }
    await initRepo({ store, lock, now: () => now })
    expect(useRepoStatus.getState().writer).toBe(false)
    await expect(createNode({ archetype: 'idea', title: 'Nope' })).rejects.toBeInstanceOf(ReadOnlyError)
    expect(await logEvent('dwell', 'x')).toBeNull()
    expect(await store.listNodes()).toEqual([])
  })
})
