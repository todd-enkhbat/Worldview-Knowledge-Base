import { Group, Vector3 } from 'three'
import { SplatMesh, type SparkRenderer } from '@sparkjsdev/spark'
import { RENDER_ORDER } from '../../world/layers.ts'
import { fetchSplatBytes, fitCrop, quantileBox, type Fit } from './fixtures.ts'
import { BOX_HALF, makeGlassBox } from './glass.ts'
import { addClip, setSplatLayer } from './diorama.ts'

// The two motion tests.
//
// MovingLod (#347): a `lod: true` lion that moves sinusoidally every frame. The LoD cut is
// computed on the worker for the mesh's last known transform, so a moving LoD mesh may
// only get new indices (and a new display) at the traversal/sort rate.
//
// TweenStage (fly-in step 1): a non-LoD proxy scaled exponentially about the entry pose,
// s(u) = S^u, with spark.lodSplatScale lowered while the tween runs.

export const MOVING_CENTRE = new Vector3(0, 1.3, 6)
export const STAGE_CENTRE = new Vector3(0, BOX_HALF + 0.2, -13)

export class MovingLod {
  readonly group = new Group()
  mesh: SplatMesh | null = null
  private leak = false
  disposed = false

  async load(): Promise<void> {
    const { bytes, fileType } = await fetchSplatBytes('/fixtures/lion.v3.spz')
    const mesh = new SplatMesh({ fileBytes: bytes, fileType, lod: true })
    await mesh.initialized
    if (this.disposed) return mesh.dispose()
    const lod = mesh.packedSplats!.lodSplats!
    const fit = fitCrop(quantileBox(lod, [0.002, 0.002, 0.002], [0.998, 0.998, 0.998]), [Math.PI, 0, 0], 1.1)
    mesh.quaternion.copy(fit.quaternion)
    mesh.scale.setScalar(fit.scale)
    mesh.position.copy(fit.position)
    mesh.renderOrder = RENDER_ORDER.SPLATS
    setSplatLayer(mesh, this.leak)
    this.mesh = mesh
    this.group.add(mesh)
  }

  setLeak(leak: boolean): void {
    this.leak = leak
    if (this.mesh) setSplatLayer(this.mesh, leak)
  }

  update(t: number): void {
    this.group.position.set(MOVING_CENTRE.x + 7 * Math.sin((2 * Math.PI * t) / 6), MOVING_CENTRE.y, MOVING_CENTRE.z)
    this.group.rotation.y = 0.5 * t
  }

  dispose(): void {
    this.disposed = true
    this.mesh?.dispose()
  }
}

/** 0 → 1 → hold → 0 → rest; returns u ∈ [0, 1] and whether the scale is changing or held. */
export function tweenPhase(t: number, period = 6): { u: number; active: boolean } {
  const x = ((t % period) + period) % period
  const ease = (a: number) => a * a * (3 - 2 * a)
  if (x < 2) return { u: ease(x / 2), active: true }
  if (x < 3) return { u: 1, active: true }
  if (x < 5) return { u: ease(1 - (x - 3) / 2), active: true }
  return { u: 0, active: false }
}

export class TweenStage {
  readonly group = new Group()
  mesh: SplatMesh | null = null
  private fit: Fit | null = null
  /** Entry pose: the centre of the stage box's front face (+z), in world space. */
  readonly pivot = STAGE_CENTRE.clone().add(new Vector3(0, 0, BOX_HALF))
  readonly maxScale = 12
  /** lodSplatScale while the tween runs (1 otherwise). */
  readonly tweenLodScale = 0.5
  private leak = false
  private base = new Vector3()

  constructor() {
    const glass = makeGlassBox()
    glass.group.position.copy(STAGE_CENTRE)
    this.group.add(glass.group)
  }

  /** Shares the PackedSplats of an existing (non-LoD) proxy. */
  async attach(source: SplatMesh, fit: Fit): Promise<void> {
    if (this.mesh) return
    const mesh = new SplatMesh({ packedSplats: source.packedSplats })
    await mesh.initialized
    mesh.quaternion.copy(fit.quaternion)
    mesh.renderOrder = RENDER_ORDER.SPLATS
    setSplatLayer(mesh, this.leak)
    // The clip SDF is a child of the mesh, so the crop box scales with the tween.
    addClip(mesh, fit)
    this.fit = fit
    this.base.copy(fit.position).add(STAGE_CENTRE)
    this.mesh = mesh
    this.group.add(mesh)
    this.setScale(1)
  }

  setLeak(leak: boolean): void {
    this.leak = leak
    if (this.mesh) setSplatLayer(this.mesh, leak)
  }

  setScale(s: number): void {
    if (!this.mesh || !this.fit) return
    this.mesh.scale.setScalar(this.fit.scale * s)
    this.mesh.position.copy(this.base).sub(this.pivot).multiplyScalar(s).add(this.pivot)
  }

  /** Returns true while the tween is moving or holding. */
  update(t: number, enabled: boolean, spark: SparkRenderer | null): boolean {
    const { u, active } = enabled ? tweenPhase(t) : { u: 0, active: false }
    this.setScale(Math.pow(this.maxScale, u))
    if (spark) spark.lodSplatScale = active ? this.tweenLodScale : 1
    return active
  }

  dispose(): void {
    // The PackedSplats belong to the source proxy; only drop our generator.
    this.mesh?.removeFromParent()
  }
}
