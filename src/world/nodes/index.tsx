import { Suspense, useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useWorld } from '../../app/store.ts'
import { memoryIndex } from '../../domain/memoryIndex.ts'
import type { Archetype, NodeRecord } from '../../domain/types.ts'
import { LAYER } from '../layers.ts'
import { Crystals, Demons, Documents, Lenses, Monoliths, Tesseracts, type VectorPairs } from './archetypes.tsx'
import { useNodeKit } from './kit.ts'
import { LabelPool } from './labels.tsx'
import { SelectionMarkers } from './markers.tsx'

export { usePoseWriterStatic, buildStaticPoseTable } from './staticPoses.ts'
export { setFlyInReady, enterMemory } from './instancing.ts'
export { memoryPlaqueText } from './labels.tsx'

// <NodeLayer/>: every live node as its archetype's mesh family, placed from the pose table
// each frame. Subscribes only to useWorld.nodes (one Map identity per mutation); selection,
// hover and proximity are read inside useFrame so they never re-render this tree.

export interface NodeGroups {
  all: NodeRecord[]
  byArchetype: Record<Archetype, NodeRecord[]>
  /** 1-based memory number (domain/memoryIndex.ts: temporalOrigin, createdAt, id). */
  memoryRank: Map<string, number>
  vectors: VectorPairs
}

/** Pure grouping of the live records. Exported for tests. */
export function groupNodes(nodes: ReadonlyMap<string, NodeRecord>): NodeGroups {
  const byArchetype: Record<Archetype, NodeRecord[]> = { idea: [], entity: [], lens: [], document: [], memory: [], demon: [] }
  const all: NodeRecord[] = []
  for (const n of nodes.values()) {
    all.push(n)
    byArchetype[n.archetype].push(n)
  }

  const memoryRank = memoryIndex(byArchetype.memory)

  // Entities pull on everything they are linked with, whichever side declared the link.
  const linked = new Map<string, Set<string>>()
  for (const e of byArchetype.entity) linked.set(e.id, new Set())
  for (const n of all) {
    for (const l of n.links) {
      if (!nodes.has(l.targetId) || l.targetId === n.id) continue
      linked.get(n.id)?.add(l.targetId)
      linked.get(l.targetId)?.add(n.id)
    }
  }
  const from: string[] = []
  const to: string[] = []
  for (const [e, targets] of linked) {
    for (const t of targets) {
      from.push(e)
      to.push(t)
    }
  }
  return { all, byArchetype, memoryRank, vectors: { from, to } }
}

export function NodeLayer() {
  const nodes = useWorld((s) => s.nodes)
  const groups = useMemo(() => groupNodes(nodes), [nodes])
  const kit = useNodeKit()
  const raycaster = useThree((s) => s.raycaster)

  // Memory front shells (and ghosts) live on LAYER.GLASS but carry pointer handlers; the
  // raycaster tests layers, so it must see GLASS. R3F only raycasts objects with handlers,
  // so this exposes nothing else. Left enabled on unmount: other glass pickers may rely on it.
  useEffect(() => {
    raycaster.layers.enable(LAYER.GLASS)
    // A node hovered at unmount would otherwise leave the pointer cursor behind.
    return () => {
      document.body.style.cursor = ''
    }
  }, [raycaster])

  useFrame((state) => {
    kit.time.value = state.clock.elapsedTime
  }, -1)

  const { byArchetype } = groups
  return (
    <group name="node-layer">
      <Crystals records={byArchetype.idea} kit={kit} />
      <Monoliths records={byArchetype.entity} kit={kit} vectors={groups.vectors} />
      <Lenses records={byArchetype.lens} kit={kit} />
      <Documents records={byArchetype.document} kit={kit} />
      <Tesseracts records={byArchetype.memory} kit={kit} />
      <Demons records={byArchetype.demon} kit={kit} />
      <SelectionMarkers byId={nodes} kit={kit} />
      <Suspense fallback={null}>
        <LabelPool records={groups.all} byId={nodes} memoryRank={groups.memoryRank} />
      </Suspense>
    </group>
  )
}
