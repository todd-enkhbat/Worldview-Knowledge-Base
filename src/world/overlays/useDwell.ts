import { useEffect } from 'react'
import { useApp } from '../../app/store.ts'
import { logEvent } from '../../data/repo.ts'
import { useProximity } from '../camera/proximity.ts'

// Dwell detection: a node the camera lingers by (proximity's nearest node) or that stays
// selected for DWELL_MS of wall-clock time logs ONE 'dwell' event per visit. A visit lasts
// while the node stays attended (near or selected, either way); it ends when the node is
// neither, and the next visit can dwell again. Hidden tabs do not dwell.

export const DWELL_MS = 1000
const TICK_MS = 200

/** Pure visit bookkeeping (tested): feed it the attended ids and the time, get the ids that just dwelt. */
export class DwellTracker {
  private since = new Map<string, number>()
  private logged = new Set<string>()

  update(attended: Iterable<string>, now: number): string[] {
    const cur = new Set(attended)
    for (const id of [...this.since.keys()]) {
      if (!cur.has(id)) {
        this.since.delete(id)
        this.logged.delete(id)
      }
    }
    const out: string[] = []
    for (const id of cur) {
      const t0 = this.since.get(id)
      if (t0 === undefined) this.since.set(id, now)
      else if (!this.logged.has(id) && now - t0 >= DWELL_MS) {
        this.logged.add(id)
        out.push(id)
      }
    }
    return out
  }

  reset(): void {
    this.since.clear()
    this.logged.clear()
  }
}

function attended(): string[] {
  const out: string[] = []
  const near = useProximity.getState().nearestId
  const sel = useApp.getState().selectedId
  if (near) out.push(near)
  if (sel && sel !== near) out.push(sel)
  return out
}

/** Mount once (inside <Overlays/>). */
export function useDwell(): void {
  useEffect(() => {
    const tracker = new DwellTracker()
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        tracker.reset()
        return
      }
      for (const id of tracker.update(attended(), Date.now())) {
        void logEvent('dwell', id).catch(() => {})
      }
    }
    const timer = setInterval(tick, TICK_MS)
    // Start visits promptly instead of up to one tick late.
    const offs = [
      useProximity.subscribe((s, p) => {
        if (s.nearestId !== p.nearestId) tick()
      }),
      useApp.subscribe((s, p) => {
        if (s.selectedId !== p.selectedId) tick()
      }),
    ]
    return () => {
      clearInterval(timer)
      for (const off of offs) off()
    }
  }, [])
}
