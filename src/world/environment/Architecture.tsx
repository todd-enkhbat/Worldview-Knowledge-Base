import { useEffect, useMemo } from 'react'
import { BoxGeometry, CylinderGeometry, type Material } from 'three'
import { CORE_RADIUS } from '../../domain/placement.ts'
import { LAYER } from '../layers.ts'
import { createFlutedCylinderGeometry } from './geometry.ts'
import { BoxInstances, ShaftInstances } from './instances.tsx'
import { CORE_FLUTES, type Architecture as ArchitectureLayout } from './layout.ts'

// Static massing: the fluted core, the ground colonnade and its pylons, monoliths and
// cantilevers. All of it stands outside the node rings (layout.ts). Five draw calls in
// total, whatever the span of the world.

export interface ArchitectureMaterials {
  /** Board-formed concrete (slabs, beams, monoliths). */
  board: Material
  /** Cast concrete with tall pour lifts (core, shafts, drums). */
  cast: Material
  emissive: Material
}

export function Architecture({ layout, materials }: { layout: ArchitectureLayout; materials: ArchitectureMaterials }) {
  const geo = useMemo(() => {
    const drum = new CylinderGeometry(1, 1, 1, 72, 1)
    drum.translate(0, 0.5, 0)
    return {
      core: createFlutedCylinderGeometry({ flutes: CORE_FLUTES, depth: 0.045, segmentsPerFlute: 6 }),
      shaft: createFlutedCylinderGeometry({ flutes: 20, depth: 0.07, segmentsPerFlute: 5, caps: false }),
      box: new BoxGeometry(1, 1, 1),
      drum,
    }
  }, [])
  useEffect(
    () => () => {
      for (const g of Object.values(geo)) g.dispose()
    },
    [geo],
  )

  return (
    <group>
      <mesh
        geometry={geo.core}
        material={materials.cast}
        position={[0, layout.core.y0, 0]}
        scale={[CORE_RADIUS, layout.core.height, CORE_RADIUS]}
        layers={LAYER.SOLID}
      />
      <ShaftInstances items={layout.shafts} geometry={geo.shaft} material={materials.cast} />
      <ShaftInstances items={layout.drums} geometry={geo.drum} material={materials.cast} />
      <BoxInstances items={layout.boxes} geometry={geo.box} material={materials.board} />
      <BoxInstances items={layout.emissive} geometry={geo.box} material={materials.emissive} />
    </group>
  )
}
