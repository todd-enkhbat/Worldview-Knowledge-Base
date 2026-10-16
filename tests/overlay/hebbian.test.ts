import { describe, expect, it } from 'vitest'
import { DEFAULT_AMPLITUDE } from '../../src/data/repo.ts'
import type { InteractionEvent, InteractionKind } from '../../src/domain/types.ts'
import {
  FALLBACK_AMPLITUDE,
  FOLD_SKEW_MS,
  HEBB,
  applyEvent,
  applyEvents,
  citadelHeight,
  createPlasticity,
  elevation,
  foldLog,
  mistAmount,
  neglectAt,
  nodePlasticity,
  synapseKey,
  synapsesAt,
  traceAt,
} from '../../src/overlay/hebbian.ts'
import type { PlasticityState } from '../../src/overlay/hebbian.ts'

const DAY = 86_400_000
const MIN = 60_000
const T = Date.UTC(2026, 0, 1)

let seq = 0
function ev(kind: InteractionKind, nodeId: string, t: number, amplitude?: number): InteractionEvent {
  const e: InteractionEvent = { id: `e${String(++seq).padStart(6, '0')}`, t, kind, nodeId }
  if (amplitude !== undefined) e.amplitude = amplitude
  return e
}

/** Deterministic pseudo-random log over `n` nodes. */
function randomLog(count: number, nodes: number, seed = 1): InteractionEvent[] {
  let s = seed >>> 0
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
  const kinds: InteractionKind[] = ['dwell', 'inspect', 'enter', 'demon-match']
  const out: InteractionEvent[] = []
  let t = T
  for (let i = 0; i < count; i++) {
    t += Math.floor(rnd() * (rnd() < 0.7 ? 20 * MIN : 3 * DAY))
    out.push(ev(kinds[Math.floor(rnd() * 4)], `n${Math.floor(rnd() * nodes)}`, t, rnd() < 0.2 ? undefined : 0.25 + rnd() * 2))
  }
  return out
}

function snapshot(s: PlasticityState) {
  return {
    traces: [...s.traces.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    synapses: [...s.synapses.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    adjacency: [...s.adjacency.entries()].map(([k, v]) => [k, [...v].sort()] as const).sort(([a], [b]) => (a < b ? -1 : 1)),
    last: s.last,
    events: s.events,
  }
}

describe('hebbian trace', () => {
  it('mirrors the repo amplitudes', () => {
    expect(FALLBACK_AMPLITUDE).toEqual(DEFAULT_AMPLITUDE)
  })

  it('decays with T_E between events and stores post-event values', () => {
    const s = createPlasticity()
    applyEvent(s, ev('inspect', 'a', T, 1))
    applyEvent(s, ev('inspect', 'a', T + 7 * DAY, 1))
    const tr = s.traces.get('a')!
    expect(tr.tE).toBe(T + 7 * DAY)
    expect(tr.e).toBeCloseTo(1 + Math.exp(-1), 12)
    expect(traceAt(s, 'a', T + 14 * DAY)).toBeCloseTo((1 + Math.exp(-1)) * Math.exp(-1), 12)
    expect(traceAt(s, 'b', T)).toBe(0)
  })

  it('uses the per-kind fallback amplitude and ignores non-positive ones', () => {
    const s = createPlasticity()
    applyEvent(s, ev('enter', 'a', T))
    applyEvent(s, ev('inspect', 'b', T + 1, -3))
    expect(s.traces.get('a')!.e).toBe(FALLBACK_AMPLITUDE.enter)
    expect(s.traces.has('b')).toBe(false)
  })

  it('keeps elevation bounded, rising with use and sinking with neglect', () => {
    for (const e of [0, 0.1, 1, 10, 1e6]) for (const n of [0, 0.5, 1]) {
      const y = elevation(e, n)
      expect(Math.abs(y)).toBeLessThanOrEqual(HEBB.Y_MAX)
    }
    expect(elevation(100, 0)).toBeCloseTo(HEBB.Y_MAX, 6)
    expect(elevation(0, 1)).toBeCloseTo(-HEBB.Y_SINK, 12)
    expect(elevation(0, 0)).toBe(0)
    expect(neglectAt(T, T - 5)).toBe(0)
    expect(neglectAt(T, T + 1000 * DAY)).toBeCloseTo(1, 6)
    expect(mistAmount(0, 1)).toBe(1)
    expect(mistAmount(50, 1)).toBeLessThan(0.01)
    expect(citadelHeight(0)).toBe(0)
    expect(citadelHeight(1e9)).toBeCloseTo(HEBB.CITADEL_MAX, 6)
  })

  it('reads a never-visited node from its creation time', () => {
    const s = createPlasticity()
    const p = nodePlasticity(s, 'x', T, T + 300 * DAY)
    expect(p.e).toBe(0)
    expect(p.neglect).toBeGreaterThan(0.99)
    expect(p.y).toBeLessThan(0)
    expect(p.mist).toBeGreaterThan(0.99)
    const fresh = nodePlasticity(s, 'x', T, T)
    expect(fresh.y).toBe(0)
    expect(fresh.mist).toBe(0)
  })
})

describe('synapses', () => {
  it('co-activation within 30 min strengthens w = wmax − (wmax − w)e^{−ηc}', () => {
    const s = createPlasticity()
    applyEvent(s, ev('inspect', 'a', T, 1))
    applyEvent(s, ev('inspect', 'b', T + 10 * MIN, 1))
    const w1 = s.synapses.get(synapseKey('a', 'b'))!.w
    expect(w1).toBeCloseTo(HEBB.W_MAX * (1 - Math.exp(-HEBB.ETA)), 12)
    applyEvent(s, ev('inspect', 'a', T + 20 * MIN, 1))
    const w2 = s.synapses.get(synapseKey('a', 'b'))!.w
    const w1d = w1 * Math.exp(-(10 * MIN) / HEBB.T_W_MS)
    expect(w2).toBeCloseTo(HEBB.W_MAX - (HEBB.W_MAX - w1d) * Math.exp(-HEBB.ETA), 12)
    // Outside the window: no new partner.
    applyEvent(s, ev('inspect', 'c', T + 2 * 60 * MIN, 1))
    expect(s.synapses.has(synapseKey('a', 'c'))).toBe(false)
  })

  it('decays with T_w and prunes below 0.02', () => {
    const s = createPlasticity()
    applyEvent(s, ev('inspect', 'a', T, 1))
    applyEvent(s, ev('inspect', 'b', T + MIN, 1))
    expect(synapsesAt(s, T + DAY)).toHaveLength(1)
    const w = s.synapses.get(synapseKey('a', 'b'))!.w
    const dead = T + MIN + HEBB.T_W_MS * Math.log(w / HEBB.W_PRUNE) + DAY
    expect(synapsesAt(s, dead)).toHaveLength(0)
  })

  it('demon matches feed the trace but never wire synapses', () => {
    const s = createPlasticity()
    applyEvent(s, ev('demon-match', 'a', T))
    applyEvent(s, ev('demon-match', 'b', T + 1))
    applyEvent(s, ev('inspect', 'c', T + 2))
    expect(s.synapses.size).toBe(0)
    expect(s.traces.get('a')!.e).toBe(FALLBACK_AMPLITUDE['demon-match'])
  })

  it('caps every node at 24 synapses, dropping the weakest', () => {
    const s = createPlasticity()
    // 30 partners inside one window, with rising amplitude; then the hub.
    for (let i = 0; i < 30; i++) applyEvent(s, ev('inspect', `p${String(i).padStart(2, '0')}`, T + i * 1000, 0.1 + i * 0.05))
    applyEvent(s, ev('enter', 'hub', T + 31 * 1000, 2))
    expect(s.adjacency.get('hub')!.size).toBe(HEBB.DEGREE_CAP)
    // The six weakest partners (smallest amplitude) lost their link to the hub.
    for (let i = 0; i < 6; i++) expect(s.synapses.has(synapseKey('hub', `p${String(i).padStart(2, '0')}`))).toBe(false)
    for (const keys of s.adjacency.values()) expect(keys.size).toBeLessThanOrEqual(HEBB.DEGREE_CAP)
  })
})

describe('incremental vs full recompute', () => {
  it('agree exactly for any chunking of the log', () => {
    const log = randomLog(1500, 40, 7)
    const full = foldLog(log)
    for (const chunk of [1, 7, 64, 500]) {
      const inc = createPlasticity()
      for (let i = 0; i < log.length; i += chunk) expect(applyEvents(inc, log.slice(i, i + chunk))).toBe(true)
      expect(snapshot(inc)).toEqual(snapshot(full))
    }
    expect(full.synapses.size).toBeGreaterThan(0)
  })

  it('is order-insensitive for the full fold and skips re-delivered events', () => {
    const log = randomLog(300, 12, 3)
    const shuffled = [...log].reverse()
    expect(snapshot(foldLog(shuffled))).toEqual(snapshot(foldLog(log)))
    const inc = foldLog(log.slice(0, 200))
    // Re-delivery from (last.t − FOLD_SKEW_MS), as the engine fetches, folds only the unseen tail.
    const since = log[199].t - FOLD_SKEW_MS
    expect(applyEvents(inc, log.filter((e) => e.t >= since))).toBe(true)
    expect(snapshot(inc)).toEqual(snapshot(foldLog(log)))
  })

  it('refuses out-of-order events without touching the state', () => {
    const log = randomLog(50, 5, 9)
    const s = foldLog(log)
    const before = snapshot(s)
    const late = ev('inspect', 'n1', log[10].t - 1, 1)
    expect(applyEvents(s, [late])).toBe(false)
    expect(snapshot(s)).toEqual(before)
    expect(snapshot(foldLog([...log, late]))).not.toEqual(before)
  })

  it('compacting events older than a year changes nothing visible', () => {
    const log = randomLog(1200, 15, 11)
    const now = log.at(-1)!.t + DAY
    const cutoff = now - 365.2425 * DAY
    expect(log[0].t).toBeLessThan(cutoff - 30 * DAY)
    const full = foldLog(log)
    const compact = foldLog(log.filter((e) => e.t >= cutoff))
    const w = (s: PlasticityState) => new Map(synapsesAt(s, now).map((x) => [synapseKey(x.a, x.b), x.w]))
    const wf = w(full)
    const wc = w(compact)
    for (const k of new Set([...wf.keys(), ...wc.keys()])) expect(Math.abs((wf.get(k) ?? 0) - (wc.get(k) ?? 0))).toBeLessThan(0.0175)
    for (let i = 0; i < 15; i++) {
      const a = nodePlasticity(full, `n${i}`, T, now)
      const b = nodePlasticity(compact, `n${i}`, T, now)
      expect(Math.abs(a.y - b.y)).toBeLessThan(1e-3)
      expect(Math.abs(a.citadel - b.citadel)).toBeLessThan(1e-9)
    }
  })
})
