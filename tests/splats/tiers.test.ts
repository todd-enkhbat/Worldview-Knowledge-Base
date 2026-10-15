import { describe, expect, it } from 'vitest'
import { Matrix4, Quaternion, Vector3 } from 'three'
import {
  TIER_LIMITS,
  assignTiers,
  crystalProgress,
  lodSplatBudget,
  tiersChanged,
  type SplatTier,
  type TierCandidate,
} from '../../src/world/splats/tiers.ts'
import {
  FLIGHT,
  applyUpFixOp,
  captureEntryPose,
  contentMatrix,
  entryWorld,
  fitBox,
  flightScale,
  growthFor,
  newFlightState,
  normalizeCrop,
  planFlight,
  stepFlight,
  type FlightInput,
} from '../../src/world/splats/flyIn.ts'

const cand = (id: string, distance: number, extra: Partial<TierCandidate> = {}): TierCandidate => ({
  id,
  distance,
  born: true,
  hasProxy: true,
  hasThumb: true,
  canFocus: true,
  ...extra,
})

const none = new Map<string, SplatTier>()

describe('assignTiers', () => {
  it('keeps at most 6 proxies, nearest first, the rest impostors', () => {
    const cs = Array.from({ length: 10 }, (_, i) => cand(`m${i}`, 5 + i * 3))
    const t = assignTiers(cs, null, none)
    const proxies = [...t].filter(([, v]) => v === 'proxy').map(([k]) => k)
    expect(proxies).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
    expect(t.get('m6')).toBe('impostor')
    expect(t.get('m9')).toBe('impostor')
  })

  it('makes exactly one focused memory, regardless of distance, and it does not take a proxy slot', () => {
    const cs = [...Array.from({ length: 8 }, (_, i) => cand(`m${i}`, 5 + i)), cand('far', 900)]
    const t = assignTiers(cs, 'far', none)
    expect([...t.values()].filter((v) => v === 'focused')).toHaveLength(1)
    expect(t.get('far')).toBe('focused')
    expect([...t.values()].filter((v) => v === 'proxy')).toHaveLength(TIER_LIMITS.maxProxies)
  })

  it('does not focus a memory with nothing to show', () => {
    const t = assignTiers([cand('a', 1, { canFocus: false, hasProxy: false })], 'a', none)
    expect(t.get('a')).toBe('impostor')
  })

  it('applies distance hysteresis: enter at 60, leave beyond 75', () => {
    const at = (d: number, prev: Map<string, SplatTier>) => assignTiers([cand('a', d)], null, prev).get('a')
    expect(at(65, none)).toBe('impostor')
    const inside = new Map<string, SplatTier>([['a', 'proxy']])
    expect(at(65, inside)).toBe('proxy')
    expect(at(74.9, inside)).toBe('proxy')
    expect(at(76, inside)).toBe('impostor')
  })

  it('applies rank hysteresis: a newcomer must be meaningfully closer to evict an incumbent', () => {
    const limits = { ...TIER_LIMITS, maxProxies: 1 }
    const prev = new Map<string, SplatTier>([['old', 'proxy']])
    // 10 % closer is not enough (bonus 15 %)...
    let t = assignTiers([cand('old', 20), cand('new', 18)], null, prev, limits)
    expect(t.get('old')).toBe('proxy')
    expect(t.get('new')).toBe('impostor')
    // ...30 % closer is.
    t = assignTiers([cand('old', 20), cand('new', 14)], null, prev, limits)
    expect(t.get('new')).toBe('proxy')
    expect(t.get('old')).toBe('impostor')
  })

  it('does not thrash when the camera hovers between two memories', () => {
    const limits = { ...TIER_LIMITS, maxProxies: 1 }
    let prev: Map<string, SplatTier> = new Map()
    let flips = 0
    let holder = ''
    for (let i = 0; i < 200; i++) {
      const wobble = Math.sin(i * 0.7) * 0.8
      const t = assignTiers([cand('a', 20 + wobble), cand('b', 20 - wobble)], null, prev, limits)
      const now = t.get('a') === 'proxy' ? 'a' : 'b'
      if (holder && now !== holder) flips++
      holder = now
      prev = t
    }
    expect(flips).toBe(0)
  })

  it('gives unborn memories nothing and memories without a thumb no impostor', () => {
    const t = assignTiers([cand('ghost', 3, { born: false }), cand('bare', 500, { hasThumb: false })], null, none)
    expect(t.get('ghost')).toBe('none')
    expect(t.get('bare')).toBe('none')
  })

  it('is stable for equal distances (id order)', () => {
    const limits = { ...TIER_LIMITS, maxProxies: 1 }
    const t = assignTiers([cand('b', 10), cand('a', 10)], null, none, limits)
    expect(t.get('a')).toBe('proxy')
    expect(t.get('b')).toBe('impostor')
  })
})

describe('tiersChanged', () => {
  it('detects size and value changes only', () => {
    const a = new Map<string, SplatTier>([['x', 'proxy']])
    expect(tiersChanged(a, new Map(a))).toBe(false)
    expect(tiersChanged(a, new Map([['x', 'impostor']]))).toBe(true)
    expect(tiersChanged(a, new Map())).toBe(true)
  })
})

describe('lodSplatBudget', () => {
  it('keeps Σ proxies + focused ≤ 2M', () => {
    for (const resident of [0, 100_000, 350_000, 600_000]) {
      const lod = lodSplatBudget(2_500_000, resident)
      expect(lod + resident).toBeLessThanOrEqual(TIER_LIMITS.splatBudget)
    }
    expect(lodSplatBudget(2_500_000, 600_000)).toBe(1_400_000)
  })

  it('never raises the quality ladder count', () => {
    expect(lodSplatBudget(1_000_000, 0)).toBe(1_000_000)
    expect(lodSplatBudget(400_000, 600_000)).toBe(400_000)
  })

  it('keeps a floor for the focused interior', () => {
    expect(lodSplatBudget(1_500_000, 1_900_000)).toBe(TIER_LIMITS.minLodSplats)
    expect(lodSplatBudget(100_000, 1_900_000)).toBe(100_000)
  })
})

describe('crystalProgress', () => {
  it('is monotonic through the phases and ends at 1', () => {
    const seq = [
      crystalProgress('idle'),
      crystalProgress('loading', 0),
      crystalProgress('loading', 1),
      crystalProgress('decoding', 0.5),
      crystalProgress('growing', 0.2),
      crystalProgress('growing', 1),
      crystalProgress('fading', 0.5),
      crystalProgress('ready'),
    ]
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1])
    expect(seq.at(-1)).toBe(1)
    expect(crystalProgress('growing', 7)).toBe(crystalProgress('growing', 1))
  })
})

// ─── fly-in geometry (flyIn.ts) ──────────────────────────────────────────────────────

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('fitBox', () => {
  it('fits the largest rotated extent into the half-size and centres the box', () => {
    const box = { min: [0, 0, 0] as [number, number, number], max: [4, 2, 10] as [number, number, number] }
    const fit = fitBox(box, [0, 0, 0, 1], 0.5)
    close(fit.scale, 0.5 / 5)
    // centre (2, 1, 5) lands at the origin
    const c = new Vector3(2, 1, 5).multiplyScalar(fit.scale).applyQuaternion(fit.quaternion).add(fit.position)
    close(c.length(), 0)
  })

  it('accounts for the up-fix rotation (|R|·h)', () => {
    const box = { min: [-1, -3, -1] as [number, number, number], max: [1, 3, 1] as [number, number, number] }
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 4)
    const fit = fitBox(box, [q.x, q.y, q.z, q.w], 1)
    // rotated by 45° about Z: x/y extent = (1 + 3)·√½
    close(fit.scale, 1 / (4 * Math.SQRT1_2))
  })

  it('treats a degenerate quaternion as identity', () => {
    const fit = fitBox({ min: [0, 0, 0], max: [1, 1, 1] }, [0, 0, 0, 0], 1)
    close(fit.quaternion.w, 1)
  })
})

describe('entry poses', () => {
  it('round-trips a camera through captureEntryPose / entryWorld', () => {
    const mesh = new Matrix4().compose(new Vector3(3, -2, 7), new Quaternion().setFromAxisAngle(new Vector3(1, 1, 0).normalize(), 0.8), new Vector3(0.3, 0.3, 0.3))
    const cam = { position: new Vector3(1, 2, 3), quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1.1) }
    const pose = captureEntryPose(mesh, cam, 55)
    expect(pose.fov).toBe(55)
    const back = entryWorld(mesh, pose)
    close(back.position.distanceTo(cam.position), 0, 1e-5)
    close(Math.abs(back.quaternion.dot(cam.quaternion)), 1, 1e-6)
  })
})

describe('applyUpFixOp', () => {
  it('four quarter turns are the identity and two flips cancel', () => {
    let q: [number, number, number, number] = [0, 0, 0, 1]
    for (let i = 0; i < 4; i++) q = applyUpFixOp(q, '+x')
    close(Math.abs(q[3]), 1)
    let f: [number, number, number, number] = [0, 0, 0, 1]
    f = applyUpFixOp(applyUpFixOp(f, 'flip'), 'flip')
    close(Math.abs(f[3]), 1)
  })

  it('+x then −x cancels; flip turns +Y down', () => {
    const q = applyUpFixOp(applyUpFixOp([0, 0, 0, 1], '+z'), '-z')
    close(Math.abs(q[3]), 1)
    const flip = applyUpFixOp([0, 0, 0, 1], 'flip')
    const up = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(...flip))
    close(up.y, -1)
  })
})

describe('normalizeCrop', () => {
  it('orders min/max, enforces a minimum extent and repairs non-finite values', () => {
    const fallback = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] }
    const n = normalizeCrop({ min: [2, 0.5, Number.NaN], max: [1, 0.5, 3] }, fallback)
    expect(n.min[0]).toBe(1)
    expect(n.max[0]).toBe(2)
    expect(n.max[1] - n.min[1]).toBeGreaterThan(0)
    expect(n.min[2]).toBe(0)
  })
})

describe('flight', () => {
  const plan = () =>
    planFlight({
      id: 'm',
      base: new Matrix4().makeTranslation(10, 5, 0),
      fit: new Matrix4().compose(new Vector3(0, 0, 0), new Quaternion(), new Vector3(0.1, 0.1, 0.1)),
      entry: { position: [1, 0, 2], quaternion: [0, 0, 0, 1] },
      camera: { position: new Vector3(30, 20, 30), quaternion: new Quaternion() },
      centre: new Vector3(10, 5, 0),
    })

  it('grows to 1 world unit per native unit (within the clamp)', () => {
    expect(plan().growth).toBeCloseTo(10)
    expect(growthFor(1)).toBe(FLIGHT.minGrowth)
    expect(growthFor(1e-6)).toBe(FLIGHT.maxGrowth)
  })

  it('scales about the entry point: the pivot is a fixed point at every scale', () => {
    const p = plan()
    close(p.pivot.x, 10.1)
    close(p.pivot.z, 0.2)
    for (const u of [0, 0.3, 0.7, 1]) {
      const m = contentMatrix(p, flightScale(u, p.growth))
      const entryLocal = new Vector3(0.1, 0, 0.2) // entry (1, 0, 2) through the 0.1 fit
      close(entryLocal.applyMatrix4(m).distanceTo(p.pivot), 0, 1e-9)
    }
    close(flightScale(0, p.growth), 1)
    close(flightScale(1, p.growth), p.growth)
  })

  const run = (s: ReturnType<typeof newFlightState>, input: Partial<FlightInput>, frames: number) => {
    const events: string[] = []
    for (let i = 0; i < frames; i++) {
      const ev = stepFlight(s, { dir: 'in', dt: 1 / 60, seconds: 2, interiorReady: false, interiorPending: true, blend: 0, ...input })
      if (ev !== 'none') events.push(ev)
    }
    return events
  }

  it('approaches, waits for the interior at rest, then enters once the crossfade is done', () => {
    const s = newFlightState()
    expect(run(s, {}, 200)).toEqual([])
    expect(s.phase).toBe('arrive')
    expect(s.u).toBe(1)
    expect(s.blendTarget).toBe(0)
    expect(run(s, { interiorReady: true, blend: 0.5 }, 5)).toEqual([])
    expect(s.blendTarget).toBe(1)
    expect(run(s, { interiorReady: true, blend: 1 }, 1)).toEqual(['inside'])
    expect(s.phase).toBe('inside')
  })

  it('enters on the proxy when there is no interior', () => {
    const s = newFlightState()
    expect(run(s, { interiorPending: false }, 200)).toEqual(['inside'])
  })

  it('reverses: return (fade back), then retreat to u = 0, then out', () => {
    const s = newFlightState()
    run(s, { interiorPending: false }, 200)
    expect(run(s, { dir: 'out', blend: 1 }, 10)).toEqual([])
    expect(s.phase).toBe('return')
    expect(s.blendTarget).toBe(0)
    run(s, { dir: 'out', blend: 0 }, Math.ceil(FLIGHT.returnSeconds * 60) + 2)
    expect(s.phase).toBe('retreat')
    // 'out' repeats while idle; the rig acts on the first one and unmounts.
    expect(run(s, { dir: 'out', blend: 0 }, 200)[0]).toBe('out')
    expect(s.u).toBe(0)
    expect(s.phase).toBe('idle')
  })

  it('Esc mid-approach retreats from where it is', () => {
    const s = newFlightState()
    run(s, {}, 30)
    const u = s.u
    expect(u).toBeGreaterThan(0)
    expect(u).toBeLessThan(1)
    run(s, { dir: 'out' }, 2)
    expect(s.phase).toBe('retreat')
    expect(s.u).toBeLessThan(u)
  })
})
