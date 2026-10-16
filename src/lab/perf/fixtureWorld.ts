import { useApp, useWorld } from '../../app/store.ts'
import { bootData } from '../../app/boot.ts'
import { MS_PER_YEAR, Y_PER_YEAR } from '../../domain/constants.ts'
import { anchorY } from '../../domain/placement.ts'
import type { NodeRecord, Quat, WorldSettings } from '../../domain/types.ts'
import { createMemoryStore } from '../../data/memoryStore.ts'
import { closeRepo, defaultSettings, initRepo, isRepoReady } from '../../data/repo.ts'
import { buildDemoWorld } from '../../data/seed/demo.ts'
import { ingestScene } from '../../world/splats/ingest/ingest.ts'
import type { PathMemory, V3 } from './cameraPath.ts'

// The fixed fixture world of #/lab/perf. The bench must not touch the user's world, so it
// swaps the repo onto a private in-memory store for its lifetime (the page-wide writer lock
// stays held, so other tabs see nothing change) and swaps the IndexedDB repo back on exit.
// The world is a pure function of constants: the demo seed at a fixed T0 and "now", a
// fixed physics seed, and the four CC-BY fixtures (public/fixtures, docs/CREDITS.md)
// attached to four demo memories when they are present.

export const PERF_T0 = Date.UTC(1990, 0, 1)
export const PERF_NOW = Date.UTC(2026, 0, 1)
export const PERF_PHYSICS_SEED = 0x5eed

const Y_DOWN: Quat = [1, 0, 0, 0]
const IDENTITY: Quat = [0, 0, 0, 1]

/** The fixtures in the order they are attached (memories in date order). */
export const PERF_FIXTURES: readonly { name: string; url: string; upFix: Quat }[] = [
  { name: 'lion', url: '/fixtures/lion.v3.spz', upFix: Y_DOWN },
  { name: 'tomatoes', url: '/fixtures/tomatoes.v4.spz', upFix: IDENTITY },
  { name: 'apartment', url: '/fixtures/apartment.sog', upFix: Y_DOWN },
  { name: 'hall', url: '/fixtures/knock-community-hall.sog', upFix: Y_DOWN },
]

export interface FixtureReport {
  readonly name: string
  readonly nodeId: string
  readonly status: 'attached' | 'missing' | 'failed'
  readonly ms: number
  readonly splats?: number
  readonly error?: string
}

export interface FixtureWorld {
  readonly settings: WorldSettings
  readonly nodes: number
  /** The (up to four) memories that carry the fixtures, in date order. */
  readonly memories: readonly NodeRecord[]
  readonly fixtures: FixtureReport[]
}

let swapped = false
// Swaps run strictly in order: StrictMode mounts, unmounts and remounts the page at once.
let queue: Promise<unknown> = Promise.resolve()

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn)
  queue = p.catch(() => undefined)
  return p
}

/** Swap the repo onto the deterministic in-memory fixture world (records only; no splats yet). */
export function enterFixtureWorld(): Promise<FixtureWorld> {
  return serial(enter)
}

async function enter(): Promise<FixtureWorld> {
  await bootData()
  await closeRepo()
  swapped = true
  const store = createMemoryStore()
  const settings: WorldSettings = { ...defaultSettings(PERF_T0, PERF_NOW), physicsSeed: PERF_PHYSICS_SEED, qualityTier: 'high' }
  const records = buildDemoWorld(PERF_T0, PERF_NOW, { yPerYear: settings.yPerYear })
  await store.putNodes(records)
  await store.putSettings(settings)
  await initRepo({ store, now: () => PERF_NOW, lock: null, sync: null, storageStatus: false, autoBackup: false })
  const memories = records
    .filter((r) => r.archetype === 'memory')
    .sort((a, b) => a.temporalOrigin - b.temporalOrigin || (a.id < b.id ? -1 : 1))
  // Up to four, spread over the span.
  const pick: NodeRecord[] = []
  const k = Math.min(PERF_FIXTURES.length, memories.length)
  for (let i = 0; i < k; i++) pick.push(memories[Math.round((i * (memories.length - 1)) / Math.max(1, k - 1))])
  return { settings, nodes: records.length, memories: pick, fixtures: [] }
}

/** Is the fixture file served? (public/fixtures is gitignored; scripts/fetch-fixtures.sh fills it.) */
async function present(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' })
    const type = r.headers.get('content-type') ?? ''
    // Vite's SPA fallback answers unknown paths with index.html.
    return r.ok && !type.includes('text/html')
  } catch {
    return false
  }
}

/**
 * Attach the fixtures to the world's memories (needs the world SparkRenderer mounted: the
 * ingest cuts proxies and thumbnails with it). Missing files are skipped.
 */
export async function attachFixtures(world: FixtureWorld, onProgress?: (msg: string) => void): Promise<FixtureReport[]> {
  const out: FixtureReport[] = []
  for (let i = 0; i < world.memories.length && i < PERF_FIXTURES.length; i++) {
    const f = PERF_FIXTURES[i]
    const nodeId = world.memories[i].id
    const t0 = performance.now()
    if (!(await present(f.url))) {
      out.push({ name: f.name, nodeId, status: 'missing', ms: 0 })
      continue
    }
    try {
      const r = await ingestScene(
        nodeId,
        { url: f.url },
        {
          name: f.url.split('/').pop(),
          upFix: f.upFix,
          onProgress: (p) => onProgress?.(`${f.name}: ${p.label} ${(p.fraction * 100).toFixed(0)}%`),
        },
      )
      out.push({ name: f.name, nodeId, status: 'attached', ms: Math.round(performance.now() - t0), splats: r.block.counts.interior })
    } catch (e) {
      out.push({ name: f.name, nodeId, status: 'failed', ms: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e) })
    }
  }
  world.fixtures.splice(0, world.fixtures.length, ...out)
  return out
}

/** Static anchors (date heights) of the world's memories, for the camera path. */
export function memoryAnchors(world: FixtureWorld): PathMemory[] {
  const { T0, yPerYear } = world.settings
  return world.memories.map((n) => ({ anchor: [n.anchorXZ[0], anchorY(n, { T0, yPerYear }), n.anchorXZ[1]] as V3 }))
}

/** Height of the fixed "now" in the fixture world. */
export function presentY(): number {
  const s = useWorld.getState().settings
  return ((PERF_NOW - (s?.T0 ?? PERF_T0)) / MS_PER_YEAR) * (s?.yPerYear ?? Y_PER_YEAR)
}

/** Swap the user's IndexedDB world back in (idempotent). */
export function exitFixtureWorld(): Promise<void> {
  return serial(exit)
}

async function exit(): Promise<void> {
  if (!swapped) return
  swapped = false
  await closeRepo()
  if (!isRepoReady()) await initRepo()
  useApp.setState({ mode: 'orbit', prevMode: 'orbit', selectedId: null, focusedId: null })
}
