// GLSL ES 3.00 generator for the dust kernel (tether + landscape, no pairs). Every
// integer the shader embeds comes from src/physics (Q-format shifts, PhysicsParams,
// LUT layout), so the GPU kernel cannot drift from the TS reference by a hand-copied
// constant. The function bodies are line-for-line ports of fixed.ts, sinlut.ts and
// potentials.ts following the JS → GLSL table in docs/PHYSICS.md: uint arithmetic for
// every intentionally wrapping op, arithmetic >> on int, no floats inside K. Births are
// handled in the shader too: spawn.ts spawnDustState (with rng.ts draw and fixed.ts
// isqrt) is ported the same way, so dormant texels are regenerated bit-exactly.

import { DRIFT_SHIFT, INT_MIN, KICK_SHIFT } from '../../physics/fixed.ts'
import { DUST_BURST_RADIUS, LANDSCAPE_MODES, type PhysicsParams, landscapeHash } from '../../physics/params.ts'
import { TETHER_SHIFT, landscapeCoef } from '../../physics/potentials.ts'
import { SIN_LUT_BITS, SIN_LUT_SIZE, SIN_LUT_TEX_WIDTH } from '../../physics/sinlut.ts'
import { spawnSpeed } from '../../physics/spawn.ts'

/**
 * Required after `#version 300 es` in every kernel shader (docs/PHYSICS.md): fragment
 * shaders default to mediump int, which is only guaranteed on (−2^15, 2^15).
 */
export const GLSL_PRECISION_HEADER = [
  'precision highp float;',
  'precision highp int;',
  'precision highp isampler2D;',
  'precision highp usampler2D;',
].join('\n')

/** three.js prepends `#version 300 es` to a GLSL3 RawShaderMaterial; raw WebGL needs it in the source. */
export const GLSL_VERSION_LINE = '#version 300 es'

// Literals that are structural in the TS sources (not physics parameters). Each one is
// re-derived from the exported constants where possible; tests/physics/gpuDust.test.ts
// evaluates the kernel through this spec and checks it against src/physics bit for bit.
/** mulshr splits a = ah·2^16 + al (fixed.ts). */
const MULSHR_SPLIT = 16
/** sinQ15 interpolates with a 16-bit fraction below the table index (sinlut.ts). */
const SIN_FRAC_BITS = 16
/** The table is Q1.15: s = mulshr(c_im, sin, 15) (potentials.ts). */
const SIN_Q = 15
/** I += mulshr(s, k, 16) (potentials.ts). */
const LANDSCAPE_K_SHIFT = 16

/** Every integer the generated dust shader embeds. */
export interface DustKernelSpec {
  readonly mulshrSplit: number
  readonly driftShift: number
  readonly kickShift: number
  readonly tetherShift: number
  readonly invMass: number
  readonly kXZ: number
  readonly kY: number
  readonly uSat: number
  readonly modes: number
  /** Per-mode wave vector (phase units per Q.19 LSB). */
  readonly kx: readonly number[]
  readonly kz: readonly number[]
  /** φ_m as u32. */
  readonly phase: readonly number[]
  /** c_im = landscapeCoef(C_m, τ_dust): dust shares one τ, so it is a per-mode constant. */
  readonly lcoef: readonly number[]
  readonly sinQ: number
  readonly landscapeKShift: number
  /** index = Φ >>> sinIndexShift. */
  readonly sinIndexShift: number
  /** frac = (Φ >>> sinFracShift) & sinFracMask. */
  readonly sinFracShift: number
  readonly sinFracMask: number
  readonly sinFracBits: number
  readonly sinLutMask: number
  /** texelFetch(lut, ivec2(i & (w − 1), i >> lutTexShift)). */
  readonly lutTexWidth: number
  readonly lutTexShift: number
  /** fnv1a of the landscape (provenance comment in the shader). */
  readonly landscapeHash: number
  readonly seed: number
}

export function dustKernelSpec(p: PhysicsParams): DustKernelSpec {
  const l = p.landscape
  const lutTexShift = Math.log2(SIN_LUT_TEX_WIDTH)
  if (!Number.isInteger(lutTexShift)) throw new Error('SIN_LUT_TEX_WIDTH must be a power of two')
  const modes = LANDSCAPE_MODES
  return {
    mulshrSplit: MULSHR_SPLIT,
    driftShift: DRIFT_SHIFT,
    kickShift: KICK_SHIFT,
    tetherShift: TETHER_SHIFT,
    invMass: p.dustInvMass,
    kXZ: p.dust.kXZ,
    kY: p.dust.kY,
    uSat: p.dust.uSat,
    modes,
    kx: Array.from(l.kx),
    kz: Array.from(l.kz),
    phase: Array.from(l.phase, (v) => v >>> 0),
    lcoef: Array.from(l.coef, (c) => landscapeCoef(c, p.dustTau)),
    sinQ: SIN_Q,
    landscapeKShift: LANDSCAPE_K_SHIFT,
    sinIndexShift: 32 - SIN_LUT_BITS,
    sinFracShift: 32 - SIN_LUT_BITS - SIN_FRAC_BITS,
    sinFracMask: (1 << SIN_FRAC_BITS) - 1,
    sinFracBits: SIN_FRAC_BITS,
    sinLutMask: SIN_LUT_SIZE - 1,
    lutTexWidth: SIN_LUT_TEX_WIDTH,
    lutTexShift,
    landscapeHash: landscapeHash(l),
    seed: p.seed >>> 0,
  }
}

// ---- spawn (spawn.ts spawnDustState + rng.ts draw + fixed.ts isqrt) ----
// The physics constants come from src/physics exports; the structural literals below
// are private to spawn.ts / rng.ts / fixed.ts, so tests/physics/gpuDustBirths.test.ts
// evaluates the port through this spec against spawnDustState for many seeds, and an
// off-by-one in any field fails it.

/** Every integer the generated spawn port embeds. */
export interface DustSpawnSpec {
  /** DUST_BURST_RADIUS: |u| = 0.01·l along ê (Q.19). */
  readonly burstRadius: number
  /** spawnSpeed(dustTemp, dustInvMass): D0 in Q.27 (dust is one population). */
  readonly d0: number
  /** Draw streams: u noise per axis (S_U + a), ê_y, azimuth, velocity noise per axis (S_NOISE + a). */
  readonly streamU: number
  readonly streamDirY: number
  readonly streamDirPhi: number
  readonly streamNoise: number
  /** e_y = (h >>> eyShift) − eyBias, uniform in [−1, 1) Q.15. */
  readonly eyShift: number
  readonly eyBias: number
  /** ρ = isqrt(rhoBase − e_y²), rhoBase = 1 in Q.30. */
  readonly rhoBase: number
  /** cos(Φ) = sin(Φ + cosOffset). */
  readonly cosOffset: number
  /** ê_xz = rshr(ρ·cos|sin, dirShift). */
  readonly dirShift: number
  /** base = mulshr(burstRadius, ê_a, burstShift). */
  readonly burstShift: number
  /** push = 1 + (h & burstPushMask), away from the anchor. */
  readonly burstPushMask: number
  /** noise = (h >>> noiseShift) − noiseBias ∈ [−1/32, 1/32) Q.15. */
  readonly noiseShift: number
  readonly noiseBias: number
  /** D_a = mulshr(d0, ê_a, velShift) + mulshr(d0, noise, velShift). */
  readonly velShift: number
  /** lowbias32 multipliers and shifts (x ^= x >>> s1; x *= m1; x ^= x >>> s2; x *= m2; x ^= x >>> s3). */
  readonly lbMul1: number
  readonly lbMul2: number
  readonly lbShift1: number
  readonly lbShift2: number
  readonly lbShift3: number
  /** draw(seed, k) = lowbias32(lowbias32(seed) + (k + 1)·golden). */
  readonly golden: number
  /** isqrt: digit-by-digit, `isqrtIters` iterations from bit `isqrtTopBit`. */
  readonly isqrtIters: number
  readonly isqrtTopBit: number
}

export function dustSpawnSpec(p: PhysicsParams): DustSpawnSpec {
  return {
    burstRadius: DUST_BURST_RADIUS,
    d0: spawnSpeed(p.dustTemp, p.dustInvMass),
    streamU: 0,
    streamDirY: 3,
    streamDirPhi: 4,
    streamNoise: 5,
    eyShift: 16,
    eyBias: 32768,
    rhoBase: 0x40000000,
    cosOffset: 0x40000000,
    dirShift: 15,
    burstShift: 15,
    burstPushMask: 63,
    noiseShift: 21,
    noiseBias: 1024,
    velShift: 15,
    lbMul1: 0x7feb352d,
    lbMul2: 0x846ca68b,
    lbShift1: 16,
    lbShift2: 15,
    lbShift3: 16,
    golden: 0x9e3779b9,
    isqrtIters: 16,
    isqrtTopBit: 0x40000000,
  }
}

/** A GLSL `int` literal for any i32 (INT_MIN has no decimal literal in GLSL). */
export function glslInt(v: number): string {
  if (!Number.isInteger(v) || v < INT_MIN || v > 0x7fffffff) throw new RangeError(`not an i32: ${v}`)
  if (v === INT_MIN) return 'int(0x80000000u)'
  return v < 0 ? `(${v})` : `${v}`
}

/** A GLSL `uint` literal for any u32 bit pattern. */
export function glslUint(v: number): string {
  return `0x${(v >>> 0).toString(16).padStart(8, '0')}u`
}

/** Full-screen triangle; one fragment per particle texel. */
export function dustVertexShader(): string {
  return `${GLSL_PRECISION_HEADER}

in vec3 position;

void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`
}

/**
 * The stepping fragment shader. Reads X (xyz Q.19, w carried), D (xyz Q.27, w carried)
 * and the anchor (xyz Q.19, w = birth) per texel; runs uSteps forward or backward
 * Levesque–Verlet steps in a loop; writes X to location 0 and D to location 1.
 * uSteps = 0 is a plain copy (used to load an uploaded state into the ping-pong).
 *
 * With uBirths ≠ 0 the source state is at step uStep and every texel follows world.ts
 * birth semantics (forward n→n+1 and backward n+1→n act on A(n) = {birth ≤ n}): a texel
 * whose birth b ≥ the destination step outputs its spawn state, regenerated from the
 * anchor and the meta seed; a forward draw that crosses b starts from the spawn at b and
 * steps the rest. A 0-step draw at uStep therefore also re-spawns every dormant texel.
 */
export function dustStepFragmentShader(p: PhysicsParams): string {
  const s = dustKernelSpec(p)
  const sp = dustSpawnSpec(p)
  const modeConsts: string[] = []
  const modeBody: string[] = []
  for (let m = 0; m < s.modes; m++) {
    modeConsts.push(
      `const int LS_KX_${m} = ${glslInt(s.kx[m])};`,
      `const int LS_KZ_${m} = ${glslInt(s.kz[m])};`,
      `const uint LS_PHASE_${m} = ${glslUint(s.phase[m])};`,
      `const int LS_C_${m} = ${glslInt(s.lcoef[m])};`,
    )
    modeBody.push(
      `  // mode ${m}`,
      `  ph = uint(LS_KX_${m}) * ux + uint(LS_KZ_${m}) * uz + LS_PHASE_${m};`,
      `  sm = mulshr(LS_C_${m}, sinQ15(ph), SIN_Q);`,
      `  lx += uint(mulshr(sm, LS_KX_${m}, LS_K_SHIFT));`,
      `  lz += uint(mulshr(sm, LS_KZ_${m}, LS_K_SHIFT));`,
    )
  }
  return `${GLSL_PRECISION_HEADER}

// Generated by src/gpu/dust/glsl.ts — do not edit. Physics seed ${glslUint(s.seed)},
// landscape fnv1a ${glslUint(s.landscapeHash)}. Integer-only: no float enters K or the step.

uniform isampler2D uX;
uniform isampler2D uD;
uniform isampler2D uAnchor;
uniform isampler2D uMeta;
uniform isampler2D uSinLut;
uniform int uSteps;
uniform int uBackward;
uniform int uStep;
uniform int uBirths;

layout(location = 0) out ivec4 oX;
layout(location = 1) out ivec4 oD;

const int SPLIT = ${glslInt(s.mulshrSplit)};
const int SPLIT_MASK = ${glslInt((1 << s.mulshrSplit) - 1)};
const uint DRIFT_SHIFT = ${s.driftShift}u;
const int KICK_SHIFT = ${glslInt(s.kickShift)};
const int TETHER_SHIFT = ${glslInt(s.tetherShift)};
const int INV_MASS = ${glslInt(s.invMass)};
const int TETHER_KXZ = ${glslInt(s.kXZ)};
const int TETHER_KY = ${glslInt(s.kY)};
const int TETHER_SAT = ${glslInt(s.uSat)};
const int SIN_Q = ${glslInt(s.sinQ)};
const int LS_K_SHIFT = ${glslInt(s.landscapeKShift)};
const uint SIN_INDEX_SHIFT = ${s.sinIndexShift}u;
const uint SIN_FRAC_SHIFT = ${s.sinFracShift}u;
const uint SIN_FRAC_MASK = ${glslUint(s.sinFracMask)};
const int SIN_FRAC_BITS = ${glslInt(s.sinFracBits)};
const int SIN_LUT_MASK = ${glslInt(s.sinLutMask)};
const int LUT_TEX_MASK = ${glslInt(s.lutTexWidth - 1)};
const int LUT_TEX_SHIFT = ${glslInt(s.lutTexShift)};
${modeConsts.join('\n')}
const int SP_BURST_RADIUS = ${glslInt(sp.burstRadius)};
const int SP_D0 = ${glslInt(sp.d0)};
const int SP_STREAM_U = ${glslInt(sp.streamU)};
const int SP_STREAM_DIR_Y = ${glslInt(sp.streamDirY)};
const int SP_STREAM_DIR_PHI = ${glslInt(sp.streamDirPhi)};
const int SP_STREAM_NOISE = ${glslInt(sp.streamNoise)};
const uint SP_EY_SHIFT = ${sp.eyShift}u;
const int SP_EY_BIAS = ${glslInt(sp.eyBias)};
const int SP_RHO_BASE = ${glslInt(sp.rhoBase)};
const uint SP_COS_OFFSET = ${glslUint(sp.cosOffset)};
const int SP_DIR_SHIFT = ${glslInt(sp.dirShift)};
const int SP_BURST_SHIFT = ${glslInt(sp.burstShift)};
const uint SP_PUSH_MASK = ${glslUint(sp.burstPushMask)};
const uint SP_NOISE_SHIFT = ${sp.noiseShift}u;
const int SP_NOISE_BIAS = ${glslInt(sp.noiseBias)};
const int SP_VEL_SHIFT = ${glslInt(sp.velShift)};
const uint LB_MUL1 = ${glslUint(sp.lbMul1)};
const uint LB_MUL2 = ${glslUint(sp.lbMul2)};
const uint LB_SHIFT1 = ${sp.lbShift1}u;
const uint LB_SHIFT2 = ${sp.lbShift2}u;
const uint LB_SHIFT3 = ${sp.lbShift3}u;
const uint RNG_GOLDEN = ${glslUint(sp.golden)};
const int ISQRT_ITERS = ${glslInt(sp.isqrtIters)};
const uint ISQRT_TOP_BIT = ${glslUint(sp.isqrtTopBit)};

// 1 when remainder r rounds floor f up under half-even: sign bit of half − r − (f & 1).
int roundUp(int r, int f, int halfv) {
  return int(uint(halfv - r - (f & 1)) >> 31u);
}

// fixed.ts rshr: round-half-even arithmetic right shift, s ∈ [1, 30].
int rshr(int x, int s) {
  int f = x >> s;
  int r = x & ((1 << s) - 1);
  return f + roundUp(r, f, 1 << (s - 1));
}

// fixed.ts mulshr: rhe(a·b / 2^s) for any i32 a, |b| ≤ 2^15, without a 64-bit product.
int mulshr(int a, int b, int s) {
  int ah = a >> SPLIT;
  int al = a & SPLIT_MASK;
  int q = al * b;
  int hi = ah * b + (q >> SPLIT);
  int ql = q & SPLIT_MASK;
  if (s < SPLIT) {
    return int((uint(hi) << uint(SPLIT - s)) + uint(rshr(ql, s)));
  }
  int t = s - SPLIT;
  int f = hi >> t;
  int r = ((hi & ((1 << t) - 1)) << SPLIT) | ql;
  return f + roundUp(r, f, 1 << (s - 1));
}

// fixed.ts drift: sgn(D)·((|D| + 128) >> 8), with |D| + 128 taken as u32 and drift(INT_MIN) = 0.
int drift(int d) {
  int sg = d >> 31;
  int a = int(uint(d ^ sg) - uint(sg));
  int m = int((uint(a) + (1u << (DRIFT_SHIFT - 1u))) >> DRIFT_SHIFT) & ~(a >> 31);
  return int(uint(m ^ sg) - uint(sg));
}

int lut(int i) {
  return texelFetch(uSinLut, ivec2(i & LUT_TEX_MASK, i >> LUT_TEX_SHIFT), 0).r;
}

// sinlut.ts sinQ15: phase is a u32 with 2^32 ≡ 2π.
int sinQ15(uint ph) {
  int i = int(ph >> SIN_INDEX_SHIFT);
  int f = int((ph >> SIN_FRAC_SHIFT) & SIN_FRAC_MASK);
  int a = lut(i);
  int b = lut((i + 1) & SIN_LUT_MASK);
  return a + rshr((b - a) * f, SIN_FRAC_BITS);
}

// potentials.ts tetherImpulse on the wrapped offset u.
int tether(int u, int k) {
  int us = u > TETHER_SAT ? TETHER_SAT : (u < -TETHER_SAT ? -TETHER_SAT : u);
  return -mulshr(us, k, TETHER_SHIFT);
}

// K(X): tether + landscape impulse (Q.30), then the dust mass (Q.27). n-independent for dust.
ivec3 kick(ivec3 x, ivec3 a) {
  uvec3 u = uvec3(x) - uvec3(a);
  int ix = tether(int(u.x), TETHER_KXZ);
  int iy = tether(int(u.y), TETHER_KY);
  int iz = tether(int(u.z), TETHER_KXZ);
  uint ux = uint(x.x);
  uint uz = uint(x.z);
  uint lx = 0u;
  uint lz = 0u;
  uint ph;
  int sm;
${modeBody.join('\n')}
  ix = int(uint(ix) + lx);
  iz = int(uint(iz) + lz);
  return ivec3(mulshr(ix, INV_MASS, KICK_SHIFT), mulshr(iy, INV_MASS, KICK_SHIFT), mulshr(iz, INV_MASS, KICK_SHIFT));
}

ivec3 drift3(ivec3 d) {
  return ivec3(drift(d.x), drift(d.y), drift(d.z));
}

// rng.ts lowbias32 / draw on u32.
uint lowbias32(uint v) {
  v ^= v >> LB_SHIFT1;
  v *= LB_MUL1;
  v ^= v >> LB_SHIFT2;
  v *= LB_MUL2;
  v ^= v >> LB_SHIFT3;
  return v;
}

uint drawH(uint seed, int stream) {
  return lowbias32(lowbias32(seed) + uint(stream + 1) * RNG_GOLDEN);
}

// fixed.ts isqrt: floor(sqrt(n)), digit by digit, fixed iteration count.
uint isqrtU(uint n) {
  uint v = n;
  uint r = 0u;
  uint bit = ISQRT_TOP_BIT;
  for (int k = 0; k < ISQRT_ITERS; k++) {
    uint t = r + bit;
    if (v >= t) {
      v -= t;
      r = (r >> 1u) + bit;
    } else {
      r >>= 1u;
    }
    bit >>= 2u;
  }
  return r;
}

// spawn.ts spawnDustState (radial burst) at anchor a: X = a + u, D.
void spawnDust(ivec3 a, uint seed, out ivec3 x, out ivec3 d) {
  // unitDirection: e_y uniform in [−1, 1), azimuth from the sine LUT (cos = sin + quarter turn).
  int ey = int(drawH(seed, SP_STREAM_DIR_Y) >> SP_EY_SHIFT) - SP_EY_BIAS;
  int rho = int(isqrtU(uint(SP_RHO_BASE - ey * ey)));
  uint phi = drawH(seed, SP_STREAM_DIR_PHI);
  ivec3 e = ivec3(rshr(rho * sinQ15(phi + SP_COS_OFFSET), SP_DIR_SHIFT), ey, rshr(rho * sinQ15(phi), SP_DIR_SHIFT));
  ivec3 u;
  ivec3 v;
  for (int c = 0; c < 3; c++) {
    int base = mulshr(SP_BURST_RADIUS, e[c], SP_BURST_SHIFT);
    int push = 1 + int(drawH(seed, SP_STREAM_U + c) & SP_PUSH_MASK);
    u[c] = base < 0 ? base - push : base + push;
    int noise = int(drawH(seed, SP_STREAM_NOISE + c) >> SP_NOISE_SHIFT) - SP_NOISE_BIAS;
    v[c] = int(uint(mulshr(SP_D0, e[c], SP_VEL_SHIFT)) + uint(mulshr(SP_D0, noise, SP_VEL_SHIFT)));
  }
  x = ivec3(uvec3(a) + uvec3(u));
  d = v;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec4 xs = texelFetch(uX, p, 0);
  ivec4 ds = texelFetch(uD, p, 0);
  ivec4 an = texelFetch(uAnchor, p, 0);
  ivec3 a = an.xyz;
  ivec3 x = xs.xyz;
  ivec3 d = ds.xyz;
  int steps = uSteps;
  if (uBirths != 0) {
    // world.ts births: the state at n ≤ birth is the spawn; only A(n) = {birth ≤ n} steps.
    int b = an.w;
    int dest = uBackward == 0 ? uStep + uSteps : uStep - uSteps;
    if (dest <= b) {
      spawnDust(a, uint(texelFetch(uMeta, p, 0).x), x, d);
      steps = 0;
    } else if (uBackward == 0 && uStep < b) {
      spawnDust(a, uint(texelFetch(uMeta, p, 0).x), x, d);
      steps = dest - b;
    }
  }
  if (uBackward == 0) {
    // forward n → n+1: D += K(X); X += drift(D)
    for (int k = 0; k < steps; k++) {
      d = ivec3(uvec3(d) + uvec3(kick(x, a)));
      x = ivec3(uvec3(x) + uvec3(drift3(d)));
    }
  } else {
    // backward n+1 → n: X −= drift(D); D −= K(X)
    for (int k = 0; k < steps; k++) {
      x = ivec3(uvec3(x) - uvec3(drift3(d)));
      d = ivec3(uvec3(d) - uvec3(kick(x, a)));
    }
  }
  oX = ivec4(x, xs.w);
  oD = ivec4(d, ds.w);
}
`
}

/**
 * Writes uploaded rows into a render target: the draw is scissored to the patch rectangle,
 * and texel p takes texel p − origin of the patch textures. Used for CPU-computed edit rows.
 */
export function dustPatchFragmentShader(): string {
  return `${GLSL_PRECISION_HEADER}

// Generated by src/gpu/dust/glsl.ts — do not edit.

uniform isampler2D uPatchX;
uniform isampler2D uPatchD;
uniform int uOriginX;
uniform int uOriginY;

layout(location = 0) out ivec4 oX;
layout(location = 1) out ivec4 oD;

void main() {
  ivec2 q = ivec2(gl_FragCoord.xy) - ivec2(uOriginX, uOriginY);
  oX = texelFetch(uPatchX, q, 0);
  oD = texelFetch(uPatchD, q, 0);
}
`
}
