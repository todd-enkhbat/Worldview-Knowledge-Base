// Uniform integer-cell grid for the pair core. Produces each candidate pair (i, j) of
// the active set exactly once and applies it with the kernel's addPair, so the result
// is bit-identical to the O(N²) reference: pair impulses are wrapping i32 sums, which
// do not depend on visiting order, and addPair is orientation-independent.
//
// Cells are 2^shift Q.19 LSB wide with 2^shift ≥ σ (4 u for σ = 3 u). Each cell visits
// its own pairs once and 13 of its 26 neighbours (a half shell), so every adjacent cell
// pair is visited from exactly one side. Two layouts, chosen per call:
//
// - Dense: signed cell coordinates X >> shift, indexed directly over the active set's
//   bounding box (padded by one cell). Used when the box is compact AND spans at most
//   L − 3 cells per axis (L = 2^(32−shift) cells around the torus): then no pair can
//   straddle the ±4096 u seam (that needs cells −L/2 and L/2 − 1 both occupied, a span
//   of L), so every pair with |d_a| < σ ≤ 2^shift has signed cells ≤ 1 apart.
// - Hash: unsigned cell coordinates X >>> shift in an open-addressing table. Because the
//   cell width is a power of two dividing 2^32, X >>> shift depends only on X mod 2^32,
//   so cells wrap exactly like the torus differences (X_i − X_j) | 0, and neighbours are
//   taken modulo L (L ≥ 3 makes −1, 0, +1 distinct). Any world, any spread.
//
// Integer-only. Nothing allocates per step once the scratch has grown to fit.

import { type ParticleSystem, type PairAccumulator, addPair } from './integrator.ts'

// Odd 32-bit multipliers for the cell hash (golden ratio, murmur3 finaliser constants).
const H1 = 0x9e3779b1 | 0
const H2 = 0x85ebca77 | 0
const H3 = 0xc2b2ae3d | 0

/** Half-shell offsets, flattened (dx, dy, dz) × 13: nonzero, lexicographically positive in (dz, dy, dx). */
const HALF_SHELL: Int32Array = (() => {
  const out: number[] = []
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dz > 0 || (dz === 0 && (dy > 0 || (dy === 0 && dx > 0)))) out.push(dx, dy, dz)
      }
    }
  }
  return Int32Array.from(out)
})()
const SHELL = 13

/** Dense layout cap: cells ≤ max(DENSE_MIN_CELLS, DENSE_CELLS_PER_PARTICLE · n). */
const DENSE_MIN_CELLS = 1 << 17
const DENSE_CELLS_PER_PARTICLE = 16

export interface PairGrid {
  /** Cell width is 2^shift Q.19 LSB. */
  readonly shift: number
  /** Always use the hash layout (tests). */
  forceHash: boolean
  /** Scratch capacity in particles. */
  cap: number
  /** Particles in cell order: slot and position (copied for locality). */
  slot: Int32Array
  px: Int32Array
  py: Int32Array
  pz: Int32Array
  /** Cell of list[k] (dense linear index or hash cell index). */
  pcell: Int32Array
  /** Occupied cells, in first-seen order (dense linear indices). */
  occ: Int32Array
  /** Hash layout, per occupied cell: unsigned coordinates, first sorted position, count. */
  cellX: Int32Array
  cellY: Int32Array
  cellZ: Int32Array
  cellStart: Int32Array
  cellCount: Int32Array
  /** Hash layout: open-addressing table of cell indices, −1 = empty. */
  table: Int32Array
  /** Dense layout, per cell of the box: first sorted position (−1 = empty) and count. */
  head: Int32Array
  dcnt: Int32Array
  /** Dense layout: linear index offsets of the half shell for the current box. */
  doff: Int32Array
  /** Diagnostics from the last call. */
  lastMode: 'none' | 'dense' | 'hash'
  lastCells: number
  lastCandidates: number
}

/** Smallest power-of-two cell width ≥ σ (Q.19 LSB), as a shift. */
export function cellShiftFor(sigma: number): number {
  let s = 0
  while (2 ** s < sigma) s++
  if (s < 2 || s > 30) throw new RangeError(`pair cutoff ${sigma} gives an unusable cell shift ${s}`)
  return s
}

type PerParticle = Pick<PairGrid, 'slot' | 'px' | 'py' | 'pz' | 'pcell' | 'occ' | 'cellX' | 'cellY' | 'cellZ' | 'cellStart' | 'cellCount' | 'table'>

function alloc(cap: number): PerParticle {
  return {
    slot: new Int32Array(cap),
    px: new Int32Array(cap),
    py: new Int32Array(cap),
    pz: new Int32Array(cap),
    pcell: new Int32Array(cap),
    occ: new Int32Array(cap),
    cellX: new Int32Array(cap),
    cellY: new Int32Array(cap),
    cellZ: new Int32Array(cap),
    cellStart: new Int32Array(cap),
    cellCount: new Int32Array(cap),
    table: new Int32Array(2 * cap),
  }
}

export function createPairGrid(sigma: number, capacity = 64): PairGrid {
  let cap = 64
  while (cap < capacity) cap *= 2
  return {
    shift: cellShiftFor(sigma),
    forceHash: false,
    cap,
    ...alloc(cap),
    head: new Int32Array(0),
    dcnt: new Int32Array(0),
    doff: new Int32Array(SHELL),
    lastMode: 'none',
    lastCells: 0,
    lastCandidates: 0,
  }
}

function ensureCapacity(g: PairGrid, n: number): void {
  if (n <= g.cap) return
  let cap = g.cap
  while (cap < n) cap *= 2
  Object.assign(g, alloc(cap))
  g.cap = cap
}

/** Visit pairs (a, b) with a ∈ [st, en), b ∈ [st2, en2) (b > a when the ranges are the same cell). */
function cellPairs(
  sys: ParticleSystem,
  g: PairGrid,
  step: number,
  sig: number,
  st: number,
  en: number,
  st2: number,
  en2: number,
  same: boolean,
): number {
  const { px, py, pz, slot } = g
  const imp = sys.imp
  let cand = 0
  for (let a = st; a < en; a++) {
    const xa = px[a]
    const ya = py[a]
    const za = pz[a]
    for (let b = same ? a + 1 : st2; b < en2; b++) {
      const dx = (xa - px[b]) | 0
      if (dx >= sig || dx <= -sig) continue
      const dy = (ya - py[b]) | 0
      if (dy >= sig || dy <= -sig) continue
      const dz = (za - pz[b]) | 0
      if (dz >= sig || dz <= -sig) continue
      cand++
      addPair(sys, slot[a], slot[b], step, imp)
    }
  }
  return cand
}

function copyParticle(g: PairGrid, x: Int32Array, i: number, p: number): void {
  g.slot[p] = i
  g.px[p] = x[3 * i]
  g.py[p] = x[3 * i + 1]
  g.pz[p] = x[3 * i + 2]
}

/** Dense layout; returns false (nothing done) when the box is too large or may wrap. */
function denseGrid(sys: ParticleSystem, step: number, list: Int32Array, n: number, g: PairGrid): boolean {
  const x = sys.x
  const s = g.shift
  let minX = 0x7fffffff
  let minY = 0x7fffffff
  let minZ = 0x7fffffff
  let maxX = -0x80000000
  let maxY = -0x80000000
  let maxZ = -0x80000000
  for (let k = 0; k < n; k++) {
    const o = 3 * list[k]
    const cx = x[o] >> s
    const cy = x[o + 1] >> s
    const cz = x[o + 2] >> s
    if (cx < minX) minX = cx
    if (cx > maxX) maxX = cx
    if (cy < minY) minY = cy
    if (cy > maxY) maxY = cy
    if (cz < minZ) minZ = cz
    if (cz > maxZ) maxZ = cz
  }
  const lim = 2 ** (32 - s) - 3
  const sx = maxX - minX + 1
  const sy = maxY - minY + 1
  const sz = maxZ - minZ + 1
  if (sx > lim || sy > lim || sz > lim) return false
  const nx = sx + 2
  const ny = sy + 2
  const nz = sz + 2
  const vol = nx * ny * nz
  if (vol > Math.max(DENSE_MIN_CELLS, DENSE_CELLS_PER_PARTICLE * n)) return false
  if (g.head.length < vol) {
    let len = 1024
    while (len < vol) len *= 2
    g.head = new Int32Array(len)
    g.dcnt = new Int32Array(len)
  }
  const { head, dcnt, occ, pcell } = g
  head.fill(-1, 0, vol)
  // Shift the box by one cell so every half-shell neighbour index stays inside [0, vol).
  const ox = minX - 1
  const oy = minY - 1
  const oz = minZ - 1
  let nocc = 0
  for (let k = 0; k < n; k++) {
    const o = 3 * list[k]
    const c = (((x[o + 2] >> s) - oz) * ny + ((x[o + 1] >> s) - oy)) * nx + ((x[o] >> s) - ox)
    pcell[k] = c
    if (head[c] < 0) {
      head[c] = 0
      dcnt[c] = 0
      occ[nocc++] = c
    }
    dcnt[c]++
  }
  // head[c] ← end of the cell's range, then scatter downwards so head[c] ends at its start.
  let start = 0
  for (let j = 0; j < nocc; j++) {
    const c = occ[j]
    start += dcnt[c]
    head[c] = start
  }
  for (let k = 0; k < n; k++) copyParticle(g, x, list[k], --head[pcell[k]])

  const doff = g.doff
  for (let q = 0; q < SHELL; q++) {
    doff[q] = (HALF_SHELL[3 * q + 2] * ny + HALF_SHELL[3 * q + 1]) * nx + HALF_SHELL[3 * q]
  }
  const sig = sys.params.pairSigma
  let cand = 0
  for (let j = 0; j < nocc; j++) {
    const c = occ[j]
    const st = head[c]
    const en = st + dcnt[c]
    cand += cellPairs(sys, g, step, sig, st, en, st, en, true)
    for (let q = 0; q < SHELL; q++) {
      const c2 = c + doff[q]
      const st2 = head[c2]
      if (st2 < 0) continue
      cand += cellPairs(sys, g, step, sig, st, en, st2, st2 + dcnt[c2], false)
    }
  }
  g.lastMode = 'dense'
  g.lastCells = nocc
  g.lastCandidates = cand
  return true
}

function hashGrid(sys: ParticleSystem, step: number, list: Int32Array, n: number, g: PairGrid): void {
  const x = sys.x
  const s = g.shift
  const cmask = (2 ** (32 - s) - 1) | 0
  let bits = 6
  while (1 << bits < 2 * n) bits++
  const tsize = 1 << bits
  const tmask = tsize - 1
  const hshift = 32 - bits
  if (g.table.length < tsize) g.table = new Int32Array(tsize)
  const { table, pcell, cellX, cellY, cellZ, cellStart, cellCount } = g
  table.fill(-1, 0, tsize)

  let nc = 0
  for (let k = 0; k < n; k++) {
    const o = 3 * list[k]
    const cx = x[o] >>> s
    const cy = x[o + 1] >>> s
    const cz = x[o + 2] >>> s
    let h = (Math.imul(cx, H1) + Math.imul(cy, H2) + Math.imul(cz, H3)) >>> hshift
    let c: number
    for (;;) {
      c = table[h]
      if (c < 0) {
        c = nc++
        table[h] = c
        cellX[c] = cx
        cellY[c] = cy
        cellZ[c] = cz
        cellCount[c] = 0
        break
      }
      if (cellX[c] === cx && cellY[c] === cy && cellZ[c] === cz) break
      h = (h + 1) & tmask
    }
    cellCount[c]++
    pcell[k] = c
  }
  let start = 0
  for (let c = 0; c < nc; c++) {
    start += cellCount[c]
    cellStart[c] = start
  }
  for (let k = 0; k < n; k++) copyParticle(g, x, list[k], --cellStart[pcell[k]])

  const sig = sys.params.pairSigma
  let cand = 0
  for (let c = 0; c < nc; c++) {
    const st = cellStart[c]
    const en = st + cellCount[c]
    cand += cellPairs(sys, g, step, sig, st, en, st, en, true)
    const cx = cellX[c]
    const cy = cellY[c]
    const cz = cellZ[c]
    for (let q = 0; q < SHELL; q++) {
      const ncx = (cx + HALF_SHELL[3 * q]) & cmask
      const ncy = (cy + HALF_SHELL[3 * q + 1]) & cmask
      const ncz = (cz + HALF_SHELL[3 * q + 2]) & cmask
      let h = (Math.imul(ncx, H1) + Math.imul(ncy, H2) + Math.imul(ncz, H3)) >>> hshift
      let c2 = table[h]
      while (c2 >= 0 && (cellX[c2] !== ncx || cellY[c2] !== ncy || cellZ[c2] !== ncz)) {
        h = (h + 1) & tmask
        c2 = table[h]
      }
      if (c2 < 0) continue
      const st2 = cellStart[c2]
      cand += cellPairs(sys, g, step, sig, st, en, st2, st2 + cellCount[c2], false)
    }
  }
  g.lastMode = 'hash'
  g.lastCells = nc
  g.lastCandidates = cand
}

/**
 * Pair impulses for the active particles list[0..n) at step n, accumulated into
 * sys.imp (and the float shadow) through addPair. Bit-identical to
 * accumulatePairsListBruteForce / accumulatePairsBruteForce over the same set.
 */
export function accumulatePairsGrid(
  sys: ParticleSystem,
  step: number,
  list: Int32Array,
  n: number,
  g: PairGrid,
): void {
  g.lastMode = 'none'
  g.lastCells = 0
  g.lastCandidates = 0
  if (n < 2) return
  ensureCapacity(g, n)
  if (!g.forceHash && denseGrid(sys, step, list, n, g)) return
  hashGrid(sys, step, list, n, g)
}

/** A PairAccumulator bound to one grid's scratch (one grid per world/worker). */
export function gridPairAccumulator(g: PairGrid): PairAccumulator {
  return (sys, step, list, n) => accumulatePairsGrid(sys, step, list, n, g)
}
