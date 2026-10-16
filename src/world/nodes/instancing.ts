import { useMemo } from 'react'
import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import { canTransition, useApp, useWorld } from '../../app/store.ts'
import type { NodeRecord } from '../../domain/types.ts'
import type { PoseTable } from '../poses.ts'

// Shared plumbing for the instanced archetype families: the per-node basis (pose · yaw ·
// scale), instanced-mesh construction, and pointer handlers that map instanceId → node id.

/** Instance capacity grows in powers of two so adding a node rarely rebuilds a mesh. */
export function capacityFor(n: number): number {
  let c = 4
  while (c < n) c <<= 1
  return c
}

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** Deterministic per-node phase in [0, 1) for animation offsets. */
export function nodePhase(id: string): number {
  return hash32(id) / 4294967296
}

/**
 * Yaw that turns the node's +Z face toward the world axis (the core and the catwalk), so
 * engraved faces, plaques and lens axes read from the walkway. Nodes on the axis fall back to
 * a hashed angle. Ideas and demons have no front; they get a hashed jitter on top.
 */
export function nodeYaw(rec: NodeRecord): number {
  const [x, z] = rec.anchorXZ
  const facing = Math.hypot(x, z) < 1e-3 ? nodePhase(rec.id) * Math.PI * 2 : Math.atan2(-x, -z)
  if (rec.archetype === 'idea' || rec.archetype === 'demon') return facing + nodePhase(rec.id) * Math.PI * 2
  return facing
}

/** Mass reads as a subtle size change; memories and documents keep their spec'd size. */
export function nodeScale(rec: NodeRecord): number {
  if (rec.archetype === 'memory' || rec.archetype === 'document') return 1
  return 0.85 + 0.15 * Math.sqrt(rec.thermo.mass)
}

/**
 * Distance boost that keeps nodes the hero of a wide shot. Within `near` of the camera (the
 * catwalk, inspection, the fly-in) a node has its true size; beyond it the scale grows
 * linearly with distance, so the apparent size levels off like a map marker, up to `max`.
 * At 100 u a node is ≈ 2.7× and from ≈ 160 u on 4×: a 2.4 u tesseract still covers
 * ≈ 50 px of a 768 px-tall view from 150 u.
 */
export const FAR_SCALE = { near: 24, per: 45, max: 4 } as const

export function farScale(distance: number): number {
  return distance <= FAR_SCALE.near ? 1 : Math.min(FAR_SCALE.max, 1 + (distance - FAR_SCALE.near) / FAR_SCALE.per)
}

/**
 * Memories with a volumetric scene are the world's landmarks ("glass terrariums"): the same
 * true size up close (spurs and the catwalk are laid out for a 2.4 u cube), but a steeper,
 * higher boost so the scene inside still reads from the orbit view.
 */
export const TERRARIUM_FAR_SCALE = { near: 24, per: 18, max: 9 } as const

export function terrariumFarScale(distance: number): number {
  const f = TERRARIUM_FAR_SCALE
  return distance <= f.near ? 1 : Math.min(f.max, 1 + (distance - f.near) / f.per)
}

/** The distance boost for a record: terrariums get theirs, everything else farScale. */
export function recordFarScale(rec: Pick<NodeRecord, 'splat'>, distance: number): number {
  return rec.splat ? terrariumFarScale(distance) : farScale(distance)
}

/** farScale() of a node's pose seen from `cam` (world position); 1 when it has no pose. */
export function nodeFarScale(table: PoseTable, id: string, cam: Vector3, terrarium = false): number {
  const row = table.index.get(id)
  if (row === undefined) return 1
  const o = row * 3
  return (terrarium ? terrariumFarScale : farScale)(Math.hypot(table.pos[o] - cam.x, table.pos[o + 1] - cam.y, table.pos[o + 2] - cam.z))
}

/** Collapses an instance (unborn, missing pose, or the other state of a ghost pair). */
export const ZERO_MATRIX = new Matrix4().makeScale(0, 0, 0)

const _p = new Vector3()
const _q = new Quaternion()
const _s = new Vector3()
const _up = new Vector3(0, 1, 0)

/** Node basis into `out`. Returns 1 if born, 0 if unborn (ghost), -1 if it has no pose row. */
export function nodeMatrix(table: PoseTable, id: string, yaw: number, scale: number, out: Matrix4): 1 | 0 | -1 {
  const row = table.index.get(id)
  if (row === undefined) return -1
  const o = row * 3
  _p.set(table.pos[o], table.pos[o + 1], table.pos[o + 2])
  _q.setFromAxisAngle(_up, yaw)
  _s.setScalar(scale)
  out.compose(_p, _q, _s)
  return table.born[row] === 1 ? 1 : 0
}

export interface InstancedSpec {
  name: string
  geometry: BufferGeometry
  material: Material
  layer: number
  renderOrder?: number
  /** Allocate instanceColor (glow colour per instance). */
  color?: boolean
}

/** The caller owns geometry and material; mesh.dispose() frees only the instance buffers. */
export function makeInstanced(spec: InstancedSpec, capacity: number): InstancedMesh {
  const m = new InstancedMesh(spec.geometry, spec.material, capacity)
  m.name = spec.name
  m.layers.set(spec.layer)
  m.renderOrder = spec.renderOrder ?? 0
  m.instanceMatrix.setUsage(DynamicDrawUsage)
  // Created up front so the first program compile already has USE_INSTANCING_COLOR.
  if (spec.color) m.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage)
  m.count = 0
  return m
}

// ─── memory entry (Phase 2 owns the fly-in) ──────────────────────────────────────────────

let flyInReady = false

/** Called by the Phase-2 fly-in rig once it handles the 'entering' mode. */
export function setFlyInReady(ready: boolean): void {
  flyInReady = ready
}

/** Double-click on a memory's front shell. */
export function enterMemory(id: string): void {
  const app = useApp.getState()
  app.select(id)
  // Only a memory with a volumetric scene can be entered, and only from a free camera mode;
  // otherwise this is just a selection (focus drives the interior load, so it waits too).
  // flyInReady is flipped by the splat layer (splats/SparkLayer.tsx) once it is mounted.
  if (!flyInReady || !useWorld.getState().nodes.get(id)?.splat) return
  if (app.mode === 'entering' || !canTransition(app.mode, 'entering')) return
  app.focus(id)
  app.setMode('entering')
}

// ─── pointer handlers ───────────────────────────────────────────────────────────────────

function setCursor(c: string): void {
  if (typeof document !== 'undefined') document.body.style.cursor = c
}

export interface InstanceHandlers {
  onPointerOver: (e: ThreeEvent<PointerEvent>) => void
  onPointerOut: (e: ThreeEvent<PointerEvent>) => void
  onClick: (e: ThreeEvent<MouseEvent>) => void
  onDoubleClick: (e: ThreeEvent<MouseEvent>) => void
}

/** Handlers for an instanced mesh whose instance i is node ids[i]. */
export function useInstanceHandlers(ids: readonly string[]): InstanceHandlers {
  return useMemo(() => {
    const idOf = (e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>) =>
      e.instanceId === undefined ? undefined : ids[e.instanceId]
    return {
      onPointerOver: (e) => {
        const id = idOf(e)
        if (!id) return
        e.stopPropagation()
        useApp.getState().hover(id)
        setCursor('pointer')
      },
      onPointerOut: (e) => {
        const id = idOf(e)
        const app = useApp.getState()
        if (id && app.hoveredId === id) app.hover(null)
        setCursor('')
      },
      onClick: (e) => {
        const id = idOf(e)
        if (!id) return
        e.stopPropagation()
        useApp.getState().select(id)
      },
      onDoubleClick: (e) => {
        const id = idOf(e)
        if (!id) return
        e.stopPropagation()
        enterMemory(id)
      },
    }
  }, [ids])
}
