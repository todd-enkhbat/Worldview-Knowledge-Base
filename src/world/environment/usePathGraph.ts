import { useEffect, useMemo, useState } from 'react'
import { useWorld } from '../../app/store.ts'
import { Y_PER_YEAR } from '../../domain/constants.ts'
import { yOf } from '../../domain/time.ts'
import type { NodeRecord } from '../../domain/types.ts'
import { buildPathGraph, fallbackT0, type PathGraph, type PathMemory } from '../paths.ts'

// Store → catwalk path graph. Shared by the environment (geometry) and the camera rig (walking),
// so both see the same helix, landings and spurs.

const DAY_MS = 86_400_000

/** Wall clock quantised to the UTC day: the Present moves 0.03 u a day, and a coarse clock keeps
 *  the catwalk geometry from rebuilding more than once a day. */
export function useDayClock(): number {
  const [day, setDay] = useState(() => Math.floor(Date.now() / DAY_MS) * DAY_MS)
  useEffect(() => {
    const id = setInterval(() => {
      const d = Math.floor(Date.now() / DAY_MS) * DAY_MS
      setDay((prev) => (prev === d ? prev : d))
    }, 3_600_000)
    return () => clearInterval(id)
  }, [])
  return day
}

export interface WorldTime {
  T0: number
  now: number
  yPerYear: number
}

/** T0 from the settings, or now − 30 y before first run (sandboxes). */
export function useWorldTime(): WorldTime {
  const now = useDayClock()
  const T0 = useWorld((s) => s.settings?.T0 ?? null)
  const yPerYear = useWorld((s) => s.settings?.yPerYear ?? Y_PER_YEAR)
  return useMemo(() => ({ T0: T0 ?? fallbackT0(now), now, yPerYear }), [T0, now, yPerYear])
}

/** Placement-relevant fingerprint of the live memories; edits to titles etc. leave it unchanged. */
function memoryKey(nodes: Map<string, NodeRecord>): string {
  let key = ''
  for (const n of nodes.values()) {
    if (n.archetype !== 'memory') continue
    key += `${n.id},${n.anchorXZ[0]},${n.anchorXZ[1]},${n.temporalOrigin};`
  }
  return key
}

export function collectMemories(nodes: Map<string, NodeRecord>, T0: number, yPerYear: number): PathMemory[] {
  const out: PathMemory[] = []
  for (const n of nodes.values()) {
    if (n.archetype !== 'memory') continue
    out.push({ id: n.id, anchorXZ: n.anchorXZ, y: yOf(n.temporalOrigin, T0, yPerYear) })
  }
  return out
}

export function usePathGraph(): PathGraph {
  const { T0, now, yPerYear } = useWorldTime()
  // A string selector re-renders only when a memory is added, removed, moved or re-dated.
  const key = useWorld((s) => memoryKey(s.nodes))
  return useMemo(() => {
    void key
    const memories = collectMemories(useWorld.getState().nodes, T0, yPerYear)
    return buildPathGraph({ T0, now, yPerYear, memories })
  }, [key, T0, now, yPerYear])
}
