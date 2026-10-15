import { Group, Vector3 } from 'three'
import {
  SplatEdit,
  SplatEditRgbaBlendMode,
  SplatEditSdf,
  SplatEditSdfType,
  SplatMesh,
  type SparkRenderer,
} from '@sparkjsdev/spark'
import { LAYER, RENDER_ORDER } from '../../world/layers.ts'
import { fetchSplatBytes, fitCrop, quantileBox, type Fit, type FixtureSpec } from './fixtures.ts'
import { BOX_HALF, makeGlassBox, type GlassBox } from './glass.ts'
import { buildProxy, coverage, lodLeaves, lodLevelCounts, waitForLodTree } from './proxy.ts'
import { useS1, type DioramaMode, type ProxyMethod } from './state.ts'

// One diorama: a fixture as a `lod: true` SplatMesh in a glass box, clipped to its crop box
// by a SplatEdit with one SplatEditSdf BOX, plus in-browser decimated proxies. Row A holds
// the full mesh or a proxy; row B (mode 'both') holds the proxy beside it for comparison.

const FIT_HALF = BOX_HALF - 0.08

export function setSplatLayer(obj: { layers: { set(n: number): void; enable(n: number): void } }, leak: boolean): void {
  obj.layers.set(LAYER.SPLATS)
  if (leak) obj.layers.enable(LAYER.SOLID)
}

/** Clip a mesh to its crop box: alpha × 0 outside (the SDF is inverted). */
export function addClip(mesh: SplatMesh, fit: Fit): void {
  const edit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, sdfSmooth: 0, softEdge: 0 })
  const box = new SplatEditSdf({ type: SplatEditSdfType.BOX, invert: true, opacity: 0 })
  box.position.copy(fit.cropCentre)
  box.scale.copy(fit.cropHalf)
  edit.add(box)
  mesh.add(edit)
}

function pose(mesh: SplatMesh, fit: Fit): void {
  mesh.quaternion.copy(fit.quaternion)
  mesh.scale.setScalar(fit.scale)
  mesh.position.copy(fit.position)
}

export class Diorama {
  readonly rowA = new Group()
  readonly rowB = new Group()
  readonly glassA: GlassBox
  readonly glassB: GlassBox
  full: SplatMesh | null = null
  fit: Fit | null = null
  /** Row-A and row-B instances per method (row B shares row A's PackedSplats). */
  readonly proxies = new Map<ProxyMethod, { a: SplatMesh; b: SplatMesh }>()
  private building = new Map<ProxyMethod, Promise<void>>()
  private mode: DioramaMode = 'lod'
  private method: ProxyMethod = 'cut'
  private leak = false
  disposed = false

  readonly index: number
  readonly spec: FixtureSpec

  constructor(index: number, spec: FixtureSpec, centreA: Vector3, centreB: Vector3) {
    this.index = index
    this.spec = spec
    this.glassA = makeGlassBox()
    this.glassB = makeGlassBox()
    this.rowA.position.copy(centreA)
    this.rowB.position.copy(centreB)
    this.rowA.add(this.glassA.group)
    this.rowB.add(this.glassB.group)
  }

  private report(patch: Parameters<ReturnType<typeof useS1.getState>['setDiorama']>[1]): void {
    if (!this.disposed) useS1.getState().setDiorama(this.index, patch)
  }

  async load(spark: SparkRenderer): Promise<void> {
    const t0 = performance.now()
    this.report({ name: this.spec.name, status: 'fetching', proxies: {} })
    try {
      const { bytes, fileType, convertMs } = await fetchSplatBytes(this.spec.url)
      this.report({ status: 'decoding + LoD', convertMs })
      const full = new SplatMesh({ fileBytes: bytes, fileType, lod: true })
      await full.initialized
      if (this.disposed) return full.dispose()
      const lod = full.packedSplats?.lodSplats
      if (!lod) throw new Error('no LoD splats after load')
      const crop = quantileBox(lod, this.spec.cropLo, this.spec.cropHi)
      this.fit = fitCrop(crop, this.spec.euler, FIT_HALF)
      pose(full, this.fit)
      addClip(full, this.fit)
      setSplatLayer(full, this.leak)
      full.renderOrder = RENDER_ORDER.SPLATS
      this.full = full
      this.rowA.add(full)
      const leaves = lodLeaves(lod, Number.MAX_SAFE_INTEGER).length
      this.report({ status: 'waiting for LoD tree', loadMs: Math.round(performance.now() - t0), splats: leaves, lodSplats: lod.numSplats })
      this.apply()
      const lodReadyMs = Math.round(await waitForLodTree(spark, full))
      this.report({ status: 'building proxies', lodReadyMs, levels: await lodLevelCounts(spark, full) })
      await this.ensureProxy(spark, 'cut')
      await this.ensureProxy(spark, 'level')
      this.report({ status: 'ready' })
    } catch (e) {
      console.error(`[s1] ${this.spec.name}`, e)
      this.report({ status: 'error', error: String(e) })
    }
  }

  ensureProxy(spark: SparkRenderer, method: ProxyMethod): Promise<void> {
    const existing = this.building.get(method)
    if (existing) return existing
    const job = (async () => {
      const full = this.full
      const fit = this.fit
      if (!full || !fit) return
      // The LoD tree is only alive while the full mesh renders (lodCleanupTimeoutMs).
      const wasVisible = full.visible
      full.visible = true
      await waitForLodTree(spark, full)
      const built = await buildProxy(spark, full, method)
      full.visible = wasVisible
      if (this.disposed) return built.mesh.dispose()
      const lod = full.packedSplats!.lodSplats!
      built.info.coverage = coverage(lod, lodLeaves(lod), built.mesh.packedSplats!)
      const a = built.mesh
      const b = new SplatMesh({ packedSplats: a.packedSplats })
      await b.initialized
      for (const m of [a, b]) {
        pose(m, fit)
        addClip(m, fit)
        setSplatLayer(m, this.leak)
        m.renderOrder = RENDER_ORDER.SPLATS
      }
      this.rowA.add(a)
      this.rowB.add(b)
      this.proxies.set(method, { a, b })
      const prev = useS1.getState().dioramas[this.index]?.proxies ?? {}
      this.report({ proxies: { ...prev, [method]: built.info } })
      this.apply()
    })()
    this.building.set(method, job)
    return job
  }

  setMode(mode: DioramaMode, method: ProxyMethod, spark: SparkRenderer | null): void {
    this.mode = mode
    this.method = method
    if (mode !== 'lod' && spark && this.full && !this.proxies.has(method)) void this.ensureProxy(spark, method)
    this.apply()
  }

  setLeak(leak: boolean): void {
    this.leak = leak
    const all = [this.full, ...[...this.proxies.values()].flatMap((p) => [p.a, p.b])]
    for (const m of all) if (m) setSplatLayer(m, leak)
  }

  setDepthProxy(on: boolean, early: boolean): void {
    this.glassA.setDepthProxy(on, early)
    this.glassB.setDepthProxy(on, early)
  }

  private apply(): void {
    const proxy = this.proxies.get(this.method)
    if (this.full) this.full.visible = this.mode !== 'proxy'
    for (const [m, p] of this.proxies) {
      p.a.visible = this.mode === 'proxy' && m === this.method
      p.b.visible = this.mode === 'both' && m === this.method
    }
    this.rowB.visible = this.mode === 'both'
    if (this.full && this.mode === 'proxy' && !proxy) this.full.visible = true
  }

  dispose(): void {
    this.disposed = true
    this.full?.dispose()
    for (const p of this.proxies.values()) {
      p.b.dispose()
      p.a.dispose()
    }
    this.proxies.clear()
  }
}
