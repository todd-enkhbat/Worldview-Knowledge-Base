import { useLayoutEffect, useRef } from 'react'
import { Color, Object3D, type BufferGeometry, type InstancedMesh, type Material } from 'three'
import { LAYER } from '../layers.ts'
import type { BoxInst, ShaftInst } from './layout.ts'

// Copies pure instance lists (layout.ts) into InstancedMeshes. Writes happen only when the list
// changes, never per frame. Capacity is the list length; a new length remounts the mesh.

const _o = new Object3D()
const _c = new Color()

export function writeBoxInstances(mesh: InstancedMesh, items: readonly BoxInst[]): void {
  let colored = false
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    _o.position.set(it.p[0], it.p[1], it.p[2])
    _o.rotation.set(0, it.ry ?? 0, it.rz ?? 0, 'YXZ')
    _o.scale.set(it.s[0], it.s[1], it.s[2])
    _o.updateMatrix()
    mesh.setMatrixAt(i, _o.matrix)
    if (it.c) colored = true
  }
  if (colored) {
    for (let i = 0; i < items.length; i++) {
      const c = items[i].c
      mesh.setColorAt(i, c ? _c.setRGB(c[0], c[1], c[2]) : _c.setRGB(1, 1, 1))
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }
  finish(mesh, items.length)
}

export function writeShaftInstances(mesh: InstancedMesh, items: readonly ShaftInst[]): void {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    _o.position.set(it.x, it.y0, it.z)
    // A per-shaft twist so the flutes do not line up like a pattern fill.
    _o.rotation.set(0, (i * 2.399) % (Math.PI * 2), 0)
    _o.scale.set(it.radius, it.height, it.radius)
    _o.updateMatrix()
    mesh.setMatrixAt(i, _o.matrix)
    const t = it.tone ?? 1
    mesh.setColorAt(i, _c.setRGB(t, t, t))
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  finish(mesh, items.length)
}

function finish(mesh: InstancedMesh, n: number): void {
  mesh.count = n
  mesh.instanceMatrix.needsUpdate = true
  // Keep frustum culling correct for the whole batch.
  mesh.computeBoundingBox()
  mesh.computeBoundingSphere()
}

interface InstancesProps<T> {
  items: readonly T[]
  geometry: BufferGeometry
  material: Material
  layer?: number
  renderOrder?: number
}

export function BoxInstances({ items, geometry, material, layer = LAYER.SOLID, renderOrder }: InstancesProps<BoxInst>) {
  const ref = useRef<InstancedMesh>(null)
  const capacity = Math.max(1, items.length)
  useLayoutEffect(() => {
    if (ref.current) writeBoxInstances(ref.current, items)
  }, [items, capacity])
  return <instancedMesh key={capacity} ref={ref} args={[geometry, material, capacity]} layers={layer} renderOrder={renderOrder} />
}

export function ShaftInstances({ items, geometry, material, layer = LAYER.SOLID }: InstancesProps<ShaftInst>) {
  const ref = useRef<InstancedMesh>(null)
  const capacity = Math.max(1, items.length)
  useLayoutEffect(() => {
    if (ref.current) writeShaftInstances(ref.current, items)
  }, [items, capacity])
  return <instancedMesh key={capacity} ref={ref} args={[geometry, material, capacity]} layers={layer} />
}
