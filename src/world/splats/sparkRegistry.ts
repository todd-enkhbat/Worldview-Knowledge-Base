import type { SparkRenderer } from '@sparkjsdev/spark'
import type { Object3D } from 'three'

// The ONE world SparkRenderer (CLAUDE.md: exactly one per canvas). SparkLayer creates it and
// registers it here; everything else (diorama meshes, the ingest pipeline's budgeted proxy
// cut, dev stats) borrows it instead of constructing another. Dioramas add their SplatMeshes
// to the world only after whenSpark() resolves, so nothing is generated before the renderer
// (with its layer, budget and forceSinglePass settings) exists.

let current: SparkRenderer | null = null
let waiters: ((s: SparkRenderer) => void)[] = []

/** Register (or clear, with null) the world renderer. Called by SparkLayer only. */
export function setSpark(s: SparkRenderer | null): void {
  current = s
  if (!s) return
  const pending = waiters
  waiters = []
  for (const resolve of pending) resolve(s)
}

export function getSpark(): SparkRenderer | null {
  return current
}

/** Resolves with the world renderer as soon as one is registered (immediately if it is). */
export function whenSpark(): Promise<SparkRenderer> {
  if (current) return Promise.resolve(current)
  return new Promise((resolve) => waiters.push(resolve))
}

// The splat stage: a top-level scene group outside the world group (environment, nodes,
// links), so a diorama lifted into it stays visible when the world is hidden (interior,
// framing). SparkLayer owns it.

let stage: Object3D | null = null

export function setSplatStage(s: Object3D | null): void {
  stage = s
}

export function getSplatStage(): Object3D | null {
  return stage
}
