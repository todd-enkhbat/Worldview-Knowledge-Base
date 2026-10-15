import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { BoxGeometry, DynamicDrawUsage, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three'
import { useWorld } from '../../app/store.ts'
import { getOverlayFields } from '../../overlay/index.ts'
import { LAYER } from '../layers.ts'
import { capacityFor, farScale, nodeScale } from '../nodes/instancing.ts'
import { getPoseTable } from '../poses.ts'

// Citadels: board-formed concrete plinths that accrete UNDER frequently visited nodes,
// height ∝ tanh E (overlay/hebbian.ts). The node stays at its date; the column grows down
// from just below it. One InstancedMesh; born nodes only (a ghost has no ground to stand on).

/** Ignore plinths shorter than this (world units). */
const MIN_HEIGHT = 0.05
const WIDTH = 1.1
/** Gap between the node's lower extent and the plinth top. */
const CLEARANCE = 0.35

const _m = new Matrix4()
const _p = new Vector3()
const _q = new Quaternion()
const _s = new Vector3()

export function Citadels() {
  const nodes = useWorld((s) => s.nodes)
  const geometry = useMemo(() => {
    // Unit box with its top face at y = 0, so scale.y is the height below the anchor point.
    const g = new BoxGeometry(1, 1, 1)
    g.translate(0, -0.5, 0)
    return g
  }, [])
  const material = useMemo(() => new MeshStandardMaterial({ color: '#8d8a84', roughness: 0.92, metalness: 0 }), [])
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  const capacity = Math.max(64, capacityFor(nodes.size))
  const mesh = useMemo(() => {
    const m = new InstancedMesh(geometry, material, capacity)
    m.name = 'citadels'
    m.instanceMatrix.setUsage(DynamicDrawUsage)
    m.layers.set(LAYER.SOLID)
    m.frustumCulled = false
    m.count = 0
    return m
  }, [geometry, material, capacity])
  useEffect(() => () => mesh.dispose(), [mesh])

  useFrame((state) => {
    const t = Date.now()
    const f = getOverlayFields(t)
    const table = getPoseTable()
    const cam = state.camera.position
    let n = 0
    for (const [id, p] of f.nodes) {
      if (p.citadel < MIN_HEIGHT || n >= capacity) continue
      const row = table.index.get(id)
      const rec = nodes.get(id)
      if (row === undefined || !rec || table.born[row] !== 1) continue
      const o = row * 3
      const x = table.pos[o]
      const y = table.pos[o + 1]
      const z = table.pos[o + 2]
      const far = farScale(Math.hypot(x - cam.x, y - cam.y, z - cam.z))
      const top = y - 1.5 * nodeScale(rec) * far - CLEARANCE
      _p.set(x, top, z)
      _s.set(WIDTH, p.citadel, WIDTH)
      mesh.setMatrixAt(n++, _m.compose(_p, _q, _s))
    }
    mesh.count = n
    mesh.instanceMatrix.needsUpdate = true
  }, -1)

  return <primitive object={mesh} />
}
