import { useEffect, useLayoutEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BoxGeometry,
  Color,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Quaternion,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Texture,
  Vector3,
  type Camera,
  type Object3D,
} from 'three'
import {
  SplatEdit,
  SplatEditRgbaBlendMode,
  SplatEditSdf,
  SplatEditSdfType,
  SplatFileType,
  SplatMesh,
  type PackedSplats,
} from '@sparkjsdev/spark'
import type { Quat, SplatBlock } from '../../domain/types.ts'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { TESSERACT } from '../nodes/geometry.ts'
import { farScale } from '../nodes/instancing.ts'
import { readPose } from '../poses.ts'
import { loadSplatBytes } from './assets.ts'
import { FLIGHT, fitBox, isWorldHidden, type Box, type DioramaFit } from './flyIn.ts'
import { getSpark, whenSpark } from './sparkRegistry.ts'
import { crystalProgress, publishCrystal, type CrystalPhase, type SplatTier } from './tiers.ts'

// One memory's splat diorama ("glass terrarium"), mounted by the tesseract's diorama slot.
//
//   anchor (R3F group in the slot, on the memory's basis)
//   └ content          far-boost scale; lifted into the splat stage for flights and framing
//     ├ impostor       thumbnail sprite (tier 'impostor', or while the proxy loads)
//     └ fit            upFix rotation + uniform scale + offset: crop box → tesseract inner cube
//       ├ proxy        ≤ 100k non-LoD SplatMesh, clipped by its own SplatEdit BOX
//       ├ interior     lod:true SplatMesh (tier 'focused' only), clipped likewise
//       └ crop lines   framing only: the draft crop as a wireframe
//
// The glass shells and the depth proxy come from the tesseract family itself (nodes/
// archetypes.tsx: back shell −1, front shell 1, depth proxy 100 with transparent:true), so
// the diorama adds splats (renderOrder 0, LAYER.SPLATS) and the impostor only.
//
// A SplatEdit is applied to the SplatMesh it is a descendant of; one that is NOT under a
// SplatMesh is global and would clip every splat in the world, so each mesh gets its own.

/** Half-size of the cube a diorama is fitted into: the tesseract's inner cube, inset. */
export const DIORAMA_HALF = TESSERACT.inner - 0.03
/** Framing: the full (unclipped) scene is fitted into a cube of this half-size (world units). */
export const FRAMING_HALF = 4

type LoadState = 'none' | 'loading' | 'ready' | 'error'

// ─── mesh bookkeeping ───────────────────────────────────────────────────────────────

let liveMeshes = 0

/** SplatMeshes created by the dioramas and not yet disposed (leak check for the dev hooks). */
export function liveSplatMeshes(): number {
  return liveMeshes
}

function prepareMesh(m: SplatMesh): SplatMesh {
  liveMeshes++
  m.layers.set(LAYER.SPLATS)
  m.renderOrder = RENDER_ORDER.SPLATS
  // Picking uses CPU poses (PLAN); raycastable:false already makes Spark's raycast a no-op.
  m.raycast = () => {}
  return m
}

function disposeMesh(m: SplatMesh | null): void {
  if (!m) return
  m.removeFromParent()
  // SplatEdits has no dispose(); its SDF texture is the only GPU resource it holds.
  if (m.rgbaDisplaceEdits) {
    m.rgbaDisplaceEdits.sdfTexture.dispose()
    m.rgbaDisplaceEdits = null
  }
  m.dispose()
  liveMeshes--
}

interface Clip {
  edit: SplatEdit
  box: SplatEditSdf
}

/** Clip a mesh to a native-units box: alpha × 0 outside (inverted SDF), as in S1. */
function addClip(mesh: SplatMesh): Clip {
  const edit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, sdfSmooth: 0, softEdge: 0 })
  const box = new SplatEditSdf({ type: SplatEditSdfType.BOX, invert: true, opacity: 0 })
  edit.add(box)
  mesh.add(edit)
  return { edit, box }
}

function setClip(clip: Clip | null, crop: Box | null, enabled: boolean): void {
  if (!clip) return
  // Spark gathers edits with traverseVisible, so a hidden edit is simply not applied.
  clip.edit.visible = enabled && crop !== null
  if (!crop) return
  clip.box.position.set((crop.min[0] + crop.max[0]) / 2, (crop.min[1] + crop.max[1]) / 2, (crop.min[2] + crop.max[2]) / 2)
  clip.box.scale.set(
    Math.max(1e-4, Math.abs(crop.max[0] - crop.min[0]) / 2),
    Math.max(1e-4, Math.abs(crop.max[1] - crop.min[1]) / 2),
    Math.max(1e-4, Math.abs(crop.max[2] - crop.min[2]) / 2),
  )
}

/**
 * Robust bounds (native units): the lo/hi quantiles of sampled splat centres per axis, so
 * far floaters (sky splats hundreds of metres out) do not shrink the scene to a speck.
 */
export function quantileBounds(packed: PackedSplats | undefined, lo = 0.01, hi = 0.99, samples = 40_000): Box | null {
  const n = packed?.numSplats ?? 0
  if (!packed || n === 0) return null
  const k = Math.min(n, samples)
  const xs = new Float32Array(k)
  const ys = new Float32Array(k)
  const zs = new Float32Array(k)
  const step = n / k
  for (let i = 0; i < k; i++) {
    const c = packed.getSplat(Math.min(n - 1, Math.floor(i * step))).center
    xs[i] = c.x
    ys[i] = c.y
    zs[i] = c.z
  }
  const q = (a: Float32Array, f: number) => a[Math.min(k - 1, Math.max(0, Math.round(f * (k - 1))))]
  xs.sort()
  ys.sort()
  zs.sort()
  return { min: [q(xs, lo), q(ys, lo), q(zs, lo)], max: [q(xs, hi), q(ys, hi), q(zs, hi)] }
}

/** quantileBounds of a mesh's splats, falling back to its LoD splats. */
export function meshBounds(mesh: SplatMesh | null, lo = 0.01, hi = 0.99): Box | null {
  if (!mesh) return null
  try {
    const b = quantileBounds(mesh.packedSplats, lo, hi)
    if (b) return b
  } catch {
    // a lod:true mesh may keep only its LoD splats
  }
  try {
    return quantileBounds(mesh.packedSplats?.lodSplats, lo, hi)
  } catch {
    return null
  }
}

// Shared by every diorama (never disposed: module lifetime).
const CROP_EDGES = new EdgesGeometry(new BoxGeometry(2, 2, 2))
const CROP_MAT = new LineBasicMaterial({
  color: new Color('#e8b04a').multiplyScalar(2.2),
  transparent: true,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
})

const _p = new Vector3()
const _s = new Vector3()
const _q = new Quaternion()

// ─── the diorama ────────────────────────────────────────────────────────────────────

/** Framing view: the draft up-fix and crop (native units) being edited. */
export interface FramingView {
  upFix: Quat
  crop: Box | null
}

export class DioramaInstance {
  readonly id: string
  readonly content = new Group()
  readonly fitGroup = new Group()
  block: SplatBlock
  fit: DioramaFit | null = null
  tier: SplatTier = 'none'
  proxy: SplatMesh | null = null
  interior: SplatMesh | null = null
  proxyState: LoadState = 'none'
  interiorPhase: CrystalPhase = 'idle'
  interiorError: string | undefined
  /** 0 = proxy, 1 = interior. Animated toward blendTarget once the interior is live. */
  blend = 0
  blendTarget: 0 | 1 = 0
  /** Content is in the splat stage (flight or framing) instead of its slot. */
  lifted = false
  framing: FramingView | null = null
  disposed = false

  private anchor: Object3D | null = null
  private impostor: Sprite | null = null
  private thumbBitmap: ImageBitmap | null = null
  private thumbState: LoadState = 'none'
  private proxyClip: Clip | null = null
  private interiorClip: Clip | null = null
  private cropLines: LineSegments | null = null
  private proxyToken = 0
  private interiorToken = 0
  private thumbToken = 0
  /** Native bounds of the first loaded mesh, used to fit when the block has no crop. */
  private loadedBounds: Box | null = null
  /** Framing bounds (native, unclipped) and which mesh they came from. */
  private framingBox: Box | null = null
  private framingFrom: 'interior' | 'proxy' | 'crop' | null = null
  private phaseSince = 0

  constructor(id: string, block: SplatBlock) {
    this.id = id
    this.block = block
    this.content.name = 'diorama-content'
    this.content.userData.nodeId = id
    this.fitGroup.name = 'diorama-fit'
    this.content.add(this.fitGroup)
    this.refit()
  }

  // ── placement ──

  attach(anchor: Object3D): void {
    this.anchor = anchor
    if (!this.lifted) anchor.add(this.content)
  }

  /** Move the content into the stage (world-space parent); the caller drives its matrix. */
  lift(stage: Object3D): void {
    this.lifted = true
    stage.add(this.content)
  }

  /** Back into the slot at rest. */
  restore(): void {
    this.lifted = false
    this.content.position.set(0, 0, 0)
    this.content.quaternion.identity()
    this.content.scale.setScalar(1)
    if (this.anchor && !this.disposed) this.anchor.add(this.content)
    else this.content.removeFromParent()
    this.updateVisibility()
  }

  setContentMatrix(m: Matrix4): void {
    m.decompose(this.content.position, this.content.quaternion, this.content.scale)
  }

  /** Native splat frame → world (the meshes' world matrix). */
  meshWorld(): Matrix4 {
    this.fitGroup.updateWorldMatrix(true, false)
    return this.fitGroup.matrixWorld
  }

  /** World units per native unit right now. */
  worldPerNative(): number {
    this.meshWorld().decompose(_p, _q, _s)
    return Math.abs(_s.x)
  }

  // ── state queries for the rigs ──

  get proxyPending(): boolean {
    return this.proxyState === 'loading' || (this.proxyState === 'none' && this.block.proxyAssetId !== null && this.wantsProxy())
  }

  get interiorReady(): boolean {
    return this.interiorPhase === 'ready' && this.interior !== null
  }

  /** An interior is expected and still on its way. */
  get interiorPending(): boolean {
    if (!this.block.interiorAssetId) return false
    return this.interiorPhase !== 'ready' && this.interiorPhase !== 'error'
  }

  /** Splats this diorama's proxy currently draws (counts against the 2M budget). */
  residentProxySplats(): number {
    const p = this.proxy
    if (!p || !p.visible) return 0
    if (!this.lifted && (isWorldHidden() || !this.content.parent)) return 0
    return p.packedSplats?.numSplats ?? 0
  }

  // ── record updates ──

  setBlock(block: SplatBlock): void {
    const prev = this.block
    if (prev === block) return
    this.block = block
    if (prev.proxyAssetId !== block.proxyAssetId) this.dropProxy()
    if (prev.interiorAssetId !== block.interiorAssetId) this.dropInterior()
    if (prev.thumbAssetId !== block.thumbAssetId) this.dropThumb()
    if (!this.framing) this.refit()
    this.applyClips()
    this.applyTier()
  }

  setTier(tier: SplatTier): void {
    if (tier === this.tier) return
    this.tier = tier
    this.applyTier()
  }

  private wantsProxy(): boolean {
    return this.tier === 'proxy' || this.tier === 'focused' || this.lifted
  }

  private applyTier(): void {
    if (this.disposed) return
    if (this.wantsProxy()) this.ensureProxy()
    else this.dropProxy()
    if (this.tier === 'focused') this.ensureInterior()
    else if (!this.lifted) this.dropInterior()
    if (this.tier !== 'none' && this.block.thumbAssetId) this.ensureThumb()
    else this.dropThumb()
    this.updateVisibility()
  }

  /** Fit the crop (or the loaded bounds) into the tesseract's inner cube. */
  private refit(): void {
    const box = this.block.crop ?? this.loadedBounds
    if (!box) {
      this.fit = null
      this.fitGroup.visible = false
      return
    }
    this.fit = fitBox(box, this.block.upFix, DIORAMA_HALF)
    this.applyFit(this.fit)
  }

  private applyFit(fit: DioramaFit): void {
    this.fitGroup.position.copy(fit.position)
    this.fitGroup.quaternion.copy(fit.quaternion)
    this.fitGroup.scale.setScalar(fit.scale)
    this.fitGroup.visible = true
  }

  private applyClips(): void {
    const crop = this.block.crop
    const enabled = this.framing === null
    setClip(this.proxyClip, crop, enabled)
    setClip(this.interiorClip, crop, enabled)
  }

  // ── loading ──

  private ensureProxy(): void {
    const assetId = this.block.proxyAssetId
    if (this.proxyState !== 'none' || !assetId) return
    const token = ++this.proxyToken
    this.proxyState = 'loading'
    void (async () => {
      let mesh: SplatMesh | null = null
      try {
        const bytes = await loadSplatBytes(assetId)
        await whenSpark()
        if (token !== this.proxyToken || this.disposed) return
        mesh = prepareMesh(new SplatMesh({ fileBytes: bytes, fileType: SplatFileType.SPZ, raycastable: false }))
        await mesh.initialized
        if (token !== this.proxyToken || this.disposed) return disposeMesh(mesh)
        this.proxy = mesh
        this.proxyClip = addClip(mesh)
        this.proxyState = 'ready'
        if (!this.block.crop && !this.loadedBounds) {
          this.loadedBounds = meshBounds(mesh)
          if (!this.framing) this.refit()
        }
        this.fitGroup.add(mesh)
        this.applyClips()
        this.updateVisibility()
      } catch (e) {
        if (mesh && this.proxy !== mesh) disposeMesh(mesh)
        if (token !== this.proxyToken) return
        this.proxyState = 'error'
        console.error(`[splats] proxy for ${this.id}`, e)
      }
    })()
  }

  private dropProxy(): void {
    this.proxyToken++
    disposeMesh(this.proxy)
    this.proxy = null
    this.proxyClip = null
    this.proxyState = 'none'
  }

  private ensureInterior(): void {
    const assetId = this.block.interiorAssetId
    if (this.interiorPhase !== 'idle' || !assetId) return
    const token = ++this.interiorToken
    this.setPhase('loading')
    void (async () => {
      let mesh: SplatMesh | null = null
      try {
        const bytes = await loadSplatBytes(assetId)
        await whenSpark()
        if (token !== this.interiorToken || this.disposed) return
        this.setPhase('decoding')
        mesh = prepareMesh(new SplatMesh({ fileBytes: bytes, fileType: SplatFileType.SPZ, lod: true, raycastable: false }))
        await mesh.initialized
        if (token !== this.interiorToken || this.disposed) return disposeMesh(mesh)
        // Invisible but rendered: Spark builds a LoD tree only for a mesh it draws.
        mesh.opacity = 0
        this.interior = mesh
        this.interiorClip = addClip(mesh)
        if (!this.block.crop && !this.loadedBounds) {
          this.loadedBounds = meshBounds(mesh)
          if (!this.framing) this.refit()
        }
        this.fitGroup.add(mesh)
        this.applyClips()
        this.setPhase('growing')
        this.updateVisibility()
      } catch (e) {
        if (mesh && this.interior !== mesh) disposeMesh(mesh)
        if (token !== this.interiorToken) return
        this.interiorError = e instanceof Error ? e.message : String(e)
        this.setPhase('error')
        console.error(`[splats] interior for ${this.id}`, e)
      }
    })()
  }

  private dropInterior(): void {
    this.interiorToken++
    disposeMesh(this.interior)
    this.interior = null
    this.interiorClip = null
    this.interiorError = undefined
    this.blend = 0
    if (this.framingFrom === 'interior') {
      this.framingBox = null
      this.framingFrom = null
    }
    this.setPhase('idle')
  }

  private ensureThumb(): void {
    const assetId = this.block.thumbAssetId
    if (this.thumbState !== 'none' || !assetId) return
    const token = ++this.thumbToken
    this.thumbState = 'loading'
    void (async () => {
      try {
        const bytes = await loadSplatBytes(assetId)
        // flipY at decode: WebGL ignores UNPACK_FLIP_Y for ImageBitmap uploads.
        const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), { imageOrientation: 'flipY' })
        if (token !== this.thumbToken || this.disposed) return bitmap.close()
        const tex = new Texture(bitmap)
        tex.flipY = false
        tex.colorSpace = SRGBColorSpace
        tex.needsUpdate = true
        const sprite = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
        sprite.name = 'diorama-impostor'
        sprite.layers.set(LAYER.GLASS)
        sprite.renderOrder = RENDER_ORDER.SPLATS
        sprite.raycast = () => {}
        const w = 2 * DIORAMA_HALF
        const aspect = bitmap.width > 0 ? bitmap.height / bitmap.width : 1
        sprite.scale.set(aspect > 1 ? w / aspect : w, aspect > 1 ? w : w * aspect, 1)
        this.impostor = sprite
        this.thumbBitmap = bitmap
        this.thumbState = 'ready'
        this.content.add(sprite)
        this.updateVisibility()
      } catch (e) {
        if (token !== this.thumbToken) return
        this.thumbState = 'error'
        console.warn(`[splats] thumbnail for ${this.id}`, e)
      }
    })()
  }

  private dropThumb(): void {
    this.thumbToken++
    const s = this.impostor
    if (s) {
      s.removeFromParent()
      s.material.map?.dispose()
      s.material.dispose()
    }
    this.thumbBitmap?.close()
    this.thumbBitmap = null
    this.impostor = null
    this.thumbState = 'none'
  }

  // ── framing ──

  /** Unclipped native bounds for framing: the interior if live, else the proxy, else the crop. */
  framingBounds(): Box | null {
    const want = this.interiorReady ? 'interior' : this.proxy ? 'proxy' : this.block.crop ? 'crop' : null
    if (want && want !== this.framingFrom && !(this.framingFrom === 'interior' && want !== 'interior')) {
      const box =
        want === 'interior' ? meshBounds(this.interior, 0.005, 0.995)
        : want === 'proxy' ? meshBounds(this.proxy, 0.005, 0.995)
        : this.block.crop
      if (box) {
        this.framingBox = box
        this.framingFrom = want
      }
    }
    return this.framingBox
  }

  /** Enter/update (view) or leave (null) the framing view: unclipped, fitted to FRAMING_HALF. */
  setFraming(view: FramingView | null): void {
    this.framing = view
    if (!view) {
      if (this.cropLines) this.cropLines.visible = false
      this.refit()
      this.applyClips()
      this.updateVisibility()
      return
    }
    const bounds = this.framingBounds()
    if (bounds) this.applyFit(fitBox(bounds, view.upFix, FRAMING_HALF))
    else this.fitGroup.visible = false
    if (!this.cropLines) {
      const lines = new LineSegments(CROP_EDGES, CROP_MAT)
      lines.name = 'diorama-crop'
      lines.layers.set(LAYER.GLASS)
      lines.renderOrder = RENDER_ORDER.LABELS
      lines.raycast = () => {}
      this.cropLines = lines
      this.fitGroup.add(lines)
    }
    const crop = view.crop
    this.cropLines.visible = crop !== null
    if (crop) {
      this.cropLines.position.set((crop.min[0] + crop.max[0]) / 2, (crop.min[1] + crop.max[1]) / 2, (crop.min[2] + crop.max[2]) / 2)
      this.cropLines.scale.set(
        Math.max(1e-4, (crop.max[0] - crop.min[0]) / 2),
        Math.max(1e-4, (crop.max[1] - crop.min[1]) / 2),
        Math.max(1e-4, (crop.max[2] - crop.min[2]) / 2),
      )
    }
    this.applyClips()
    this.updateVisibility()
  }

  // ── per frame ──

  frame(camera: Camera, dt: number): void {
    if (this.disposed) return
    if (!this.lifted && readPose(this.id, _p)) {
      // Match the tesseract's distance boost (nodes/instancing.ts farScale) so the diorama
      // stays inside its inner cube when the node is drawn larger far away.
      this.content.scale.setScalar(farScale(camera.position.distanceTo(_p)))
    }
    if (this.interiorPhase === 'growing' && this.interior) {
      const spark = getSpark()
      if (spark?.lodInstances.has(this.interior)) this.setPhase('ready')
    }
    const target = this.interiorReady ? this.blendTarget : 0
    if (this.blend !== target) {
      const step = Math.max(0, dt) / FLIGHT.fadeSeconds
      this.blend = target > this.blend ? Math.min(target, this.blend + step) : Math.max(target, this.blend - step)
    }
    this.updateVisibility()
    if (this.tier === 'focused') this.publishProgress()
  }

  private setPhase(p: CrystalPhase): void {
    if (this.interiorPhase === p) return
    this.interiorPhase = p
    this.phaseSince = performance.now()
  }

  /** Crystallising progress of the focused interior, for the HUD. */
  crystal(): { phase: CrystalPhase; progress: number } {
    let phase: CrystalPhase
    let within: number
    if (!this.block.interiorAssetId) {
      phase = this.proxyState === 'ready' ? 'ready' : this.proxyState === 'error' ? 'error' : 'loading'
      within = 0.5
    } else if (this.interiorPhase === 'ready') {
      phase = this.blendTarget === 1 && this.blend < 1 ? 'fading' : 'ready'
      within = this.blend
    } else {
      phase = this.interiorPhase === 'idle' ? 'loading' : this.interiorPhase
      // No real progress events for in-memory bytes: ease toward the phase's end.
      within = 1 - Math.exp(-(performance.now() - this.phaseSince) / 1500)
    }
    return { phase, progress: crystalProgress(phase, within) }
  }

  private publishProgress(): void {
    const c = this.crystal()
    publishCrystal({ id: this.id, phase: c.phase, progress: c.progress, error: this.interiorError })
  }

  private updateVisibility(): void {
    const proxyReady = this.proxyState === 'ready' && this.proxy !== null
    const shown = this.tier === 'proxy' || this.tier === 'focused' || this.lifted
    const live = this.interiorReady
    if (this.proxy) {
      this.proxy.visible = proxyReady && shown && !(live && this.blend >= 1)
      this.proxy.opacity = live ? 1 - this.blend : 1
    }
    if (this.interior) {
      // While the LoD tree grows the interior must render (at opacity 0); once live it is
      // hidden at blend 0 and its tree survives (lodCleanupTimeoutMs = Infinity while focused).
      this.interior.visible = this.interiorPhase === 'growing' || (live && this.blend > 0)
      this.interior.opacity = live ? this.blend : 0
    }
    if (this.impostor) {
      const placeholder = shown && !proxyReady && !(live && this.blend > 0)
      this.impostor.visible = !this.lifted && (this.tier === 'impostor' || placeholder)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.dropProxy()
    this.dropInterior()
    this.dropThumb()
    this.cropLines?.removeFromParent()
    this.cropLines = null
    this.content.removeFromParent()
    this.anchor = null
  }
}

// ─── registry (the tier manager and the rigs look dioramas up by node id) ────────────

const dioramas = new Map<string, DioramaInstance>()

export function getDiorama(id: string | null | undefined): DioramaInstance | undefined {
  return id ? dioramas.get(id) : undefined
}

export function listDioramas(): IterableIterator<DioramaInstance> {
  return dioramas.values()
}

// ─── component ──────────────────────────────────────────────────────────────────────

export interface DioramaProps {
  id: string
  block: SplatBlock
}

/**
 * Mounted inside a memory's diorama slot (nodes/archetypes.tsx). The instance is created in
 * the effect (not in state) so a StrictMode remount gets a fresh one instead of a disposed one.
 */
export function Diorama({ id, block }: DioramaProps) {
  const anchor = useRef<Group>(null)
  const inst = useRef<DioramaInstance | null>(null)
  const latest = useRef(block)
  latest.current = block

  useLayoutEffect(() => {
    const d = new DioramaInstance(id, latest.current)
    inst.current = d
    if (anchor.current) d.attach(anchor.current)
    dioramas.set(id, d)
    return () => {
      if (dioramas.get(id) === d) dioramas.delete(id)
      if (inst.current === d) inst.current = null
      d.dispose()
    }
  }, [id])

  useEffect(() => {
    inst.current?.setBlock(block)
  }, [block])

  useFrame((state, dt) => inst.current?.frame(state.camera, dt), -1)

  return <group ref={anchor} name="diorama-anchor" />
}
