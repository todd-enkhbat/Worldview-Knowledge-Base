import { useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BoxGeometry, Color, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Vector2, Vector3, type Camera } from 'three'
import { create } from 'zustand'
import { canTransition, useApp, useWorld } from '../../app/store.ts'
import { reframeScene } from '../../data/scenes.ts'
import type { Pose, Quat } from '../../domain/types.ts'
import { getOrbitControls } from '../camera/flyTo.ts'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { readPose } from '../poses.ts'
import { FRAMING_HALF, getDiorama, type DioramaInstance } from './Diorama.tsx'
import { applyUpFixOp, captureEntryPose, normalizeCrop, type Box, type UpFixOp } from './flyIn.ts'
import { useWorldHidden } from './InteriorRig.tsx'
import { getSplatStage } from './sparkRegistry.ts'

// 'framing' (PLAN: a camera mode in the MAIN canvas, not a second canvas): the focused
// memory's full interior, unclipped, lifted out of its tesseract into the splat stage and
// scaled up so the whole capture fits a FRAMING_HALF cube; the world is hidden. The orbit
// CameraControls (CameraRig mounts OrbitRig for 'framing') circle it. The draft crop shows as
// a wireframe with six drag handles; src/hud/SplatFraming.tsx edits the same draft
// numerically, sets the up-fix, captures the entry pose and saves via reframeScene().

export interface FramingDraft {
  /** Memory being framed, or null when framing is closed. */
  id: string | null
  upFix: Quat
  /** Crop in native units; null = no crop. */
  crop: Box | null
  entryPose: Pose | null
  /** Unclipped native bounds of what is shown (field ranges, "reset crop"). */
  bounds: Box | null
  dirty: boolean
  saving: boolean
  error: string | null
}

const CLOSED: FramingDraft = { id: null, upFix: [0, 0, 0, 1], crop: null, entryPose: null, bounds: null, dirty: false, saving: false, error: null }

export const useFraming = create<FramingDraft>()(() => ({ ...CLOSED }))

function draftFrom(id: string): FramingDraft | null {
  const b = useWorld.getState().nodes.get(id)?.splat
  if (!b) return null
  return { ...CLOSED, id, upFix: b.upFix, crop: b.crop, entryPose: b.entryPose }
}

/** Open the framing mode for a memory with a scene. False if it has none or the mode can't switch. */
export function openFraming(id: string): boolean {
  const draft = draftFrom(id)
  const app = useApp.getState()
  if (!draft || !canTransition(app.mode, 'framing')) return false
  useFraming.setState(draft)
  app.select(id)
  app.focus(id)
  return app.setMode('framing')
}

/** Leave framing for the mode it was opened from (Cancel). Unsaved edits are dropped. */
export function closeFraming(): void {
  const app = useApp.getState()
  if (app.mode !== 'framing') return
  app.setMode(app.prevMode !== 'framing' && canTransition('framing', app.prevMode) ? app.prevMode : 'orbit')
}

function edit(patch: Partial<FramingDraft>): void {
  useFraming.setState({ ...patch, dirty: true, error: null })
}

/** Set one face of the crop box (native units). Creates the crop from the bounds if there is none. */
export function setCropAxis(axis: 0 | 1 | 2, side: 'min' | 'max', value: number): void {
  const d = useFraming.getState()
  const base = d.crop ?? d.bounds
  if (!base) return
  const next: Box = { min: [...base.min], max: [...base.max] }
  next[side][axis] = value
  edit({ crop: normalizeCrop(next, base) })
}

export function setCrop(crop: Box | null): void {
  const d = useFraming.getState()
  edit({ crop: crop && (d.bounds ?? crop) ? normalizeCrop(crop, d.bounds ?? crop) : null })
}

/** Crop to the visible bounds (the robust 0.5–99.5 % box of the capture). */
export function resetCrop(): void {
  const b = useFraming.getState().bounds
  if (b) edit({ crop: { min: [...b.min], max: [...b.max] } })
}

export function applyUpFix(op: UpFixOp): void {
  edit({ upFix: applyUpFixOp(useFraming.getState().upFix, op) })
}

let capture: (() => Pose | null) | null = null

/** "Set entry pose here": the current camera, relative to the splat. */
export function captureEntryHere(): boolean {
  const pose = capture?.() ?? null
  if (pose) edit({ entryPose: pose })
  return pose !== null
}

/** Save crop, up-fix and entry pose (reframeScene), then leave framing. */
export async function saveFraming(): Promise<boolean> {
  const d = useFraming.getState()
  if (!d.id || d.saving) return false
  const entryPose = d.entryPose ?? useWorld.getState().nodes.get(d.id)?.splat?.entryPose
  if (!entryPose) {
    useFraming.setState({ error: 'This memory has no volumetric scene' })
    return false
  }
  useFraming.setState({ saving: true, error: null })
  try {
    await reframeScene(d.id, { crop: d.crop, upFix: d.upFix, entryPose })
    useFraming.setState({ saving: false, dirty: false })
    closeFraming()
    return true
  } catch (e) {
    useFraming.setState({ saving: false, error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

// ─── drag handles ───────────────────────────────────────────────────────────────────

interface Handle {
  mesh: Mesh
  axis: 0 | 1 | 2
  side: 'min' | 'max'
}

const HANDLE_GEO = new BoxGeometry(1, 1, 1)
const HANDLE_MAT = new MeshBasicMaterial({
  color: new Color('#e8b04a').multiplyScalar(2.5),
  transparent: true,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
})
/** Handle size as a fraction of its camera distance (constant on screen). */
const HANDLE_SCREEN = 0.014

function makeHandles(): Handle[] {
  const out: Handle[] = []
  for (const axis of [0, 1, 2] as const) {
    for (const side of ['min', 'max'] as const) {
      const mesh = new Mesh(HANDLE_GEO, HANDLE_MAT)
      mesh.name = `crop-handle-${'xyz'[axis]}-${side}`
      mesh.layers.set(LAYER.GLASS)
      mesh.renderOrder = RENDER_ORDER.LABELS + 1
      mesh.visible = false
      out.push({ mesh, axis, side })
    }
  }
  return out
}

const _native = new Vector3()
const _axis = new Vector3()
const _w0 = new Vector3()

/** Parameter t of the point on line p + t·a (a unit) closest to the ray o + s·d (d unit). */
function closestOnLine(o: Vector3, d: Vector3, p: Vector3, a: Vector3): number | null {
  _w0.subVectors(o, p)
  const b = d.dot(a)
  const denom = 1 - b * b
  if (denom < 1e-6) return null
  const dd = d.dot(_w0)
  const e = a.dot(_w0)
  return (e - b * dd) / denom
}

function placeHandles(handles: Handle[], inst: DioramaInstance, crop: Box | null, camera: Camera): void {
  const world = inst.meshWorld()
  for (const h of handles) {
    h.mesh.visible = crop !== null
    if (!crop) continue
    _native.set((crop.min[0] + crop.max[0]) / 2, (crop.min[1] + crop.max[1]) / 2, (crop.min[2] + crop.max[2]) / 2)
    _native.setComponent(h.axis, crop[h.side][h.axis])
    h.mesh.position.copy(_native).applyMatrix4(world)
    h.mesh.scale.setScalar(Math.max(0.02, camera.position.distanceTo(h.mesh.position) * HANDLE_SCREEN))
  }
}

// ─── the rig ────────────────────────────────────────────────────────────────────────

export function FramingRig() {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const framed = useRef<DioramaInstance | null>(null)
  const synced = useRef<{ draft: FramingDraft | null; bounds: Box | null }>({ draft: null, bounds: null })
  const handles = useRef<Handle[]>([])

  useWorldHidden()

  useLayoutEffect(() => {
    // Opened without openFraming() (e.g. setMode('framing') directly): draft the focused memory.
    const app = useApp.getState()
    const id = app.focusedId ?? app.selectedId
    if (id && useFraming.getState().id !== id) {
      const draft = draftFrom(id)
      if (draft) useFraming.setState(draft)
    }
    if (!useFraming.getState().id) {
      queueMicrotask(closeFraming)
      return
    }
    if (useApp.getState().focusedId !== useFraming.getState().id) app.focus(useFraming.getState().id)

    const stage = getSplatStage()
    const hs = makeHandles()
    handles.current = hs
    for (const h of hs) stage?.add(h.mesh)

    capture = () => {
      const inst = framed.current
      if (!inst) return null
      const fov = camera instanceof PerspectiveCamera ? camera.fov : undefined
      return captureEntryPose(inst.meshWorld(), { position: camera.position, quaternion: camera.quaternion }, fov)
    }

    // Drag a handle along its axis. Capture phase on the canvas, so the orbit controls (which
    // listen on the same element) never see a press that grabbed a handle.
    const el = gl.domElement
    const raycaster = new Raycaster()
    raycaster.layers.set(LAYER.GLASS)
    const ndc = new Vector2()
    let drag: { h: Handle; start: number; t0: number; origin: Vector3; dir: Vector3; perNative: number; pointerId: number } | null = null
    const ray = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      return raycaster.ray
    }
    const pick = (e: PointerEvent): Handle | null => {
      ray(e)
      const hit = raycaster.intersectObjects(hs.filter((h) => h.mesh.visible).map((h) => h.mesh), false)[0]
      return hit ? (hs.find((h) => h.mesh === hit.object) ?? null) : null
    }
    const onDown = (e: PointerEvent) => {
      const inst = framed.current
      const crop = useFraming.getState().crop
      if (e.button !== 0 || !inst || !crop) return
      const h = pick(e)
      if (!h) return
      e.stopImmediatePropagation()
      e.preventDefault()
      const world = inst.meshWorld()
      const dir = _axis.setFromMatrixColumn(world, h.axis).normalize().clone()
      const origin = h.mesh.position.clone()
      const r = raycaster.ray
      const t0 = closestOnLine(r.origin, r.direction, origin, dir) ?? 0
      drag = { h, start: crop[h.side][h.axis], t0, origin, dir, perNative: Math.max(1e-9, inst.worldPerNative()), pointerId: e.pointerId }
      const c = getOrbitControls()
      if (c) c.enabled = false
      el.setPointerCapture(e.pointerId)
      el.style.cursor = 'grabbing'
    }
    const onMove = (e: PointerEvent) => {
      if (!drag) {
        el.style.cursor = pick(e) ? 'grab' : ''
        return
      }
      const r = ray(e)
      const t = closestOnLine(r.origin, r.direction, drag.origin, drag.dir)
      if (t === null) return
      setCropAxis(drag.h.axis, drag.h.side, drag.start + (t - drag.t0) / drag.perNative)
    }
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      drag = null
      const c = getOrbitControls()
      if (c) c.enabled = true
      el.style.cursor = ''
    }
    el.addEventListener('pointerdown', onDown, { capture: true })
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)

    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true })
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.style.cursor = ''
      const c = getOrbitControls()
      if (c) c.enabled = true
      capture = null
      for (const h of hs) h.mesh.removeFromParent()
      handles.current = []
      const inst = framed.current
      framed.current = null
      if (inst && !inst.disposed) {
        inst.setFraming(null)
        inst.blendTarget = 0
        inst.restore()
      }
      synced.current = { draft: null, bounds: null }
      const s = useApp.getState()
      const id = useFraming.getState().id
      if (s.mode !== 'entering' && s.focusedId === id) s.focus(null)
      useFraming.setState({ ...CLOSED })
    }
  }, [camera, gl])

  useFrame(() => {
    const d = useFraming.getState()
    const inst = getDiorama(d.id)
    if (!inst) return
    if (framed.current !== inst) {
      const stage = getSplatStage()
      if (!stage) return
      // Lift out of the tesseract to the memory's centre, world-aligned (no yaw), so the
      // up-fix buttons turn the scene about the axes the user sees.
      const centre = new Vector3()
      if (!readPose(inst.id, centre)) inst.content.getWorldPosition(centre)
      inst.lift(stage)
      inst.content.position.copy(centre)
      inst.content.quaternion.identity()
      inst.content.scale.setScalar(1)
      framed.current = inst
      synced.current = { draft: null, bounds: null }
      // Frame the FRAMING_HALF cube from the current viewing direction, a little above.
      const c = getOrbitControls()
      if (c) {
        const dir = camera.position.clone().sub(centre)
        if (dir.lengthSq() < 1e-6) dir.set(0.6, 0.35, 0.7)
        dir.normalize()
        dir.y = Math.max(dir.y, 0.25)
        dir.normalize().multiplyScalar(FRAMING_HALF * 2.8)
        void c.setLookAt(centre.x + dir.x, centre.y + dir.y, centre.z + dir.z, centre.x, centre.y, centre.z, true)
      }
    }
    inst.blendTarget = 1
    const bounds = inst.framingBounds()
    const s = synced.current
    if (s.draft !== d || s.bounds !== bounds) {
      s.draft = d
      s.bounds = bounds
      inst.setFraming({ upFix: d.upFix, crop: d.crop })
      if (bounds !== d.bounds) useFraming.setState({ bounds })
    }
    placeHandles(handles.current, inst, d.crop, camera)
  }, -1)

  return null
}
