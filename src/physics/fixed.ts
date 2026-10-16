// Fixed-point primitives shared by the CPU kernel and its GLSL ES 3.00 port.
// Every function is i32/u32 only: (a + b) | 0, Math.imul, >>, >>>, &. No value
// ever passes through a double that is not exact. See docs/PHYSICS.md for the
// Q-format table and the overflow bound of each operation.

/** Position X and anchors A: i32 Q.19 world units (±4096 u, wraps as a torus). */
export const X_FRAC = 19
/** Displacement-per-step D: i32 Q.27 u/step. */
export const D_FRAC = 27
/** drift(D) maps Q.27 → Q.19. */
export const DRIFT_SHIFT = D_FRAC - X_FRAC
/** Mass-weighted impulse I = F·dt² in Q.30 (u/step · mass). */
export const IMP_FRAC = 30
/** Inverse mass 1/m in Q.13: m ∈ [0.25, 4] ↔ [32768, 2048]. */
export const INV_MASS_FRAC = 13
export const INV_MASS_MIN = 2048
export const INV_MASS_MAX = 32768
/** Coupling τ and temperature T in Q.15: [0, 1] ↔ [0, 32768]. */
export const TAU_FRAC = 15
export const TAU_ONE = 32768
/** K = mulshr(I, invMass, KICK_SHIFT): Q.30 · Q.13 → Q.27. */
export const KICK_SHIFT = IMP_FRAC + INV_MASS_FRAC - D_FRAC
/**
 * Default tether shift: I_Q30 = −mulshr(u_Q19, k, TETHER_SHIFT), a Q.19 × Q.11 coefficient.
 * A population axis may use a smaller shift (a coarser coefficient LSB) to reach a stiffer
 * spring with k ≤ 2^15; see PopulationParams.yShift and docs/PHYSICS.md.
 */
export const TETHER_SHIFT = 11
/** One world unit in Q.19. */
export const UNIT = 1 << X_FRAC
/** Fixed step: dt = 1/60 s. It is folded into every integer force coefficient. */
export const STEPS_PER_SECOND = 60

export const INT_MIN = -0x80000000
export const INT_MAX = 0x7fffffff
/** Largest |b| accepted by mulshr (the "small" operand). */
export const MUL_SMALL_MAX = 0x8000

/**
 * Round-half-even arithmetic right shift: rhe(x / 2^s) for any i32 x, s ∈ [1, 30].
 * Floor-based (>> is floor for negatives), so it is odd-symmetric: rshr(-x) = -rshr(x).
 */
export function rshr(x: number, s: number): number {
  const f = x >> s
  const r = x & ((1 << s) - 1)
  return (f + roundUp(r, f, 1 << (s - 1))) | 0
}

/**
 * 1 when the remainder r (0 ≤ r < 2^30) rounds the floor f up under half-even:
 * r > half, or r = half with f odd ⇔ r + (f & 1) > half. Branchless (the sign bit of
 * half − r − (f & 1)), because data-dependent branches here cost ~2× in mispredictions.
 */
function roundUp(r: number, f: number, half: number): number {
  return (half - r - (f & 1)) >>> 31
}

/**
 * rhe(a·b / 2^s) without a 64-bit product: any i32 a, |b| ≤ 2^15, s ∈ [1, 30].
 * Split a = ah·2^16 + al: |ah·b| ≤ 2^30 and 0 ≤ al < 2^16 gives |al·b| < 2^31.
 * Exact whenever the true result fits in i32, which is always the case for s ≥ 16.
 */
export function mulshr(a: number, b: number, s: number): number {
  const ah = a >> 16
  const al = a & 0xffff
  const q = Math.imul(al, b)
  // a·b = hi·2^16 + ql with ql ∈ [0, 2^16)
  const hi = (Math.imul(ah, b) + (q >> 16)) | 0
  const ql = q & 0xffff
  if (s < 16) {
    // hi·2^(16−s) is even, so the tie parity is decided by ql alone.
    return ((hi << (16 - s)) + rshr(ql, s)) | 0
  }
  const t = s - 16
  const f = hi >> t
  const r = ((hi & ((1 << t) - 1)) << 16) | ql
  return (f + roundUp(r, f, 1 << (s - 1))) | 0
}

/**
 * drift(D) = sgn(D)·((|D| + 128) >> 8): Q.27 → Q.19, exactly odd on all of Z/2^32.
 * |D| + 128 is evaluated as u32 so it cannot overflow; D = INT_MIN (where −D = D)
 * maps to 0, the only value that keeps drift(−D) = −drift(D) there.
 */
export function drift(d: number): number {
  const s = d >> 31
  const a = ((d ^ s) - s) | 0
  const m = ((a + 128) >>> DRIFT_SHIFT) & ~(a >> 31)
  return ((m ^ s) - s) | 0
}

/** floor(√n) for n ∈ [0, 2^32), digit-by-digit with a fixed 16 iterations (GLSL: uint). */
export function isqrt(n: number): number {
  let x = n >>> 0
  let r = 0
  let bit = 0x40000000
  for (let k = 0; k < 16; k++) {
    const t = r + bit
    if (x >= t) {
      x -= t
      r = (r >>> 1) + bit
    } else {
      r >>>= 1
    }
    bit >>>= 2
  }
  return r
}

/** Clamp to [−m, m]. */
export function clampSym(v: number, m: number): number {
  return v > m ? m : v < -m ? -m : v
}

/**
 * Round-half-up integer division for build-time constants, a ≥ 0, b > 0, 2a + b < 2^53.
 * floor() of an exact-integer quotient below 2^53 is exact in every engine.
 */
export function roundDiv(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b))
}

/** Quantise a record mass (float boundary; IEEE basic ops are engine-independent). */
export function invMassFromMass(m: number): number {
  const q = Math.round((1 << INV_MASS_FRAC) / m)
  return q < INV_MASS_MIN ? INV_MASS_MIN : q > INV_MASS_MAX ? INV_MASS_MAX : q
}

/** Quantise a record temperature τ ∈ [0, 1] to Q.15. */
export function tauFromUnit(t: number): number {
  const q = Math.round(t * TAU_ONE)
  return q < 0 ? 0 : q > TAU_ONE ? TAU_ONE : q
}
