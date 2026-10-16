# Physics

This file covers the derivation, Q-formats and measured results for the integer reversible kernel (`src/physics/`). It refines [PLAN.md § Physics core](PLAN.md#physics-core-full-derivation-in-docsphysicsmd). Phase 0 covers the shared integer primitives, the potentials as pure functions, the integrator, spawn and the energy diagnostic. The grid, births, worker and checkpoints come in Phase 3.

| File | Contents |
|---|---|
| `fixed.ts` | Q-format constants, `rshr`, `mulshr`, `drift`, `isqrt`, and the quantisers for mass and temperature at the record boundary |
| `sinlut.ts` | The 4096-entry Q1.15 sine table: integer-only generation, pinned hash, `assertSinLut()`, `sinQ15`/`cosQ15` |
| `rng.ts` | `lowbias32`, `draw(seed, stream)`, `fnv1a32` (UTF-8), `fnv1aWords`, Irwin–Hall `normalQ16`, `uniformBelow` |
| `params.ts` | `PhysicsParams` (all integer fields), landscape generation, ramp LUT, decoders for the effective constants, `computeOmegaMaxDt` / `assertStable` |
| `potentials.ts` | Tether, landscape and pair-core impulses, and the impulse→kick conversion. All are pure functions that map line-for-line to GLSL. |
| `integrator.ts` | SoA particle system, `computeKicks`, `stepForward`/`stepBackward`, `flip`, O(N²) pair helpers, `stateHash` |
| `spawn.ts` | Past-Hypothesis spawn for nodes and the radial dust burst |
| `energy.ts` | The float64 energy diagnostic with synchronised velocity |
| `checked.ts` | An instrumented mirror of K: the same algorithm in exact float64, with every intermediate checked against i32 |

## Units and Q-formats

dt = 1/60 s is fixed, and time is an integer step. dt is folded into every integer coefficient, so changing dt means regenerating the params.

| Quantity | Storage | Format | Range | LSB / note |
|---|---|---|---|---|
| X, anchor A | i32 | Q.19 u | ±4096 u | 1.9e-6 u. All differences wrap, so the world is an 8192 u torus. |
| D (displacement per step) | i32 | Q.27 u/step | ±16 u/step (±960 u/s) | v = D·60/2²⁷ u/s |
| drift(D) | i32 | Q.19 | | `sgn(D)·((|D|+128) >> 8)` |
| u = (X − A) \| 0 | i32 | Q.19 | saturated at ±64 u (2²⁵) | Huber continuation beyond that |
| I = F·dt² (mass-weighted impulse) | i32 | Q.30 u/step·mass | ±2 | Sum of all force terms per particle |
| K (kick) | i32 | Q.27 | \|K\| ≤ 2³⁰ | K = rhe(I·(1/m) / 2¹⁶) |
| 1/m | i32 | Q.13 | [2048, 32768] | m ∈ [4, 0.25]. Dust uses m = 1 (8192). |
| τ, T | i32 | Q.15 | [0, 32768] | Nodes: τ = T = temperature. Dust: τ = T = 1. |
| Phase Φ | u32 | 2³² ≡ 2π | wraps | |
| Sine table | i16 ×4096 | Q1.15, amplitude 32767 | | Effective amplitude ρ = 32767/32768 |
| Tether coefficient k_q | i32 | k·2^(shift+11)/3600 | ≤ 2¹⁵ | Nodes: kXZ = 1 → 1165 (shift 11); **kY = 64 → 18641 (shift 9, saturation 16 u)**. Dust: 350 / 1748 (0.3 / 1.5, shift 11). |
| k_m = (kx, kz) | i32 | phase units per Q.19 LSB (1 unit = 2π/2¹³ rad/u) | \|k\| ∈ [819, 1911] | k_y = 0 |
| c_m | i32 | Q.16 | ±4.8 (Irwin–Hall ±6σ, σ = 0.8) | |
| C_m (force coefficient at τ = 1) | i32 | A·c·2π·2³³·dt² | ≤ 1.15e9 at A = 16 | |
| c_im = C_m·τ_i, s_m = c_im·sin Φ | i32 | as C_m | | Cached per particle in `lcoef` |
| Amplitude scale A | i32 | Q.8 | [0, 4096] (≤ 16×) | |
| Pair q = rhe(d / 2⁶) | i32 | Q.13 | \|q\| ≤ 24576 | |
| r² | i32 | Q.26 | < 1.82e9 | |
| s = r²/σ², 1 − s, (1 − s)², λ | i32 | Q.15 | [0, 32768] | |
| g = 6ε/σ²·dt²·2¹¹·(1 − s)²·λ | i32 | Q.10 | ≤ 19418 | |
| Pair impulse f | i32 | Q.30 | ≤ 8.54e6 per axis | |

Buffers are SoA `Int32Array`s with xyz interleaved per particle (stride 3): `x`, `d`, `anchor`, `imp`, `kick`. One particle is one RGBA32I texel on the GPU, with w free. Per-particle scalars are `invMass`, `tau` and `birth`. `lcoef` holds 8 values per particle.

## Integrator

The Levesque–Verlet bijection:

- **Forward** n→n+1: `D += K(X, n); X += drift(D)`.
- **Backward** n+1→n: `X −= drift(D); D −= K(X, n)`.

K depends only on X and n (n enters only through the ramp λ), and every addition wraps mod 2³². The map is therefore a bijection on all of (Z/2³²)^{6N}, whatever K returns. The tests run it on uniformly random full-range states.

**Loschmidt flip.** `F(X, D) = (X, −(D + K(X)))`.
- F∘F = id holds exactly, by wrapping arithmetic.
- F∘Φ∘F = Φ⁻¹ needs `drift(−D) = −drift(D)` for every D. That is why `drift(INT_MIN)` is defined as 0: it is the only value that is odd where −D = D.
- The identity also needs K to be n-independent, which holds in a birth-free world with every ramp saturated.

## Potentials

H = Σ|p|²/2m + Σ U_T(u_i) + Σ τ_i U_L(x_i) + Σ_{i<j} λ_ij(n) φ(r_ij).

**Tether** (per axis): `I = −mulshr(clamp(u, ±uSat), k_q, 11)` for X and Z. The node time axis Y uses its own shift and saturation, `I_y = −mulshr(clamp(u_y, ±uSatY), kY_q, 9)` with uSatY = 16 u (see **Stiff time tether** below). Dust uses shift 11 and 64 u on every axis, so the GPU kernel is unchanged.
- Inside |u| ≤ 64 u the potential is ½k u²; beyond it, the potential is k·uSat·(|u| − uSat/2). This is conservative and C¹.
- Saturations are counted in `sys.saturations`, the overflow sentinel of criterion B.
- It stays at 0 in every realistic test, because |u| ≲ 1 u.

**Landscape**: U_L = Σ_m c_m cos(k_m·x + φ_m), with 8 modes. Each mode uses four draws, streams 4m..4m+3 of the seed:
- |k| = 819 + ⌊u16·1093/2¹⁶⌋, i.e. (2π/6)·[0.6, 1.4].
- Direction ψ is a uniform u32 phase, giving `kx = rhe(|k|·cos ψ)` and `kz = rhe(|k|·sin ψ)`.
- φ_m is a uniform u32.
- c_m = 0.8·N(0, 1) by Irwin–Hall.
- Then `C_m = mulshr(mulshr(c_m, 29282, 7), A, 8)`, where 29282 = 2π·2¹⁷/3600 in Q.7.

The landscape is generated integer-only and pinned in tests: seed 0x5eed hashes to 0x2a41d855.

At runtime, for each mode:
- `Φ = kx·X + kz·Z + φ` in wrapping u32.
- `s = mulshr(c_im, sinQ15(Φ), 15)`.
- `I += (mulshr(s, kx, 16), 0, mulshr(s, kz, 16))`.

Each mode's force is a scalar function of its own phase times k_m. The force is therefore curl-free apart from the final per-component rounding (≤ ½ LSB of Q.30).

**Pair core** (nodes only), for the wrapped separation d = X_i − X_j:
1. Per-axis early-out at |d| ≥ σ.
2. `q = rshr(d, 6)` and `r² = Σq²`.
3. `s = mulshr(r², 3641, 26)`; skip when s ≥ 1.
4. `g = rshr(rshr(19418·rshr(w², 15), 15)·λ, 15)`, where w = 1 − s.
5. `f = mulshr(d, g, 10)`.

This is φ = ε(1 − s)³ with F = 6ε/σ²·(1 − s)²·d: no sqrt and no division. Round-half-even is odd-symmetric, so `f(−d) = −f(d)` exactly. The O(N²) helper adds f to i and −f to j. Per node, the impulse is summed in i32 and divided by the node's own mass once (see Deviations). The result is bit-identical under any pair order or orientation (tested), and Σ_i f = 0 exactly.

**Ramp**: `λ(a) = smoothstep(a/120)` is an exact-integer Q.15 LUT of 121 entries (λ[60] = 16384) and is 1 beyond. The age is `n − max(n_i, n_j)`.

## Rounding rules

| Where | Rule |
|---|---|
| Every right shift in K, spawn and param generation | Round half to even (`rshr`, `mulshr`): floor-based, exact for negatives, odd-symmetric. The round-up bit is computed without a branch, as the sign of `half − r − (f & 1)`. |
| drift | Round half away from zero, `sgn·((|D|+128) >> 8)`. Odd by construction; `drift(INT_MIN) = 0`. |
| LUT fraction | The low 4 phase bits are truncated (2⁻²⁸ of a turn). |
| Build-time constants | Round half up of exact integer rationals (`roundDiv`, numerators < 2⁵³). |
| Record boundary | `invMassFromMass(m) = round(8192/m)` and `tauFromUnit(t) = round(32768·t)` use only IEEE basic operations and `Math.round`, which are correctly rounded in every engine. |

## Overflow bounds (every product < 2³¹)

`mulshr(a, b, s)` is the workhorse. It accepts any i32 a, |b| ≤ 2¹⁵, and s ∈ [1, 30].
- Split a = ah·2¹⁶ + al.
- |ah·b| ≤ 2¹⁵·2¹⁵ = 2³⁰.
- 0 ≤ al < 2¹⁶, so |al·b| ≤ (2¹⁶−1)·2¹⁵ < 2³¹.
- hi = ah·b + (al·b >> 16) ≤ 2³⁰ + 2¹⁵.
- For s ≥ 16 the remainder is < 2^s ≤ 2³⁰, and the result |ab|/2^s < 2³⁰ always fits.
- For s < 16 the result is `(hi << (16−s)) + rshr(ql, s)`. It is exact whenever the true result fits; every call site below proves it does.

| Operation | Bound |
|---|---|
| `rshr(x, s)` | f + 1 ≤ 2³⁰ |
| `drift` | \|D\| taken as u32, + 128 ≤ 2³¹ + 128 < 2³² |
| Tether `mulshr(us, k, 11)` (X, Z; dust Y) | 2²⁵·2¹⁵/2¹¹ = 2²⁹ |
| Node time tether `mulshr(us_y, kY, 9)` | uSatY·k/2⁹ = 2²³·18641/2⁹ = 3.05e8 ≤ 2²⁹ (`assertTetherBounds` checks every population at load) |
| Phase `kx·X + kz·Z + φ` | Wraps by design (mod 2³² ≡ mod 2π) |
| LUT `(b − a)·frac` | \|b − a\| ≤ 51, frac < 2¹⁶, product < 2²² |
| Landscape `c·τ`, `c·sin` | `mulshr` with b = τ ≤ 2¹⁵ or b = sin ≤ 32767. The result is ≤ \|C\| ≤ 4.8·A·228.76·2¹⁶ ≤ 1.15e9 (A ≤ 16) |
| Landscape Σ_m `mulshr(s, k, 16)` | Each ≤ 1.15e9·1911/2¹⁶ + 1 = 3.36e7; × 8 = 2.69e8 at A = 16 (1.68e7 at A = 1) |
| Pair q², r² | \|q\| ≤ 24576, so q² ≤ 6.04e8 and r² ≤ 1.81e9 |
| Pair s, w², P·w², g·λ | s < 2¹⁷; w ≤ 2¹⁵ so w² ≤ 2³⁰; 19418·2¹⁵ < 2³⁰ |
| Pair f = `mulshr(d, g, 10)` | 3·2¹⁹·19418·max x(1−x²)² / 2¹⁰ = 8.54e6 |
| Per-node Σ I | Tether ≤ 5.37e8 (any k ≤ 2¹⁵) plus landscape ≤ 2.69e8 leaves room for **157** worst-case pair neighbours at A = 16 (213 at A = 1). Beyond that the sum wraps: still reversible and order-independent, but wrong. At runtime an exact float64 shadow of Σ I (nodes only, never fed into K) counts wraps in `sys.impulseWraps`; criterion B uses `overflowSentinel(sys)` = tether saturations + impulse wraps (`tests/physics/sentinel.test.ts`). |
| Kick `mulshr(I, 1/m, 16)` | 2³¹·2¹⁵/2¹⁶ = 2³⁰ for every i32 I |
| `D += K`, `X += drift` | Wrap by design (bijection on the torus) |
| Spawn | T·(1/m) ≤ 2³⁰; isqrt ≤ 2¹⁵; ×27962 < 2³⁰; ρ·cos ≤ 2³⁰ |
| Param generation | \|k\|·cos < 2²⁶; c·29282 and C·A go through `mulshr` (b ≤ 2¹⁵) |

`checked.ts` evaluates the same algorithm in exact float64 (every intermediate is an integer < 2⁵³). It checks every value the i32 kernel holds, including the `mulshr` partial products. Intentional wraps are reduced mod 2³² explicitly. The overflow sweep (`tests/physics/overflow.test.ts`) runs it bit-for-bit against the fast kernel on:
- every i32 tether offset class, including ±uSat±1 and INT_MIN/INT_MAX, for every coefficient up to 2¹⁵;
- every LUT index × fraction extreme;
- full-range landscape positions at A = 16 with every mode at the 6σ amplitude and |k| = 1911, for τ ∈ {0, 1, 32767, 32768};
- pair separations 0..σ (r = 0, axes, diagonals, random), at every ramp age;
- every i32 impulse × the mass extremes;
- whole-particle K in realistic and compressed worlds.

## Sine LUT

The table is generated integer-only:
- π comes from Machin's formula in BigInt at 2⁻¹²⁰.
- sin(πi/2048) comes from its Taylor series for the quarter wave i ∈ [0, 1024], rounded half-even to 32767·sin.
- The table is mirrored to exact `T[2048−i] = T[i]` and `T[−i] = −T[i]`.

BigInt is exact, so the table is bit-identical in V8 and JavaScriptCore.
- Its fnv1a32 over little-endian int16 bytes is **0xee115a3a**. It is pinned in `SIN_LUT_FNV1A` and checked at runtime by `assertSinLut()`; call that at worker start.
- A Math.sin build would agree as well: every entry is within 0.5 of 32767·sin, and no entry is closer than 1.4e-4 to a rounding tie.
- Lookup: index = Φ >>> 20, frac = (Φ >>> 4) & 0xFFFF, `a + rshr((b − a)·frac, 16)`. The measured maximum error is 0.992 LSB against 32767·sin (≤ 1 is asserted).
- cos(Φ) = sin(Φ + 2³⁰).

GPU upload: WebGL2 only guarantees MAX_TEXTURE_SIZE ≥ 2048. Upload the table as a **64×64** R16I (or R32I) texture and read it with `texelFetch(lut, ivec2(i & 63, i >> 6), 0).r`.

## PRNG

- `lowbias32(x)`: `x ^= x>>16; x *= 0x7feb352d; x ^= x>>15; x *= 0x846ca68b; x ^= x>>16` on u32. It is a bijection.
- `draw(seed, k) = lowbias32(lowbias32(seed) + (k+1)·0x9E3779B9)`: stateless and counter-based.
- `fnv1a32(id)` hashes the UTF-8 bytes of the id string. It is the per-node spawn seed.
- `normalQ16(h)`: Irwin–Hall, 12 u16 uniforms from a 6-step lowbias32 chain, minus 393210. Variance (2¹⁶)² − 1, hard-bounded at ±6σ.
- `uniformBelow(h, n) = (h>>>16)·n >>> 16`, for n ≤ 2¹⁵.
- `isqrt` uses digit-by-digit square root with a fixed 16 iterations on u32.

## Spawn (Past-Hypothesis macrostate)

The length scale is **l = 1 u**: the thermal tether length √(T_max/kXZ) for nodes (T_max = 1, kXZ = 1).

**Nodes** (`spawnNodeState`):
- **Offset**: u_a = ±(1 + uniformBelow(h, 15134)) LSB on each axis. That is uniform in ±0.05·l/√3, so |u| ≤ 0.05·l, and it is never 0.
- **Direction**: ê is uniform on the sphere (Archimedes). e_y is uniform in [−1, 1), ρ = isqrt(2³⁰ − e_y²), and (ρ cos ψ, ρ sin ψ) comes from the sine LUT.
- **Speed**: D0 = `rshr(isqrt(T·(1/m))·27962, 8)`, which is 0.8·√(T/m)·dt in Q.27.
- **Velocity**: D = D0·ê plus a per-axis relative noise in [−1/32, 1/32).

**Dust** (`spawnDustState`, radial burst):
- u = 0.01·l·ê, plus a nonzero 1..64 LSB push away from the anchor on every axis.
- D = D0(T = 1, m = 1)·ê plus the same relative noise. That is 0.8 u/s outward.

## Stability

`computeOmegaMaxDt` bounds ω_max·dt from above, with ω_i² = k_max/m_i + τ_i·Σ_m |c_m||k_m|²/m_i + 6ε/σ²·(1/m_i + 1/m_min).
- The last term covers one pair core at its steepest, since |φ''| ≤ 6ε/σ² on s ∈ [0, 1].
- `assertStable` throws at ≥ 0.5.
- Realistic node worlds give 0.31–0.32.
- The worst node (m = 0.25, τ = 1) gives 0.32 at A = 1, 0.37 at A = 4 and 0.42 at A = 8. A = 16 is rejected.

## Energy (diagnostic, float64)

E_n = Σ ½ m v_n² + Σ U_T + Σ τ_i U_L + Σ λ φ, using the synchronised velocity **v_n = (D_n + K_n/2)·60/2²⁷** u/s. Every constant is decoded from the integer params that K actually uses:

| Constant | Decoded value |
|---|---|
| m | 2¹³/(1/m)_q |
| k | k_q·3600/2²². Nodes: 0.99993 and 15.9997. Dust: 0.30041 and 1.50032. |
| τ_i·c_m | c_im·ρ·3600/(2π·2³³) |
| σ² | 2¹⁵/3641, so σ = 2.99995 |
| ε | 19418·σ²·3600/(6·2²¹) = 49.998 |
| Tether beyond uSat | Huber energy |

## JS → GLSL ES 3.00 mapping

**Required precision header.** three.js prepends no precision statements to a `RawShaderMaterial`, and GLSL ES 3.00 §4.5.4 predeclares `precision mediump int;` in fragment shaders. mediump ints are only guaranteed on (−2¹⁵, 2¹⁵), and the wrap guarantee covers highp only. `isampler2D`/`usampler2D` have no default precision. Every kernel shader (vertex and fragment) must therefore begin, after `#version 300 es`, with:

```glsl
precision highp float;
precision highp int;
precision highp isampler2D;
precision highp usampler2D;
```

GPU dust init asserts that `gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_INT)` reports `rangeMin ≥ 31` and `rangeMax ≥ 30`. If it doesn't, GPU dust is refused and the CPU runs it instead.

| TS | GLSL ES 3.00 | Note |
|---|---|---|
| (header) | `precision highp int;` etc. as above | Without it, fragment ints may be 16-bit |
| `(a + b) \| 0`, `(a - b) \| 0` where proven in range | `a + b` (int) | |
| Intentionally wrapping sums (`X += drift`, `D += K`, torus differences, `Φ`) | `int(uint(a) + uint(b))` | uint wrap is well defined; prefer it for every wrapping op |
| `Math.imul(a, b)` with \|ab\| < 2³¹ | `a * b` (int) | |
| `Math.imul(kx, X)` (phase) | `uint(kx) * uint(X)` | Low 32 bits |
| `a >> s` | `a >> s` on int | Arithmetic (sign-extending) per spec §5.9 |
| `a >>> s` | `uint(a) >> s` | Logical |
| `& \| ^ ~` | same | |
| `(half - r - (f & 1)) >>> 31` | `int(uint(half - r - (f & 1)) >> 31u)` | Branchless round-up |
| `c ? x : y` on ints | `c ? x : y` | |
| `SIN_LUT` (Int16Array) | 64×64 R16I `isampler2D` + `texelFetch` | |
| `PhysicsParams` fields | `uniform int` / `int[8]` arrays or `#define` | All integer |
| `lowbias32`, `draw` | uint arithmetic | Identical constants |
| `isqrt` | `for (int k = 0; k < 16; k++)` on uint | No data-dependent loop bound |

There are no 64-bit ops, no `imulExtended`, and no division of negatives anywhere in K, drift, spawn, the PRNG or the LUT. The only divisions are build-time `roundDiv` of positive integers.

## Measured performance

Measured on Node 26.5 on an Apple M5 Pro, single thread, steady state, using `stepForward` with no allocation per step:

| World | ms/step | Particle-steps/s |
|---|---|---|
| N = 1000 dust (tether + 8-mode landscape, no pairs) | 0.092 | **10.9 M** |
| N = 1000 nodes, pairs off | 0.092 | **10.9 M** |
| N = 1000 nodes, O(N²) brute-force pairs on | 1.45 | **0.69 M** |

The O(N²) helper performs 5e5 pair tests per step and is a reference only; the uniform grid comes in Phase 3. Branchless round-half-even was a 2.8× speed-up over the branchy version: data-dependent rounding branches mispredict about half the time.

The test folder `tests/physics` runs in ≈ 2.6 s wall time. Its 40 tests are listed below.

## Test coverage (`tests/physics/`)

- **`fixed`**: `rshr` and `mulshr` against an exact BigInt reference (random, exact ties for every shift, negatives, INT_MIN/INT_MAX); `drift` is odd on Z/2³²; `isqrt`; fnv1a vectors and UTF-8; pinned lowbias32 outputs; normal moments.
- **`sinlut`**: pinned hash, entry accuracy and tie margin, symmetry, interpolation ≤ 1 LSB, cos.
- **`params`**: coefficients, pinned landscape hash (seed 0x5eed: 0x2a41d855; A = 16: 0x7fe6d224), the |k| and c distributions, the ramp LUT, the stability gate.
- **`reversibility`**: inverse∘forward = id on full-range random i32 X, D and anchors, for 1, 10 and 100 steps, with pairs and ramps active. R1-lite: N = 100, n ∈ {1, 600, 6000}, with newborn ramps. Dust. Loschmidt: F∘F = id, F∘Φ∘F = Φ⁻¹, and forward 600 → flip → forward 600 → flip returns the identical hash.
- **`overflow`**: the sweep described above.
- **`forces`**: integer impulse against float64 −∇U of the decoded potential, per component, with stated bounds:
  - tether ≤ ½;
  - landscape Σ_m[(|c_im|/2¹⁵ + ½)·|k_m|/2¹⁶ + ½];
  - pair |d_a|·6.63/2¹⁰ + ½ per pair (Δs ≤ 4.5 LSB from the Q.13 pre-shift);
  - the kick inherits the bound scaled by (1/m)/2¹⁶, plus ½;
  - the worst error is < 3e-4 of the largest force in a compressed world.

  Also in `forces`: pair-order and orientation independence (bit-identical), and exact cancellation of pair impulses.
- **`energy`**: E-lite. Two seeds, N = 100 nodes in 50×50×36 u (3 years), pairs on, birth-free, 6000 steps: |E_n − E_0|/⟨KE⟩ ≤ 2e-3 (measured 1.9e-4 to 5.5e-4), and the fitted secular slope over the run is ≤ 2e-4 of ⟨KE⟩. Dust conserves energy too.
- **`spawn`**: |u| ≤ 0.05·l, never 0; v0 = 0.8√(T/m) within the noise; ê is unit and isotropic; dust bursts outward.

## Deviations from PLAN.md

1. **Per-node mass quantisation.** Pair impulses f_ij are summed in i32 together with the field impulses, then divided by each node's own mass once (`K = rhe(ΣI·(1/m)/2¹⁶)`). The plan quantised each pair's ΔD separately. Integer addition is associative and commutative, so the result is still exactly independent of pair order. This gives one rounding per node instead of deg(i).
2. **Torus semantics.** X − A, X_i − X_j and Φ all wrap mod 2³², so H is periodic with period 8192 u. K is then well defined for every i32 input, which the full-range bijection tests need. This is physically irrelevant, since |u| ≤ 12 u.
3. **Tether saturation** at |u| = 64 u, with a Huber continuation that stays conservative. The saturation count is the criterion-B overflow sentinel.
4. **drift(INT_MIN) := 0**, so drift is odd on all of Z/2³².
5. **Sine amplitude 32767**, because int16 cannot hold 32768. The effective landscape amplitude carries ρ = 32767/32768, and the energy diagnostic uses it.
6. **Effective constants are the rounded integers**: kY = 63.9993, σ = 2.99995, ε = 49.998, and so on. dt is folded into the coefficients.
7. **Landscape amplitude scale** A is Q.8 and capped at 16× for overflow; the stability gate rejects A = 16 for a τ = 1, m = 0.25 node. The lab can use up to about 8×.
8. **Loschmidt identities** are exact only when K is n-independent, i.e. birth-free with every ramp saturated, as in the lab world.
9. **Dust** is one population with m = 1, τ = 1, T = 1. The anchor/birth texture has no room for per-particle mass or temperature.
10. **The sine LUT texture is 64×64**, not 4096×1, because of the WebGL2 minimum MAX_TEXTURE_SIZE.
11. **Spawn**: l = 1 u; uniform per-axis offsets; ±1/32 relative velocity noise.
12. **E-lite world density.** A world spawned with heavy core overlap shows a bounded O((ωdt)²) leapfrog offset of 2.4–3.2e-3 of ⟨KE⟩ during its first ~15 steps of explosive decompression, with no slope. An example is 100 nodes in a 30×30×12 u box, which starts with pair energy ≈ 300 against KE ≈ 16. The E test therefore uses a realistic 3-year layout. Lab worlds should not spawn nodes deep inside each other's cores.

## Stiff time tether (kY = 64, criterion B)

The first full acceptance run (2026-10-15) failed criterion B on one count: max|u_y| = 1.023 u, against a limit of 0.5 u. 1 243 of 10 000 nodes went past 0.5 u at some point. PLAN's "|u_y| ≲ 0.25 u" accounted only for the tether-driven oscillation (spawn speed v0 against kY = 16 gives ≲ 0.2 u). The excess came from the **pair core**. When XZ-wandering nodes come within σ, the steepest core force 6ε·max[t(1−t²)²]/σ ≈ 28.6 pushes along every axis, and against kY = 16 that is ≈ 1.8 u statically.

**Decision (user, 2026-10-15): raise the node time tether to kY = 64.** The static push drops 4× to ≈ 0.45 u, and the tether-only oscillation halves (ω_y = √(kY/m)). The integer path stays overflow-free. kY = 64 needs the coefficient 74 565 > 2¹⁵ at shift 11, so Y uses shift 9 (coefficient 18 641, exactly the old kY = 16 integer) and saturates at uSatY = 16 u. That keeps |I_y| ≤ 3.05e8 < 2²⁹; the Huber continuation beyond 16 u stays conservative, and those saturations count in the sentinel. Stability: ω_y·dt = √(64/0.25)/60 ≈ 0.27 at the lightest mass. The load-time gate still holds with pair and landscape curvature (realistic worlds ≈ 0.38 < 0.5). Dust keeps kY = 1.5, so the GPU kernel stays bit-identical. `PHYSICS_VERSION` is 2, so caches keyed on version 1 are never read again.

## Measured growth rate

How fast does S(t) climb from the Past-Hypothesis start to its plateau in the lab world? The lab world is `LAB_CONFIG` in `src/lab/demos/labSim.ts`, the same `buildLab()` world criterion S uses: N = 1000, birth-free, landscape 6× AMP_ONE, a 40 × 36 × 40 u box, PHYSICS_VERSION 2 (kY = 64).

**Method.** S is sampled at every step (1/60 s) for 60 s, which gives 3601 samples. The model S(t) = S_plat − (S_plat − S₀)·e^{−t/τ} is fitted by least squares (`fitGrowth` in `src/lab/demos/growthFit.ts`). For a fixed τ the model is linear in (S_plat, S₀), so those two come in closed form. τ comes from a log-spaced scan followed by golden-section refinement. t50 and t95 are model-free: the first time (S − S₀)/(S_plat − S₀) reaches 0.5 or 0.95, with S_plat the mean over the second half of the run (as in criterion S). Three world seeds were measured on Node 26.5 on an Apple M5 Pro, at 12.8 s per run.

| Seed | τ (60 s fit) | τ (first 10 s) | t50 | t95 | S₀ | S_plat (2nd half) | R² |
|---|---|---|---|---|---|---|---|
| 7 | 0.761 s | 0.778 s | 0.52 s | 1.93 s | −10.90 | −2.02 ± 0.06 | 0.987 |
| 8 | 0.755 s | 0.781 s | 0.50 s | 1.90 s | −10.93 | −2.08 ± 0.06 | 0.984 |
| 9 | 0.740 s | 0.769 s | 0.53 s | 2.08 s | −10.91 | −2.10 ± 0.07 | 0.981 |

**Result: τ = 0.75 ± 0.01 s, a growth rate of 1.33 s⁻¹ (80 steps).** S closes half the gap in about 0.5 s and 95 % of it by about 2 s, ten times inside criterion S's 20 s.

**Shape.** The curve is not a single exponential (R² ≈ 0.98). The first ~0.3 s is a fast ballistic rise: positions start inside |u| ≤ 0.05 l, so the spread, and with it log-volume, grows linearly in t. A shoulder near 1–1.5 s follows before the plateau. τ is of the order of the time-tether period 2π√(m/kY) = 0.79 s at m = 1, well below the XZ tether period of 2π s. The single-exponential fit cannot separate the mechanisms, though: tether phase mixing, landscape chaos and pair collisions all contribute.

**Plateau.** The plateau sits near −2 nats, below 0, because the nodes are colder than T_REF and the landscape and pair cores keep p ≠ N(0, I). Over the next five minutes it drifts down by ≈ 0.1–0.15 nats: −2.13 ± 0.05 averaged over 150–300 s in the acceptance run. This is slow relaxation into the landscape wells.

**Reproducing it.** The #/lab "growth rate" panel runs the same fit in the lab worker, over 30 s with S every 2 steps (`GROWTH_DEFAULTS`). The arrow-of-time panel fits its own 300 s forward branch. It runs `arrowOfTime()` at kernel step 0 throughout (K is n-independent in the birth-free world), and it reproduces the acceptance-tier numbers bit for bit: S_fwd −2.2068, S_ret −2.2115, a ratio of 0.9995, 998 of 1000 particles not home, the control returning hash 0x5a5b8348, and τ = 0.74 s on that branch. On Node it takes 22 s.

## Overlays (O: dissipative, reproducible from the log)
O is a pure function of (records, interaction log, wall-clock t). P never reads it. `overlayHook.applyOverlays` adds O's bounded offsets to the pose table after the writer, and keeps the P positions itself, so repeated calls on an unchanged table do not stack offsets.

| Quantity | Definition | Constants (`HEBB`, `DEMON`, `KEPLER`) |
|---|---|---|
| Trace | E ← E·e^{−Δt/T_E} + A_k at each event; the post-event value is stored | T_E = 7 d; A_k: dwell 0.5, inspect 1, enter 2, demon-match 0.25 |
| Neglect | n = 1 − e^{−(t − t_ref)/T_N}, where t_ref is the last event (or creation) | T_N = 30 d |
| Elevation | Y_h = clamp(Y_max·tanh(E/E_r) − Y_sink·n, ±Y_max) | Y_max = 2.5 u, Y_sink = 0.8 u, E_r = 4 |
| Mist | m = n·(1 − tanh(E/E_r)) | veil drawn when m ≥ 0.08 |
| Citadel | h = 6 u·tanh(E/4), drawn under the node | — |
| Synapse | each event pairs with every other node's strongest event in the last 30 min, c = √(A·A′): w ← w_max − (w_max − w·e^{−Δt/T_w})e^{−ηc} | T_w = 90 d, η = 0.35, w_max = 1, prune 0.02, degree ≤ 24 |
| Demon slot | r = x + w(t)(s − x) in XZ; w = smoothstep((t − t_act)/2 s) | lattice pitch 4 u, square rings |
| Bits | each matched node's event stores log2(C/M); an activation records M·log2(C/M) ≤ log2 binom(C, M) | — |
| Landauer debt | unpaid: Σbits·kT_eff·ln 2, with kT_eff = mean node temperature (world energy units: thermal speed √(T/m)) | SI scale at 300 K: k_B·300 K·ln 2 ≈ 2.87 zJ per bit |
| Kepler | circular orbits of radius a = 2.4 + 0.7k u, period T = 20 s·(a/2.4)^{3/2} | inclination ≤ 0.35 rad |

**Determinism.** The fold runs in (t, id) order. The incremental update (new events since last.t − 60 s, de-duplicated by id) and the full recompute run the same arithmetic in the same order, so they agree exactly (`tests/overlay/hebbian.test.ts`). An event that arrives out of order triggers a full recompute. Pruning and the degree cap act only at update time, and reads filter by w(t) ≥ 0.02, so the folded state depends on the log alone.
