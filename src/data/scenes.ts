import { useWorld } from '../app/store.ts'
import type { AssetKind, NodeRecord, SplatBlock } from '../domain/types.ts'
import { ReadOnlyError } from './locks.ts'
import { getStore, updateNode, useRepoStatus } from './repo.ts'

// Volumetric scenes on memory nodes: the splat blobs (interior, proxy, thumbnail) and the
// node.splat block that points at them. Same discipline as attachments in repo.ts:
//   1. blobs first (each with AssetMeta.nodeId, so purge and orphan sweeps find them),
//   2. the record last (one updateNode), so a reader never sees ids without bytes,
//   3. on failure, the blobs written so far are deleted again,
//   4. only after the record commits are the replaced blobs deleted.
// Writes for one node are serialised, so the orphan sweep in (4) never sees another
// in-flight ingest's fresh blobs.

export type SceneSlot = 'interior' | 'proxy' | 'thumb'

/** SplatBlock without the asset ids, which attachScene assigns. */
export type SceneBlockDraft = Omit<SplatBlock, 'proxyAssetId' | 'interiorAssetId' | 'thumbAssetId'>

export interface SceneAsset {
  data: Blob | Uint8Array
  mime: string
}

/** Per slot: data to store, null to drop the slot, undefined (absent) to keep it. */
export type SceneAssets = Partial<Record<SceneSlot, SceneAsset | null>>

export const SPZ_MIME = 'application/x-spz'

const SLOTS: readonly SceneSlot[] = ['interior', 'proxy', 'thumb']
const KIND: Readonly<Record<SceneSlot, AssetKind>> = { interior: 'splat-interior', proxy: 'splat-proxy', thumb: 'splat-thumb' }
const FIELD = { interior: 'interiorAssetId', proxy: 'proxyAssetId', thumb: 'thumbAssetId' } as const satisfies Record<SceneSlot, keyof SplatBlock>
const SPLAT_KINDS = new Set<AssetKind>(Object.values(KIND))
const FORMATS = new Set<SplatBlock['sourceFormat']>(['spz', 'ply', 'splat', 'ksplat', 'sog', 'rad', 'unknown'])

export class SceneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SceneError'
  }
}

/** The live memory node, or a SceneError explaining why it cannot hold a scene. */
export function requireMemory(nodeId: string): NodeRecord {
  const node = useWorld.getState().nodes.get(nodeId)
  if (!node) throw new SceneError(`No live node ${nodeId}`)
  if (node.archetype !== 'memory') throw new SceneError(`Only memories can hold a volumetric scene (this is a ${node.archetype})`)
  return node
}

/** Throw before any heavy work when this tab cannot write. */
export function assertCanWrite(): void {
  if (!useRepoStatus.getState().writer) throw new ReadOnlyError()
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const vec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(finite)

/** Structural problems with a splat block (empty = valid). */
export function sceneBlockIssues(b: SplatBlock): string[] {
  const out: string[] = []
  if (!vec(b.entryPose?.position, 3)) out.push('entryPose.position must be 3 finite numbers')
  if (!vec(b.entryPose?.quaternion, 4) || Math.hypot(...b.entryPose.quaternion) < 1e-6) out.push('entryPose.quaternion must be a non-zero quaternion')
  if (b.entryPose?.fov !== undefined && (!finite(b.entryPose.fov) || b.entryPose.fov <= 0 || b.entryPose.fov >= 180)) out.push('entryPose.fov must be in (0, 180)')
  if (!vec(b.upFix, 4) || Math.hypot(...b.upFix) < 1e-6) out.push('upFix must be a non-zero quaternion')
  if (b.crop !== null) {
    if (!b.crop || !vec(b.crop.min, 3) || !vec(b.crop.max, 3)) out.push('crop must be null or { min, max } of 3 numbers')
    else if (!b.crop.min.every((v, i) => v < b.crop!.max[i])) out.push('crop.min must be below crop.max on every axis')
  }
  const { interior, proxy } = b.counts ?? {}
  if (!Number.isInteger(interior) || interior < 0 || !Number.isInteger(proxy) || proxy < 0) out.push('counts must be non-negative integers')
  if (!FORMATS.has(b.sourceFormat)) out.push(`unknown sourceFormat ${String(b.sourceFormat)}`)
  if (!b.interiorAssetId) out.push('a scene needs its interior asset')
  return out
}

const queues = new Map<string, Promise<unknown>>()

/** Run scene writes for one node one at a time. */
function serial<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(nodeId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  const tail = next.catch(() => {})
  queues.set(nodeId, tail)
  void tail.then(() => {
    if (queues.get(nodeId) === tail) queues.delete(nodeId)
  })
  return next
}

function byteLength(d: Blob | Uint8Array): number {
  return d instanceof Uint8Array ? d.byteLength : d.size
}

function stripIds(b: SplatBlock): SceneBlockDraft {
  const { proxyAssetId: _p, interiorAssetId: _i, thumbAssetId: _t, ...rest } = b
  return rest
}

async function writeScene(nodeId: string, draft: (prev: SplatBlock | undefined) => SceneBlockDraft, assets: SceneAssets): Promise<NodeRecord> {
  assertCanWrite()
  const prev = requireMemory(nodeId)
  const base = draft(prev.splat)
  const store = getStore()
  const now = Date.now()
  const ids: Pick<SplatBlock, 'interiorAssetId' | 'proxyAssetId' | 'thumbAssetId'> = {
    interiorAssetId: prev.splat?.interiorAssetId ?? null,
    proxyAssetId: prev.splat?.proxyAssetId ?? null,
    thumbAssetId: prev.splat?.thumbAssetId ?? null,
  }
  const written: string[] = []
  let record: NodeRecord
  try {
    for (const slot of SLOTS) {
      const a = assets[slot]
      if (a === undefined) continue
      if (a === null) {
        ids[FIELD[slot]] = null
        continue
      }
      const id = crypto.randomUUID()
      await store.putBlob({ meta: { id, kind: KIND[slot], mime: a.mime, bytes: byteLength(a.data), createdAt: now, nodeId }, data: a.data })
      written.push(id)
      ids[FIELD[slot]] = id
    }
    const block: SplatBlock = { ...base, ...ids }
    const issues = sceneBlockIssues(block)
    if (issues.length > 0) throw new SceneError(`Invalid scene: ${issues.join('; ')}`)
    record = await updateNode(nodeId, { splat: block })
  } catch (e) {
    for (const id of written) await store.deleteBlob(id).catch(() => {})
    throw e
  }
  await sweep(nodeId, record.splat)
  return record
}

/**
 * Delete splat blobs of `nodeId` that `keep` no longer references: the replaced ones, plus
 * orphans left by an ingest that died between its blob writes and its cleanup.
 */
async function sweep(nodeId: string, keep: SplatBlock | undefined): Promise<string[]> {
  const store = getStore()
  const live = new Set([keep?.interiorAssetId, keep?.proxyAssetId, keep?.thumbAssetId].filter((x): x is string => !!x))
  const stale = (await store.listAssets()).filter((m) => m.nodeId === nodeId && SPLAT_KINDS.has(m.kind) && !live.has(m.id)).map((m) => m.id)
  for (const id of stale) await store.deleteBlob(id).catch((e) => console.warn('[scenes] blob delete failed', id, e))
  return stale
}

/**
 * Give a memory its volumetric scene, replacing any previous one (whose blobs are deleted
 * once the new record is committed). `assets.interior` is required.
 */
export function attachScene(nodeId: string, block: SceneBlockDraft, assets: SceneAssets): Promise<NodeRecord> {
  if (!assets.interior) return Promise.reject(new SceneError('attachScene needs the interior asset'))
  const all: SceneAssets = { interior: assets.interior, proxy: assets.proxy ?? null, thumb: assets.thumb ?? null }
  return serial(nodeId, () => writeScene(nodeId, () => block, all))
}

/**
 * Change the framing numbers (crop, up-fix, entry pose, …) and optionally swap derived blobs
 * (proxy / thumbnail) of an existing scene. The interior is never re-encoded here.
 */
export function updateScene(nodeId: string, patch: Partial<SceneBlockDraft>, assets: Omit<SceneAssets, 'interior'> = {}): Promise<NodeRecord> {
  return serial(nodeId, () =>
    writeScene(
      nodeId,
      (prev) => {
        if (!prev) throw new SceneError('This memory has no volumetric scene')
        return { ...stripIds(prev), ...patch }
      },
      { proxy: assets.proxy, thumb: assets.thumb },
    ),
  )
}

export interface ScenePatch {
  crop?: SplatBlock['crop']
  upFix?: SplatBlock['upFix']
  entryPose?: SplatBlock['entryPose']
}

/**
 * Save a scene's framing (crop, up-fix, entry pose): numbers only. The crop is a render-time
 * SplatEdit BOX on the stored full interior, so nothing is re-encoded; the proxy and the
 * thumbnail keep their old framing until rebuildScene (world/splats/ingest) refreshes them.
 */
export function reframeScene(nodeId: string, patch: ScenePatch): Promise<NodeRecord> {
  const clean: Partial<SceneBlockDraft> = {}
  if (patch.crop !== undefined) clean.crop = patch.crop ? { min: [...patch.crop.min], max: [...patch.crop.max] } : null
  if (patch.upFix !== undefined) clean.upFix = [...patch.upFix]
  if (patch.entryPose !== undefined) clean.entryPose = { ...patch.entryPose, position: [...patch.entryPose.position], quaternion: [...patch.entryPose.quaternion] }
  return updateScene(nodeId, clean)
}

/** Remove a memory's scene: the record first, then its blobs. */
export function detachScene(nodeId: string): Promise<NodeRecord> {
  return serial(nodeId, async () => {
    assertCanWrite()
    const prev = requireMemory(nodeId)
    const record = prev.splat ? await updateNode(nodeId, { splat: undefined }) : prev
    await sweep(nodeId, undefined)
    return record
  })
}
