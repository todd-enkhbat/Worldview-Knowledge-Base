import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, Euler, Matrix4, Quaternion, Vector3, type Group } from 'three'
import type { NodeRecord } from '../../domain/types.ts'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { getPoseTable } from '../poses.ts'
import { emphasisLevel, sampleEmphasis } from './emphasis.ts'
import { CAMERA_EPS2, Family, type LocalFn, type PartDef } from './family.tsx'
import { DEMON } from './geometry.ts'
import { ZERO_MATRIX, capacityFor, farScale, makeInstanced, nodeMatrix, nodeScale, nodeYaw } from './instancing.ts'
import type { NodeKit } from './kit.ts'
import { COLORS, GAIN } from './materials.ts'
import { Diorama } from '../splats/Diorama.tsx'

// The six archetype families. Solid parts live on LAYER.SOLID (seen by the reflector);
// shells, flow cones, demon fields and ghosts on LAYER.GLASS.

const TAU = Math.PI * 2
const _e = new Euler()

interface FamilyInput {
  records: readonly NodeRecord[]
  kit: NodeKit
}

const ghostPart = (kit: NodeKit, key: keyof NodeKit['geo']['ghost']): PartDef => ({
  name: `${key}-ghost`,
  geometry: kit.geo.ghost[key],
  material: kit.mat.ghost,
  layer: LAYER.GLASS,
  renderOrder: RENDER_ORDER.FRONT_SHELL,
  ghost: true,
  pick: true,
})

// ─── idea ───────────────────────────────────────────────────────────────────────────────

const spinCrystal: LocalFn = (_r, phase, t, out) => {
  out.makeRotationFromEuler(_e.set(0.08 * Math.sin(t * 0.4 + phase * TAU), t * 0.16 + phase * TAU, 0))
}

export function Crystals({ records, kit }: FamilyInput) {
  const parts = useMemo<PartDef[]>(
    () => [
      {
        name: 'idea-crystal',
        geometry: kit.geo.crystal,
        material: kit.mat.crystal,
        layer: LAYER.SOLID,
        glow: { color: COLORS.ember, intensity: 2.6 },
        pick: true,
        local: spinCrystal,
      },
      { ...ghostPart(kit, 'idea'), local: spinCrystal },
    ],
    [kit],
  )
  return <Family name="ideas" records={records} parts={parts} animated />
}

// ─── entity ─────────────────────────────────────────────────────────────────────────────

export function Monoliths({ records, kit, vectors }: FamilyInput & { vectors: VectorPairs }) {
  const parts = useMemo<PartDef[]>(
    () => [
      {
        name: 'entity-monolith',
        geometry: kit.geo.monolith,
        material: kit.mat.obsidian,
        layer: LAYER.SOLID,
        pick: true,
        // Hairline edges (materials.ts obsidianMaterial); selection turns them signal.
        glow: { color: COLORS.ember, intensity: 1.5 },
      },
      {
        name: 'entity-seam',
        geometry: kit.geo.monolithSeam,
        material: kit.mat.glow,
        layer: LAYER.SOLID,
        glow: { color: COLORS.ember, intensity: 2.2 },
      },
      ghostPart(kit, 'entity'),
    ],
    [kit],
  )
  return (
    <Family name="entities" records={records} parts={parts}>
      <GravityVectors pairs={vectors} kit={kit} />
    </Family>
  )
}

/** Entity → linked node pairs, in either link direction. */
export interface VectorPairs {
  from: readonly string[]
  to: readonly string[]
}

const _a = new Vector3()
const _b = new Vector3()
const _dir = new Vector3()
const _q = new Quaternion()
const _s = new Vector3()
const _m = new Matrix4()
const _c = new Color()
const _cam = new Vector3()
const UP = new Vector3(0, 1, 0)

/** Dashed tapered field lines from each monolith toward each node it is linked with. */
function GravityVectors({ pairs, kit }: { pairs: VectorPairs; kit: NodeKit }) {
  const capacity = capacityFor(pairs.from.length)
  const mesh = useMemo(
    () => makeInstanced({ name: 'entity-vectors', geometry: kit.geo.vector, material: kit.mat.glow, layer: LAYER.SOLID, color: true }, capacity),
    [kit, capacity],
  )
  useEffect(() => () => mesh.dispose(), [mesh])
  const st = useRef({
    version: -1,
    pairs: null as VectorPairs | null,
    mesh: mesh,
    cam: new Vector3(Infinity, 0, 0),
    sel: null as string | null,
    hov: null as string | null,
    near: null as string | null,
  })

  useFrame((state) => {
    const s = st.current
    const table = getPoseTable()
    const e = sampleEmphasis(state.camera, state.clock.elapsedTime)
    state.camera.getWorldPosition(_cam)
    const dirty =
      s.pairs !== pairs ||
      s.mesh !== mesh ||
      s.version !== table.version ||
      _cam.distanceToSquared(s.cam) > CAMERA_EPS2 ||
      e.selected !== s.sel ||
      e.hovered !== s.hov ||
      e.near !== s.near
    if (!dirty) return
    const n = pairs.from.length
    for (let i = 0; i < n; i++) {
      const ra = table.index.get(pairs.from[i])
      const rb = table.index.get(pairs.to[i])
      if (ra === undefined || rb === undefined || table.born[ra] !== 1) {
        mesh.setMatrixAt(i, ZERO_MATRIX)
        continue
      }
      _a.fromArray(table.pos, ra * 3)
      _b.fromArray(table.pos, rb * 3)
      _dir.subVectors(_b, _a)
      const d = _dir.length()
      // The monolith's far boost (Family) applies to its vectors too, so they stay legible
      // with it from a wide shot.
      const far = farScale(_a.distanceTo(_cam))
      // Reads as a pull, not a link: a short vector, never reaching into the target.
      const len = Math.min(Math.max(d * 0.3, 1.2 * far), 4.5 * far, d - 1.4 * far)
      if (len < 0.3) {
        mesh.setMatrixAt(i, ZERO_MATRIX)
        continue
      }
      _dir.divideScalar(d)
      _q.setFromUnitVectors(UP, _dir)
      _a.addScaledVector(_dir, 0.55 * far)
      _s.set(far, len, far)
      mesh.setMatrixAt(i, _m.compose(_a, _q, _s))
      const level = Math.max(emphasisLevel(e, pairs.from[i]), emphasisLevel(e, pairs.to[i]))
      if (level === 2) _c.copy(COLORS.signal).multiplyScalar(GAIN.select * 0.7)
      else _c.copy(COLORS.ember).multiplyScalar(level === 1 ? 3.2 : 1.1)
      if (table.born[rb] !== 1) _c.multiplyScalar(0.3)
      mesh.setColorAt(i, _c)
    }
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.boundingSphere = null
    s.version = table.version
    s.pairs = pairs
    s.mesh = mesh
    s.cam.copy(_cam)
    s.sel = e.selected
    s.hov = e.hovered
    s.near = e.near
  }, -1)

  return pairs.from.length > 0 ? <primitive object={mesh} /> : null
}

// ─── lens ───────────────────────────────────────────────────────────────────────────────

const ringB: LocalFn = (_r, phase, t, out) => {
  out.makeRotationY(0.9 + t * 0.21 + phase * TAU)
}
const ringC: LocalFn = (_r, phase, t, out) => {
  out.makeRotationX(1.2 + t * 0.13 + phase * TAU * 1.3)
}

export function Lenses({ records, kit }: FamilyInput) {
  const parts = useMemo<PartDef[]>(
    () => [
      { name: 'lens-limb', geometry: kit.geo.lensLimb, material: kit.mat.brass, layer: LAYER.SOLID, pick: true },
      { name: 'lens-ring-b', geometry: kit.geo.lensRingB, material: kit.mat.brass, layer: LAYER.SOLID, local: ringB },
      { name: 'lens-ring-c', geometry: kit.geo.lensRingC, material: kit.mat.brass, layer: LAYER.SOLID, local: ringC },
      { name: 'lens-disc', geometry: kit.geo.lensDisc, material: kit.mat.darkGlass, layer: LAYER.SOLID, pick: true },
      {
        name: 'lens-rim',
        geometry: kit.geo.lensRim,
        material: kit.mat.glow,
        layer: LAYER.SOLID,
        glow: { color: COLORS.ember, intensity: 2.4 },
      },
      {
        name: 'lens-flow',
        geometry: kit.geo.lensCone,
        material: kit.mat.flowCone,
        layer: LAYER.GLASS,
        renderOrder: RENDER_ORDER.FRONT_SHELL,
      },
      ghostPart(kit, 'lens'),
    ],
    [kit],
  )
  return <Family name="lenses" records={records} parts={parts} animated />
}

// ─── document ───────────────────────────────────────────────────────────────────────────

export function Documents({ records, kit }: FamilyInput) {
  const parts = useMemo<PartDef[]>(
    () => [
      { name: 'document-slab', geometry: kit.geo.slab, material: kit.mat.concrete, layer: LAYER.SOLID, pick: true },
      {
        name: 'document-rule',
        geometry: kit.geo.slabRule,
        material: kit.mat.glow,
        layer: LAYER.SOLID,
        glow: { color: COLORS.ember, intensity: 2 },
      },
      ghostPart(kit, 'document'),
    ],
    [kit],
  )
  return <Family name="documents" records={records} parts={parts} />
}

// ─── memory ─────────────────────────────────────────────────────────────────────────────

export function Tesseracts({ records, kit }: FamilyInput) {
  const parts = useMemo<PartDef[]>(
    () => [
      { name: 'memory-rims', geometry: kit.geo.tessRim, material: kit.mat.chrome, layer: LAYER.SOLID, pick: true },
      { name: 'memory-struts', geometry: kit.geo.tessStrut, material: kit.mat.brass, layer: LAYER.SOLID },
      {
        name: 'memory-glow',
        geometry: kit.geo.tessGlow,
        material: kit.mat.glow,
        layer: LAYER.SOLID,
        glow: { color: COLORS.ember, intensity: 3.2 },
      },
      { name: 'memory-plaque', geometry: kit.geo.tessPlaque, material: kit.mat.blackSteel, layer: LAYER.SOLID, pick: true },
      {
        name: 'memory-back-shell',
        geometry: kit.geo.backShell,
        material: kit.mat.backShell,
        layer: LAYER.GLASS,
        renderOrder: RENDER_ORDER.BACK_SHELL,
      },
      {
        name: 'memory-front-shell',
        geometry: kit.geo.frontShell,
        material: kit.mat.frontShell,
        layer: LAYER.GLASS,
        renderOrder: RENDER_ORDER.FRONT_SHELL,
        pick: true,
        enter: true,
      },
      {
        name: 'memory-depth-proxy',
        geometry: kit.geo.depthProxy,
        material: kit.mat.depthProxy,
        layer: LAYER.GLASS,
        renderOrder: RENDER_ORDER.DEPTH_PROXY,
      },
      { ...ghostPart(kit, 'memory'), enter: false },
    ],
    [kit],
  )
  return (
    <Family name="memories" records={records} parts={parts}>
      <DioramaSlots records={records} />
    </Family>
  )
}

/**
 * One group per memory, kept on the memory's basis, where the Phase-2 splat diorama mounts
 * (splats/Diorama.tsx, for memories with a scene). Found by name ('diorama-slot') and
 * userData.nodeId.
 */
function DioramaSlots({ records }: { records: readonly NodeRecord[] }) {
  const refs = useRef<(Group | null)[]>([])
  const yaw = useMemo(() => Float32Array.from(records, nodeYaw), [records])
  useFrame(() => {
    const table = getPoseTable()
    for (let i = 0; i < records.length; i++) {
      const g = refs.current[i]
      if (!g) continue
      const born = nodeMatrix(table, records[i].id, yaw[i], 1, _m)
      g.visible = born === 1
      if (born === 1) _m.decompose(g.position, g.quaternion, g.scale)
    }
  }, -1)
  return (
    <>
      {records.map((r, i) => (
        <group
          key={r.id}
          name="diorama-slot"
          userData={{ nodeId: r.id }}
          ref={(g) => {
            refs.current[i] = g
          }}
        >
          {r.splat && <Diorama id={r.id} block={r.splat} />}
        </group>
      ))}
    </>
  )
}

// ─── demon ──────────────────────────────────────────────────────────────────────────────

const demonRing: LocalFn = (_r, phase, t, out) => {
  out.makeRotationFromEuler(_e.set(DEMON.tilt, t * 0.5 + phase * TAU, 0))
}
const demonSlit: LocalFn = (_r, _p, _t, out) => {
  out.makeRotationX(DEMON.tilt)
}
// The field is the demon's real sorting radius, so it undoes the node scale and the far boost.
const demonField: LocalFn = (rec, _p, _t, out, far) => {
  const d = rec.demon
  if (!d || !d.active) out.makeScale(0, 0, 0)
  else {
    const k = d.radius / (nodeScale(rec) * far)
    out.makeScale(k, k, k)
  }
}

export function Demons({ records, kit }: FamilyInput) {
  const parts = useMemo<PartDef[]>(
    () => [
      { name: 'demon-body', geometry: kit.geo.demonBody, material: kit.mat.darkGlass, layer: LAYER.SOLID, pick: true },
      { name: 'demon-aperture', geometry: kit.geo.demonRing, material: kit.mat.brass, layer: LAYER.SOLID, pick: true, local: demonRing },
      {
        name: 'demon-slit',
        geometry: kit.geo.demonSlit,
        material: kit.mat.glow,
        layer: LAYER.SOLID,
        local: demonSlit,
        glow: { color: COLORS.ember, intensity: (r) => (r.demon?.active === false ? 0.5 : 3) },
      },
      {
        name: 'demon-field',
        geometry: kit.geo.demonField,
        material: kit.mat.demonField,
        layer: LAYER.GLASS,
        renderOrder: RENDER_ORDER.FRONT_SHELL,
        local: demonField,
      },
      ghostPart(kit, 'demon'),
    ],
    [kit],
  )
  return <Family name="demons" records={records} parts={parts} animated />
}
