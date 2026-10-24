# Decisions

Deviations from the original spec and from [PLAN.md](PLAN.md), with reasons. Each phase gate appends its acceptance results and any stretch-goal cuts.

## Stack (2026-10-13, verified with `npm view` at scaffold time)
| Package | Version | Note |
|---|---|---|
| vite | 8.3.4 | |
| @vitejs/plugin-react | 6.1.2 | |
| react / react-dom | 19.3.0 | fiber 9.8.1 requires react <19.4 |
| typescript | **6.0.3** | Plan said "current stable" (7.0.2, the native port). typescript-eslint 8.71.2 requires TS <6.1, so 6.0.x is pinned. |
| tailwindcss / @tailwindcss/vite | 4.3.3 | |
| three | 0.186.1 | postprocessing 6.39.5 requires <0.187 |
| @types/three | 0.186.0 | latest 0.186.x |
| @react-three/fiber | 9.8.1 | |
| @react-three/drei | 10.7.9 | pulls stats-gl with a nested three 0.170 — never import `StatsGl` |
| @react-three/postprocessing / postprocessing | 3.2.0 / 6.39.5 | |
| @sparkjsdev/spark | 2.3.1 | WebGL2 only |
| zustand / maath | 5.0.15 / 0.10.8 | |
| idb / fflate | 8.0.4 / 0.8.3 | fflate is also Spark's dependency |
| vitest / jsdom / fake-indexeddb | 5.0.4 / 30.1.2 / 6.2.5 | |
| eslint / typescript-eslint / react-hooks | 10.12.0 / 8.71.2 / 7.1.1 | |
| leva | 0.10.1 | dev only |
| @fontsource/inter, @fontsource/jetbrains-mono | 5.3.0 | self-hosted woff for troika labels |

## Spec deviations
| Spec | Replacement | Reason |
|---|---|---|
| @mkkellogg/gaussian-splats-3d | Spark 2.3.1 | Unmaintained (its README points to Spark); no LoD |
| MeshPortalMaterial portals | Clipped splat dioramas under one SparkRenderer | One SparkRenderer per portal would multiply the cost |
| Transmission glass | Ordered alpha/fresnel shells plus depth proxies | three's transmission pass excludes transparent splats |
| f32 curl-noise "Hamiltonian" WGSL | Integer leapfrog over a real H, integer-only K | Curl force heats without bound; f32 reversal error ≈ 150 u; float K differs between CPU and GPU |
| `hash()` vector potential | XZ Fourier landscape with sine LUT | The hash is white noise, discontinuous every 0.03 u |
| Hebbian y-drift inside the integrator | Event-log overlay (signed elevation, citadels) | It breaks the inverse (227 u error) and has no decay |
| WebGPU compute | WebGL2 integer GPGPU + CPU worker | Spark is WebGL2 only |
| Next.js | Vite SPA | The static and Tauri targets strip Next's server features |
| Persisted pos/vel columns | Derived from (records, step) | Determinism |
| "Descend to base plane" when unvisited | Small sink, per-node mist, desaturation | Y is reserved for time |
| FLOAT[1536] | float[512] (Phase 4) | A Matryoshka size every candidate embedding model supports |
| Quality rung 3 "DOF only during fly-in" | `dofOnlyFlyIn` turns post DOF off everywhere; orbit DOF focuses on the orbit target | PLAN also turns DOF off during `entering` (splats write no depth), so the two rules only agree on "no DOF" |

## Data layer (2026-10-14)
| Plan / spec | Replacement | Reason |
|---|---|---|
| Streaming import with fflate `Unzip` | Read the zip central directory; assets go to the store as zero-copy `file.slice()`s; deflated entries (OS re-zips) go through fflate `Inflate` | fflate's `Zip` writes data descriptors, and `Unzip` finds the end of such an entry by scanning for a PK signature. A 100 MB splat contains one about 7 % of the time, which would silently truncate it |
| Manifest first in the archive | `manifest.json` and `assets.json` written last | Asset bytes are fetched one at a time (the IndexedDB blob fallback materialises each in memory), so a missing blob is only known mid-export; readers use the central directory |
| Pre-import backup in OPFS | OPFS, else a separate IndexedDB database `hyperspace-backups` | Safari without `createWritable` cannot write OPFS from the main thread; import must still always back up first |
| Links to trashed nodes are errors | Errors by default; the repo validates with `trashedLinkTargets: 'warn'` | An undo-able delete of B must not block editing A |
| Tag change re-places the node; sector = hash of tags | Only a primary (first) tag change re-places; sector from the primary tag | Secondary tags land in the same sector, and re-placing would undo a drag |
| Slugs | ASCII kebab-case; non-Latin titles become `node`, `node-2`, … | Stable, URL-safe ids; titles keep the original script |
| `persist()` on load | Not on Firefox by default (it prompts); request from a user gesture there | Firefox shows a permission prompt |
| `updateSettings` | Refuses a `yPerYear` change that would bring anchors closer than σ; T0 changes go through `relayoutWorld` | Rescaling Y is not spacing-preserving, unlike a T0 shift |

## Phase log
<!-- Each phase gate appends: date, acceptance results (npm run test:accept), bench numbers, cuts. -->

### Phase 0 — integer kernel (2026-10-14)
Kernel in `src/physics/` (fixed, sinlut, rng, params, potentials, integrator, spawn, energy, checked); derivations in [PHYSICS.md](PHYSICS.md). `tests/physics` (40 tests, ≈ 2.6 s) pass: full-range bijection, R1-lite (N = 100, n ∈ {1, 600, 6000}), Loschmidt, overflow sweep against a checked mirror, force accuracy, pair-order independence, E-lite (|ΔE|/⟨KE⟩ ≤ 5.5e-4, no slope).

**Bench** (Node 26.5, Apple M5 Pro, single thread):

| World | Particle-steps/s |
|---|---|
| N = 1000 dust | 10.9 M |
| N = 1000 nodes, pairs off | 10.9 M |
| N = 1000 nodes, O(N²) pairs | 0.69 M (reference only; the grid comes in Phase 3) |

**Deviations from PLAN.md:**

| PLAN | Kernel | Reason |
|---|---|---|
| Quantise each pair's ΔD by mass | Sum the pair and field impulses (Q.30) in i32, then make one rhe division per node by its own mass | Still exactly order-independent (integer addition), with one rounding instead of deg(i) |
| (unspecified) | Every difference (X − A, X_i − X_j, phase) wraps mod 2³²: an 8192 u torus | K is defined for every i32 input; the full-range bijection holds |
| Harmonic tether | Huber continuation beyond \|u\| = 64 u; saturations counted as the B sentinel | Overflow-free by construction for all inputs, and still conservative |
| drift = sgn(D)·((\|D\|+128) >> 8) | Same, with drift(INT_MIN) := 0 | Keeps drift exactly odd, so F∘Φ∘F = Φ⁻¹ holds on all of Z/2³² |
| Q1.15 sine LUT | Amplitude 32767 (int16); BigInt-generated; hash 0xee115a3a; uploaded as a 64×64 texture | int16 limit; engine-independence; WebGL2 only guarantees MAX_TEXTURE_SIZE ≥ 2048 |
| k, ε, σ, c, m as reals | Rounded integer coefficients with dt folded in; the energy diagnostic decodes the effective values | Integer-only K |
| "stronger lab landscape" | Amplitude scale A in Q.8, capped at 16× for overflow; the stability gate allows ≈ 8× at τ = 1, m = 0.25 | Overflow and stability bounds |
| Loschmidt flip | Exact only with every ramp saturated (birth-free) | λ(n) makes K time-dependent |
| Dust with its own τ | Dust m = 1, τ = 1, T = 1 (global) | The anchor/birth texture has no per-particle mass or temperature |
| Spawn \|u\| ≲ 0.05 l | l = 1 u; uniform per-axis ±0.05 l/√3, never 0; ±1/32 relative speed noise | — |
| Rounding branches | Branchless round-half-even (sign-bit trick) | 2.8× throughput (branch mispredictions) |

### Phase 0 — S2 integer GPGPU (2026-10-15)
**Outcome: pass.** The real dust kernel (tether + 8-mode landscape, no pairs) runs on WebGL2 and is bit-identical to `src/physics/` in every int. Checked in the agent pane (Chrome): `gl.getParameter(RENDERER)` = `WebKit WebGL`, unmasked `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)`. Fragment `HIGH_INT` reports rangeMin 31 and rangeMax 30. The user check in Safari is still pending: open `#/lab` and confirm the panel says "bit-identical".

- **World**: realistic radial-burst spawns (`spawnDust`). Owners sit in 64-texel segments, with 2 at the torus seam (X − A and X wrap), about 1/8 anywhere on the ±4096 u torus, and the rest in ±64 u XZ × 40 years of Y. Landscape seed 0x5eed, A = 1×.
- **Schedule**: one single-step draw, then 99 + 4 × 100 steps forward (k steps per draw in the shader loop). The same draws then run backward. After every draw the GPU state is read back and compared with the TS snapshot at that step: 13 checkpoints, every one identical at n = 4096, 16384 and 131072.
- **Results**: identicalAfterForward = true, and identicalAfterBackward = true: 500 forward plus 500 back returns the uploaded state exactly.
- **Extra runs**, also identical: A = 8× at n = 16384, and 3000 + 3000 steps at A = 4×.
- **Pinned**: for n = 4096, the TS state hash is `e3cbe8f9` at step 0 and `12b4ca67` at step 500, in both the lab and `tests/physics/gpuDust.test.ts`.
- **Negative control**: in the pane, three one-line shader mutations were each caught at step 1 by thousands of mismatching ints. They were LUT interpolation truncated instead of rounded half-even, drift without its +128, and tether off. The comparison is therefore sensitive to a 1-LSB difference.

| n | Texture | GPU ms/step (timer query) | Wall ms/step (synced) | GPU particle-steps/s | TS ms/step (same page) |
|---|---|---|---|---|---|
| 4 096 | 64×64 | 0.0035 | 0.0041 | 1.2 G | 0.27 |
| 16 384 | 128×128 | 0.0040–0.0042 | 0.0063 | 4.0 G | 1.06–1.34 |
| 131 072 (full budget) | 512×256 | 0.0139 | 0.0177 | 9.5 G | 8.5 |

**Implementation** (`src/gpu/dust/`, lab at `src/lab/s2/`, `window.__s2()` in dev):
- **GLSL generation**: `glsl.ts` generates the shader from `PhysicsParams` and the exported Q-format and LUT constants. The landscape modes are unrolled with per-mode `const` literals, and c_im = `landscapeCoef(C_m, τ_dust)` is folded in because dust shares one τ. The remaining structural literals (the mulshr 2¹⁶ split, the 16-bit LUT fraction, the Q1.15 sine, the k shift of 16) live in one `DustKernelSpec`. A node test evaluates the kernel through that spec with GLSL integer semantics against `stepForward`/`stepBackward`, and an off-by-one in any spec field fails it.
- **Shader rules**: every shader starts with the required highp precision header. Every wrapping op is done in uint. `int(uint)` is relied on to preserve the bit pattern.
- **three objects**: two `WebGLRenderTarget({count: 2, type: IntType, format: RGBAIntegerFormat, internalFormat: 'RGBA32I', Nearest, depthBuffer: false})` targets, a GLSL3 `RawShaderMaterial` with `layout(location=0|1) out ivec4`, and DataTextures for the upload, the anchors (w = birth) and the sine LUT (64×64 R32I, `texelFetch`). three prepends `#version 300 es` to a GLSL3 RawShaderMaterial, so the generated source starts directly with the precision header.
- **Drawing and readback**: no raw WebGL calls were needed. Draws go through `renderer.render` with `autoClear` off, because `clear()` on an integer color buffer is INVALID_OPERATION; the previous render target and `autoClear` are restored afterwards. Readback uses `readRenderTargetPixels(…, textureIndex)` with RGBA_INTEGER/INT.
- **Init**: init asserts fragment `HIGH_INT` rangeMin ≥ 31 and rangeMax ≥ 30 (`DustGpuUnsupportedError` otherwise, so the CPU runs dust), runs `assertSinLut()`, and checks framebuffer completeness and the program diagnostics on the first draw.
- **Texel layout**: X = (xyz Q.19, flags), D = (xyz Q.27, 0), anchor = (xyz Q.19, birth). The w channels are carried through every step unchanged.
- **Not in S2**: dormant particles (regenerating the spawn when n < n_i) still need a GPU port of `spawnDustState` plus its own CPU≡GPU check, which is a Phase 3 task. Births are uploaded but not used yet.

### Phase 0 — S1 (agent, built-in pane) (2026-10-15)
**Outcome: the plan holds, with two deviations (proxy selection, SPZ v4) and one open item (primary browser, which needs the user's Safari and Chrome runs).** Spike at `#/lab/s1` (`src/lab/S1Spike.tsx`, helpers in `src/lab/s1/`), `window.__s1()` in dev.

- **Environment**: the agent pane is Chromium 152 (`Claude/2.37 Chrome/152`). `RENDERER` = `WebKit WebGL`, unmasked `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)`, 120 Hz. Canvas 560×711 CSS px at DPR 1.5 (840×1066). `EXT_disjoint_timer_query_webgl2` is available, so GPU time is measured per frame.
- **Scene**: one `SparkRenderer`, added to the scene as an object on `LAYER.SPLATS`. It holds:
  - four `lod: true` dioramas (lion 195k, tomatoes 445k, apartment 661k, hall 1.94M), each clipped by a `SplatEdit` (MULTIPLY) with one inverted `SplatEditSdf` BOX in native units, as a child of the mesh;
  - glass shells and depth proxies in the `RENDER_ORDER` bands;
  - a drei `MeshReflectorMaterial` floor (1024);
  - an `EffectComposer` (multisampling 0, HalfFloat) with threshold Bloom (1.0) and AgX;
  - 100k `THREE.Points` on `LAYER.DUST`;
  - a moving `lod: true` lion (#347);
  - a proxy tween stage.
  Default LoD budget 2.5M.
- **Method**: each run is the 20 s scripted orbit (radius 10–22 u, one revolution) after a 2 s warm-up. It records:
  - the rAF interval and main-thread time (first to last `useFrame`) in a ring buffer;
  - GPU time per frame from a timer query;
  - Spark sorts (`sorting` true→false: readback + worker sort + upload) and the `readPixels`/`getBufferSubData` call times on the GL context;
  - LoD traversals (`driveLodExclusive`);
  - `renderer.info` per frame (autoReset off).
  vsync is the mode of the intervals (8.33 ms).

| Run (orbit unless noted) | fps | rAF p50/p95/p99/max ms | GPU p50/p95/p99 ms | > 1.5× vsync | Sorts/s, latency p50/p95 ms | getBufferSubData p50/p95/max ms | Splats sorted |
|---|---|---|---|---|---|---|---|
| All on, first run after load | 99.4 | 8.4 / 27.2 / 41.9 / 67.1 | 13.0 / 28.6 / 41.5 | 18.6 % | 18, 47 / 103 | 12.4 / 38.9 / 66.1 | 1.36M |
| All on, repeat | 118.1 | 8.3 / 9.5 / 16.6 / 25.9 | 8.5 / 13.8 / 17.9 | 2.2 % | 56, 18 / 23 | 1.6 / 2.5 / 14.3 | 1.38M |
| Baseline (all five features off) | 116.6 | 8.3 / 15.8 / 27.6 / 35.6 | 6.9 / 14.3 / 19.0 | 8.2 % | 28, 34 / 73 | 4.3 / 22.8 / 33.9 | 1.47M |
| Baseline, repeat | 118.4 | 8.3 / 10.0 / 14.5 / 28.1 | 5.1 / 8.7 / 15.9 | 1.5 % | 56, 17 / 22 | 1.9 / 2.5 / 26.3 | 1.49M |
| + reflector only | 112.2 | 8.3 / 18.2 / 32.9 / 47.8 | 7.5 / 16.1 / 22.2 | 10.6 % | 23, 40 / 92 | 7.1 / 31.0 / 45.5 | 1.47M |
| + composer and bloom only | 115.1 | 8.3 / 12.1 / 28.7 / 60.6 | 9.8 / 17.3 / 23.1 | 4.8 % | 39, 18 / 67 | 1.9 / 21.5 / 55.3 | 1.47M |
| + 100k points only | 117.6 | 8.3 / 10.2 / 25.2 / 37.2 | 6.4 / 10.6 / 18.7 | 3.2 % | 47, 17 / 47 | 1.8 / 9.8 / 34.4 | 1.48M |
| + moving LoD only | 116.5 | 8.3 / 11.1 / 29.5 / 45.3 | 7.0 / 14.0 / 19.0 | 4.0 % | 43, 18 / 62 | 2.0 / 18.6 / 44.4 | 1.64M |
| + tween only | 119.9 | 8.3 / 9.6 / 10.7 / 24.1 | 6.1 / 11.6 / 15.3 | 0.4 % | 55, 18 / 26 | 1.7 / 2.7 / 15.7 | 1.35M |
| All on, `forceSinglePass` off | 115.8 | 8.3 / 14.1 / 31.0 / 66.3 | 15.6 / 26.1 / 34.0 | 6.0 % | 35, 23 / 55 | 2.0 / 20.6 / 64.1 | 1.38M |
| All on, dioramas as proxies (cut) | 119.9 | 8.3 / 8.9 / 9.3 / 16.4 | 5.8 / 11.6 / 13.2 | 0.08 % | 61, 11 / 15 | 0.9 / 1.1 / 1.4 | 0.65M |
| Static camera, moving LoD only | 119.9 | 8.3 / 9.2 / 9.9 / 17.1 | 5.4 / 7.9 / 8.5 | 0.08 % | 57, 18 / 21 | 1.5 / 1.7 / 2.6 | 1.26M |
| Static camera, tween only (non-LoD mover) | 119.1 | 8.3 / 9.3 / 10.7 / 31.4 | 4.4 / 7.0 / 8.6 | 0.3 % | 42, 15 / 19 | 1.5 / 1.7 / 27.6 | 1.20M |
| ✗ Leak control: splats on layer 0 (6 s) | 71.3 | 8.3 / 66.0 / 92.3 / 108 | 27.8 / 44.9 / 58.6 | 18.9 % | 9, 113 / 157 | — | 1.78M |

In every run, main-thread time inside the frame is 0.4–0.6 ms p50 and ≤ 1.0 ms p99, with no long tasks during runs. `renderer.info` all on: 56–58 calls, 2.73–2.77M triangles (2 per sorted splat), 100k points, 17 programs.

**Run-to-run variance is large.** The same configuration ranged from 2 % to 19 % slow frames. Slow frames track the GPU p50 and the `getBufferSubData` p95, not the main thread. Treat single runs as indicative, and compare toggles with back-to-back repeats.

**Findings:**
- **#407 (Chrome sort stutter on Apple Silicon)**: partially reproduced, and only under GPU load. Spark's sort readback (`readRenderTargetPixelsAsync` → `getBufferSubData` after the fence) runs in a task outside rAF.
  - Under load, that task blocks the main thread: p95 20–39 ms, max 66 ms. Missed frames follow (rAF p95 15–27 ms).
  - At steady state with about 1.4M splats it is usually 1.6–2 ms p50 and 2.5 ms p95.
  - At the planned proxy budget (0.65M) it never exceeds 1.4 ms, and the frame graph is flat.
  - **Primary browser not chosen yet.** It depends on the user's Safari and Chrome numbers (CHECKLISTS, Phase 0). The pane suggests the stall is GPU-queue-bound, so it may also appear in desktop Chrome on the same Mac.
- **#347 (moving LoD meshes)**: no frame-time stutter in the pane. With a static camera and only the lion moving, 0.08 % of frames are slow and Spark's display updates on 81 % of frames, against 65 % for a moving non-LoD proxy (which rests 1 s in 6). The LoD cut is the weak point: with the four big LoD dioramas live (2.5M budget), one traversal of the LoD worker takes 225–315 ms, so a moving LoD mesh's detail refreshes only about 4×/s. With only small LoD meshes it takes 8.6 ms (65/s). Visual popping on the moving lion needs a human eye; it is left to the user's runs.
- **Proxy scale tween**: no stutter. Tween frames (`s = 12^u` about the entry pose, `lodSplatScale` 1 → 0.5 while active) have rAF p95 9.4–9.6 ms and 0.4–1.7 % slow, against 5 % for non-tween frames in the same run. Lowering `lodSplatScale` lowers the GPU time, so the PLAN's fly-in step 1 stands; no dissolve-swap fallback is needed.
- **`forceSinglePass`**: it is meaningful. The material is `transparent` + `DoubleSide`, so without it three's `renderObject` draws Spark twice (BackSide, then FrontSide) and flips `material.needsUpdate` twice per frame. With it off:
  - triangles double (5.50M against 2.75M) and GPU p50 nearly doubles (15.6 against 8.5 ms);
  - 7 extra program variants appear (24 against 17);
  - the image is unchanged, because each screen-facing quad survives exactly one of the two culled passes.
  Keep `spark.material.forceSinglePass = true`.
- **Layer exclusion from the reflector**: it works.
  - Draw count: with the SparkRenderer and the SplatMeshes on `LAYER.SPLATS`, Spark's `onBeforeRender` runs once per frame for the main camera and 0 times for drei's reflector camera, in every run.
  - Visual: the floor reflects the brass frames and plinths only.
  - Negative control: put Spark on layer 0 too and the reflector draws the splats (they are visible in the floor). Because `info.render.frame` advances on every `gl.render`, Spark then re-generates and re-sorts for the mirrored camera on every frame. That drops sorting to 9/s with 113 ms latency, triples GPU time and costs about 40 % of the frame rate.
- **Depth-proxy band**: it works, with one catch: the proxy material must be `transparent: true`. three draws the entire opaque list before the transparent list whatever the `renderOrder`, so an opaque depth-only box would precede the splats.
  - In a linear-depth view of the composer's depth texture, the cubes read as solid volumes with proxies on and vanish with them off (splats write no depth).
  - Negative control: at `renderOrder` −3 (before the splats), splats of the back row seen through a front box disappear. At 100 they are visible.
- **Spark in the composer**: it renders correctly into the HalfFloat composer target. It takes `renderSize` from the target and sets `encodeLinear` because the target is linear. The splat colours are display-referred, so through AgX they come out slightly desaturated and darker than with direct rendering.
- **SPZ v4**: Spark 2.3.1 cannot read it. `getSplatFileType` returns `undefined` for a raw `NGSP` header, and forcing `fileType: SPZ` throws "Invalid gzip header".
  - The layout, measured on tomatoes.v4.spz:
    - a 32 B header: magic, version 4, N, shDegree, fractionalBits, flags, numStreams = 6, u32 tocOffset = 32;
    - a TOC of 6 × (u64 compressed, u64 uncompressed);
    - one zstd frame per stream, in v3's section order (positions 9N, alpha N, colour 3N, scale 3N, rotation 4N, SH 45N).
  - `src/lab/s1/spzV4.ts` repacks it: three's `zstddec`, a v3 header, then gzip. It takes 735–982 ms for 445k splats at SH3 (29 MB raw), and Spark loads the result with SH intact.
- **Decimation quality** (≤ 100k proxies, built from the live LoD tree in about 20 ms, plus `writeSpz` v3 and re-parse in about 90 ms; about 1.5 MB per proxy):
  - `getLodTreeLevel(mesh, L)` is **not** a complete cut. Levels are overlapping BFS-depth bands: counts rise, then fall (lion: 1, 8, … 92 889 at L20, 85 483 at L21, … 12 at L29), and they sum to about 3× the node count. Large leaves drop out of deeper levels.
  - The budget-driven cut is a complete cut. It calls the LoD worker's `traverseLodTrees` with `maxSplats` = 100k, seen from 1000 diagonals away with foveation off.
  - Centre-occupancy coverage, measured on a 48³ grid against the tree's leaves:

    | Fixture | getLodTreeLevel (best rising level) | Budget cut |
    |---|---|---|
    | lion | L20, 92 889: 0.83 cells / 0.95 mass | 100 000: 0.99 / 1.00 |
    | tomatoes | L24, 82 848: **0.55 / 0.92**, visibly broken (dark, hollow tomatoes) | 99 994: 1.00 / 1.00, indistinguishable at diorama size |
    | apartment | L22, 98 883: 0.57 / 0.995 | 99 997: 0.99 / 1.00 |
    | hall | L19, 73 089: 0.93 / 0.98 (L36, past the peak: 0.29 / 0.66) | 99 992: 0.94 / 0.99, softer grass and roof |

  - Proxies drop SH, because `extractSplats` copies only centre, scale, rotation, opacity and colour.
  - The hall spends much of its budget outside the crop box. Cropping first (`transcodeSpz` with `clipXyz`, as PLAN's ingest does) and then decimating will look better.
- **Load and LoD build** (main thread free; the tiny LoD runs on a worker): lion 0.37 s, tomatoes 1.6 s (including the v4 repack), apartment 0.9 s, hall 3.6 s (1.94M → 2.49M LoD nodes, a 2.8–3.1 s build). The LoD tree is ready 0.1–0.3 s after first render.

**Deviations from PLAN.md:**

| PLAN | S1 / Phase 2 | Reason |
|---|---|---|
| Proxies via `spark.getLodTreeLevel(mesh, level)` → extract → `writeSpz` v3 | Budget cut via the LoD worker's `traverseLodTrees` (maxSplats = 100k, distant viewpoint, foveation 1) → `extractSplats` → `writeSpz` v3. `getLodTreeLevel` stays only as a diagnostic. The opacity × volume subsample remains the no-LoD fallback | `getLodTreeLevel` levels are not complete cuts: 55–57 % cell coverage on tomatoes and apartment (tomatoes visibly broken). The cut covers 94–100 %. It uses a TS-private worker RPC, so the Spark pin matters |
| SPZ v4 → v3 regzipped with fflate | Same parse and zstd path; the spike gzips with `CompressionStream('gzip')` (native, async). Either works | Native and off the JS heap. fflate stays the fallback in the ingest worker if `CompressionStream` is missing |
| Depth proxies: colorWrite off, depthWrite on, renderOrder 100 | Plus `transparent: true` | Otherwise they render in the opaque list, before every transparent band |

### Phase 1 exit (agent, built-in pane) (2026-10-15)
All four exit items pass. They were run by hand in the built-in pane (Chromium, ANGLE Metal, Apple M5 Pro):

| Step | Result |
|---|---|
| Wipe → first run through the UI (T0 = 1994-01-01, start empty) | ✓ settings persisted, `firstRunComplete` true, no console errors |
| One node of each archetype through picker + editor; link Boltzmann → "Entropy is the arrow of time" via Inspector → Link to… → palette | ✓ 6 nodes with per-archetype defaults (`thermo`, `entity.kind`, `demon` block); 1 link |
| Reload | ✓ 6 nodes present, no console errors |
| `recordHashes` → `exportArchive` (5 328 B) → `wipe` (0 nodes) → `importArchive` → `recordHashes` | ✓ identical: `4e54079a…facfa476cd` |

**Bug fixed during the run:** "Link to…" opened a plain palette. CommandPalette cleared the link intent in its mount-effect cleanup, and React StrictMode runs that cleanup straight after mount. The intent is now cleared by a `useApp` subscription when the palette panel closes, so it survives open and is still dropped on every close path. Regression test: `tests/hud/paletteIntent.test.ts`.

**Known cosmetic gap:** in an *empty* world the default orbit camera sits near the colonnade's ring beam, so a grey band covers the lower quarter. The establishing shot only frames populated worlds. This is a Phase 2 polish item.

**Not run by the agent:** P (performance) in Safari/Chrome and G in Safari are user checks.

### Phase 2 — ingest + dioramas (agent, built-in pane) (2026-10-15)
Ingest runs entirely in the browser through `__wv.ingestFromUrl` (worker transcode → interior SPZ v3 → budgeted-LoD proxy → thumbnail, blobs first and record last):

| Fixture | Format | Interior splats | Proxy splats | Ingest time |
|---|---|---|---|---|
| lion.v3.spz | SPZ v3 | 195 099 | 99 994 | 1.9 s |
| tomatoes.v4.spz | SPZ v4 → v3 in the browser (`upFix` identity) | 445 409 | 99 995 | 5.2 s |
| apartment.sog | SOG | 661 466 | 99 998 | 2.2 s |

Fly-in to the lion reaches `interior` with the LoD interior focused (`crystal.phase = ready`). The other two memories stay resident as proxies (200k proxy splats). Picture: the lion is upright and sharp, and the Inspector shows "MEMORY 002 · Lion" with its thumbnail.

**Still open:** the 20× fly-in/out leak check needs the Browser pane **visible**. A hidden pane gets no animation frames, so a single fly-in took 34 s and the cycle loop stalled. The user's Scaniverse upload also remains open.

**Conventions (builder A):** the interior is stored uncropped in the capture's own frame. `upFix` is the render-time mesh rotation. `crop` is a SplatEdit BOX in native units, by default the 1–99 % quantile box of the splat centres + 2 %. `entryPose` is mesh-local. The default `upFix` is a half turn about X (y-down captures; right for 3 of the 4 fixtures). Framing saves numbers only; `rebuildScene(id)` refreshes the proxy and thumbnail.

### Phase 3a — physics core + acceptance (2026-10-15)
`npm run test:accept` (Node 26.5, M5 Pro, 188 s; full JSON in `bench-results/accept-2026-10-15.json`):

| ID | Criterion | Measured | Result |
|---|---|---|---|
| R1 | fwd n / back n identical hashes, N = 1000 with births, n ∈ {1, 600, 6000} | 6 cases, 1 668 birth crossings | PASS |
| R1 | n = 36 000 fwd/back at N = 10 000 (births over the span) | identical; active 778 → 10 000 | PASS |
| R1 | 10 random scrub schedules × 2000 frames (Scrubber + seekTo) | all equal straight runs; 221 397 steps, 655 seeks | PASS |
| R2 | checkpoint hashes across runs | 170 checkpoints, 0 mismatches | PASS |
| R2 | shuffled insertion orders (different slots) | identical id-ordered hashes | PASS |
| R2 | grid ≡ brute force ≡ shuffled pair lists ≡ permuted active list | bit-identical | PASS |
| R2 | dust CPU ≡ GPU | criterion G (browser); S2 passed in the pane | — |
| L | f64 shadow, N ≤ 8 | max\|det J − 1\| 2.7e-10, symplectic defect 2.1e-10 | PASS |
| E | lab, birth-free, N = 1000, amp 6×, 36 000 steps | max 4.75e-4 ⟨KE⟩, AR(1)-corrected slope t 1.81 | PASS |
| E | main world ledger with births | max\|ledger\| 1.75e-4 ⟨KE⟩ (raw \|E_n − E_0\| 0.86 ⟨KE⟩) | PASS |
| D | min distance ≥ σ/2 among pairs older than 720 steps, N = 10 000, 36 000 steps | old pairs min 1.979 u; newborn min 0.884 u (118 of 845 444 pair-steps) | PASS |
| **B** | max\|u_xz\| ≤ 12 u, **max\|u_y\| ≤ 0.5 u**, sentinel 0 | u_xz 4.41 u, **u_y 1.023 u** (1 243 nodes ever > 0.5 u), sentinel 0 | **FAIL (u_y)** |
| S | lab ratio ≥ 0.95 by 1200 steps, bit-identical return | 1.029 (≥ 0.95 from step 120); inverse and flip–forward–flip identical | PASS |
| S | arrow of time: 18 000 fwd, 1-LSB kick, 18 000 back, ratio ≥ 0.5 | 0.983; 1000/1000 particles fail to return; unperturbed control returns exactly | PASS |

**B analysis:** the tether alone gives \|u_y\| ≲ 0.2 u, which is where PLAN's "≲ 0.25 u" came from. The excess comes from the pair core. When XZ-wandering nodes come within σ, the peak core force (≈ 28.6 force units) against kY = 16 displaces them up to ≈ 1.8 u statically. The observed 1.02 u is about one month of time-height (12 u/year). **Decision pending with the user:**
- (a) an ellipsoidal core stretched along Y (σ_y = 2σ, a real gradient, so collisions resolve sideways);
- (b) a stiffer kY, which needs a tether overflow rework because the coefficient goes above 2¹⁵;
- (c) amend B to ≤ 1.25 u.

### Phase 3b — motion, timeline, dust (2026-10-15)
Built: the physics worker (`src/physics/workerProtocol.ts`, `workerHost.ts`, `worker.ts`), the main-thread playhead clock and pose writer (`src/world/time/`), the Timeline HUD (`src/hud/Timeline.tsx`), GPU dust with births, checkpoints and CPU edit rows (`src/gpu/dust/`), and `<DustLayer/>` mounted in the world scene (`src/world/dust/`). `npm run check` passes: typecheck, lint, 57 files with 495 tests.

**Agent checks in the built-in pane** (ANGLE Metal, Apple M5 Pro, Chrome 152 in the desktop app). The pane was hidden, so frames ran at about 2 fps; these results show correctness, not speed. The demo world had 9 nodes, plus 4 QA nodes born in 2001, 2012, 2018 and 2023 that were moved to the trash afterwards.
- **Motion:** at 10× the 2001 memory drifts about 0.1 u in xz over 360 steps, on the worker's trajectory.
- **Scrubbing:** the playhead went to 6600, 12 600, 3000, 9000 and back to the present.
  - At every stop, the pose table's `born` flags agreed with dust's born segment count (1, 4, 0, 2, 13).
  - Births appear and disappear as ghosts, and the Timeline readouts follow.
  - Reverse play at −10× crossed today's births cleanly.
- **Edit:** `updateNode` moved the 2012 memory's date to 2011. The node dropped 16.9 u in Y on the next rendered frame, `settling` came and went, and the world converged.
- **G (agent):** `__wv.dustCheck()` compares every int of GPU dust X and D with a CPU dust world. The CPU world is rebuilt from the owners and runs from step 0 with births, independently of the edit-row path.
  - It was **bit-identical in all 16 checks**: on load, after inserts, after scrubs to the five stops above, after playing forward, after reverse play, after the past edit, at birth + 60 of the 2001 memory, with a future-born node added while paused and then trashed, and after trashing 4 born owners while paused.
  - `#/lab`, panel G (`runDustIdentity`): 4096 texels × 600 steps (15 checks) and 16 384 texels × 3600 steps with checkpoint interval 600 (35 checks) were bit-identical. S2 is still bit-identical.
  - **User: Safari pending.**

**Budgets, N = 1000:**

| Budget | Node, `npm run bench` (10-year span, 6000 steps, cache warm) | Browser worker (V8 in Chrome 152, 30-year span, 18 000 steps, no cache) |
|---|---|---|
| Cold start < 1 s | 33 ms (300 steps from a cached checkpoint); 99 ms (599 steps) | 1013 ms replaying from step 0 on the first visit; later loads hydrate from the cache |
| Edit-to-visible < 500 ms, hold frame | 0 ms: the edited node shows at once in its new layout on the old trajectory | 0 ms |
| Edit-to-visible < 500 ms, fully settled | recent 93 ms; mid-span 439 ms; oldest node, full recompute over 6000 steps, **569 ms (over)** | recent 65 ms; 9 years back 485 ms; oldest node, 18 000 steps, **1001 ms (over)** |
| Steps/s | 6153 with all 1000 active (102× real time); largest N at 10× real time is 7800 | — |

The browser figures come from a blob module worker running `PhysicsHost` on `realisticRecords(n = 1000, 30 years)`, without IndexedDB. Settle time grows linearly with how far back the edit reaches, at about 55 µs per step at N = 1000. Edits that reach back more than about 9 years exceed the 500 ms settle budget, while the hold frame stays immediate.

**Bugs fixed during integration:**
1. **Failed first dust draw.** `DustGpu`'s ping-pong targets had no GL texture until three first rendered into them. The first 0-step spawn draw therefore sampled three's 8-bit placeholder through an `isampler2D`. That raises GL_INVALID_OPERATION ("mismatch between texture format and sampler type") and the draw is silently skipped, once per context. Both targets are now allocated with `renderer.initRenderTarget` at construction and after a context restore.
2. **Stale live state after an owner change.** `DustSim.setOwner` gave a segment to a not-yet-born owner, or freed it, but left the previous occupant's state in the live buffer until the next stepping draw. With a paused playhead that state stayed stale. The renderer culls such texels, so nothing was visible, but the live buffer no longer matched the CPU reference. A 0-step draw now re-spawns texels with birth ≥ live. The new test in `tests/physics/gpuDustSim.test.ts` fails without this fix.
3. **Interior world-hide.** `<DustLayer/>` wrote `points.visible` every frame, which would have undone the interior's world-hide. The points now sit in a top-level group named `dust` (`WORLD_GROUP_NAMES`), and the points object is renamed `dust-points`.

**Decisions (builders' proposals, accepted):**
- `workerHost.ts` (`PhysicsHost`) is split out of `worker.ts` so it can be tested in node. `worker.ts` only wires it up and opens the checkpoint cache, which is its own IndexedDB database, `hyperspace-cache`. Cache lookups are fire-and-forget and never hold up a start, and checkpoint step 0 is never written to the cache.
- Seeks post stats only. A past edit posts one hold frame immediately (the old trajectory with the new slot layout) and recomputes in time-budgeted chunks.
- The clock copies its step into `useApp().clock.step` at 10 Hz while playing and exactly on pause. A step written there by anything else is a seek.
- The Timeline's Present button moves only the playhead; `goToPresent` still flies the camera.
- The R3F hook lives in `usePlayheadClock.ts`, so `clock.ts` stays importable in node.
- Demon birth ticks use the signal colour.
- **GPU dust fallback:** without 32-bit highp int in both the vertex and fragment stages, the world renders no dust. This deviates from PHYSICS.md, which says the CPU runs it.
- **GPU dust state:**
  - Dormant texels hold their spawn state rather than being cleared.
  - Each texel's spawn seed and style live in a static meta texture.
- **GPU dust edits:**
  - An asynchronous edit (one needing more than 1024 CPU steps) hides its segment until its CPU rows are done, and drops later checkpoints instead of patching them.
  - More than 8 physics changes at once restart dust from step 0.
- **GPU dust budgets:**
  - The checkpoint ring has 8 slots of 4 MB at the full 131 072-texel budget, so up to about 44 MB of GPU memory in total.
  - Without `EXT_disjoint_timer_query_webgl2` (Safari), the stepping budget is a fixed 2.1 M texel-steps per frame.
- **Dev hooks:**
  - `__wv.dustCheck({anyStep?, timeoutMs?})` waits for pending edit rows and for dust to reach the playhead, then compares.
  - `window.__dustIdentity()` runs the lab's G check from the console.

**Gaps:**
- **Edit budget:** an edit reaching back more than about 9 years at N = 1000 settles in more than 500 ms (1.0 s for a 30-year full recompute in the browser).
- **First-visit cold start:** loading a 30-year world with no cache replays from step 0 and takes about 1 s at N = 1000.
- **Real frame costs not measured:** the pane was hidden, so the costs of GPU dust stepping and the pose writer at 60 fps, and how long dust takes to catch up from step 0 on a cold start, are unknown. Tested here only with 1024 texels; the full 131 072 texels is unexercised in the app.
- **Dust and settling:** dust does not set the `settling` flag.
- **Energy ledger:** its baseline restarts on every seek or edit.
- **Entropy cost:** the entropy calculation is O(n²) on up to 2000 samples, about 20–40 ms once a second in the worker.
- **Frame allocations:** each frame allocates three typed arrays, and buffers are not returned to the worker for reuse.
- **Hidden-pane quirk (environment):** while the desktop pane is hidden, the R3F canvas stays 300 × 150 until the pane lays out. The world mounts only after a screenshot or once the pane is shown.

### Phase 3 — criterion B fix: stiff time tether kY = 64 (2026-10-15)
**User decision:** raise the node time tether from kY = 16 to 64 to meet B as written, rather than amend B or ellipsoidalise the core. The Y axis uses shift 9 (coefficient 18 641) and saturates at 16 u, so the integer path stays overflow-free (|I_y| ≤ 3.05e8 < 2²⁹; `assertTetherBounds`). Dust is unchanged, so the GPU kernel stays bit-identical. `PHYSICS_VERSION` = 2. Derivation: [PHYSICS.md § Stiff time tether](PHYSICS.md).

`npm run test:accept`, 214 s: **every criterion passes.**

| ID | kY = 16 | kY = 64 |
|---|---|---|
| R1 (N = 1k, births; N = 10k × 36 000; 10 scrub schedules) | PASS | PASS |
| R2 (checkpoints, insertion order, neighbour lists) | PASS | PASS |
| L (det J, symplectic defect) | 2.7e-10 / 2.1e-10 | 3.0e-10 / 2.0e-10 |
| E lab (≤ 2e-3 ⟨KE⟩) | 4.75e-4 | 8.15e-4 |
| E main-world ledger | 1.75e-4 | 2.42e-4 |
| D (old pairs ≥ σ/2) | min 1.979 u | min 1.943 u |
| **B** max\|u_y\| ≤ 0.5 u | **1.023 u (FAIL)** | **0.482 u (PASS; 0 nodes > 0.5 u)** |
| B max\|u_xz\| ≤ 12 u, sentinel 0 | 4.41 u, 0 | 5.19 u, 0 |
| S ratio by 1200 steps / arrow of time | 1.029 / 0.983 | 1.024 / 0.999 |

**Note on E:** with kY = 64 the lab run's energy has a statistically significant but tiny linear trend: −4.46e-5 ⟨KE⟩ over 36 000 steps (AR(1)-corrected t = −12.4), about 45× below the 2e-3 bound. The integer map is a lattice bijection, so this is the slow, bounded rounding noise of K at the stiffer frequency, not unbounded heating. The test passes on magnitude. To watch: re-check this when changing dt-stiff constants.

### Phase 3c — overlays (2026-10-15)
The O layer (`src/overlay/`, `src/world/overlays/`, `world/time/overlayHook.ts`) follows PLAN's overlay bullets. Constants and derivations: [PHYSICS.md § Overlays](PHYSICS.md#overlays-o-dissipative-reproducible-from-the-log). Choices PLAN left open:
- **T_E and T_w are e-folding times** (λ = 1/T), not half-lives.
- **Demon matches feed the Hebbian trace but never co-activate synapses.** A demon matching M nodes at once would otherwise wire an M-clique that says nothing about the user's attention.
- **The demon lattice moves nodes in XZ only.** Each sorted node keeps its date (plus the bounded Hebbian offset), so Y stays time.
- **Diorama-bearing memories are measured but never moved by demons.** They count toward C and M, and get no slot. They are the cold nodes PLAN keeps still for Spark #347.
- **An activation** is an active demon appearing, being switched on, or having its query, radius, anchor or date changed (or "Sort again"). It logs one `demon-match` per matched node, with bits = log2(C/M) each, all stamped at the same time.
- **Compaction** offers two scopes, both behind a confirmation. "Older than one year" changes nothing visible. Those events' traces have decayed below 1e-20, and their influence on any current synapse weight is at most e^{−365/90} ≈ 0.017. "Everything" resets plasticity. The paid ledger is device-local kv (`overlay.landauerPaid`) and is not part of the archive.
- **Display smoothing.** Pose offsets glide with τ = 350 ms. The node being flown into or framed holds its offset until the camera is out, so its own `enter` event cannot shift the diorama mid-flight.

### Phase 3c — overlays, worldline, lab, perf (agent, built-in pane) (2026-10-15)
**Integration.** `WorldPage` mounts `<Overlays/>` inside a top-level `<group name="overlays">` and mounts `<Worldline/>` at scene level. The ribbon moved out of `CameraRig`, which now mounts only `<AutonavRig/>`. `'overlays'` joins `WORLD_GROUP_NAMES` (`world/splats/flyIn.ts`), so the interior's world-hide covers citadels, mist, filaments, lattice and satellites. The worldline hides itself in the interior. `#/lab/perf`'s `PerfScene` composes the same overlays and worldline, so the bench measures what the world draws.

**Agent checks in the built-in pane** (Chrome 152 in the desktop app, ANGLE Metal, Apple M5 Pro). The pane was **visible** this time, and rAF ran at 120 Hz. The world was the 9-node demo.
- **Hebbian.** "First physics lecture" was selected 4 times, ≥ 1.6 s each. That logged 4 `inspect` and 4 `dwell` events, one dwell per visit.
  - E rose from 0.94 to 6.94, Y_h from 0.57 to 2.35 u (cap 2.5 u) and the citadel from 1.38 to 5.64 u.
  - The pose Y went from 394.00 to 395.79, which is the anchor (393.44) plus Y_h.
  - In the scene graph: 9 citadels, 18 filaments (28 synapses before pruning) and 1 Kepler glyph. Mist was 0, because no node is neglected yet.
- **Demon.** "Sort by entropy" was given the query "entropy information" and a radius of 60 u.
  - Result: C = 6, M = 1, so bits = log2 6 = 2.585. One `demon-match` event was logged.
  - "Information theory" eased onto the lattice slot (demon + (4, 0)) in XZ and kept its date height plus Y_h. The lattice and the citadels under both nodes are visible.
  - DemonPanel showed: recorded 2.58 bit · 1 ev, kT_eff 0.189, unpaid 0.338, which equals bits·kT·ln2. "Sort again" raised these to 5.17 bit · 2 ev and 0.677.
  - Afterwards the demon was put back to its seed query and radius. The test events stay in this profile's log.
- **Interior.** Flying into the Lion hid environment, nodes, links, dust, overlays and worldline. Flying out restored all of them.
- **Worldline and autonav.**
  - The ribbon runs through the 4 memories in date order (52.3 u).
  - Palette → "Ride the worldline" switched to `autonav`. The camera followed the ribbon 4–5 u off it, reached the end, held, and returned to orbit.
  - Esc during a ride returned to orbit.
- **Lab.**
  - Exact reversal: Φ 10× to step 4781, then "Reverse to 0", gave hash `0x5a5b8348` = initial ("bit-identical to the initial state").
  - Arrow of time, 300 s: **PASS**. S₀ −10.901 → S_fwd −2.207 → S_ret −2.212, ratio **0.999**. 998 of 1000 particles did not come home. The control was bit-identical. Wall time 16.7 s.
  - Growth panel: τ = 0.770 s (30 s fit, every second step, R² 0.992). This agrees with the first-10 s fits in PHYSICS.md (0.769–0.781 s).
- **Perf smoke** (`await __perf()`):
  - Fixtures attached: lion, tomatoes, apartment and hall (1.8, 5.4, 2.3 and 9.1 s).
  - Refresh snapped to 120 Hz. The path phase had 3599 frames and the scrub 1201, with **0 slow** and 0 dropped frames. The longest interval was 10.6 ms. Main thread: median 1.3 ms, p99 1.9 ms.
  - At peak, 2 proxies were resident (200k splats).
  - GPU timer: median 10.2 ms, p99 16.4 ms. That is longer than the 8.3 ms interval even though no frame was slow, so on ANGLE Metal the elapsed-time query overlaps frames. Read GPU ms as relative only.
  - Status: "P met" **in this pane only**. P remains the user's check, in Safari and Chrome.

**Bugs fixed during the run:**
- **`#/lab/perf` never recorded a frame interval.** `PerfRecorder.raf()` had no caller, so every report had `frames: 0`, `refresh: null` and `verdict.pass: false`, whatever the frame rate. `PerfDriver` now runs its own rAF loop and feeds the recorder the browser's timestamps. R3F's frame callbacks do not expose them.
- **`report.splats` always read zero.** It was sampled when the run finished, after the scrub has taken the playhead 12 years back and the camera is far from every fixture. It is now `{ end, peak, sampleMs }`, with the peak sampled at 2 Hz over the measured phases.
- **Overlays outside the world group.** Without the `'overlays'` group name, citadels and filaments would have drawn around the diorama interior.

**Recorded for builder 2:**
- The bench swaps the repo onto a private in-memory world for the run and restores the IndexedDB world afterwards. The user's 9 nodes and 38 events were intact after three runs.
- `src/lab` imports `scripts/physics-worlds.ts` (`buildLab`), so the lab world and criterion S share one definition.

**Stretch cuts: none in Phase 3.** Kepler satellites (stretch 3), demon ledger visuals (4) and the ride-the-timeline camera (5) shipped. One partial: Kepler cards are plain boxes without thumbnails.

**Open after Phase 3c:**
- Per-node desaturation is missing; the mist veil is the only hint.
- The paid-ledger total is device-local and not in exports.
- Events more than 60 s out of order fold only on a full reload.
- No "Esc exits" hint during autonav.
- The DemonPanel overlaps the Nearby card at the bottom left.
- The `src/physics/entropy.ts` header still says l_y = 0.25 u. It should say 0.125 u for kY = 64, but kernel files were not to be edited.
- The bench runs in orbit mode, so the floor reflector is not measured.
- User checks: P in Safari and Chrome, G in Safari, a Scaniverse upload, and the Phase 2 20× fly-in/out leak loop.

### Phase 2 exit — 20× fly-in/out (agent, built-in pane, visible) (2026-10-15)
`__wv.flyIn` / `__wv.flyOut` on the lion 20 times, 156 s in total (≈ 7.8 s per in+out cycle at 120 Hz):

| Snapshot | Spark meshes (live) | geometries | textures | programs | JS heap |
|---|---|---|---|---|---|
| start | 0 (0) | 101 | 64 | 51 | 111 MB |
| after 1 | 0 (0) | 103 | 70 | 54 | 202 MB (pre-GC) |
| after 10 | 0 (0) | 109 | 70 | 54 | 144 MB |
| after 20 | 0 (0) | 109 | 70 | 54 | 222 MB pre-GC → 139–156 MB settled |

The first cycle warms shader programs, textures and the LoD worker. From cycle 10 to 20 every counter is flat, so there is no leak. The geometry creep of +6 by cycle 10 is label and overlay pooling as the camera moves, and it stops there.

**Small UX fixes in the same pass:** a ModeHint shows how to exit each camera mode that takes over the controls (autonav, first person, interior, third person); the Nearby card hides while the demon panel occupies its column; `entropy.ts` documents l_y = 0.125 u for kY = 64.

### Phase 3 gate — static build (2026-10-15)
`npm run build` succeeds in ≈ 0.5 s. `npm run serve` (production preview on the same origin, localhost:5173) loads `#/`, `#/lab` and `#/lab/perf` with no console errors from the bundle. `window.__wv` is absent in production as intended, and the user's world (9 records) loads from the same origin's storage.

Sizes:
- `dist` is 76 MB, but only because `public/fixtures/` (≈ 50 MB of CC-BY scans, gitignored) is copied in. Publishing (Phase 5) must exclude or host them separately.
- The largest chunk is Spark at 2.5 MB (0.9 MB gzipped), with its WASM embedded.

**Execution pauses here for the user's review**, per PLAN. Open user-only items are in [CHECKLISTS.md](CHECKLISTS.md):
- P in Safari + Chrome;
- G and S2 in Safari;
- S1 in Safari + Chrome, which also picks the primary browser;
- a Scaniverse upload.

### Pre-Phase-4 world-building pass (2026-10-16)
User review after Phase 3: the world read as "boxes and 3D renders"; splats were invisible from orbit.
- **Terrariums.** Splat scenes were fitted to the 1.1 u inner cube and proxies loaded only within 60 u, so from orbit a memory was an empty glass box. Now `DIORAMA_HALF = TESSERACT.shell − 0.08` (the scene fills the glass), memories with a scene use `terrariumFarScale` (true size within 24 u, so spurs and the catwalk are unchanged; up to 9× far away against 4× for other nodes), and the proxy tier band is 180 / 220 u (still ≤ 6 proxies × 100k).
- **Land.** `environment/Terrain.tsx`: a terraced basin outside the peristyle, hills, and a ring of ridged ranges (peak ≥ 260 u, ~0.55 × column height) with ember survey contours every 24 u. Decorative only: no collision or walking. Nodes anchored far out (r > 800 u) at low Y could sit inside a range.
- **New memory from a splat file.** Use TopBar **+ Scene**, or drop a capture anywhere on the world. This creates a memory titled after the file and dated by its modification day, selects it so the Inspector shows ingest progress, and enters the terrarium when done. A failed ingest sends the empty memory to the trash.
- Debug finding: fog/DOF post reads depth behind splats (they write none). The shells' depth proxies cover this at close range; it is why tiny far scenes were washed to black.

### Phase 4 — engine, embeddings, omnibox, semantic layout (2026-10-16)
User choices at the gate: SQLite as an **opt-in** engine (IndexedDB stays the default and the static build keeps working), the user supplies `ANTHROPIC_API_KEY` in `.env.local`, and the embedding model loads **from Hugging Face on first use** (no vendored weights).

**Dependencies added** (exact pins): `sqlite-vec` 0.1.9, `@huggingface/transformers` 4.3.1, `@anthropic-ai/sdk` 0.135.0, `zod` 4.6.7, `umap-js` 1.4.0. `onnxruntime-node` arrives transitively with transformers.js, but its postinstall is blocked and nothing on the Node side uses it.

**Engine.** `server/` holds the engine: `worldDb.ts` (node:sqlite + sqlite-vec, executing `src/domain/schema.sql`), `api.ts` (`/api/world`, `/api/embeddings`, `/api/refine`, `/api/health`) and `vitePlugin.ts`. The plugin mounts the API on the dev and preview servers, so the app and engine share the localhost:5173 origin. `src/data/httpStore.ts` implements `WorldStore` over that API and passes the same contract suite as memoryStore and idbStore (`tests/data/store.test.ts`). Data lives in `data/world.sqlite` and `data/blobs/` (gitignored).
- Schema changes now that `schema.sql` executes: three FKs were dropped (`links.target_id`, `attachments.blob_id`, `assets.node_id`), because import and scene ingest write in an order those FKs reject. Two columns were added: `nodes.provenance` and `nodes.extra` (unknown NodeRecord keys, so records round-trip byte-for-byte under canonical JSON). `embedding_meta` was added for change detection.
- Switching engines goes through Settings → Engine (`src/data/engine.ts`). The whole world is exported to an archive and imported into the target, and the records hash is checked; the target's previous contents go to a pre-import backup first. The engine you leave keeps its copy. If the SQLite engine is selected but not running, the app opens the IndexedDB copy **read-only** with a banner rather than letting the two diverge.
- Device-local kv keys (`DEVICE_KV_KEYS`, e.g. the backup folder handle) stay in the browser (`hyperspace-device` IndexedDB), since they cannot be serialised to the server.
- Verified: demo world + every optional field + an unknown future key → archive → SQLite → archive → memory gives the same records hash (`tests/server/engine.test.ts`). The pane world (11 nodes, 30 MB of splats) moved to SQLite with an identical hash, and its interiors stream from the server.

**Embeddings.** EmbeddingGemma 2 (`onnx-community/embeddinggemma-2-ONNX`) runs in a module worker (`src/ai/embed.worker.ts`) with document/query prompt formats. Vectors are truncated to 512 dimensions (Matryoshka) and re-normalised.
- **Deviation:** PLAN said q4 on local wasm paths. q4's `GatherBlockQuantized` op has no WASM kernel in onnxruntime-web, so the worker uses WebGPU + q4 (~175 MB) and falls back to WASM + q8 (~315 MB). The runtime config is part of each embedding's text hash, so vectors from the two never mix. The pane runs `webgpu/q4`.
- Vectors live in the SQLite engine's `vec0` table (KNN in SQL) or, on IndexedDB, in a separate `hyperspace-embeddings` database (brute-force KNN). Either way they are derived data: not exported and not hashed. Indexing is opt-in per browser (Settings → Semantic engine) because of the download, then incremental through the repo change feed.

**Omnibox** (`/` or TopBar "/ Add"; `src/ai/omnibox.ts`, `src/hud/Omnibox.tsx`):
1. A provisional record is spawned from heuristics (`provisional.ts`: archetype, #tags, dates clamped to [T0, now]). It is placed semantically when the index answers within 700 ms. Measured spawn time: 21 ms with tag placement, 59 ms with semantic placement (budget 1500 ms).
2. `claude-haiku-5-5` refines the record through `messages.create` with an `output_config.format` json_schema, effort `low` and thinking `disabled`. The reply is parsed by hand and checked with zod (`refineSchema.ts`, shared by client and server). Link targets are limited to the candidates sent. A refusal, truncation, invalid reply or missing key keeps the provisional record, marked `provenance.state = 'fallback'`. A refinement is one undoable step; it may change the archetype (`retypeNode`) but never re-places the node (`updateNode(…, { keepAnchor })`).
- `NodeRecord.provenance` was added (optional) in `domain/types.ts`.
- **Not verified live:** no API key was configured, so the Haiku call ran only against a stubbed client (`tests/server/refine.test.ts`). The no-key path was checked in the pane.

**Semantic layout** (`src/ai/layout.ts`):
- New nodes take the similarity-weighted circular-mean bearing of their neighbours, on their archetype's ring.
- **Re-crystallise** (Settings) is an explicit, undoable event. Seeded UMAP lays every embedded node out in 2D. A Kabsch/Umeyama similarity (reflection allowed) aligns that layout to the current anchors. Each node then takes its aligned bearing and keeps its own radius; `reanchorNodes` writes all moves atomically and nudges for σ.
- In the pane, re-crystallise grouped the 11 nodes into scene memories (−36°…27°), thermodynamics (81°…137°) and information theory (173°…−83°). Mean turn on this first run: 52°, expected after the arbitrary tag-hash layout.
- **Kept:** tag-hash placement remains the fallback when the index is off.

**Not in Phase 4:** demons still match with BM25 rather than embeddings. The capture pipeline, desktop shell and publishing stay in ROADMAP.

### Readability pass, part 1: labels, default view, architecture dimming (2026-10-19)
User choices: keep the five `LinkKind`s, dim the architecture behind a slider, and start with labels and the default view. Plan: `../Worldview-Knowledge-Base-main/plans/readability-pass.md`.

**Screen-space labels.** Before this pass, no title was readable from the default view: in-world troika text at 0.065–0.19 u is sub-pixel at establishing-shot distance. `world/nodes/ScreenLabels.tsx` is an HTML overlay over the canvas, with one pooled div per shown node, 12 px bold title and a 10 px tag line (archetype · date at its precision).
- **Handover:** a node gets a screen label only when its in-world title would be smaller than `MIN_WORLD_TEXT_PX = 11` (`worldTextPx` in `labels.tsx`). The in-world pool now carries text only above that size, so the two never double up.
- **Declutter:** `declutter.ts` is pure and tested. It places labels greedily by priority (selected > hovered > linked to selection > degree > nearness, ties on id). It tries above, right, left and below, and drops a label only when no side fits clear of placed labels, the viewport and the HUD bars. Placement is resampled every 0.2 s; positions follow the pose table every frame. Opacity fades over 150 ms (none under reduced motion).
- Far titles are clipped to 28 characters; hovered and selected nodes show the full title.
- An HTML overlay was chosen over billboarded troika at constant pixel size. It needs no glyph atlas or extra draw calls, and text stays crisp at any DPR. The `#/lab/perf` A/B in the plan was not run; the main-thread check below stands in for it.

**Default view.** `establish.ts` margins are now asymmetric (0.34 above, 0.16 below), because labels sit over their nodes and the top bar covers the top of the frame. When the middle half of node heights is narrower than 25 % of the 10–90 % band, the shot frames that dense cluster instead of the whole band. The demo world has 10 of 14 nodes within a year of NOW, and from far enough to see all 14 those labels cannot fit.

**Architecture dimming.** Settings → Quality → Architecture (30–100 %, default 62 %) scales albedo and `envMapIntensity` of the board/cast concrete, brass, metal and terrain materials from their original values (`environment/dim.ts`). Emitters and year numerals are untouched. It is a per-device preference in `localStorage` (`hyperspace.view`), not world data, so archives and hashes are unchanged.

**Measured** (pane, demo world, `__wv.readability()`):
- 800×600: 7 of 12 in view readable, 0 overlaps.
- 1440×900: 9 of 11 in view readable (82 %, RD1 target 80 %), 0 overlaps, min title 12 px.
- Frame time at 120 Hz: median 8.3 ms, p99 9.8 ms, 0 frames > 25 ms over 180 frames.
- `npm run check`: 608 tests pass.

**Not done yet:** typed and visible links (RD2), year rings and the present plane (RD3/RD4), and the first-visit orientation line. P in Safari is still the user's check, now with labels on.

### Readability pass, part 2: typed, visible links (2026-10-19)
The five `LinkKind`s are kept, per the user. Before this, every link was one grey `LineBasicMaterial` at 0.28 brightness and the kind was never drawn.
- **Styles** (`world/links/style.ts`):
  - supports: solid ember, 2 px.
  - contradicts: solid signal red, 2 px, with a 14 % gap at the midpoint.
  - derives: dashed bone, 1.5 px, with an arrow.
  - influenced-by: dotted, 1.5 px, with an arrow.
  - relates: grey, 1 px.
- **One link per node pair.** When a pair carries several kinds, the most assertive is drawn (contradicts > supports > derives > influenced-by > relates).
- **Arrow direction:** arrows follow the flow of ideas. For "A derives from B" and "A was influenced by B" the arrow runs B → A, and the legend says so. The plan's "arrowhead at the target" is superseded by this.
- **Rendering:** `LineSegments2` + `LineMaterial` (three/examples), with screen-space widths, one object per kind (≤ 5 draw calls). Buffers are allocated once per link set and rewritten in place. Arrowheads keep a constant 9 px on screen, so a rebuild runs when the poses, the camera or the emphasis change. Base brightness is raised from 0.28 to 1.15; near, hovered and selected ends go to 1.7, 2.4 and 3. Unborn ends fade to 0.3.
- **Hover:** `LinkHover.tsx` picks in screen space (≤ 6 px from the projected segment) and shows "A — supports → B". A hovered node always wins over a link. The tip flips at the stage edges.
- **Legend:** a HUD key at the bottom left lists all five kinds with counts for this world, dimming kinds with no links. It is open on a first visit and remembered per device (`hyperspace.linkLegend`). No keyboard shortcut was added, because `L` is already Library.
- **Verified:** in the node sandbox, `__wv.linkStats()` gives contradicts 1 link → 2 segments, derives and influenced-by 1 → 3 (body + two head strokes), relates 5 → 5, supports 1 → 1. Hovering the red link showed "Notes on brutalism — contradicts → Rain on the concrete church". `npm run check`: 612 tests pass.
- **Not verified by eye:** the arrowheads close up, because the sandbox camera drifts and screenshots at that size are unreliable. The segment counts above stand in for that check.
- **Test noise:** an earlier full run failed 18 files on worker start-up and 60 s timeouts while the machine ran about 100× slower than usual. A rerun on a quiet machine passed in 20 s.

### Readability pass, part 3: time in the scene (2026-10-21)
- **Year rings** (`world/time/YearRings.tsx`): a faint horizontal ring around the node field on 1 January of every year. The rings use `ringYears()`, which is the same list as the Timeline's `yearTicks()`, so the two cannot drift apart (RD4, `tests/world/timeRings.test.ts`). The ring radius is the outermost node radius + 8 u (at least 30 u). It is one `LineSegments` with per-vertex colour: dim, marked (labelled years), or ember (the focused year).
- **Year labels:** screen-space, 11 px, at the ring's right-hand edge. When that edge is off screen at close framing, a label slides inward along the camera's right axis until it fits. Labels are thinned by `labelStride()` (1/2/5/10/… years) so they stay ≥ 24 px apart.
- **Present plane:** a disc at the playhead's height (3.5 % ember) with an ember edge ring. It moves as you scrub, matching the Timeline's playhead.
- **Hover, both ways:**
  - Pointer over the Timeline sets `useApp.timeFocusYear`. That year's ring and label turn ember, the tick brightens, and that year's node labels get an ember tint and a priority boost.
  - A birth tick within 5 px of the pointer hovers its node.
  - A node hovered in the world draws its birth tick thick and shows its title above the bar.
  - Leaving the bar clears only the hover the bar itself set.
- **Node labels avoid HUD panels** marked `data-label-avoid` (the link legend), so they no longer slip underneath it.
- **Verified in the pane:**
  - Year labels 2024–2028 show on the right edge of the default view.
  - Hovering 2026 on the Timeline: `timeFocusYear` = 2026, the 2026 ring label is ember, and 7 node labels are tinted.
  - Hovering a node shows its title over its birth tick.
  - Frame time: median 8.3 ms, p99 9.8 ms, 0 frames > 25 ms.
  - `npm run check`: 616 tests pass.
- **Known nit:** the birth-tick title sits over the readouts row while it shows.

### Readability pass, part 4: first-visit orientation line (2026-10-21)
- `hud/OrientationHint.tsx` shows one line, "Height is time · lines are relations · click a node to read it", centred at the top of the stage. It appears on a first visit to a world with nodes, in orbit mode only, so it never competes with ModeHint.
- It is dismissed by the first pointerdown, wheel or key anywhere and remembered per device (`hyperspace.oriented`). It is marked `data-label-avoid`, so node labels keep clear of it.
- **Verified in the pane:** it shows on load with the flag cleared, disappears on a keydown (flag set), and does not return after a reload.
- `npm run check`: 616 tests pass. One run failed `durabilityUi › trash lists, restores and empties` under parallel load. That test passed alone (7/7) and on the next full run (616/616), so it looks flaky and is not related to this change.

**The readability pass is built.** What's left is the user's: RD7 (open the world cold and give a verdict) and RD5/P (Safari perf with labels, links and rings on).

### Milestone 1: chat intake and the Obsidian bridge (2026-10-21)
User pivot (plan: `../Worldview-Knowledge-Base-main/plans/milestone-1-intake.md`): adding things must be as easy as talking. The chat is now the front door. `/` and TopBar "Add" open it, and it opens full screen for an interview on a first visit to an empty world. Nothing reaches the world until a card is kept.

**How it works**
- **Server** (`server/chat.ts`, `POST /api/chat`): a thin relay that holds the key, the system prompt and the tool list. It streams one turn as NDJSON `ChatStreamEvent`s (`src/ai/chat/protocol.ts`).
  - Model: `claude-opus-5-5`, overridable with `CHAT_MODEL`. Adaptive thinking, effort `medium`, `max_tokens` 64k, top-level auto-caching (files are resent every turn).
  - Refusals fall back server-side: `fallbacks: "default"` under the `server-side-fallback-2026-07-01` beta.
  - **Deviation:** the plan said Sonnet 5.5 for the conversation. The Claude API reference defaults to Opus 5.5 unless the user names another model, so that is the default; `CHAT_MODEL=claude-sonnet-5-5` switches it.
- **Tools.** All three are answered by the browser: `search_world` (semantic plus fuzzy over title, tags and text), `propose_notes` and `ask_user`.
  - Inputs stream eagerly (`eager_input_streaming`), so the API does not validate them. The browser checks every input with zod. An invalid or truncated (`max_tokens`) input goes back as an `is_error` tool result, and the turn continues (at most 6 automatic turns).
- **Session** (`src/ai/chat/session.ts`): the browser owns the conversation.
  - It is append-only, so thinking blocks stay valid, and saved in the world kv as `chat.v1`.
  - Searches are answered at once. Proposals and questions wait. When every card in a call is decided, the results go back without the user typing; otherwise they ride along with the next message.
  - Cards kept after their results were sent are reported in the next message.
  - Keep and Keep all go through `addNodes` as one undoable step, and links between proposals in the same call resolve. Edit sends a plain-words change request at once.
- **Intake:**
  - PDFs and images go to Claude as document and image blocks; text and markdown as `<file>` blocks. The limit is 20 MB a file.
  - URLs in a message are fetched by the server (`server/fetchUrl.ts`, `POST /api/fetch-url`: http/https only, 5 MB, 15 s, HTML reduced to text) and sent as `<page>` blocks.
  - A dropped or picked folder is imported as an Obsidian vault with no Claude involved. Drops anywhere on the world route here unless they are splat captures, which still become memories.
- **Obsidian bridge** (`src/data/obsidian.ts`):
  - Export ("Export vault" in the chat): one `.md` per note in a zip. Frontmatter carries title, id, kind, date, precision, tags, links as `"kind [[Note]]"` and source, plus a `hyperspace` JSON line with the rest of the record.
  - Re-importing our own export is lossless (I4, `tests/data/obsidian.test.ts`). Bodies are kept verbatim, so edits made in Obsidian win.
  - Foreign vaults are read from frontmatter (`date`/`created`, `tags`, `kind`/`type`, `links`), inline `#tags`, `[[wikilinks]]` (aliases, headings and embeds) and file dates. `.obsidian/` and `.trash/` are skipped.
- **Dates before T0** (e.g. Boltzmann, 1844) become a display-only `referenceDate`, and the note enters at T0 (`fitDate`). Dates past the horizon are clamped.
- **Repo:** a new `addNodes(drafts)` does a bulk, undoable add. It places every node first, then attaches links, so links within the batch validate. It keeps a given anchor when free and skips ids already present.
- **Provenance** is now a union: omnibox, or intake (`chat`/`file`/`url`/`obsidian` with `ref`, `quote`, `model`, `keptAt`).

**Verified**
- `npm run check`: 81 files, 629 tests. New: protocol and relay with a stubbed client, the URL reader, the vault round trip and foreign vaults, and the session (search auto-answered; nothing written before Keep (I5); link resolution; one-step undo; invalid inputs; no key (I7); pre-T0 dates).
- Live: one `curl` turn against `/api/chat` returned thinking, text and a `propose_notes` call with an inferred date marked `certain: false`.
- In the pane: the panel, chips, cards, the uncertain-date marker, the kept state and the question buttons render, from sample state that was not saved. The panel is read-only correctly while another tab is the writer.

**Not done or not verified**
- The plan's default engine switch (server store as default) was deferred. The data layer is unchanged and the HTTP store already makes it cloud-ready.
- The conversation lives in kv, which world archives do not export.
- `.docx`, email and calendar are deferred.
- I1 (10 notes in 5 minutes), I2 (a 20-page PDF in under 60 s), I3 (a live URL) and I6 (asks rather than guesses) were not measured end to end in the UI; that needs the writer tab and real use.
- No cost estimate in Settings yet: the token counts show in the chat footer only.

### Milestone 1b: anything can live in the world (2026-10-22)
User report: Claude kept a dropped photo as "My studio portrait" but said it could not attach the picture, because "notes here only hold text". Notes now keep originals of any type and point at live things.

**Model**
- `Attachment.kind` is `'image' | 'text' | 'file'`. Any file is kept byte for byte, up to 256 MB a file (was 64 MB, images and text only). `sniffMime` now recognises PDF and SQLite by magic, plus ~35 named formats (Office and iWork, epub, video, audio, archives, vCard, iCal, parquet, GeoJSON, KML, GPX, notebooks).
- `NodeRecord.embeds?: Embed[]` (`youtube | web | place`), optional, so older records are valid as they are.

**Intake** (`src/ai/chat/apply.ts`, `preview.ts`): every item keeps its original `File`, and Claude reads:
- PDFs ≤ 20 MB whole.
- Images whole. HEIC, oversize or unsupported types are re-encoded as JPEG ≤ 1568 px for Claude only; the original is kept as is.
- Text as text.
- Video: duration plus a frame from 10 % in. Audio: duration.
- Previews: CSV/TSV (rows, typed columns, first rows), JSON (shape; notebooks as cells), vCard (one line per contact), iCal (one line per event), zip (listing plus small text files), docx/pptx/xlsx (text, slides, sheets and strings).
- Anything else: name, type and size, and Claude asks.
- **Folders:** a folder with `.obsidian/` or mostly markdown imports as a vault. Any other folder is staged as its layout plus up to 60 files.
- **YouTube links** are read through oEmbed (title and channel).

**Keeping**
- Proposals gain `attach` (names of files from the conversation), `embeds` and `addTo` (an existing note's id: its files, embeds and links go onto that note instead of a new one).
- On Keep, the originals are stored with `addAttachment`. A note whose source is a URL embeds that URL even if Claude did not.
- Originals wait in memory until kept. After a reload, the card names any file that must be added again.

**Prompt.** The system prompt now says originals are kept and links become embeds, and tells Claude never to describe a picture instead of keeping it.

**Inspector** (`src/hud/NoteMedia.tsx`): video and audio play in place, PDFs view in place, and any file opens or saves. YouTube plays (youtube-nocookie), pages open, and places show an OpenStreetMap map (when they have coordinates) plus Apple and Google Maps links. Players and iframes load only on click.

**Vault.** Export writes originals to `attachments/<note>/<file>`, and frontmatter lists them along with `url`/`place`. Import attaches files that notes reference (`![[photo.jpg]]`, `[[paper.pdf]]`, or our own `attachments/` paths).

**Verified**
- `npm run check`: 82 files, 636 tests. One timing flake in `archive.autoBackup` passed on rerun.
- In the pane, from local sample state that was never saved: the video, PDF and contact-card rows and the YouTube, place and page embeds render.
- Live: a dropped image plus "Keep it" → `search_world`, then a `memory` proposal with `attach: ['portrait.png']`.

**Not done**
- Geocoding addresses (a place without coordinates gets map links, not a map).
- Reading inside databases, video or audio.
- Persisting not-yet-kept originals across a reload.
- Thumbnails for video.

### Milestone 2: the particle world (2026-10-22)
The user asked for the world to be "particles and waves instead of rigid bodies", time you experience rather than climb, and no single ring and circle. Built as the new default world. The classic world stays a setting: Settings → Quality → World: Field / Classic (per device, `hyperspace.view`).

**Design decisions (made by the agent, user to review)**
- **Space is meaning only.** `world/field/layout.ts` is a deterministic force layout. Links pull together (non-`relates` links pull harder), shared tags pull weakly, the top-4 semantic neighbours pull when the embedding index is on, and every pair repels. There are no archetype rings and no time axis.
  - It starts from the frozen anchors (scaled 0.45), so the world's shape is stable across reloads.
  - A warm start runs at 0.3 heat, so keeping a note nudges its neighbourhood rather than reshuffling the world (tested: existing notes move < 6 u; a newly linked one < 12 u).
- **Time is experienced through the timeline only** (`world/field/state.ts`). Everything is a pure function of the playhead, so scrubbing back restores the frame exactly (tested).
  - A note is born when the playhead passes its date and condenses out of a wide cloud over ~2 months.
  - Its order then decays with τ = 6 y toward a floor of 0.3: the cloud spreads and its rise in the land erodes.
  - Links hold order, up to half the decay at degree ≥ 6.
  - Every birth sends a wave across the land for 1.2 y (crest speed 70 u/y; at most 16 ripples at once).
- **Albert's framing.** The visible land is the macrostate: the sum of the born notes' bumps, with height = mass, links and order. Newborn notes are low-entropy (tight clouds) and age into high-entropy ones (diffuse). The engine's integer microstate keeps running underneath for the timeline's S and ΔE readouts, but in the field it no longer positions the notes.
  - **Deviation:** the grains are a shader animation over that macrostate, not the reversible integer dynamics. They are deterministic in the playhead, plus a cosmetic wall-clock shimmer that moves nothing time decides.
- **Rendering** (`world/field/FieldLayer.tsx`): three GPU point layers fed by two small float textures each frame.
  - **Land:** 300² jittered grains on a 128² heightfield, with an ambient swell, birth ripples and faint contours. It writes depth so the post fog sees land, not sky.
  - **Clouds:** 420–1600+ grains per note by mass, attachments and text (≤ 260k in all), additive and archetype-coloured.
  - **Image notes:** their grains are the picture. A 56² card of the thumbnail's pixels faces you and dissolves as order falls, and 60 % of the cloud takes the photo's colours.
  - **Currents:** 40 grains per link flow along an arc in the link kind's colour.
  - Selection, hover and the selection's neighbours brighten.
- **Shared pose table.** `world/field/runtime.ts` writes it in field mode, so screen labels (always on in the field), the link tooltip, fly-to and the Inspector work unchanged. `usePhysicsPoses` hands over to it; the physics client still runs.
- **Picking** (`FieldPicker.tsx`) is in screen space: the nearest born note within its on-screen cloud (≥ 26 px). A click is a press that moved ≤ 5 px, so orbit drags never select; a click on empty land deselects.
- **Hidden in the field:** the column, helix, catwalk, terrain ranges, colonnade, numerals, manifold, node meshes and plaques, link lines, year rings, present plane, overlays (citadels, mist, synapses, demon lattice), worldline and GPU dust. Third person and autonav (both ride the helix) are refused in field mode. Captured splat scenes still render at their notes.
- **Camera:** a raised three-quarter shot over the whole layout (`fieldShot`).

**Verified in the pane** (demo world, 14 notes, read-only tab):
- The land, clouds and labels render with no console errors.
- At 2004-11 nothing is born and the land is flat and empty.
- At 2010-11, Boltzmann and the one-month-old "Entropy is the arrow of time" show the newborn as a loose condensing cloud with its rise beginning.
- 120 Hz: median 8.3 ms, p99 9.4 ms.
- `npm run check`: 85 files, 644 tests (new: layout, time model, runtime and pose table).

**Not done**
- Attention (inspecting a note re-condensing it) is not wired, because the interaction log is async and not in the store yet.
- No level of detail for the land up close: grains thin out at ground level.
- No entropy readout for the field itself (the timeline's S is still the engine's).
- Currents for very large worlds are uncapped (40 × links).
- Image cards use the first image only.
- Splat scenes keep their terrarium scale (small against the field).

### Milestone 2b: refining the field (2026-10-22)
User: "exactly what I'm talking about… make it nicer, refine it"; keep the old design as a backup view; no Anthropic API calls for now (no credit). Nothing in this pass calls the API.

- **World view** is a top-level Settings section (Field (topographic) / Classic (structure), per device) and a palette command. `setWorldView` drops field-incompatible modes and asks the orbit rig to reframe.
  - **Bug fixed:** React's dev double-mount took the reframe on the first mount, then restored the old pivot on the second. A requested reframe now stays pending until a frame renders (`requestEstablishingShot`).
  - **Verified in the pane:** field → classic frames the notes' band (target y 387); classic → field frames the layout (target y 6).
  - `__wv.orbit()` reports the camera and the last establishing outcome.
- **Attention** (`world/field/attention.ts`): inspect, dwell and enter events give a note its order back. Order decays from the latest touch at or before the playhead, so the field stays a pure function of (playhead, log). The index reloads on the repo's `events`/`import`/`wipe` changes. Clouds ease toward their target (rate 6/s) on screen only; births and condensation still jump on a scrub.
- **Topographic land:**
  - Each note tints the ground under its rise with its archetype colour (64² tint grid).
  - Contours every 1.5 u, with an index contour every 7.5 u drawn brighter and larger.
- **Detail patch:** a 190² grain patch over 64 u, snapped to its grain, follows the point where the view meets the ground. It fades in within ~120 u while the coarse land's grains shrink. Land grains are capped at 4 px and cloud grains at 5 px (smaller world sizes), so close views read as fine sand rather than pebbles.
- **Field entropy** in the timeline: in the field, S is the summed differential entropy of the born clouds, Σ ½·3·ln(2πe σ²). It rises as notes age and falls when you return to them. Classic still shows the engine's S.
- **Tests:** 647 pass (new: attention, entropy, timeline readouts in both worlds).
- **Noted, not fixed:** a read-only follower tab took ~45 s to load in the pane, before and after this work. To check in the writer tab.

### Milestone 2c: scenes and videos in the field (2026-10-24)
Toward "the same but more detailed, where we can see scenes and videos or spaces in time". No API use.

- **Scenes** (`world/field/FieldMedia.tsx`, `FieldScenes`):
  - A memory with a captured Gaussian-splat scene mounts the same `Diorama` as the classic world, on the land at its note. Its radius grows from 3.5 u (≥ 160 u away) to 10 u (≤ 45 u away), scaled by condensation.
  - The note's cloud thins as you approach (up to 85 %; `sceneReveal` → a third row in the note texture) so the scene shows through.
  - A depth stand-in box (`colorWrite` off, `renderOrder` 100, the classic trick) keeps post fog from treating the splats as sky.
  - The scenes group sits outside the `field` group, and `field` is now in `WORLD_GROUP_NAMES`, so entering a scene hides the land but not the scene.
- **Entering:** double-click a scene note in the field (`FieldPicker` → `flyIn`), or use the Inspector's Enter. Screen labels step aside while entering, inside and exiting.
- **Videos** (`FieldVideos`): the nearest 3 born video notes within 140 u (re-ranked at 2.5 Hz) each mount a muted, looping `<video>` and a 96-column grain card facing you. The card samples the `VideoTexture` and frays at the edges as the note loses order. Videos pause and unmount when far; nothing decodes otherwise.
- **Verified in the pane** (demo world; Tomatoes, Apartment and Lion hold scenes):
  - The tomato capture stands on the land and grows as you approach.
  - The Inspector's Enter flies into it with the field hidden, and Esc returns.
  - A dispatched `dblclick` on the note enters too (`mode` → `entering`). The pane tool's double-click did not fire a DOM `dblclick`.
  - 120 Hz: median 8.3 ms, p99 9.7 ms.
  - `npm run check`: 86 files, 648 tests.
- **Not verified:** video cards. This world has no video notes, and the pane tab is read-only, so I could not add one. Needs a real check in the writer tab: drop a video in the chat or the editor, keep it, and zoom near it.

### Milestone 2d: verifying media, an index guard, and the slow load (2026-10-24)
- **`#/sandbox/field` (dev only):** the real WorldPage on a throwaway in-memory world. It has the demo plus a generated 3 s canvas video ("Waves at the pier"), a generated sunset photo, and a link between them. It swaps the page's store for `createMemoryStore()` (no writer lock, no sync, no backups) after boot. The test video is drawn on a timer, because animation frames are throttled in hidden panes.
- **Index guard (`ce1c417`):** running that sandbox exposed a real hazard. The semantic indexer prunes every embedding whose note is not in the open world, and it kept writing to the SQLite server's vector store after the swap. It deleted the real world's 14 embeddings and wrote 34 sandbox ones.
  - **Now:** in-memory worlds are never indexed. The vector store follows the store actually open, not the engine preference. `stopSemantic()` pauses without changing the preference, and a pass aborts at its next await after a stop or swap.
  - **Repaired:** the 34 strays were deleted (only ids absent from the real world, live or trashed). The real world re-indexed its 14 notes locally (EmbeddingGemma, no API).
  - **Verified:** 14/14 embedded, 0 strays.
- **Photo and video cards:**
  - **Before:** both rendered but read as dark and muddy. They were additive grains that don't write depth, so the post fog treated them as sky. The video texture also never updated in a throttled view (VideoTexture relies on `requestVideoFrameCallback`), and labels sat on top of the cards.
  - **Now:** cards are their own draw of solid, depth-writing grains (`field-cards`). The video card is solid too, with an sRGB texture, and it uploads a frame whenever `currentTime` advances. Notes with a picture or video are labelled underneath (`LabelCandidate.sides`).
  - **Verified in the sandbox:** the sunset card shows sky, sun and water. The video card shows the gradient, the "WAVES" text and the disc moving between frames.
- **Pending originals survive a reload:** chat files are copied to a per-browser IndexedDB store (`hyperspace-intake`, 14-day expiry) as well as memory, and a keep looks there (`src/ai/chat/originals.ts`).
- **Slow load:** it was the hidden preview pane, not the app. Startup marks (`__wv.timings()`) show data ready at ~55 ms and all modules loaded by ~90 ms. The canvas then waits for layout and animation callbacks a hidden pane doesn't deliver; with the pane painting, the scene mounted at 3.5 s, including a 3 s video recording. A visible tab is unaffected.
- **Dev hooks:** `__wv.field(filter)`, `__wv.fieldMedia()`, `__wv.orbit()`, `__wv.timings()`.
- `npm run check`: 88 files, 652 tests.
