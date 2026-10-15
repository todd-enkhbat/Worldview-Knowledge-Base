import { Suspense, useEffect, useMemo } from 'react'
import { useApp, useWorld } from '../../app/store.ts'
import type { PathGraph } from '../paths.ts'
import { Architecture } from './Architecture.tsx'
import { Catwalk } from './Catwalk.tsx'
import { Floor } from './Floor.tsx'
import { EmptyWorldPlinth, PresentLabels, YearNumerals } from './Labels.tsx'
import { Manifold } from './Manifold.tsx'
import { EnvironmentLighting, EnvironmentLights, SkyDome, Stars } from './Sky.tsx'
import { buildArchitecture } from './layout.ts'
import { PALETTE, createConcreteMaterial, createEmissiveMaterial, createMetalMaterial } from './materials.ts'
import { usePathGraph } from './usePathGraph.ts'

// The brutalist world shell: void sky and stars, PMREM environment, floor (reflective in third
// person), fluted core, a ground colonnade with a few pylons, monoliths and cantilevers, the
// helical catwalk with year landings, memory spurs and the Present landing, and the torus
// manifold. Everything but the core and catwalk stays outside the node rings: it frames them.
//
// Draw calls (independent of span and memory count): sky 1, stars 1, floor 1, core 1, shafts 1,
// drums 1, boxes 1, emitters 2, deck 1, rails 1, spur boxes 1, metal 1, manifold 2, plus
// ≤ 2·12 + 5 text meshes.

export { usePathGraph, useWorldTime, useDayClock, collectMemories } from './usePathGraph.ts'

export interface EnvironmentSceneProps {
  /** Provide a graph to share one instance with the camera rig; defaults to usePathGraph(). */
  graph?: PathGraph
  /** Direct lights (key + ember fill). Off if the host scene lights itself. */
  lights?: boolean
  /** PMREM environment (sets scene.environment). */
  environment?: boolean
}

function useEnvironmentMaterials() {
  const m = useMemo(
    () => ({
      board: createConcreteMaterial({ board: 0.16, seams: 1, roughness: 0.9 }),
      cast: createConcreteMaterial({ board: 1.35, seams: 0.8, roughness: 0.86 }),
      brass: createMetalMaterial({ color: PALETTE.brass, roughness: 0.34 }),
      metal: createMetalMaterial({ roughness: 0.3 }),
      emissive: createEmissiveMaterial(),
    }),
    [],
  )
  useEffect(
    () => () => {
      for (const mat of Object.values(m)) mat.dispose()
    },
    [m],
  )
  return m
}

export function EnvironmentScene({ graph: external, lights = true, environment = true }: EnvironmentSceneProps) {
  const own = usePathGraph()
  const graph = external ?? own
  const reflective = useApp((s) => s.mode === 'third_person' && s.quality.reflector !== 'off')
  const reflectorRes = useApp((s) => (s.quality.reflector === '512' ? 512 : 1024))
  const emptyWorld = useWorld((s) => s.nodes.size === 0)
  const materials = useEnvironmentMaterials()
  const arch = useMemo(() => buildArchitecture(graph.helix.yMax, graph.helix.pitch), [graph.helix.yMax, graph.helix.pitch])

  return (
    <group name="environment">
      <SkyDome />
      <Stars />
      {environment && <EnvironmentLighting />}
      {lights && <EnvironmentLights />}
      <Floor reflective={reflective} resolution={reflectorRes} />
      <Architecture layout={arch} materials={materials} />
      <Catwalk graph={graph} materials={materials} emptyWorld={emptyWorld} />
      <Suspense fallback={null}>
        <YearNumerals graph={graph} />
        <PresentLabels graph={graph} />
        {emptyWorld && <EmptyWorldPlinth graph={graph} />}
      </Suspense>
      <Manifold graph={graph} />
    </group>
  )
}
