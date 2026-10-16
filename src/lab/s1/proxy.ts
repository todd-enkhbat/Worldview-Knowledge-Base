import { Vector3 } from 'three'
import { PackedSplats, SplatFileType, SplatMesh, writeSpz, type SparkRenderer } from '@sparkjsdev/spark'
import {
  PROXY_BUDGET,
  lodLeaves,
  lodWorkerCall,
  selectSubsample,
  sparkInternals,
  traverseCut,
} from '../../world/splats/proxyBuild.ts'
import type { ProxyInfo, ProxyMethod } from './state.ts'

export { PROXY_BUDGET, lodLeaves, selectSubsample }

// In-browser decimated proxies (≤ PROXY_BUDGET splats) for the far-field dioramas.
//
// Three selectors over the LoD tree Spark builds for a `lod: true` mesh:
// - 'level' (PLAN): spark.getLodTreeLevel(mesh, L). Measured on lion: L is a tree depth
//   band, not a complete cut. Counts rise then fall with L (1, 8, … 92 889 at L = 20, then
//   85 483, … 12 at L = 29) and the bands overlap (they sum to ≈ 3× the node count): big
//   leaves drop out of deeper levels. Coverage of the full splat set peaks mid-tree.
// - 'cut': the LoD worker's own traverseLodTrees with maxSplats = budget, seen from far
//   away with foveation off, i.e. a view-independent, size-uniform complete cut. The core
//   now lives in src/world/splats/proxyBuild.ts (Phase 2 ingest) and is imported back here.
// - 'subsample': seeded importance sample by opacity × volume (no LoD tree needed).
// Each result is extracted, written as SPZ v3 (what Phase 2 stores) and re-parsed into a
// plain non-LoD SplatMesh, so the timing covers the full persist-and-reload path.

function lodSource(mesh: SplatMesh): PackedSplats {
  const lod = mesh.packedSplats?.lodSplats
  if (!lod) throw new Error('mesh has no LoD splats')
  return lod
}

/** Resolves once the LoD worker has a tree for this mesh (it must be rendered first). */
export async function waitForLodTree(spark: SparkRenderer, mesh: SplatMesh, timeoutMs = 60_000): Promise<number> {
  const t0 = performance.now()
  const s = sparkInternals(spark)
  while (!s.lodInstances.has(mesh)) {
    if (performance.now() - t0 > timeoutMs) throw new Error('LoD tree never initialised')
    await new Promise((r) => setTimeout(r, 50))
  }
  return performance.now() - t0
}

/** Count per getLodTreeLevel depth (cheap: indices only, no extraction). */
export async function lodLevelCounts(spark: SparkRenderer, mesh: SplatMesh): Promise<{ level: number; n: number }[]> {
  const lodId = sparkInternals(spark).lodInstances.get(mesh)?.lodId
  if (lodId === undefined) return []
  const out: { level: number; n: number }[] = []
  for (let level = 0; level < 64; level++) {
    const { indices } = await lodWorkerCall<{ indices: Uint32Array }>(spark, 'getLodTreeLevel', { lodId, level })
    if (indices.length === 0) break
    out.push({ level, n: indices.length })
  }
  return out
}

async function selectLevel(spark: SparkRenderer, mesh: SplatMesh, budget: number): Promise<{ splats: PackedSplats; level: number }> {
  // The largest level within budget on the rising side of the band profile (up to the
  // peak). Past the peak, levels lose big leaves and coverage collapses (hall: L36 has
  // 83k splats but covers 29 % of the occupied cells).
  const counts = await lodLevelCounts(spark, mesh)
  let peak = 0
  for (let i = 1; i < counts.length; i++) if (counts[i].n > counts[peak].n) peak = i
  let best = counts[0]
  for (let i = 0; i <= peak; i++) if (counts[i].n <= budget && counts[i].n > best.n) best = counts[i]
  const proxy = await spark.getLodTreeLevel(mesh, best.level)
  if (!proxy?.packedSplats) throw new Error('getLodTreeLevel returned nothing')
  const splats = proxy.packedSplats
  return { splats, level: best.level }
}

async function selectCut(spark: SparkRenderer, mesh: SplatMesh, budget: number): Promise<PackedSplats> {
  const lodId = sparkInternals(spark).lodInstances.get(mesh)?.lodId
  if (lodId === undefined) throw new Error('no LoD instance')
  const lod = lodSource(mesh)
  const indices = await sparkInternals(spark)
    .ensureLodWorker()
    .exclusive((w) => traverseCut(w, lodId, lod, budget))
  return lod.extractSplats(indices, false)
}

export interface BuiltProxy {
  mesh: SplatMesh
  info: ProxyInfo
}

export async function buildProxy(spark: SparkRenderer, mesh: SplatMesh, method: ProxyMethod, budget = PROXY_BUDGET): Promise<BuiltProxy> {
  const t0 = performance.now()
  let splats: PackedSplats
  let level: number | undefined
  if (method === 'level') {
    const r = await selectLevel(spark, mesh, budget)
    splats = r.splats
    level = r.level
  } else if (method === 'cut') {
    splats = await selectCut(spark, mesh, budget)
  } else {
    const lod = lodSource(mesh)
    splats = selectSubsample(lod, lodLeaves(lod, Number.MAX_SAFE_INTEGER), budget)
  }
  const t1 = performance.now()
  const { fileBytes } = await writeSpz(splats, { version: 3 })
  const out = new SplatMesh({ fileBytes: fileBytes.slice(), fileType: SplatFileType.SPZ })
  await out.initialized
  const t2 = performance.now()
  const info: ProxyInfo = {
    method,
    level,
    splats: out.packedSplats?.numSplats ?? 0,
    selectMs: Math.round(t1 - t0),
    writeMs: Math.round(t2 - t1),
    bytes: fileBytes.length,
  }
  splats.dispose()
  return { mesh: out, info }
}

/**
 * Centre-occupancy coverage of `subset` against the full-resolution leaves of `lod`, on a
 * G³ grid over the leaves' bounds: the share of occupied cells (and of opacity mass) that
 * the subset also occupies. Centres only, so it under-credits coarse splats a little.
 */
export function coverage(lod: PackedSplats, leaves: Uint32Array, subset: PackedSplats, G = 48): { cells: number; mass: number } {
  const lo = new Vector3(Infinity, Infinity, Infinity)
  const hi = new Vector3(-Infinity, -Infinity, -Infinity)
  const centres = new Float32Array(leaves.length * 3)
  const opac = new Float32Array(leaves.length)
  for (let j = 0; j < leaves.length; j++) {
    const sp = lod.getSplat(leaves[j])
    centres[3 * j] = sp.center.x
    centres[3 * j + 1] = sp.center.y
    centres[3 * j + 2] = sp.center.z
    opac[j] = sp.opacity
    lo.min(sp.center)
    hi.max(sp.center)
  }
  const span = hi.clone().sub(lo).addScalar(1e-9)
  const f = (v: number, l: number, s: number) => Math.min(G - 1, Math.max(0, Math.floor(((v - l) / s) * G)))
  const key = (x: number, y: number, z: number) => (f(x, lo.x, span.x) * G + f(y, lo.y, span.y)) * G + f(z, lo.z, span.z)
  const fullMass = new Float32Array(G * G * G)
  for (let j = 0; j < leaves.length; j++) fullMass[key(centres[3 * j], centres[3 * j + 1], centres[3 * j + 2])] += opac[j]
  const occ = new Uint8Array(G * G * G)
  subset.forEachSplat((_i, c) => {
    occ[key(c.x, c.y, c.z)] = 1
  })
  // A cell counts as occupied when its sampled leaves add up to half an opaque splat.
  const minMass = 0.5
  let cells = 0
  let covered = 0
  let mass = 0
  let coveredMass = 0
  for (let k = 0; k < occ.length; k++) {
    if (fullMass[k] <= minMass) continue
    cells++
    mass += fullMass[k]
    if (occ[k]) {
      covered++
      coveredMass += fullMass[k]
    }
  }
  return { cells: round3(covered / Math.max(1, cells)), mass: round3(coveredMass / Math.max(1e-9, mass)) }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}
