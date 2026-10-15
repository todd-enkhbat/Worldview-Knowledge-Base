import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { BoxGeometry, Color, DynamicDrawUsage, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three'
import { useWorld } from '../../app/store.ts'
import { HEBB } from '../../overlay/hebbian.ts'
import { getOverlayFields } from '../../overlay/index.ts'
import { LAYER, RENDER_ORDER } from '../layers.ts'
import { capacityFor } from '../nodes/instancing.ts'
import { getPoseTable } from '../poses.ts'

// Synapse filaments: thin square beams between co-activated nodes, thickness and brightness
// sized by the Hebbian weight w (overlay/hebbian.ts). Distinct from explicit links (thin
// GL lines, world/links): these are learned from interaction, and fade as w decays.

const R_MIN = 0.02
const R_MAX = 0.11
const BASE = new Color('#e8b04a')
/** HDR gain at w = w_max (bloom picks the strong ones up). */
const GAIN = 2.2

const _m = new Matrix4()
const _a = new Vector3()
const _b = new Vector3()
const _d = new Vector3()
const _q = new Quaternion()
const _s = new Vector3()
const _z = new Vector3(0, 0, 1)
const _c = new Color()

export function Synapses() {
  const nodes = useWorld((s) => s.nodes)
  const geometry = useMemo(() => {
    // Unit beam along +z from 0 to 1.
    const g = new BoxGeometry(1, 1, 1)
    g.translate(0, 0, 0.5)
    return g
  }, [])
  const material = useMemo(() => new MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), [])
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  // Degree ≤ 24 bounds the count by 12·N; most worlds are far below that.
  const capacity = Math.max(64, capacityFor(Math.min(nodes.size * 4, nodes.size * (HEBB.DEGREE_CAP / 2))))
  const mesh = useMemo(() => {
    const m = new InstancedMesh(geometry, material, capacity)
    m.name = 'synapses'
    m.instanceMatrix.setUsage(DynamicDrawUsage)
    m.setColorAt(0, _c.setRGB(0, 0, 0))
    m.instanceColor!.setUsage(DynamicDrawUsage)
    m.layers.set(LAYER.DUST)
    m.renderOrder = RENDER_ORDER.DUST
    m.frustumCulled = false
    m.count = 0
    return m
  }, [geometry, material, capacity])
  useEffect(() => () => mesh.dispose(), [mesh])

  useFrame(() => {
    const f = getOverlayFields(Date.now())
    const table = getPoseTable()
    let n = 0
    for (const syn of f.synapses) {
      if (n >= capacity) break
      const ra = table.index.get(syn.a)
      const rb = table.index.get(syn.b)
      if (ra === undefined || rb === undefined) continue
      _a.fromArray(table.pos, ra * 3)
      _b.fromArray(table.pos, rb * 3)
      _d.subVectors(_b, _a)
      const len = _d.length()
      if (len < 1e-4) continue
      const w = syn.w / HEBB.W_MAX
      const r = R_MIN + (R_MAX - R_MIN) * w
      _q.setFromUnitVectors(_z, _d.multiplyScalar(1 / len))
      _s.set(r, r, len)
      mesh.setMatrixAt(n, _m.compose(_a, _q, _s))
      const unborn = table.born[ra] !== 1 || table.born[rb] !== 1
      const k = (0.25 + GAIN * w) * (unborn ? 0.3 : 1)
      mesh.setColorAt(n, _c.copy(BASE).multiplyScalar(k))
      n++
    }
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, -1)

  return <primitive object={mesh} />
}
