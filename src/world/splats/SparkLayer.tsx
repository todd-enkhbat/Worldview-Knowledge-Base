import { useLayoutEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Group, Vector3, type Camera, type Scene, type WebGLRenderer } from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import { useApp } from '../../app/store.ts'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { setFlyInReady } from '../nodes/instancing.ts'
import { isBorn, readPose } from '../poses.ts'
import { liveStats } from '../renderStats.ts'
import { getDiorama, listDioramas, liveSplatMeshes } from './Diorama.tsx'
import { flightLodScale } from './FlyInRig.tsx'
import { isWorldHidden } from './flyIn.ts'
import { getSpark, setSpark, setSplatStage } from './sparkRegistry.ts'
import { assignTiers, lodSplatBudget, publishCrystal, tiersChanged, useSplatTiers, type SplatTier, type TierCandidate } from './tiers.ts'

// The world's ONE SparkRenderer (CLAUDE.md), plus the tier manager that decides which
// dioramas are impostors, resident proxies or the focused interior, and the LoD budget.
//
// - Added to the scene as an object on LAYER.SPLATS only: drei's reflector camera renders
//   layer 0, so it never sees (or re-sorts for) the splats (S1 leak control: −40 % fps).
// - material.forceSinglePass: the material is transparent + DoubleSide, so three would draw
//   it twice (back, then front faces) with no visual difference (S1: 2× triangles and GPU).
// - lodSplatCount follows the quality ladder, lowered so Σ proxies + focused ≤ 2M.
// - lodCleanupTimeoutMs = Infinity only while a focused interior exists, so its LoD tree
//   survives while it is hidden at blend 0; Spark's default (3 s) otherwise.

/** Spark's default lodCleanupTimeoutMs. */
export const LOD_CLEANUP_DEFAULT_MS = 3000
/** Tier reassignment rate (Hz); the budget is applied every frame. */
const TIER_HZ = 10

const _cam = new Vector3()
const _pos = new Vector3()

let lastTiers: ReadonlyMap<string, SplatTier> = new Map()
let lastFocus: string | null = null
let sinceTiers = Infinity
let lastPublishedLod = -1
let lastPublishedResident = -1

function updateTiers(camera: Camera, focusedId: string | null): void {
  // Inside a diorama or while framing the world is hidden: keep the other dioramas as they
  // were (no loads for things nobody can see, no reload burst on the way out).
  const frozen = isWorldHidden()
  camera.getWorldPosition(_cam)
  const candidates: TierCandidate[] = []
  for (const d of listDioramas()) {
    const b = d.block
    candidates.push({
      id: d.id,
      distance: readPose(d.id, _pos) ? _cam.distanceTo(_pos) : Infinity,
      born: isBorn(d.id),
      hasProxy: b.proxyAssetId !== null,
      hasThumb: b.thumbAssetId !== null,
      canFocus: b.proxyAssetId !== null || b.interiorAssetId !== null,
    })
  }
  const next = assignTiers(candidates, focusedId, lastTiers)
  if (frozen) {
    for (const [id, t] of next) {
      const was = lastTiers.get(id)
      if (t !== 'focused' && was !== undefined && was !== 'focused') next.set(id, was)
    }
  }
  for (const d of listDioramas()) d.setTier(next.get(d.id) ?? 'none')
  if (tiersChanged(next, lastTiers)) {
    lastTiers = next
    useSplatTiers.setState({ tiers: next })
  }
  if (!focusedId || !getDiorama(focusedId)) publishCrystal({ id: null, phase: 'idle', progress: 0 })
}

function applyBudget(spark: SparkRenderer, qualityLod: number, focusedId: string | null): void {
  let resident = 0
  for (const d of listDioramas()) resident += d.residentProxySplats()
  const lod = lodSplatBudget(qualityLod, resident)
  spark.lodSplatCount = lod
  spark.lodSplatScale = flightLodScale()
  const focused = getDiorama(focusedId)
  spark.lodCleanupTimeoutMs = focused?.interior ? Infinity : LOD_CLEANUP_DEFAULT_MS
  if (lod !== lastPublishedLod || resident !== lastPublishedResident) {
    lastPublishedLod = lod
    lastPublishedResident = resident
    useSplatTiers.setState({ lodSplatCount: lod, residentProxySplats: resident })
  }
}

function createSpark(gl: WebGLRenderer, scene: Scene): () => void {
  // lodRaycast 0: Spark's LoD raycast (default 25k splats every 500 ms) is splat picking too.
  const spark = new SparkRenderer({ renderer: gl, lodSplatCount: useApp.getState().quality.lodSplatCount, lodRaycast: 0 })
  spark.name = 'spark-renderer'
  spark.renderOrder = RENDER_ORDER.SPLATS
  spark.layers.set(LAYER.SPLATS)
  spark.material.forceSinglePass = true
  // Splat picking is off (CPU poses do picking).
  spark.raycast = () => {}
  const stage = new Group()
  stage.name = 'splat-stage'
  scene.add(spark, stage)
  setSpark(spark)
  setSplatStage(stage)
  setFlyInReady(true)
  return () => {
    setFlyInReady(false)
    setSplatStage(null)
    if (getSpark() === spark) setSpark(null)
    scene.remove(spark, stage)
    spark.dispose()
    lastTiers = new Map()
    sinceTiers = Infinity
    lastPublishedLod = -1
    lastPublishedResident = -1
  }
}

export function SparkLayer() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)

  useLayoutEffect(() => createSpark(gl, scene), [gl, scene])

  // Before the camera writers' consumers render; tiers at TIER_HZ, budget every frame.
  useFrame((state, dt) => {
    const spark = getSpark()
    if (!spark) return
    const app = useApp.getState()
    sinceTiers += dt
    if (sinceTiers >= 1 / TIER_HZ || app.focusedId !== lastFocus) {
      sinceTiers = 0
      lastFocus = app.focusedId
      updateTiers(state.camera, app.focusedId)
    }
    applyBudget(spark, app.quality.lodSplatCount, app.focusedId)
  }, -1)

  return null
}

// ─── dev stats (window.__wv.splatStats) ──────────────────────────────────────────────

export interface SplatStats {
  /** SplatMeshes in the scene graph right now. */
  meshes: number
  /** SplatMeshes created by dioramas and not yet disposed (should return to baseline). */
  liveMeshes: number
  activeSplats: number
  lodSplatCount: number | undefined
  lodSplatScale: number | undefined
  lodCleanupTimeoutMs: number | undefined
  residentProxySplats: number
  tiers: Record<string, SplatTier>
  crystal: ReturnType<typeof useSplatTiers.getState>['crystal']
  renderer: { calls: number; triangles: number; points: number; geometries: number; textures: number; programs: number }
  /** Chrome only: JS heap bytes in use. */
  jsHeapUsed: number | null
}

export function splatStats(): SplatStats {
  const spark = getSpark()
  let meshes = 0
  spark?.parent?.traverse((o) => {
    if (o instanceof SplatMesh) meshes++
  })
  const t = useSplatTiers.getState()
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  return {
    meshes,
    liveMeshes: liveSplatMeshes(),
    activeSplats: spark?.activeSplats ?? 0,
    lodSplatCount: spark?.lodSplatCount,
    lodSplatScale: spark?.lodSplatScale,
    lodCleanupTimeoutMs: spark?.lodCleanupTimeoutMs,
    residentProxySplats: t.residentProxySplats,
    tiers: Object.fromEntries(t.tiers),
    crystal: t.crystal,
    renderer: {
      calls: liveStats.calls,
      triangles: liveStats.triangles,
      points: liveStats.points,
      geometries: liveStats.geometries,
      textures: liveStats.textures,
      programs: liveStats.programs,
    },
    jsHeapUsed: mem?.usedJSHeapSize ?? null,
  }
}
