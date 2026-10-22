import type { InteractionEvent } from '../../domain/types.ts'
import { getStore, isRepoReady, subscribeRepo } from '../../data/repo.ts'

// Attention in the field (milestone 2): looking at a note (inspecting it, dwelling near it,
// entering its scene) gives it back order, the way rehearsal keeps a memory sharp. Touches are
// read from the interaction log into a synchronous index, so the field stays a pure function
// of (playhead, log): a touch only counts once the playhead has reached it.

const KINDS = new Set<InteractionEvent['kind']>(['inspect', 'dwell', 'enter'])

let touches = new Map<string, Float64Array>()
let version = 0
let loading: Promise<void> | null = null
let subscribed = false

export function attentionVersion(): number {
  return version
}

/** The latest touch of a note at or before `atMs`, or -Infinity. */
export function lastTouch(id: string, atMs: number): number {
  const ts = touches.get(id)
  if (!ts?.length || ts[0] > atMs) return -Infinity
  let lo = 0
  let hi = ts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ts[mid] <= atMs) lo = mid
    else hi = mid - 1
  }
  return ts[lo]
}

/** Build the index from events (exported for tests). */
export function indexTouches(events: readonly InteractionEvent[]): Map<string, Float64Array> {
  const by = new Map<string, number[]>()
  for (const e of events) {
    if (!KINDS.has(e.kind)) continue
    let list = by.get(e.nodeId)
    if (!list) by.set(e.nodeId, (list = []))
    list.push(e.t)
  }
  return new Map([...by].map(([id, ts]) => [id, Float64Array.from(ts.sort((a, b) => a - b))]))
}

/** Load the log (once, then again whenever events change). Safe to call every frame. */
export function ensureAttention(): void {
  if (!isRepoReady()) return
  if (!subscribed) {
    subscribed = true
    subscribeRepo((change) => {
      if (change.type === 'events' || change.type === 'import' || change.type === 'wipe') void reload()
    })
  }
  if (!loading) loading = reload()
}

async function reload(): Promise<void> {
  try {
    touches = indexTouches(await getStore().listEvents())
    version++
  } catch {
    // The log is optional decoration here: without it notes simply age.
  }
}

/** Test hook. */
export function _setTouchesForTests(events: readonly InteractionEvent[]): void {
  touches = indexTouches(events)
  version++
}
