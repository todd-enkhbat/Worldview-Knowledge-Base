// Physics benchmarks (docs/PLAN.md "Budgets"): cold start and edit-to-visible at
// N = 1k, steps/s at N = 1k/5k/10k with births and pairs, and the largest N that
// sustains 10× real time (600 steps/s). Single thread, as in the physics worker.
// Writes bench-results/bench-<date>.json. `node scripts/bench-physics.ts [--quick]`.

import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { CheckpointCache, type KvStore } from '../src/physics/checkpointCache.ts'
import { Checkpoints } from '../src/physics/clock.ts'
import {
  type PhysicsWorld,
  type WorldRecord,
  buildWorld,
  readPoses,
  runTo,
  stepWorld,
  upsertRecord,
} from '../src/physics/world.ts'
import { dateStamp, realisticRecords } from './physics-worlds.ts'

const QUICK = process.argv.includes('--quick')
const WORLD_SEED = 0x5eed
const REAL_TIME_10X = 600
const COLD_BUDGET_MS = 1000
const EDIT_BUDGET_MS = 500

/** In-memory KvStore with structured-clone semantics (what IndexedDB does on put/get). */
function memoryKv(): KvStore {
  const m = new Map<string, unknown>()
  return {
    getKv: async <T>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    putKv: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    deleteKv: async (k: string) => void m.delete(k),
  }
}

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const r1 = (v: number) => Math.round(v * 10) / 10

const results: Record<string, unknown> = {}
const t00 = performance.now()
console.log(`bench-physics ${QUICK ? '(QUICK) ' : ''}${dateStamp()} node ${process.version} ${cpus()[0]?.model ?? ''}`)

// ---------------------------------------------------------------- N = 1k world

const YEARS = 10
const SPAN = YEARS * 600
const records1k = realisticRecords({ n: 1000, seed: 3, years: YEARS, preYears: 2, halfWidth: 15 })
const build = (records: WorldRecord[] = records1k) => buildWorld({ records, seed: WORLD_SEED })

// Previous session: a straight run that saved and persisted every checkpoint to 6000.
const kv = memoryKv()
const cache = new CheckpointCache(kv)
{
  const w = build()
  const cps = new Checkpoints(600)
  cps.save(w)
  while (w.step < SPAN) {
    stepWorld(w, 1)
    if (cps.maybeSave(w)) await cache.persist(w, cps, w.step)
  }
}

// ---------------------------------------------------------------- cold start

async function coldStart(now: number): Promise<{ ms: number; steps: number; parts: Record<string, number> }> {
  const t0 = performance.now()
  const w = build()
  const t1 = performance.now()
  const cps = new Checkpoints(600)
  // The worker hydrates the cached checkpoint nearest to `now` (the cache holds 0..SPAN).
  const ck = Math.min(SPAN, Math.round(now / 600) * 600)
  const found = await cache.hydrate(w, cps, ck)
  if (!found) throw new Error(`no cached checkpoint at ${ck}`)
  const t2 = performance.now()
  const steps = cps.seekTo(w, now)
  const t3 = performance.now()
  const poses = new Float32Array(3 * w.sys.count)
  readPoses(w, poses)
  const t4 = performance.now()
  return { ms: t4 - t0, steps, parts: { build: t1 - t0, hydrate: t2 - t1, steps: t3 - t2, poses: t4 - t3 } }
}

{
  const cases = [
    { name: 'mid-span, nearest checkpoint 300 steps away', now: SPAN / 2 + 300 },
    { name: 'end of span + 599 (only earlier checkpoints cached)', now: SPAN + 599 },
  ]
  const out: Record<string, unknown>[] = []
  for (const c of cases) {
    const runs: number[] = []
    let last: Awaited<ReturnType<typeof coldStart>> | undefined
    for (let k = 0; k < (QUICK ? 3 : 9); k++) {
      last = await coldStart(c.now)
      runs.push(last.ms)
    }
    const med = median(runs)
    out.push({ case: c.name, now: c.now, steps: last!.steps, medianMs: r1(med), maxMs: r1(Math.max(...runs)), parts: last!.parts })
    console.log(`cold start N = 1000, ${c.name}: ${last!.steps} steps, median ${med.toFixed(1)} ms (max ${Math.max(...runs).toFixed(1)}; build ${last!.parts.build.toFixed(1)}, hydrate ${last!.parts.hydrate.toFixed(1)}, steps ${last!.parts.steps.toFixed(1)}) — budget ${COLD_BUDGET_MS} ms ${med < COLD_BUDGET_MS ? 'OK' : 'OVER'}`)
  }
  results.coldStart = { n: 1000, budgetMs: COLD_BUDGET_MS, cases: out }
}

// ---------------------------------------------------------------- edit-to-visible

{
  // Live session at playhead P with every checkpoint ≤ P in memory.
  const P = SPAN
  const w = build()
  const cps = new Checkpoints(600)
  cps.save(w)
  while (w.step < P) {
    stepWorld(w, 1)
    cps.maybeSave(w)
  }
  const byBirth = records1k.slice().sort((a, b) => a.birthStep - b.birthStep)
  const pick = (target: number) => byBirth.reduce((best, r) => (Math.abs(r.birthStep - target) < Math.abs(best.birthStep - target) ? r : best))
  const cases = [
    { name: 'recent node (born ≈ P − 100)', rec: pick(P - 100) },
    { name: 'node born mid-span (≈ P/2)', rec: pick(P / 2) },
    { name: 'oldest node (born at 0): full recompute', rec: byBirth[0] },
  ]
  const poses = new Float32Array(3 * w.sys.count)
  const out: Record<string, unknown>[] = []
  for (const c of cases) {
    const runs: number[] = []
    let steps = 0
    let changed = 0
    for (let k = 0; k < (QUICK ? 2 : 5); k++) {
      // Alternate the anchor between two positions so every run is a real edit.
      const dx = k % 2 === 0 ? 0.5 : 0
      const edited: WorldRecord = { ...c.rec, anchor: [c.rec.anchor[0] + dx, c.rec.anchor[1], c.rec.anchor[2]] }
      const t0 = performance.now()
      const { changedFromStep } = upsertRecord(w, edited)
      cps.invalidateFrom(changedFromStep)
      steps = cps.seekTo(w, P)
      readPoses(w, poses)
      runs.push(performance.now() - t0)
      changed = changedFromStep
    }
    // Leave the world as it was for the next case.
    upsertRecord(w, c.rec)
    cps.invalidateFrom(c.rec.birthStep)
    cps.seekTo(w, P)
    const med = median(runs)
    out.push({ case: c.name, birthStep: c.rec.birthStep, changedFromStep: changed, steps, medianMs: r1(med), maxMs: r1(Math.max(...runs)) })
    console.log(`edit-to-visible N = 1000, ${c.name}: changedFromStep ${changed}, ${steps} steps, median ${med.toFixed(1)} ms — budget ${EDIT_BUDGET_MS} ms ${med < EDIT_BUDGET_MS ? 'OK' : 'OVER'}`)
  }
  results.editToVisible = { n: 1000, playhead: P, budgetMs: EDIT_BUDGET_MS, cases: out }
}

// ---------------------------------------------------------------- steps/s

/** Births of a realistic layout compressed into the first `over` steps (so every node is active quickly). */
function compressed(records: WorldRecord[], over = 1000): WorldRecord[] {
  const maxB = Math.max(1, ...records.map((r) => r.birthStep))
  return records.map((r) => ({ ...r, birthStep: Math.floor((r.birthStep * over) / maxB) }))
}

function stepsPerSecond(w: PhysicsWorld, steps: number, reps = 3): number {
  const rates: number[] = []
  for (let k = 0; k < reps; k++) {
    const t0 = performance.now()
    for (let s = 0; s < steps; s++) stepWorld(w, 1)
    rates.push((steps * 1000) / (performance.now() - t0))
  }
  return median(rates)
}

const layout = (n: number) =>
  n <= 1000
    ? realisticRecords({ n, seed: 3, years: YEARS, preYears: 2, halfWidth: 15 })
    : realisticRecords({ n, seed: 4, years: Math.max(6, Math.round((6 * n) / 1000)), preYears: 5, halfWidth: 20 })

{
  const out: Record<string, unknown>[] = []
  for (const n of QUICK ? [1000, 2000] : [1000, 5000, 10000]) {
    const recs = layout(n)
    const span = Math.max(...recs.map((r) => r.birthStep))
    // Through the birth span (A(n) grows): a 2000-step window around mid-span.
    const w = build(recs)
    runTo(w, Math.floor(span / 2))
    const midActive = w.activeCount
    const t0 = performance.now()
    for (let s = 0; s < 2000; s++) stepWorld(w, 1)
    const mid = (2000 * 1000) / (performance.now() - t0)
    // Every node active (births compressed into the first 1000 steps; ramps done).
    const wf = build(compressed(recs))
    runTo(wf, 1200)
    const full = stepsPerSecond(wf, QUICK ? 300 : 1000)
    out.push({ n, midSpanActive: midActive, midSpanStepsPerSec: Math.round(mid), allActiveStepsPerSec: Math.round(full), allActiveRealTimeX: r1(full / 60) })
    console.log(`steps/s N = ${n}: mid-span (${midActive} active, births) ${mid.toFixed(0)}; all ${n} active ${full.toFixed(0)} (${(full / 60).toFixed(1)}× real time)`)
  }
  results.stepsPerSecond = out
}

// ---------------------------------------------------------------- max N at 10× real time

{
  const measure = (n: number): number => {
    const w = build(compressed(layout(n)))
    runTo(w, 1200)
    return stepsPerSecond(w, QUICK ? 200 : 600)
  }
  const sweep: { n: number; stepsPerSec: number }[] = []
  let lo = 0
  let hi = 0
  for (const n of QUICK ? [1000, 4000, 8000] : [1000, 2000, 4000, 6000, 8000, 10000, 14000, 20000]) {
    const sps = measure(n)
    sweep.push({ n, stepsPerSec: Math.round(sps) })
    console.log(`  sweep N = ${n}: ${sps.toFixed(0)} steps/s`)
    if (sps >= REAL_TIME_10X) lo = n
    else {
      hi = n
      break
    }
  }
  // Bisect the bracket (steps/s falls monotonically with N).
  if (lo > 0 && hi > 0) {
    for (let k = 0; k < (QUICK ? 1 : 4); k++) {
      const mid = Math.round((lo + hi) / 2 / 100) * 100
      if (mid <= lo || mid >= hi) break
      const sps = measure(mid)
      sweep.push({ n: mid, stepsPerSec: Math.round(sps) })
      console.log(`  bisect N = ${mid}: ${sps.toFixed(0)} steps/s`)
      if (sps >= REAL_TIME_10X) lo = mid
      else hi = mid
    }
  }
  results.maxN10x = { stepsPerSecTarget: REAL_TIME_10X, maxN: lo, firstFailingN: hi || null, sweep: sweep.sort((a, b) => a.n - b.n) }
  console.log(`max N sustaining 10× real time (${REAL_TIME_10X} steps/s, all active): ${lo}${hi ? ` (fails at ${hi})` : ' (no failure in the sweep)'}`)
}

const total = (performance.now() - t00) / 1000
mkdirSync('bench-results', { recursive: true })
const file = `bench-results/bench-${dateStamp()}${QUICK ? '-quick' : ''}.json`
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), quick: QUICK, node: process.version, cpu: cpus()[0]?.model ?? null, totalSeconds: total, ...results }, null, 2))
console.log(`wrote ${file} (${total.toFixed(1)} s)`)
