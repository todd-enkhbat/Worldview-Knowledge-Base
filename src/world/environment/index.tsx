import { useApp } from '../../app/store.ts'
import type { PathGraph } from '../paths.ts'
import { Floor } from './Floor.tsx'
import { GalaxyEnvironment } from './GalaxyEnvironment.tsx'
import { EnvironmentLighting, EnvironmentLights } from './Sky.tsx'
import { KnowledgeGround } from './KnowledgeGround.tsx'

// XYZ is spatial. Time filters the records through the timeline; there is no chronological
// tower in the live world. Actual semantic neighborhoods shape their own connected ground.
export { usePathGraph, useWorldTime, useDayClock, collectMemories } from './usePathGraph.ts'

export interface EnvironmentSceneProps {
  /** Retained for legacy sandboxes; the spatial world does not use a year path graph. */
  graph?: PathGraph
  lights?: boolean
  environment?: boolean
  classic?: boolean
}

export function EnvironmentScene({ lights = true, environment = true }: EnvironmentSceneProps) {
  const reflective = useApp((s) => s.mode === 'third_person' && s.quality.reflector !== 'off')
  const reflectorRes = useApp((s) => (s.quality.reflector === '512' ? 512 : 1024))
  return <group name="environment">
    <GalaxyEnvironment />
    {environment && <EnvironmentLighting />}
    {lights && <EnvironmentLights />}
    <Floor reflective={reflective} resolution={reflectorRes} />
    <KnowledgeGround />
  </group>
}
