// Full-size physics acceptance tier: R1 R2 L E D B S (docs/PLAN.md "Acceptance
// criteria"). Prints a table, writes bench-results/accept-<date>.json and exits 1 on any
// failure. `node scripts/accept-physics.ts [--quick] [--only=R1,E,...]`; --quick shrinks
// every size for a smoke run (not an acceptance result).

import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { Checkpoints, Scrubber } from '../src/physics/clock.ts'
import { EnergyLedger, energyFor, forEachNearPair } from '../src/physics/ledger.ts'
import { MIN_ENTROPY_SAMPLES, selectEntropySample, systemEntropy } from '../src/physics/entropy.ts'
import { UNIT, invMassFromMass, tauFromUnit } from '../src/physics/fixed.ts'
import { createPairGrid, gridPairAccumulator } from '../src/physics/grid.ts'
import {
  type PairAccumulator,
  type ParticleSystem,
  accumulatePairList,
  accumulatePairsListBruteForce,
  computeFieldImpulsesFor,
  computeKicksFor,
  createSystem,
  flip,
  impulsesToKicksFor,
  overflowSentinel,
  setParticle,
  stateHash,
  stepForward,
} from '../src/physics/integrator.ts'
import { AMP_ONE, makePhysicsParams } from '../src/physics/params.ts'
import { draw } from '../src/physics/rng.ts'
import { checkShadowStep, shadowFromSystem } from '../src/physics/shadow.ts'
import { spawnNode } from '../src/physics/spawn.ts'
import {
  type PhysicsWorld,
  activeSlots,
  buildWorld,
  runTo,
  stateHashById,
  stepWorld,
  worldHash,
} from '../src/physics/world.ts'
import { buildLab, dateStamp, labBackward, labForward, realisticRecords } from './physics-worlds.ts'

// ---------------------------------------------------------------- configuration

const argv = process.argv.slice(2)
const QUICK = argv.includes('--quick')
const ONLY = (argv.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? []).map((s) => s.trim().toUpperCase())
const want = (id: string) => ONLY.length === 0 || ONLY.includes(id)

const WORLD_SEED = 0x5eed
const SIGMA = 3
const CFG = QUICK
  ? { n1: 400, years1: 4, r1Ns: [1, 600, 2400], n10: 2000, years10: 6, t10: 3600, schedules: 3, frames: 400, eSteps: 6000, sSteps: 3600, labN: 400 }
  : { n1: 1000, years1: 10, r1Ns: [1, 600, 6000], n10: 10000, years10: 60, t10: 36000, schedules: 10, frames: 2000, eSteps: 36000, sSteps: 18000, labN: 1000 }
const LAB = { halfWidth: QUICK ? 15 : 20, height: 36, amp: 6 * AMP_ONE }

// ---------------------------------------------------------------- reporting

type Metrics = Record<string, number | string | boolean | number[] | string[] | null>
interface Row {
  id: string
  criterion: string
  measured: string
  pass: boolean | null
  ms: number
  metrics: Metrics
}
const rows: Row[] = []

function record(id: string, criterion: string, fn: () => { pass: boolean | null; measured: string; metrics: Metrics }): void {
  const t0 = performance.now()
  let r: { pass: boolean | null; measured: string; metrics: Metrics }
  try {
    r = fn()
  } catch (e) {
    r = { pass: false, measured: `threw: ${(e as Error).message}`, metrics: { error: String((e as Error).stack ?? e) } }
  }
  const ms = performance.now() - t0
  rows.push({ id, criterion, measured: r.measured, pass: r.pass, ms, metrics: r.metrics })
  const tag = r.pass === null ? 'INFO' : r.pass ? 'PASS' : 'FAIL'
  console.log(`[${tag}] ${id.padEnd(4)} ${criterion} — ${r.measured} (${(ms / 1000).toFixed(1)} s)`)
}

const fmt = (v: number, d = 3) => (Math.abs(v) >= 1e-3 && Math.abs(v) < 1e4 ? v.toFixed(d) : v.toExponential(2))

// ---------------------------------------------------------------- worlds

const records1k = realisticRecords({ n: CFG.n1, seed: 1, years: CFG.years1, preYears: 2, halfWidth: 15 })
const build1k = (records = records1k, pairMode: 'grid' | 'brute' = 'grid') => buildWorld({ records, seed: WORLD_SEED, pairMode })

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = xs.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor((draw(seed, i) / 2 ** 32) * (i + 1))
    const t = out[i]
    out[i] = out[j]
    out[j] = t
  }
  return out
}

function activeList(w: PhysicsWorld): { list: Int32Array; n: number } {
  const list = activeSlots(w)
  return { list, n: list.length }
}

// ---------------------------------------------------------------- R1

function runR1a(): void {
  record('R1', `forward n then back n restores identical hashes (N = ${CFG.n1} with births, n ∈ {${CFG.r1Ns.join(', ')}})`, () => {
    const w = build1k()
    const results: string[] = []
    let ok = true
    let births = 0
    for (const start of [0, Math.floor((CFG.years1 * 600) / 4)]) {
      runTo(w, start)
      const h = worldHash(w)
      const hid = stateHashById(w)
      for (const n of CFG.r1Ns) {
        let crossed = 0
        for (let s = 0; s < w.birth.length; s++) if (w.birth[s] > start && w.birth[s] <= start + n) crossed++
        births += crossed
        runTo(w, start + n)
        runTo(w, start)
        const same = worldHash(w) === h && stateHashById(w) === hid
        ok &&= same
        results.push(`${start}+${n}${same ? '' : ' MISMATCH'}`)
      }
    }
    return { pass: ok && births > 0, measured: `${results.join(', ')}; ${births} birth crossings`, metrics: { cases: results, birthCrossings: births } }
  })
}

/** Per-step D/B tracker: active slots kept sorted by Y (the long time axis), insertion-sorted each step. */
class PairTracker {
  order: Int32Array
  n = 0
  oldMin2 = Number.POSITIVE_INFINITY
  newMin2 = Number.POSITIVE_INFINITY
  oldBelow = 0
  newBelow = 0
  newbornPairsSeen = 0
  maxUxz = 0
  maxUy = 0
  /** Per-slot max|u_y| (how many nodes exceed the bound, not just the worst one). */
  readonly nodeMaxUy: Float64Array
  private readonly bornAt = new Map<number, number[]>()
  private readonly w: PhysicsWorld

  constructor(w: PhysicsWorld) {
    this.w = w
    this.order = new Int32Array(w.sys.count)
    this.nodeMaxUy = new Float64Array(w.sys.count)
    for (let s = 0; s < w.birth.length; s++) {
      if (w.idOf[s] === null) continue
      const b = w.birth[s]
      if (b <= w.step) this.order[this.n++] = s
      else {
        const l = this.bornAt.get(b)
        if (l) l.push(s)
        else this.bornAt.set(b, [s])
      }
    }
    this.sort()
  }

  private sort(): void {
    const { order } = this
    const x = this.w.sys.x
    for (let a = 1; a < this.n; a++) {
      const s = order[a]
      const y = x[3 * s + 1]
      let b = a - 1
      while (b >= 0 && x[3 * order[b] + 1] > y) {
        order[b + 1] = order[b]
        b--
      }
      order[b + 1] = s
    }
  }

  /** Call after each forward step. */
  observe(): void {
    const w = this.w
    const born = this.bornAt.get(w.step)
    if (born) for (const s of born) this.order[this.n++] = s
    this.sort()
    const { x, anchor } = w.sys
    const sig = SIGMA * UNIT
    const sig2 = SIGMA * SIGMA
    const half2 = (SIGMA / 2) ** 2
    const inv = 1 / UNIT
    const birth = w.birth
    const order = this.order
    for (let a = 0; a < this.n; a++) {
      const i = order[a]
      const o = 3 * i
      const ux = Math.abs(((x[o] - anchor[o]) | 0) * inv)
      const uy = Math.abs(((x[o + 1] - anchor[o + 1]) | 0) * inv)
      const uz = Math.abs(((x[o + 2] - anchor[o + 2]) | 0) * inv)
      if (ux > this.maxUxz) this.maxUxz = ux
      if (uz > this.maxUxz) this.maxUxz = uz
      if (uy > this.maxUy) this.maxUy = uy
      if (uy > this.nodeMaxUy[i]) this.nodeMaxUy[i] = uy
      const yi = x[o + 1]
      for (let b = a + 1; b < this.n; b++) {
        const j = order[b]
        const oj = 3 * j
        const dyq = x[oj + 1] - yi
        if (dyq >= sig) break
        const dxq = (x[o] - x[oj]) | 0
        if (dxq >= sig || dxq <= -sig) continue
        const dzq = (x[o + 2] - x[oj + 2]) | 0
        if (dzq >= sig || dzq <= -sig) continue
        const r2 = (dxq * dxq + dyq * dyq + dzq * dzq) * inv * inv
        if (r2 >= sig2) continue
        const age = w.step - Math.max(birth[i], birth[j])
        if (age > 720) {
          if (r2 < this.oldMin2) this.oldMin2 = r2
          if (r2 < half2) this.oldBelow++
        } else {
          this.newbornPairsSeen++
          if (r2 < this.newMin2) this.newMin2 = r2
          if (r2 < half2) this.newBelow++
        }
      }
    }
  }
}

function runR1bDB(): void {
  const recs = realisticRecords({ n: CFG.n10, seed: 2, years: CFG.years10, preYears: 5, halfWidth: 20 })
  let tracker: PairTracker | undefined
  let w: PhysicsWorld | undefined
  let fwdMs = 0
  record('R1', `n = ${CFG.t10} forward then back at N = ${CFG.n10} (births over the span) restores the identical hash`, () => {
    w = buildWorld({ records: recs, seed: WORLD_SEED })
    const h0 = worldHash(w)
    const a0 = w.activeCount
    tracker = new PairTracker(w)
    const t0 = performance.now()
    for (let s = 0; s < CFG.t10; s++) {
      stepWorld(w, 1)
      tracker.observe()
    }
    fwdMs = performance.now() - t0
    const aT = w.activeCount
    const hT = worldHash(w)
    for (let s = 0; s < CFG.t10; s++) stepWorld(w, -1)
    const same = worldHash(w) === h0 && w.step === 0
    return {
      pass: same,
      measured: `hash ${same ? 'identical' : 'MISMATCH'}; active ${a0} → ${aT}; forward ${(fwdMs / 1000).toFixed(1)} s incl. D/B tracking`,
      metrics: { activeAt0: a0, activeAtEnd: aT, hashAtEnd: hT >>> 0, forwardMs: fwdMs },
    }
  })
  if (want('D') && tracker) {
    const t = tracker
    record('D', `min distance ≥ σ/2 among pairs older than 720 steps over ${CFG.t10} steps at N = ${CFG.n10}`, () => {
      const oldMin = Math.sqrt(t.oldMin2)
      const newMin = Math.sqrt(t.newMin2)
      return {
        pass: oldMin >= SIGMA / 2 && t.oldBelow === 0,
        measured: `old pairs min ${fmt(oldMin)} u (${t.oldBelow} pair-steps < σ/2); newborn (≤ 720 steps) min ${fmt(newMin)} u, ${t.newBelow} pair-steps < σ/2 of ${t.newbornPairsSeen} in core`,
        metrics: { oldMin, oldBelowHalfSigma: t.oldBelow, newbornMin: newMin, newbornBelowHalfSigma: t.newBelow, newbornPairStepsInCore: t.newbornPairsSeen },
      }
    })
  }
  if (want('B') && tracker && w) {
    const t = tracker
    const sentinel = overflowSentinel(w.sys)
    let over50 = 0
    let over25 = 0
    for (const v of t.nodeMaxUy) {
      if (v > 0.5) over50++
      if (v > 0.25) over25++
    }
    record('B', `max|u_xz| ≤ 12 u, max|u_y| ≤ 0.5 u, overflow sentinel 0 (N = ${CFG.n10}, ${CFG.t10} steps)`, () => ({
      pass: t.maxUxz <= 12 && t.maxUy <= 0.5 && sentinel === 0,
      measured: `max|u_xz| ${fmt(t.maxUxz)} u, max|u_y| ${fmt(t.maxUy)} u (${over50} nodes ever > 0.5 u, ${over25} > 0.25 u), sentinel ${sentinel} (saturations ${w!.sys.saturations}, wraps ${w!.sys.impulseWraps})`,
      metrics: { maxUxz: t.maxUxz, maxUy: t.maxUy, nodesOverHalfU: over50, nodesOverQuarterU: over25, sentinel, saturations: w!.sys.saturations, impulseWraps: w!.sys.impulseWraps },
    }))
  }
}

const SPEEDS = [-16, -4, -1, -0.5, 0.25, 0.5, 1, 2, 4, 16, 48]
const FRAME_DT = [1 / 120, 1 / 60, 1 / 60, 1 / 30]

function runR1cR2c(): void {
  const limit = Math.min(12000, CFG.years1 * 1200)
  // Reference: one straight forward run, hashes at every multiple of 600 (checkpoint steps).
  const ref = build1k()
  const refHash = new Map<number, number>([[0, worldHash(ref)]])
  for (let s = 1; s <= limit; s++) {
    stepWorld(ref, 1)
    if (s % 600 === 0) refHash.set(s, worldHash(ref))
  }
  const finals: number[] = []
  let ckChecked = 0
  let ckBad = 0
  let seeks = 0
  let steps = 0
  record('R1', `${CFG.schedules} random scrub schedules × ${CFG.frames} frames (Scrubber + Checkpoints.seekTo) end on the straight-run hash`, () => {
    let ok = true
    const probe = build1k()
    for (let k = 0; k < CFG.schedules; k++) {
      const w = build1k()
      const cps = new Checkpoints(600)
      cps.save(w)
      const sc = new Scrubber()
      let speed = 1
      for (let f = 0; f < CFG.frames; f++) {
        const h = draw(0xc10c + k, f)
        if (f % 50 === 0) speed = SPEEDS[h % SPEEDS.length]
        // Rare huge jumps (600× → 600 steps in one frame) force the seek path.
        const sp = (h >>> 8) % 97 === 0 ? (h & 1 ? 600 : -600) : speed
        const dt = (h >>> 16) % 53 === 0 ? 0.25 : FRAME_DT[(h >>> 4) % FRAME_DT.length]
        const adv = sc.advance(dt, sp)
        let target = w.step + adv.steps
        if (target < 0 || target > limit) {
          target = Math.max(0, Math.min(limit, target))
          sc.reset()
        }
        if (adv.seek) {
          seeks++
          steps += cps.seekTo(w, target)
        } else {
          while (w.step !== target) {
            stepWorld(w, w.step < target ? 1 : -1)
            cps.maybeSave(w)
            steps++
          }
        }
      }
      // The live state must equal a fresh straight run to the same step.
      const fresh = build1k()
      runTo(fresh, w.step)
      const same = worldHash(fresh) === worldHash(w)
      ok &&= same
      finals.push(w.step)
      // Every checkpoint this run saved (forward or backward) matches the straight run.
      for (const s of cps.keys()) {
        if (!refHash.has(s)) continue
        ckChecked++
        cps.restore(probe, s)
        if (worldHash(probe) !== refHash.get(s)) ckBad++
      }
    }
    return {
      pass: ok && ckBad === 0,
      measured: `final steps [${finals.join(', ')}] all identical to straight runs; ${steps} steps, ${seeks} seeks`,
      metrics: { finals, steps, seeks },
    }
  })
  if (want('R2')) {
    record('R2', 'checkpoint hashes match across runs (every checkpoint of every scrub schedule vs a straight run)', () => ({
      pass: ckChecked > 0 && ckBad === 0,
      measured: `${ckChecked} checkpoints compared, ${ckBad} mismatches`,
      metrics: { checkpointsCompared: ckChecked, mismatches: ckBad },
    }))
  }
}

// ---------------------------------------------------------------- R2

function runR2(): void {
  record('R2', `insertion order: 3 shuffled record orders (different slots) give identical id-ordered hashes (N = ${CFG.n1})`, () => {
    const worlds = [records1k, shuffled(records1k, 11), shuffled(records1k, 12)].map((r) => build1k(r))
    const at: number[] = []
    let ok = worlds[1].slotOf.get(records1k[0].id) !== worlds[0].slotOf.get(records1k[0].id) || worlds[2].slotOf.get(records1k[0].id) !== 0
    for (const step of [0, 600, Math.floor((CFG.years1 * 600) / 2), CFG.years1 * 600]) {
      const hs = worlds.map((w) => {
        runTo(w, step)
        return stateHashById(w)
      })
      ok &&= hs[0] === hs[1] && hs[1] === hs[2]
      at.push(step)
    }
    return { pass: ok, measured: `steps [${at.join(', ')}] identical`, metrics: { steps: at } }
  })

  record('R2', 'neighbour lists: grid ≡ brute force ≡ shuffled pair list (random orientation) ≡ permuted active list, bit for bit', () => {
    const w = build1k()
    const grid = gridPairAccumulator(createPairGrid(w.params.pairSigma, w.sys.count))
    let compared = 0
    let pairs = 0
    let ok = true
    const span = CFG.years1 * 600
    for (let k = 0; k <= 8; k++) {
      runTo(w, Math.floor((k * span) / 8))
      const { list, n } = activeList(w)
      const sys = w.sys
      const kicks = (acc: PairAccumulator, l: Int32Array): Int32Array => {
        computeKicksFor(sys, w.step, l, n, acc)
        const out = new Int32Array(3 * n)
        for (let a = 0; a < n; a++) out.set(sys.kick.subarray(3 * list[a], 3 * list[a] + 3), 3 * a)
        return out
      }
      const ref = kicks(accumulatePairsListBruteForce, list)
      const shuffledPairs: PairAccumulator = (s, step, l, m) => {
        const ps: number[] = []
        forEachNearPair(s, l, m, (i, j) => ps.push(i, j))
        const cnt = ps.length / 2
        pairs += cnt
        const idx = shuffled(Array.from({ length: cnt }, (_, q) => q), 1000 + k)
        const flat = new Int32Array(ps.length)
        idx.forEach((q, r) => {
          const swap = draw(77 + k, r) & 1
          flat[2 * r] = ps[2 * q + swap]
          flat[2 * r + 1] = ps[2 * q + 1 - swap]
        })
        accumulatePairList(s, step, flat, cnt)
      }
      const perm = Int32Array.from(shuffled(Array.from(list), 2000 + k))
      const variants = [kicks(grid, list), kicks(shuffledPairs, list), kicks(grid, perm), kicks(accumulatePairsListBruteForce, perm)]
      for (const v of variants) ok &&= v.every((x, q) => x === ref[q])
      compared += n
      // Restore K for the live step (stepWorld recomputes it anyway).
      computeFieldImpulsesFor(sys, list, n)
      impulsesToKicksFor(sys, list, n)
    }
    // Whole runs: the world's grid vs the O(N²) reference.
    const a = build1k(records1k, 'grid')
    const b = build1k(records1k, 'brute')
    const T = Math.min(3000, span)
    runTo(a, T)
    runTo(b, T)
    const runSame = worldHash(a) === worldHash(b)
    return {
      pass: ok && runSame,
      measured: `${compared} particle kicks × 5 variants identical (${pairs} candidate pairs shuffled); grid vs brute run to ${T}: ${runSame ? 'identical' : 'MISMATCH'}`,
      metrics: { kicksCompared: compared, candidatePairs: pairs, gridVsBruteRun: runSame },
    }
  })

  record('R2', 'dust CPU ≡ GPU', () => ({
    pass: null,
    measured: 'browser-only (criterion G, built-in pane / Safari); the TS mirror is covered by tests/physics/gpuDust.test.ts',
    metrics: {},
  }))
}

// ---------------------------------------------------------------- L

function packedSystem(n: number, seed: number): ParticleSystem {
  const params = makePhysicsParams({ seed: WORLD_SEED, landscapeAmp: LAB.amp })
  const sys = createSystem(params, n, 'node')
  for (let i = 0; i < n; i++) {
    const h = (k: number) => draw((seed * 7919 + i) | 0, 100 + k)
    sys.anchor[3 * i] = Math.round(((h(0) / 2 ** 32) * 3 - 1.5) * UNIT)
    sys.anchor[3 * i + 1] = Math.round((h(1) / 2 ** 32) * UNIT)
    sys.anchor[3 * i + 2] = Math.round(((h(2) / 2 ** 32) * 3 - 1.5) * UNIT)
    setParticle(sys, i, invMassFromMass(0.25 + 3.75 * (h(3) / 2 ** 32)), tauFromUnit(h(4) / 2 ** 32), h(5) % 61)
    spawnNode(sys, i, h(6))
  }
  for (let s = 0; s < 100; s++) stepForward(sys, s)
  return sys
}

function runL(): void {
  record('L', 'f64 shadow (N ≤ 8): |det J − 1| < 1e-6 and mass-weighted symplectic defect < 1e-6', () => {
    let maxDet = 0
    let maxDef = 0
    let states = 0
    let pairsInRange = 0
    for (const n of [1, 2, 4, 8]) {
      for (let seed = 1; seed <= 8; seed++) {
        const sys = packedSystem(n, seed)
        const { shadow, state } = shadowFromSystem(sys)
        const c = checkShadowStep(shadow, state, 100)
        maxDet = Math.max(maxDet, c.detError)
        maxDef = Math.max(maxDef, c.defect.frobenius)
        pairsInRange += c.pairsInRange
        states++
      }
    }
    // Clusters of 8 neighbouring nodes taken from the lab world after 600 steps.
    const lab = buildLab({ n: CFG.labN, halfWidth: LAB.halfWidth, height: LAB.height, amp: LAB.amp })
    for (let s = 0; s < 600; s++) labForward(lab, s)
    const x = lab.sys.x
    for (let c = 0; c < 16; c++) {
      const i0 = (c * 61) % lab.n
      const near = Array.from({ length: lab.n }, (_, j) => j)
        .map((j) => {
          let r2 = 0
          for (let a = 0; a < 3; a++) r2 += (((x[3 * i0 + a] - x[3 * j + a]) | 0) / UNIT) ** 2
          return [r2, j] as const
        })
        .sort((p, q) => p[0] - q[0])
        .slice(0, 8)
        .map((p) => p[1])
      const { shadow, state } = shadowFromSystem(lab.sys, near)
      const chk = checkShadowStep(shadow, state, 600)
      maxDet = Math.max(maxDet, chk.detError)
      maxDef = Math.max(maxDef, chk.defect.frobenius)
      pairsInRange += chk.pairsInRange
      states++
    }
    return {
      pass: maxDet < 1e-6 && maxDef < 1e-6 && pairsInRange > 0,
      measured: `${states} states (${pairsInRange} pair cores in range): max|det J − 1| ${fmt(maxDet)}, max defect ${fmt(maxDef)}`,
      metrics: { states, pairsInRange, maxDetError: maxDet, maxDefect: maxDef },
    }
  })
}

// ---------------------------------------------------------------- E

interface Fit {
  slope: number
  t: number
  tAdj: number
  rho: number
}

/** OLS slope of y on x with its t-stat, and the t-stat with an AR(1) effective-sample correction. */
function linearFit(xs: number[], ys: number[]): Fit {
  const m = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / m
  const my = ys.reduce((a, b) => a + b, 0) / m
  let sxx = 0
  let sxy = 0
  for (let k = 0; k < m; k++) {
    sxx += (xs[k] - mx) ** 2
    sxy += (xs[k] - mx) * (ys[k] - my)
  }
  const slope = sxy / sxx
  const icpt = my - slope * mx
  const res = ys.map((y, k) => y - icpt - slope * xs[k])
  const s2 = res.reduce((p, r) => p + r * r, 0) / (m - 2)
  const t = slope / Math.sqrt(s2 / sxx)
  let num = 0
  let den = 0
  for (let k = 0; k < m; k++) {
    den += res[k] ** 2
    if (k) num += res[k] * res[k - 1]
  }
  const rho = num / den
  const nEff = Math.max(3, (m * (1 - rho)) / (1 + rho))
  return { slope, t, tAdj: t * Math.sqrt(nEff / m), rho }
}

function runE(): void {
  record('E', `lab (birth-free, N = ${CFG.labN}, amp 6×): |E_n − E_0|/⟨KE⟩ ≤ 2e-3 over ${CFG.eSteps} steps, no secular slope`, () => {
    const lab = buildLab({ n: CFG.labN, halfWidth: LAB.halfWidth, height: LAB.height, amp: LAB.amp })
    const e0 = energyFor(lab.sys, 0, lab.list, lab.n, lab.pairs).total
    const ns: number[] = []
    const dev: number[] = []
    let ke = 0
    let pair = 0
    let maxDev = 0
    for (let s = 0; s < CFG.eSteps; s++) {
      labForward(lab, s)
      if ((s + 1) % 10 !== 0) continue
      const e = energyFor(lab.sys, s + 1, lab.list, lab.n, lab.pairs)
      ke += e.kinetic
      pair += e.pair
      ns.push(s + 1)
      dev.push(e.total - e0)
      maxDev = Math.max(maxDev, Math.abs(e.total - e0))
    }
    ke /= ns.length
    pair /= ns.length
    const fit = linearFit(ns, dev)
    const drift = (fit.slope * CFG.eSteps) / ke
    // Secular slope: rejected when the fitted drift over the run is both statistically
    // significant (AR(1)-corrected |t| ≥ 3) and ≥ 10 % of the 2e-3 budget.
    const slopeOk = Math.abs(fit.tAdj) < 3 || Math.abs(drift) <= 2e-4
    const rel = maxDev / ke
    return {
      pass: rel <= 2e-3 && slopeOk && overflowSentinel(lab.sys) === 0,
      measured: `max ${fmt(rel)} of ⟨KE⟩ = ${fmt(ke, 1)} (⟨pair⟩ ${fmt(pair, 1)}); fitted drift ${fmt(drift)} ⟨KE⟩/run, t ${fmt(fit.t, 1)}, AR(1)-corrected t ${fmt(fit.tAdj, 2)} (ρ ${fmt(fit.rho, 2)})`,
      metrics: { maxDevRel: rel, meanKE: ke, meanPair: pair, driftRel: drift, t: fit.t, tAdj: fit.tAdj, rho: fit.rho, sentinel: overflowSentinel(lab.sys) },
    }
  })

  record('E', `main world (N = ${CFG.n1}, births): birth-compensated ledger E_n − E_0 − ΣΔE_births − ramp work stays ≤ 2e-3 ⟨KE⟩`, () => {
    const w = build1k()
    const grid = gridPairAccumulator(createPairGrid(w.params.pairSigma, w.sys.count))
    let { list, n } = activeList(w)
    const ledger = new EnergyLedger(w.sys, 0, list, n, grid)
    const T = CFG.years1 * 600
    let ke = 0
    let samples = 0
    let maxRaw = 0
    let maxL = 0
    for (let s = 0; s < T; s++) {
      stepWorld(w, 1)
      ;({ list, n } = activeList(w))
      ledger.advance(w.sys, w.step, list, n)
      if (w.step % 20 !== 0) continue
      const r = ledger.read(w.sys, list, n)
      ke += r.E.kinetic
      samples++
      maxRaw = Math.max(maxRaw, Math.abs(r.raw))
      maxL = Math.max(maxL, Math.abs(r.ledger))
    }
    ke /= samples
    return {
      pass: maxL / ke <= 2e-3,
      measured: `max|ledger| ${fmt(maxL / ke)} ⟨KE⟩ while max|E_n − E_0| = ${fmt(maxRaw / ke)} ⟨KE⟩ (births ${fmt(ledger.births, 1)}, ramp work ${fmt(ledger.rampWork, 1)}, ⟨KE⟩ ${fmt(ke, 1)}, ${n} active)`,
      metrics: { maxLedgerRel: maxL / ke, maxRawRel: maxRaw / ke, births: ledger.births, rampWork: ledger.rampWork, meanKE: ke },
    }
  })
}

// ---------------------------------------------------------------- S

function runS(): void {
  const lab = buildLab({ n: CFG.labN, halfWidth: LAB.halfWidth, height: LAB.height, amp: LAB.amp })
  const sample = selectEntropySample(lab.ids, () => true)
  const S = (sys: ParticleSystem = lab.sys) => systemEntropy(sys, sample).S
  const s0 = S()
  const h0 = stateHash(lab.sys)
  const T = CFG.sSteps
  const series: [number, number][] = [[0, s0]]
  let stateAt1200: { x: Int32Array; d: Int32Array } | undefined
  let labMaxUxz = 0
  let labMaxUy = 0
  for (let s = 0; s < T; s++) {
    labForward(lab, s)
    const { x, anchor } = lab.sys
    for (let k = 0; k < 3 * lab.n; k++) {
      const u = Math.abs(((x[k] - anchor[k]) | 0) / UNIT)
      if (k % 3 === 1) {
        if (u > labMaxUy) labMaxUy = u
      } else if (u > labMaxUxz) labMaxUxz = u
    }
    if ((s + 1) % 30 === 0) series.push([s + 1, S()])
    if (s + 1 === 1200) stateAt1200 = { x: lab.sys.x.slice(), d: lab.sys.d.slice() }
  }
  const plateau = series.filter(([n]) => n >= T / 2).map(([, v]) => v)
  const sPlat = plateau.reduce((a, b) => a + b, 0) / plateau.length
  const sdPlat = Math.sqrt(plateau.reduce((a, b) => a + (b - sPlat) ** 2, 0) / (plateau.length - 1))
  const ratio = (v: number) => (v - s0) / (sPlat - s0)
  const r1200 = ratio(series.find(([n]) => n === 1200)![1])
  const cross = series.find(([, v]) => ratio(v) >= 0.95)?.[0] ?? -1
  const minAfter = Math.min(...series.filter(([n]) => n >= 1200).map(([, v]) => ratio(v)))
  const sFwd = S()
  const xF = lab.sys.x.slice()
  const dF = lab.sys.d.slice()

  record('S', `lab (N = ${CFG.labN}): (S(t) − S0)/(S_plat − S0) ≥ 0.95 by 20 s (1200 steps), bit-identical return`, () => {
    // Bit-identical return from 1200 steps, by the exact inverse and by the Loschmidt path.
    const back = buildLab({ n: CFG.labN, halfWidth: LAB.halfWidth, height: LAB.height, amp: LAB.amp })
    back.sys.x.set(stateAt1200!.x)
    back.sys.d.set(stateAt1200!.d)
    for (let s = 1200; s > 0; s--) labBackward(back, s - 1)
    const inverseOk = stateHash(back.sys) === h0
    back.sys.x.set(stateAt1200!.x)
    back.sys.d.set(stateAt1200!.d)
    flip(back.sys, 1200)
    for (let s = 1200; s < 2400; s++) labForward(back, s)
    flip(back.sys, 2400)
    const loschmidtOk = stateHash(back.sys) === h0
    return {
      pass: r1200 >= 0.95 && inverseOk && loschmidtOk && sample.length >= MIN_ENTROPY_SAMPLES,
      measured: `S0 ${fmt(s0)}, S_plat ${fmt(sPlat)} ± ${fmt(sdPlat)}; ratio at 1200 = ${fmt(r1200)} (first ≥ 0.95 at step ${cross}, min after 1200: ${fmt(minAfter)}); return: inverse ${inverseOk ? 'identical' : 'MISMATCH'}, flip–forward–flip ${loschmidtOk ? 'identical' : 'MISMATCH'}`,
      metrics: { s0, sPlat, sdPlat, ratio1200: r1200, firstCross95: cross, minRatioAfter1200: minAfter, inverseReturn: inverseOk, loschmidtReturn: loschmidtOk, sample: sample.length, series: series.filter(([n]) => n % 300 === 0).map(([, v]) => v) },
    }
  })

  record('S', `arrow of time: forward ${T} steps, 1-LSB perturbation, reverse ${T}: (S_ret − S0)/(S_fwd − S0) ≥ 0.5`, () => {
    // Perturbed reversal.
    lab.sys.x[0] = (lab.sys.x[0] + 1) | 0
    flip(lab.sys, T)
    for (let s = T; s < 2 * T; s++) labForward(lab, s)
    const sRet = S()
    const arrow = (sRet - s0) / (sFwd - s0)
    // How many particles failed to come home (|X_ret − X_0| > 0.1 u)?
    const start = buildLab({ n: CFG.labN, halfWidth: LAB.halfWidth, height: LAB.height, amp: LAB.amp })
    let strayed = 0
    for (let i = 0; i < lab.n; i++) {
      let r2 = 0
      for (let a = 0; a < 3; a++) r2 += (((lab.sys.x[3 * i + a] - start.sys.x[3 * i + a]) | 0) / UNIT) ** 2
      if (r2 > 0.01) strayed++
    }
    // Unperturbed control: the same reversal returns bit for bit.
    lab.sys.x.set(xF)
    lab.sys.d.set(dF)
    flip(lab.sys, T)
    for (let s = T; s < 2 * T; s++) labForward(lab, s)
    flip(lab.sys, 2 * T)
    const controlOk = stateHash(lab.sys) === h0
    return {
      pass: arrow >= 0.5 && controlOk,
      measured: `S_fwd ${fmt(sFwd)}, S_ret ${fmt(sRet)}: ratio ${fmt(arrow)}; ${strayed}/${lab.n} particles did not return; unperturbed control ${controlOk ? 'returns bit-identically' : 'MISMATCH'}`,
      metrics: { sFwd, sRet, arrowRatio: arrow, strayed, controlReturn: controlOk },
    }
  })

  record('B', `lab (amp 6×, forward ${T} steps; information): max|u| and the overflow sentinel`, () => ({
    pass: overflowSentinel(lab.sys) === 0 ? null : false,
    measured: `max|u_xz| ${fmt(labMaxUxz)} u, max|u_y| ${fmt(labMaxUy)} u, sentinel ${overflowSentinel(lab.sys)}`,
    metrics: { maxUxz: labMaxUxz, maxUy: labMaxUy, sentinel: overflowSentinel(lab.sys) },
  }))
}

// ---------------------------------------------------------------- main

const t0 = performance.now()
console.log(`accept-physics ${QUICK ? '(QUICK — not an acceptance result) ' : ''}${dateStamp()} node ${process.version} ${cpus()[0]?.model ?? ''}`)
if (want('R1')) runR1a()
if (want('R1') || want('D') || want('B')) runR1bDB()
if (want('R1') || want('R2')) runR1cR2c()
if (want('R2')) runR2()
if (want('L')) runL()
if (want('E')) runE()
if (want('S')) runS()

const failed = rows.filter((r) => r.pass === false)
const total = (performance.now() - t0) / 1000
console.log('\n| ID | Criterion | Measured | Result |\n|---|---|---|---|')
for (const r of rows) console.log(`| ${r.id} | ${r.criterion} | ${r.measured} | ${r.pass === null ? 'info' : r.pass ? 'PASS' : '**FAIL**'} |`)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} in ${total.toFixed(1)} s`)

mkdirSync('bench-results', { recursive: true })
const file = `bench-results/accept-${dateStamp()}${QUICK ? '-quick' : ''}.json`
writeFileSync(
  file,
  JSON.stringify(
    { date: new Date().toISOString(), quick: QUICK, node: process.version, cpu: cpus()[0]?.model ?? null, config: CFG, lab: LAB, totalSeconds: total, pass: failed.length === 0, rows },
    null,
    2,
  ),
)
console.log(`wrote ${file}`)
if (failed.length) process.exitCode = 1
