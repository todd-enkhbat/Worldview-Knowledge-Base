import type { NodeRecord } from './types.ts'

// Memories are numbered by when they entered the user's life: temporalOrigin, then
// createdAt, then id (uuids, so the order is total and stable across devices). One helper
// so the tesseract plaque and the Inspector can never disagree about "MEMORY 007".

export type MemoryOrderKey = Pick<NodeRecord, 'id' | 'archetype' | 'temporalOrigin' | 'createdAt' | 'deletedAt'>

/** Sort comparator for memories (any archetype is accepted; only the keys are compared). */
export function compareMemoryOrder(a: MemoryOrderKey, b: MemoryOrderKey): number {
  return a.temporalOrigin - b.temporalOrigin || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

const counts = (n: MemoryOrderKey) => n.archetype === 'memory' && n.deletedAt === null

/** 1-based number of every live memory in `nodes`. Trashed records and other archetypes are skipped. */
export function memoryIndex(nodes: Iterable<MemoryOrderKey>): Map<string, number> {
  const memories: MemoryOrderKey[] = []
  for (const n of nodes) if (counts(n)) memories.push(n)
  memories.sort(compareMemoryOrder)
  return new Map(memories.map((m, i) => [m.id, i + 1]))
}

/** The number of one memory without sorting (O(n)); 0 when `id` is not a live memory in `nodes`. */
export function memoryOrdinal(nodes: ReadonlyMap<string, MemoryOrderKey>, id: string): number {
  const self = nodes.get(id)
  if (!self || !counts(self)) return 0
  let before = 0
  for (const n of nodes.values()) if (n.id !== id && counts(n) && compareMemoryOrder(n, self) < 0) before++
  return before + 1
}

/** "MEMORY 001": the shared typography for plaque and Inspector. */
export function memoryLabel(ordinal: number): string {
  return `MEMORY ${String(ordinal).padStart(3, '0')}`
}
