import { useEffect, useMemo } from 'react'
import { BoxGeometry, type Material } from 'three'
import { LAYER } from '../layers.ts'
import { CATWALK_WIDTH, type PathGraph } from '../paths.ts'
import { buildCatwalkGeometry } from './catwalkGeometry.ts'
import { BoxInstances } from './instances.tsx'
import { buildCatwalkInstances, deckPieces } from './layout.ts'
import { PALETTE } from './materials.ts'

// The helical catwalk: ramp, year landings and the Present landing swept as one concrete mesh,
// brass handrails swept as one metal mesh, and the spurs, stairs, piers, posts and light strips
// as instances. Seven draw calls for any number of years and memories.

export interface CatwalkMaterials {
  board: Material
  brass: Material
  metal: Material
  emissive: Material
}

export function Catwalk({ graph, materials, emptyWorld }: { graph: PathGraph; materials: CatwalkMaterials; emptyWorld: boolean }) {
  const pieces = useMemo(() => deckPieces(graph), [graph])
  const geo = useMemo(() => buildCatwalkGeometry(graph, pieces), [graph, pieces])
  useEffect(
    () => () => {
      geo.deck.dispose()
      geo.rails.dispose()
    },
    [geo],
  )
  const inst = useMemo(() => buildCatwalkInstances(graph, pieces, emptyWorld), [graph, pieces, emptyWorld])
  const box = useMemo(() => new BoxGeometry(1, 1, 1), [])
  useEffect(() => () => box.dispose(), [box])

  const p = graph.present
  const lightR = graph.helix.radius + CATWALK_WIDTH / 2
  return (
    <group>
      <mesh geometry={geo.deck} material={materials.board} layers={LAYER.SOLID} />
      <mesh geometry={geo.rails} material={materials.brass} layers={LAYER.SOLID} />
      <BoxInstances items={inst.boxes} geometry={box} material={materials.board} />
      <BoxInstances items={inst.metal} geometry={box} material={materials.metal} />
      <BoxInstances items={inst.emissive} geometry={box} material={materials.emissive} />
      {/* Ember glow pooled on the Present landing. */}
      <pointLight
        position={[lightR * Math.cos(p.angle), p.y + 2.6, lightR * Math.sin(p.angle)]}
        color={PALETTE.ember}
        intensity={26}
        distance={34}
        decay={2}
      />
    </group>
  )
}
