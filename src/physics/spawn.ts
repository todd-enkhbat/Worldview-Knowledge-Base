// Integer-only spawn: the Past-Hypothesis macrostate of a particle as a pure function
// of its u32 seed (the id hash) and its integer temperature and inverse mass. The GPU
// regenerates dormant dust with the same code.

import { isqrt, mulshr, rshr } from './fixed.ts'
import { DUST_BURST_RADIUS, SPAWN_U_HALF, V0_COEF } from './params.ts'
import type { ParticleSystem } from './integrator.ts'
import { draw, uniformBelow } from './rng.ts'
import { cosQ15, sinQ15 } from './sinlut.ts'

// Stream ids of the per-seed draws.
const S_U = 0 // 0..2: offset per axis
const S_DIR_Y = 3
const S_DIR_PHI = 4
const S_NOISE = 5 // 5..7: speed noise per axis

/**
 * Uniform unit vector in Q.15 (Archimedes: e_y uniform in [−1, 1), azimuth from the
 * sine LUT). Writes out[o..o+2].
 */
export function unitDirection(seed: number, out: Int32Array, o: number): void {
  const ey = (draw(seed, S_DIR_Y) >>> 16) - 32768
  const rho = isqrt((0x40000000 - Math.imul(ey, ey)) >>> 0)
  const phi = draw(seed, S_DIR_PHI) | 0
  out[o] = rshr(Math.imul(rho, cosQ15(phi)), 15)
  out[o + 1] = ey
  out[o + 2] = rshr(Math.imul(rho, sinQ15(phi)), 15)
}

/** Spawn speed D0 = 0.8·√(T/m)·dt in Q.27, from T (Q.15) and 1/m (Q.13). */
export function spawnSpeed(temp: number, invMass: number): number {
  return rshr(Math.imul(isqrt(Math.imul(temp, invMass) >>> 0), V0_COEF), 8)
}

/** Relative speed noise in [−1/32, 1/32) applied per axis. */
function noisyVelocity(seed: number, d0: number, dir: Int32Array, out: Int32Array): void {
  for (let a = 0; a < 3; a++) {
    const n = (draw(seed, S_NOISE + a) >>> 21) - 1024
    out[3 + a] = (mulshr(d0, dir[a], 15) + mulshr(d0, n, 15)) | 0
  }
}

const dirScratch = new Int32Array(3)

/**
 * Node spawn: u uniform per axis in ±0.05·l/√3, never exactly 0; D = D0·ê + noise.
 * out = [u_x, u_y, u_z (Q.19), D_x, D_y, D_z (Q.27)].
 */
export function spawnNodeState(seed: number, temp: number, invMass: number, out: Int32Array): void {
  for (let a = 0; a < 3; a++) {
    const h = draw(seed, S_U + a)
    const mag = 1 + uniformBelow(h, SPAWN_U_HALF)
    out[a] = (h & 1) === 1 ? -mag : mag
  }
  unitDirection(seed, dirScratch, 0)
  noisyVelocity(seed, spawnSpeed(temp, invMass), dirScratch, out)
}

/**
 * Dust spawn (radial burst): u = 0.01·l·ê plus a nonzero kick away from the anchor
 * on every axis; D = D0·ê + noise, outward along the same ê.
 */
export function spawnDustState(seed: number, temp: number, invMass: number, out: Int32Array): void {
  unitDirection(seed, dirScratch, 0)
  for (let a = 0; a < 3; a++) {
    const base = mulshr(DUST_BURST_RADIUS, dirScratch[a], 15)
    const n = 1 + (draw(seed, S_U + a) & 63)
    out[a] = base < 0 ? base - n : base + n
  }
  noisyVelocity(seed, spawnSpeed(temp, invMass), dirScratch, out)
}

const spawnScratch = new Int32Array(6)

function writeSpawn(sys: ParticleSystem, i: number): void {
  const o = 3 * i
  for (let a = 0; a < 3; a++) {
    sys.x[o + a] = (sys.anchor[o + a] + spawnScratch[a]) | 0
    sys.d[o + a] = spawnScratch[3 + a]
  }
}

/** Write the spawn state of node i (anchor, invMass and τ already set; T = τ). */
export function spawnNode(sys: ParticleSystem, i: number, seed: number): void {
  spawnNodeState(seed, sys.tau[i], sys.invMass[i], spawnScratch)
  writeSpawn(sys, i)
}

/** Write the spawn state of dust particle i (dust temperature from params). */
export function spawnDust(sys: ParticleSystem, i: number, seed: number): void {
  spawnDustState(seed, sys.params.dustTemp, sys.invMass[i], spawnScratch)
  writeSpawn(sys, i)
}
