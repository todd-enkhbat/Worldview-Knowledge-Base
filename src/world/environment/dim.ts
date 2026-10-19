import { useEffect } from 'react'
import type { Color, MeshStandardMaterial } from 'three'
import { useApp } from '../../app/store.ts'

// Architecture dimming (Settings → Quality → Architecture): scales the albedo and environment
// reflection of the shell's lit materials so nodes, links and labels lead. Emitters (the ember
// lamps and year numerals) are left alone; they are wayfinding, not mass.

interface Base {
  color: Color
  env: number
}

const bases = new WeakMap<MeshStandardMaterial, Base>()

export function applyArchitectureDim(materials: readonly MeshStandardMaterial[], k: number): void {
  for (const m of materials) {
    let b = bases.get(m)
    if (!b) bases.set(m, (b = { color: m.color.clone(), env: m.envMapIntensity }))
    m.color.copy(b.color).multiplyScalar(k)
    m.envMapIntensity = b.env * k
  }
}

/** Keep these materials at the current architecture brightness. */
export function useArchitectureDim(materials: readonly MeshStandardMaterial[]): void {
  const k = useApp((s) => s.view.architecture)
  useEffect(() => applyArchitectureDim(materials, k), [materials, k])
}
