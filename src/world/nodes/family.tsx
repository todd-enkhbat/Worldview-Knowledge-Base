import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, Matrix4, Vector3, type InstancedMesh } from 'three'
import type { NodeRecord } from '../../domain/types.ts'
import { getPoseTable } from '../poses.ts'
import { emphasisLevel, sampleEmphasis, type Emphasis } from './emphasis.ts'
import {
  ZERO_MATRIX,
  capacityFor,
  makeInstanced,
  nodeFarScale,
  nodeMatrix,
  nodePhase,
  nodeScale,
  nodeYaw,
  useInstanceHandlers,
  type InstancedSpec,
} from './instancing.ts'
import { COLORS, GAIN } from './materials.ts'

// One archetype = one Family: a set of instanced parts sharing the node basis. Matrices are
// rewritten from the pose table in useFrame at priority −1 (after the pose writers at ≤ −2)
// whenever the table version, the record set or the camera position changes (the basis
// carries the distance boost, farScale), or every frame for animated families. Glow colours
// are rewritten only when the emphasis (selection / hover / near) changes.

/**
 * Local transform applied after the node basis. `phase` is a stable per-node [0, 1); `far`
 * is the distance boost already in the basis, for parts that must keep a world size.
 */
export type LocalFn = (rec: NodeRecord, phase: number, t: number, out: Matrix4, far: number) => void

export interface PartDef extends InstancedSpec {
  /** Renders for unborn nodes only (ghost silhouette); other parts render for born nodes. */
  ghost?: boolean
  /** Per-instance HDR glow on instanceColor, boosted by hover / selection. */
  glow?: { color: Color; intensity: number | ((rec: NodeRecord) => number) }
  /** Carries hover / click. */
  pick?: boolean
  /** Carries onDoubleClick → enterMemory. */
  enter?: boolean
  local?: LocalFn
}

interface FamilyProps {
  name: string
  records: readonly NodeRecord[]
  parts: readonly PartDef[]
  /** Rewrite matrices every frame (parts with time-dependent local transforms). */
  animated?: boolean
  children?: ReactNode
}

const _basis = new Matrix4()
const _local = new Matrix4()
const _cam = new Vector3()
/**
 * Camera travel (u², cumulative since the last write) below which a static family keeps its
 * matrices: 0.25 u changes farScale by at most 0.25 / FAR_SCALE.per ≈ 0.6 %, invisible, and
 * it spares the rewrites while damping settles or the walker strolls.
 */
export const CAMERA_EPS2 = 0.25 * 0.25
const _m = new Matrix4()
const _c = new Color()

function writeGlow(mesh: InstancedMesh, glow: NonNullable<PartDef['glow']>, records: readonly NodeRecord[], ids: readonly string[], e: Emphasis): void {
  for (let i = 0; i < records.length; i++) {
    const level = emphasisLevel(e, ids[i])
    if (level === 2) {
      _c.copy(COLORS.signal).multiplyScalar(GAIN.select)
    } else {
      const k = typeof glow.intensity === 'number' ? glow.intensity : glow.intensity(records[i])
      const gain = level === 0 ? 1 : ids[i] === e.hovered ? GAIN.hover : GAIN.emphasis
      _c.copy(glow.color).multiplyScalar(k * gain)
    }
    mesh.setColorAt(i, _c)
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

const NO_HANDLERS = {}

export function Family({ name, records, parts, animated = false, children }: FamilyProps) {
  const ids = useMemo(() => records.map((r) => r.id), [records])
  const basis = useMemo(
    () => ({
      yaw: Float32Array.from(records, nodeYaw),
      scale: Float32Array.from(records, nodeScale),
      phase: Float32Array.from(records, (r) => nodePhase(r.id)),
    }),
    [records],
  )
  const capacity = capacityFor(records.length)
  const meshes = useMemo(() => parts.map((p) => makeInstanced({ ...p, color: p.color ?? p.glow !== undefined }, capacity)), [parts, capacity])
  useEffect(
    () => () => {
      for (const m of meshes) m.dispose()
    },
    [meshes],
  )
  const handlers = useInstanceHandlers(ids)
  const pickProps = useMemo(
    () => ({ onPointerOver: handlers.onPointerOver, onPointerOut: handlers.onPointerOut, onClick: handlers.onClick }),
    [handlers],
  )
  const st = useRef({
    version: -1,
    ids: null as readonly string[] | null,
    meshes: null as InstancedMesh[] | null,
    cam: new Vector3(Infinity, 0, 0),
    sel: null as string | null,
    hov: null as string | null,
    near: null as string | null,
  })

  useFrame((state) => {
    const s = st.current
    const table = getPoseTable()
    const structural = s.ids !== ids || s.meshes !== meshes
    state.camera.getWorldPosition(_cam)
    const moved = structural || s.version !== table.version || _cam.distanceToSquared(s.cam) > CAMERA_EPS2
    const n = records.length
    const t = state.clock.elapsedTime
    if (moved || animated) {
      for (let i = 0; i < n; i++) {
        const far = nodeFarScale(table, ids[i], _cam)
        const born = nodeMatrix(table, ids[i], basis.yaw[i], basis.scale[i] * far, _basis)
        for (let k = 0; k < parts.length; k++) {
          const part = parts[k]
          const show = born === 1 ? part.ghost !== true : born === 0 ? part.ghost === true : false
          if (!show) {
            meshes[k].setMatrixAt(i, ZERO_MATRIX)
          } else if (part.local) {
            part.local(records[i], basis.phase[i], t, _local, far)
            meshes[k].setMatrixAt(i, _m.multiplyMatrices(_basis, _local))
          } else {
            meshes[k].setMatrixAt(i, _basis)
          }
        }
      }
      for (let k = 0; k < meshes.length; k++) {
        const m = meshes[k]
        m.count = n
        m.instanceMatrix.needsUpdate = true
        // Stale spheres break raycasts and frustum culling; three recomputes lazily.
        if (moved) m.boundingSphere = null
      }
      s.version = table.version
      s.cam.copy(_cam)
    }
    const e = sampleEmphasis(state.camera, t)
    if (structural || e.selected !== s.sel || e.hovered !== s.hov || e.near !== s.near) {
      for (let k = 0; k < parts.length; k++) {
        const glow = parts[k].glow
        if (glow) writeGlow(meshes[k], glow, records, ids, e)
      }
      s.sel = e.selected
      s.hov = e.hovered
      s.near = e.near
    }
    s.ids = ids
    s.meshes = meshes
  }, -1)

  if (records.length === 0) return null
  return (
    <group name={name}>
      {meshes.map((m, k) => (
        <primitive
          key={m.uuid}
          object={m}
          {...(parts[k].pick ? pickProps : NO_HANDLERS)}
          {...(parts[k].enter ? { onDoubleClick: handlers.onDoubleClick } : NO_HANDLERS)}
        />
      ))}
      {children}
    </group>
  )
}
