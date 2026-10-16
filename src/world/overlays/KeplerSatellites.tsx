import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  Vector3,
} from 'three'
import { useWorld } from '../../app/store.ts'
import { orbitOffset, satelliteSystems } from '../../overlay/kepler.ts'
import type { Orbit } from '../../overlay/kepler.ts'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { capacityFor } from '../nodes/instancing.ts'
import { getPoseTable } from '../poses.ts'

// Kepler satellites around entity monoliths (overlay/kepler.ts): attachment cards and small
// glyphs of linked nodes on circular orbits with T ∝ a^{3/2}, driven by wall-clock time.
// Decoration only: the linked nodes themselves never move. Faint orbit rings make the
// period–radius law readable; they are drawn in the orbit planes around the entity's pose.

const RING_SEGS = 48
const CARD = { w: 0.5, h: 0.34, d: 0.03 } as const
const GLYPH_R = 0.16
const RING_COLOR = new Color('#8d8a84').multiplyScalar(0.22)

const _m = new Matrix4()
const _p = new Vector3()
const _q = new Quaternion()
const _s = new Vector3(1, 1, 1)
const _o = { x: 0, y: 0, z: 0 }
const _o2 = { x: 0, y: 0, z: 0 }
const _up = new Vector3(0, 1, 0)

interface Flat {
  entityId: string
  orbit: Orbit
  /** Ring segment endpoints relative to the entity (RING_SEGS·6 floats); orbits are fixed. */
  ring: Float32Array
}

function ringOffsets(orbit: Orbit): Float32Array {
  const out = new Float32Array(RING_SEGS * 6)
  for (let k = 0; k < RING_SEGS; k++) {
    orbitOffset(orbit, (k / RING_SEGS) * orbit.periodS, _o)
    orbitOffset(orbit, ((k + 1) / RING_SEGS) * orbit.periodS, _o2)
    out.set([_o.x, _o.y, _o.z, _o2.x, _o2.y, _o2.z], k * 6)
  }
  return out
}

export function KeplerSatellites() {
  const nodes = useWorld((s) => s.nodes)
  const flat = useMemo(() => {
    const cards: Flat[] = []
    const glyphs: Flat[] = []
    for (const [entityId, orbits] of satelliteSystems(nodes)) {
      for (const orbit of orbits) (orbit.kind === 'card' ? cards : glyphs).push({ entityId, orbit, ring: ringOffsets(orbit) })
    }
    return { cards, glyphs }
  }, [nodes])

  const kit = useMemo(
    () => ({
      card: new BoxGeometry(CARD.w, CARD.h, CARD.d),
      glyph: new OctahedronGeometry(GLYPH_R),
      cardMat: new MeshStandardMaterial({ color: '#d6d3cc', roughness: 0.6, metalness: 0.1, emissive: '#9fd3e6', emissiveIntensity: 0.25 }),
      glyphMat: new MeshBasicMaterial({ color: new Color('#e8b04a').multiplyScalar(1.8), toneMapped: false }),
      ringMat: new LineBasicMaterial({ color: RING_COLOR, toneMapped: false }),
    }),
    [],
  )
  useEffect(
    () => () => {
      kit.card.dispose()
      kit.glyph.dispose()
      kit.cardMat.dispose()
      kit.glyphMat.dispose()
      kit.ringMat.dispose()
    },
    [kit],
  )

  const cardCap = capacityFor(Math.max(1, flat.cards.length))
  const glyphCap = capacityFor(Math.max(1, flat.glyphs.length))
  const ringCap = flat.cards.length + flat.glyphs.length
  const meshes = useMemo(() => {
    const mk = (geo: BufferGeometry, mat: MeshBasicMaterial | MeshStandardMaterial, cap: number, name: string) => {
      const m = new InstancedMesh(geo, mat, cap)
      m.name = name
      m.instanceMatrix.setUsage(DynamicDrawUsage)
      m.layers.set(LAYER.SOLID)
      m.frustumCulled = false
      m.count = 0
      return m
    }
    const rg = new BufferGeometry()
    rg.setAttribute('position', new BufferAttribute(new Float32Array(Math.max(1, ringCap) * RING_SEGS * 6), 3).setUsage(DynamicDrawUsage))
    rg.setDrawRange(0, 0)
    const rings = new LineSegments(rg, kit.ringMat)
    rings.name = 'kepler-rings'
    rings.layers.set(LAYER.DUST)
    rings.renderOrder = RENDER_ORDER.DUST
    rings.frustumCulled = false
    return { cards: mk(kit.card, kit.cardMat, cardCap, 'kepler-cards'), glyphs: mk(kit.glyph, kit.glyphMat, glyphCap, 'kepler-glyphs'), rings }
  }, [kit, cardCap, glyphCap, ringCap])
  useEffect(
    () => () => {
      meshes.cards.dispose()
      meshes.glyphs.dispose()
      meshes.rings.geometry.dispose()
    },
    [meshes],
  )

  useFrame(() => {
    const table = getPoseTable()
    const tSec = Date.now() / 1000
    const RP = (meshes.rings.geometry.getAttribute('position') as BufferAttribute).array as Float32Array
    let rv = 0
    const place = (list: Flat[], mesh: InstancedMesh, spin: number) => {
      let n = 0
      for (const { entityId, orbit, ring } of list) {
        const row = table.index.get(entityId)
        if (row === undefined || table.born[row] !== 1) continue
        const o = row * 3
        const cx = table.pos[o]
        const cy = table.pos[o + 1]
        const cz = table.pos[o + 2]
        orbitOffset(orbit, tSec, _o)
        _p.set(cx + _o.x, cy + _o.y, cz + _o.z)
        // Cards face along their orbit; glyphs tumble slowly.
        _q.setFromAxisAngle(_up, Math.atan2(_o.x, _o.z) + spin * tSec)
        mesh.setMatrixAt(n++, _m.compose(_p, _q, _s))
        // Orbit ring around the entity's current pose.
        for (let k = 0; k < RING_SEGS * 6; k += 3) {
          RP[rv * 3 + k] = cx + ring[k]
          RP[rv * 3 + k + 1] = cy + ring[k + 1]
          RP[rv * 3 + k + 2] = cz + ring[k + 2]
        }
        rv += RING_SEGS * 2
      }
      mesh.count = n
      mesh.instanceMatrix.needsUpdate = true
    }
    place(flat.cards, meshes.cards, 0)
    place(flat.glyphs, meshes.glyphs, 0.6)
    meshes.rings.geometry.setDrawRange(0, rv)
    meshes.rings.geometry.getAttribute('position').needsUpdate = true
  }, -1)

  if (flat.cards.length + flat.glyphs.length === 0) return null
  return (
    <>
      <primitive object={meshes.cards} />
      <primitive object={meshes.glyphs} />
      <primitive object={meshes.rings} />
    </>
  )
}
