# Architectural Hyperspace — Phases 1–3 Implementation Plan

## Context
The repo is greenfield: only a `README.md` stating the aim to "capture an individual's entire worldview … in 4D in physics / mathematical grounding". The user supplied a full engineering spec for a brutalist 4D "thermodynamic worldview engine".

Two workflows checked it before this plan:
1. A **12-agent research workflow**: 6 domain researchers, each paired with an adversarial verifier. It checked the spec against current libraries (as of 2026-10-13) and ran numerical experiments.
2. A **3-critic review** of the first draft, covering physics, rendering and product. Its fixes are folded in below.

The research found that several spec items are infeasible or wrong:
- The named splat library is unmaintained.
- The float32 curl-noise "Hamiltonian" shader heats up without bound and is not reversible (RMSE ≈ 150 u after 6000 steps).
- WebGPU conflicts with the only maintained three.js splat renderer that has LoD.
- Some acceptance criteria are ill-posed.

**Decisions made with the user**
| Topic | Decision |
|---|---|
| Scope | **Phases 1–3**: explorable world, splat dioramas, reversible physics and time scrub. Stop for review before the data/AI engine, capture pipeline, desktop shell and publishing (Phases 4–5). |
| Physics | **Exact fixed-point Hamiltonian**: bit-reversible integer leapfrog, conservative potentials, measurable entropy rise from a Past-Hypothesis state. Demons and Hebbian plasticity form a dissipative overlay driven by an event log. |
| Axes | **Y = time** (`temporalOrigin`), as the spec says. X/Z are semantic. Hebbian elevation is a bounded offset. |
| Content | Starts empty. A **local-first in-app editor** (IndexedDB + OPFS) with first-run onboarding, export/import, backups and an optional demo seed. |
| Framework | **Vite + React SPA** instead of Next.js. |
| Renderer | **WebGL2 + Spark 2.3.1**. The physics runs as an **integer-only** kernel: nodes on a CPU worker, dust on WebGL2 integer GPGPU. CPU and GPU produce identical bits, and so does every browser. |

## Pinned stack
Versions were verified with `npm view` on 2026-10-13. Re-check them at scaffold time and pin exactly, with no `^` on the 3D stack.
- vite 8.3.4, @vitejs/plugin-react 6.1.2, react/react-dom 19.3.0, typescript (current stable), tailwindcss v4 with @tailwindcss/vite.
- **three 0.186.1 exactly**, because postprocessing 6.39.5 requires three <0.187.
- @react-three/fiber 9.8.1, @react-three/drei 10.7.9, @react-three/postprocessing 3.2.0.
- **@sparkjsdev/spark 2.3.1**. It is WebGL2 only and reads SPZ v1–3, PLY, SPLAT, KSPLAT, SOG and RAD. Its dependency fflate is reused for zip archives.
- zustand 5.0.15, maath 0.10.8, leva 0.10.1 (dev only), idb (pinned at scaffold), vitest (pinned at scaffold).
- The physics core is **erasable-only TS** (`erasableSyntaxOnly`, `.ts` import specifiers), so Node 26 can run `scripts/*.ts` directly.
- **Not used**:
  - @mkkellogg/gaussian-splats-3d: unmaintained, no LoD.
  - MeshPortalMaterial for splats: one SparkRenderer per portal multiplies the cost.
  - Transmission glass: three's transmission pass excludes transparent splats.
  - WebGPURenderer: breaks Spark, drei's reflector and Text, and postprocessing.
  - A WGSL backend: outside the WebGL2 decision; moved to the roadmap.

## Architecture
```
index.html · vite.config.ts (server+preview port 5173, strictPort) · .claude/launch.json (preview_start) · public/manifest.webmanifest
src/
  main.tsx, App.tsx            hash routes: #/ world · #/lab · #/lab/perf
  app/store.ts                 zustand: camera-mode machine, selection, clock {step, speed, playing}, panels, quality tier
  app/devApi.ts                dev-only window.__wv (ingestFromUrl, exportArchive, wipe, importArchive, recordHashes, flyIn/Out, stats)
  domain/types.ts · domain/time.ts · domain/validate.ts · domain/schema.sql (Phase-4 target DDL, documentation only)
  data/WorldStore.ts           adapter interface + memoryStore (tests) + idbStore (IndexedDB records/events/settings, OPFS blobs)
  data/archive.ts              streaming export/import (fflate Zip + ZipPassThrough), auto-backup folder, pre-import backup
  data/locks.ts                Web Locks single writer + BroadcastChannel refresh; IDB blocked/versionchange handling
  data/seed/demo.ts            optional demo worldview (biographical dates) + fixture-backed memories (Phase 2)
  physics/                     integer-only, NO DOM, shared by worker · GPU shader generator · lab · tests
    fixed.ts                   Q-formats, odd-symmetric drift, round-half-even shifts, checked-product helpers, fnv1a
    sinlut.ts                  4096-entry Q1.15 Int16Array sine table + integer interpolation (same table uploaded to GLSL)
    potentials.ts              per-axis harmonic tether (stiff Y), XZ Fourier landscape × per-node coupling τ_i, polynomial pair core + birth ramp
    grid.ts                    integer-cell uniform grid; per-pair i32 kicks (order-independent)
    integrator.ts              forward/backward over active sets; spawn regeneration at birth crossings; stable slots
    world.ts                   records → anchors, birth steps, spawn states (seeded per id); validation asserts
    clock.ts                   Scrubber (acc -= n; frameDt ≤ 0.1 s) · Checkpoints (step 0 + every 600) · IDB checkpoint cache
    entropy.ts                 KL 6D (k=4, r=0 guard, deterministic id-hash sampling) · energy.ts (sync velocity, birth-compensated ledger)
    shadow.ts                  f64 continuous shadow map (N ≤ 8) for the Jacobian/symplectic tests
    worker.ts                  load/edit/seek/speed → transferable Float32Array poses + stats; CPU dust rows for edits
  gpu/dust/                    WebGL2 RGBA32I MRT ping-pong, k-steps-per-draw loop, checkpoints, segment allocator, row uploads
  overlay/hebbian.ts · overlay/demon.ts · overlay/kepler.ts
  world/                       R3F scene: HyperspaceCanvas, environment/, nodes/, splats/, links/, worldline/, camera/, post/
  hud/                         FirstRun, Timeline, Inspector, NodeEditor, ArchetypePicker, Library, DemonPanel, CommandPalette,
                               Stats, Settings (storage badge, origin, backup, credits), Trash, UndoToast
  lab/                         LabPage (physics demos, CPU↔GPU checks) · PerfBench (#/lab/perf)
tests/                         vitest (fast tier) · scripts/accept-physics.ts (full tier) · scripts/bench-physics.ts
docs/                          PHYSICS.md · ARCHITECTURE.md · DECISIONS.md · ROADMAP.md · CREDITS.md · CHECKLISTS.md
scripts/fetch-fixtures.sh      downloads the CC-BY splat fixtures (run only after user approval)
```

### Data model and storage (local-first)
- **`NodeRecord`**:
  - Core fields: id (uuid), slug, archetype, title, contentMd, tags[].
  - Time: **`temporalOrigin`** (when the item entered the user's life or worldview, epoch ms) with `temporalPrecision`, plus an optional display-only **`referenceDate`** for historical items (e.g. Boltzmann, 1877).
  - Physics: `thermo {mass ∈ [0.25,4], temperature ∈ [0,1]}`.
  - Placement and relations: **`anchorXZ`**, frozen at creation; `links[]`; `attachments[]` (images or text logs in OPFS, with webp thumbnails); visibility; `schemaVersion`.
  - Per-archetype blocks:
    - `splat {proxyAssetId, interiorAssetId, entryPose, crop, upFix, counts}`
    - `entity {kind}`
    - `demon {query, radius, active}`
  - `deletedAt` for soft delete.
- **Settings**: **`T0`** (birth date or worldview start), captured at first run, stored in the archive manifest and never derived from data. Changing it is an explicit "re-layout world" action that triggers a full recompute. The other fields are Y_PER_YEAR = 12 u, STEPS_PER_YEAR = 600, physics seed and quality tier.
- **Validation** (`domain/validate.ts`, also asserted in `world.ts`):
  - `temporalOrigin ∈ [T0, now + 5 y]`
  - `span · Y_PER_YEAR ≤ 3000 u` (≤ 250 y)
  - |anchor| < 3000 u
  - anchors at least σ apart: the placement is snapped or rejected
  - mass and temperature within their ranges
- **No positions or velocities are persisted**. They are a deterministic function of (records, settings, step). A deliberate deviation from the spec's schema.
- **Durability**. Browser storage is the only copy, so the plan includes:
  - **Backups**: streaming export (stored zip, because SPZ is already compressed) through `showSaveFilePicker` in Chrome or Blob parts in Safari, and streaming import. An optional Chrome auto-backup folder (a `showDirectoryPicker` handle kept in IDB) gets a debounced rolling backup.
  - **Storage protection**: a web-app manifest, so installing the app wins persistence. `navigator.storage.persist()`, with a "persisted / best-effort" badge. Private-window detection.
  - **Visibility of risk**: a "last backup N days ago" badge with a nag after 3 days. A Safari 7-day-eviction warning.
  - **Recoverability**: soft delete with a 30-day trash and an undo toast. Import means "replace" and always takes an automatic pre-import backup first.
  - **Concurrency**: a Web Locks single writer, with BroadcastChannel to refresh other tabs.
- **One canonical origin**: dev and preview both serve on `localhost:5173` with `strictPort`, because storage is partitioned by origin, port included. Settings shows the origin. Chrome, Safari and the built-in pane keep separate stores, bridged only by export/import. `npm run serve` (build + preview) gives a stable local "website".

### Space and time (Y = time)
- `Y(T) = Y_PER_YEAR · years(T − T0)`. Node anchor `y = Y(temporalOrigin)`.
- Time runs from T0 to now + 5 y, so future plans are allowed.
- Items born after the playhead render as ghosts.
- **Placement is frozen at creation.** Only the new node is placed:
  1. Start from the archetype's ring radius and an angle from the tag-hash sector, plus jitter seeded by the id hash.
  2. Nudge to keep ≥ σ from existing anchors.
  3. Persist the result.
  A tag change re-places only that node. Dragging uses an XZ-constrained gizmo with Y locked to the date. Phase 4 swaps in embedding projection.
- **Physics clock = biographical time.** dt = 1/60 s and 600 steps per year. At 1×, a year passes in 10 s; at 10×, in 1 s.
- **Helical brutalist catwalk** around a central core:
  - One turn per year (pitch 12 u, radius ≈ 13 u, ≈ 15% grade).
  - Year landings with engraved numerals.
  - A **radial spur** for each memory cube, attached where the helix angle equals the node's sector angle φ, on the turn nearest the node's height. Any offset of ≤ ±6 u is taken up by a short stair on the pier.
  - A geometry test checks that no spur intersects the core cylinder.
- **Empty world**: the helix still spans T0 to now + 5 y. A "Present" landing carries an "Add your first memory" plinth and a Cmd+K hint.

## Physics core (full derivation in `docs/PHYSICS.md`)
**Two layers**:
- **P**: reversible integer microdynamics.
- **O**: overlays, pure functions of (wall-clock t, event log).

P never reads O. Render pose = `O(P(n), t, log)`.

- **Hamiltonian** (u = x − anchor):
  `H = Σ|p|²/2m + Σ U_T(u_i) + Σ τ_i U_L(x_i) + Σ_{i<j} λ_ij(n) φ(r_ij)`
  - **Tether** `U_T`: harmonic, per axis. kXZ = 1 and a **stiff kY = 16**, so |u_y| ≲ 0.25 u and chronology stays readable.
  - **Landscape** `U_L = Σ_{m=1..8} c_m cos(k_m·x + φ_m)`. The wave-vectors lie **in the XZ plane** (k_y = 0), with |k| ∈ (2π/6)[0.6, 1.4] and c ~ N(0, 0.8²). This is the source of chaos.
  - **Per-node coupling** τ_i = temperature_i. Cold nodes (τ ≈ 0, e.g. splat-bearing memories) stay essentially still, which avoids Spark #347; volatile ideas wander.
  - **Initial speed**: `v0_i = 0.8·√(T_i/m_i)`.
  - **Pair core** `φ = ε(1 − r²/σ²)³` for r < σ: a polynomial in r², so it needs no division or sqrt. σ = 3 u, ε = 50.
  - **Newborn ramp** `λ_ij(n) = smoothstep((n − max(n_i,n_j))/120)`. It is an integer LUT and stays exact, because the force at each step is still position-only.
  - **Load-time assert**: ω_max·dt < 0.5.
- **Integer-only kick K** for nodes and dust. Integer-only kicks are what make CPU and GPU agree bit for bit, and V8/JSC agree too.
  - Landscape: the phase is computed in i32 (`Φ = kq·X + φq`, wrapping mod 2³² ≡ mod 2π); sin comes from the shared 4096-entry Q1.15 LUT with integer interpolation.
  - Tethers: shifts and multiplies.
  - Pair core: fixed-point polynomial.
  - Overflow: products are bounded below 2³¹ by construction, using split multiplies where needed. A sweep test covers the full input ranges.
  - Rounding: round-half-even shifts.
  - Stability: no float enters K, so there are no fused-op or trig differences. Pair kicks are quantised per pair and summed in i32, so the result does not depend on order.
- **Integer leapfrog (Levesque–Verlet bijection)**:
  - State: X is i32 Q.19 (±4096 u); D is i32 Q.27 per step.
  - **Forward**: `D += K(X); X += drift(D)`. **Backward**: `X −= drift(D); D −= K(X)`.
  - Drift uses odd-symmetric rounding: `drift(D) = sgn(D)·((|D|+128) >> 8)`.
  - Time is an integer step; dt is fixed.
- **Births and slots**:
  - Each node gets a stable slot id from a free-list, so insert and delete never reorder arrays.
  - The active set is `A(n) = {i : n_i ≤ n}`.
  - Forward n→n+1 and backward n+1→n both act on A(n).
  - Dormant slots hold no state. Crossing n_i forward writes `spawn(record_i)`. Spawn is the per-node **Past-Hypothesis macrostate**: |u| ≲ 0.05 l with seeded noise that is never exactly 0, and v = v0·ê_i plus noise. The seed is the id hash.
- **Clock**:
  1. Clamp frameDt to ≤ 0.1 s, then `acc += speed·frameDt/dt`.
  2. `n = trunc(acc); acc −= n`.
  3. Run |n| steps.
  4. Render at `X·qx + acc·D·qv`.
  If |n| > 64, seek instead: go to the nearest checkpoint on either side and run ≤ 300 steps.
- **Checkpoints**:
  - Step 0 plus every 600 steps, storing only active slots.
  - Cached in IndexedDB as a derived cache, keyed by `hash(records born ≤ step, settings, PHYSICS_VERSION)`.
  - Cold start restores the checkpoint nearest "now" and runs ≤ 600 steps.
  - **Invalidation** starts from the minimum birth step over every node whose anchor, birth or spawn inputs changed (found by diffing old and new world inputs).
  - Recompute is progressive in the worker, playhead window first, with a "settling" indicator.
  - **Budgets** (measured by the bench, recorded in DECISIONS.md): cold start < 1 s and edit-to-visible < 500 ms at N = 1k. Real-time 10× is supported up to N ≈ 5k; above that, speed is capped by N.
- **Dust (GPU)**:
  - The same integer kernel without pairs, with an isotropic-ish tether (kXZ = 0.3, kY = 1.5) and a radial-burst spawn.
  - **Storage**: an RGBA32I MRT ping-pong (X, D) plus an anchor/birth texture, with `Nearest` filtering, `depthBuffer: false` and a GLSL3 RawShaderMaterial.
  - **Allocation**: a fixed budget of about 131k texels in 64-texel segments, with stable per-id slots. Memory nodes get priority; nodes beyond the budget get no dust.
  - **Dormant particles** are generated in the shader from the anchor/birth texture whenever n < n_i.
  - **Stepping**: k steps per draw in a shader loop, time-sliced to about 3–4 ms of GPU per frame. Checkpoints every 3000 steps use `copyTextureToTexture`.
  - **Edits**: because the kernel is identical on CPU, the worker computes the edited node's dust rows on the CPU and uploads them into the live target and every later checkpoint. The rest of the dust is untouched.
- **Entropy**: KL in 6D on z = (u/l, v/v_T), computed in the worker at ≤ 1 Hz. The sample is ≤ 2k slots chosen by id hash. The HUD shows "—" while |A| < 5. The normalised rise is shown only in the lab.
- **Energy**:
  - Velocity is synchronised: `v_n = D_n + K_n/2`.
  - The main world shows a birth-compensated ledger: `E_n − E_0 − Σ ΔE_births − ramp work`.
  - The acceptance test runs in the birth-free lab world.
- **Loschmidt flip** (lab world, birth-free): `F(X,D) = (X, −(D + K(X)))`, an exact involution.
- **Overlays** (dissipative, reproducible from the log):
  - **Hebbian trace**: `E ← E·e^{−λΔt} + A_k`, with post-event values stored, T_E = 7 d. Events: dwell ≥ 1 s, inspect, enter, demon match.
  - **Signed elevation** `Y_h ∈ [−Ymax, +Ymax]` around a decaying baseline, with Ymax = 2.5 u. Long-unvisited nodes sink slightly and get per-node mist, plus desaturation. Frequently visited nodes rise.
  - **Citadels**: a plinth or column accretes *under* a node, with height ∝ tanh E, while the node stays at its date.
  - **Synapses**: co-activation within 30 min updates `w = wmax − (wmax − w)e^{−ηc}`, with T_w = 90 d, pruning below w < 0.02 and degree capped at 24.
  - **Real-time note**: plasticity follows wall-clock interaction, not the scrub, and the UI says so.
  - **Demon**: matched nodes ease toward lattice slots, `r = x + w(t)(s − x)`. Activations are logged; the log is the demon's memory (Bennett). The ledger shows the recorded bits as *unpaid* Landauer debt (bits·kT_eff·ln 2), which is charged only when the user clears or compacts the log. Matcher v1 is keyword/tag BM25-lite.
  - **Kepler**: attachment cards and small glyphs of linked nodes orbit entity monoliths (T ∝ a^{3/2}). Real nodes never move.

## Rendering specifics
These were checked against package sources.
- **Canvas**: `<Canvas gl={{antialias:false}} dpr={[1,1.5]}>`, with `gl.info.autoReset=false` reset once per frame.
- **Composer**: `<EffectComposer multisampling={0} frameBufferType={HalfFloatType}>`. Spark renders correctly into the composer target: it takes its size from the render target and outputs linear colour.
- **One SparkRenderer** with `material.forceSinglePass = true`, which avoids three's double draw of transparent DoubleSide materials (verified in S1).
  - lodSplatCount is lowered dynamically so that `Σ proxies + focused ≤ 2M`.
  - `lodCleanupTimeoutMs = Infinity` for the focused slot.
  - Splat raycast is off; picking uses CPU poses.
- **Layers**: drei's reflector camera is a fresh PerspectiveCamera that renders **only layer 0**. Splats, dust, labels and glass shells go on layers > 0, enabled only on the main camera, so the floor reflects only the architecture and solid nodes. The reflector is unmounted outside third-person.
- **renderOrder bands** for transparent objects:
  | renderOrder | Contents |
  |---|---|
  | −2 | dust, filaments |
  | −1 | dark-glass back shells (depthWrite **off**) |
  | 0 | Spark |
  | 1 | additive fresnel front shells (carry `onDoubleClick`) |
  | 2 | labels |
  | 100 | **depth-only back-face proxies** (colorWrite off, depthWrite on), so post effects see cube depth without culling transparent content |
- **Fog**: depth-based post fog only, exp2 by distance plus analytic height fog. There is no scene FogExp2, because Spark ignores it. The 16-step noise raymarch is a stretch goal.
- **Mode-dependent post**: during `entering` and `first_person`, post DOF and height fog are off; Spark's native DOF is a stretch goal.
- **Bloom**: threshold Bloom on HDR emissive (`toneMapped:false`) instead of SelectiveBloom.
- **Environment map**: a PMREM from the sky scene (drei `<Environment frames={1}>` with the sky and Lightformers) so chrome, brass and obsidian read correctly.
- **Quality ladder** (drei `PerformanceMonitor`), applied in order:
  1. DPR 1.5 → 1.25 → 1.
  2. Reflector at 512, then off.
  3. DOF only during fly-in.
  4. Lower lodSplatCount.
  troika labels are pooled to the K nearest.
- **Camera**:
  - One `SparkControls` per canvas. On entering first-person, reset `lastTime`, clear keys and toggle `enable`.
  - Avatar movement and worker poses are applied at `useFrame` priority ≤ −2.
  - CameraControls is disabled during first_person and autonav.
  - Esc precedence: palette or modal, then first-person exit, then deselect.
- **Splat ingest** runs in a module Worker:
  - **Format sniffing**. SPZ v4 (starts with `NGSP`) is **converted in the browser**: parse the header and TOC, zstd-decode each stream with three's bundled `examples/jsm/libs/zstddec.module.js`, repack as v3 and gzip with fflate. A CLI hint is shown only for shDegree 4 or extension records.
  - **Transcoding** uses `transcodeSpz({inputs:[{fileBytes, fileType, transform}], clipXyz, maxSh, version:3})`, with explicit fileType and `bytes.slice()`. The crop box is in native splat units, the same units as the SplatEditSdf BOX.
  - **Proxies** (≤ 100k splats) are decimated in the browser via `spark.getLodTreeLevel(mesh, level)` → `extractSplats` → `writeSpz v3`. The fallback is a seeded importance subsample by opacity × volume.
  - **Interior** is stored as full-resolution SPZ v3, never raw PLY.
  - **Thumbnails** use a dedicated `SparkRenderer({target})`, awaiting `spark.update()` before reading.
  - **Framing** is a camera mode in the main canvas, not a second canvas (Spark #98/#107).
- **Fly-in**:
  1. Exponential scale tween of the non-LoD proxy about the entry pose, with lodSplatScale lowered during the tween.
  2. At rest, crossfade to the focused `lod:true` interior.
  3. The world group hides and SparkControls gives 6-DOF movement with roll.
  4. Esc reverses the sequence.
  If S1 shows the proxy tween stutters, fall back to dissolve-swap and record that as a deviation.

## Phases
### Must-ship core vs stretch
**Must ship**:
- first-run flow, editor, persistence and backup;
- anchors, then physics poses;
- splat ingest, dioramas and fly-in;
- the timeline scrub with births;
- dust;
- a basic HUD;
- the lab exactness demos.

**Stretch**, cut in this order if time is short:
1. noise-raymarch fog
2. Calabi–Yau manifold (torus ships first)
3. Kepler satellites
4. demon ledger visuals
5. "ride the timeline" camera
6. iridescent crystals
7. DOF outside fly-in
8. Spark native DOF
9. per-memory spatial audio
10. avatar junction switching (orbit + fly ship first)

Cuts are recorded in DECISIONS.md at each phase gate.

### Phase 0: scaffold and spikes (exits with DECISIONS.md entries)
1. **Scaffold**: the Vite/React/TS/Tailwind scaffold with pinned deps; npm scripts `dev | serve | typecheck | lint | test | test:accept | bench`; launch.json; doc stubs; CHECKLISTS.md.
2. **Minimal integer kernel** (the reference for S2): `fixed.ts`, `sinlut.ts`, the dust variant of `potentials.ts` and `integrator.ts`, with fast tests:
   - R1-lite at N = 100;
   - inverse(forward(s)) == s over random full-range i32 states, including wrap;
   - an overflow sweep.
3. **Fixtures**: with user approval, `scripts/fetch-fixtures.sh` downloads three.js `lion.v3.spz` and `tomatoes.v4.spz`, and PlayCanvas `apartment.sog` and `knock-community-hall.sog`, all CC-BY-4.0, with credits in CREDITS.md.
4. **S2 — integer GPGPU**: run the **real** dust kernel in an RGBA32I ping-pong. It must be bit-identical to the TS reference after 500 steps, and 500 forward plus 500 back must be the identity. Agent checks in the pane; the user checks in Safari.
5. **S1 — Spark**: 4 dioramas (with in-browser decimated proxies), the reflector, bloom and 100k points. Measure the frame-time distribution in the pane, and have the user measure in Safari and Chrome. Test:
   - #347: moving LoD meshes stutter;
   - #407: Chrome sort stutter on Apple Silicon;
   - the proxy scale tween;
   - forceSinglePass;
   - the layers exclusion from the reflector;
   - the depth-proxy band;
   - the getLodTreeLevel decimation quality.
   **Choose the primary browser here**: Safari, if #407 reproduces.

### Phase 1: graphics core and editor foundation
- **Domain and data**: domain/validate/time, memoryStore + idbStore, locks, archive (streaming, auto-backup, pre-import backup), trash/undo, Settings (storage badge, origin, backup age, credits), and `__wv` dev API.
- **FirstRun**: set T0 (birth date or worldview start); choose start empty, load demo or import; read a storage and backup explainer; optionally install as an app.
- **Environment**:
  - PMREM sky and stars;
  - the reflector floor;
  - instanced fluted columns with triplanar concrete;
  - monoliths and cantilevers;
  - the helix catwalk, landings and numerals, plus radial spurs per the attachment rule;
  - the torus manifold with label;
  - post fog, Bloom, SMAA, AgX and grain.
- **Node meshes at static anchors**:
  - instanced faceted crystals;
  - obsidian monoliths with instanced gravitational vector segments toward linked nodes;
  - brass and dark-glass astrolabe lenses with a flow-line cone along the axis;
  - concrete document slabs with text;
  - memory **tesseracts**: an outer cube and an inner cube joined at the corners, chamfered chrome rims, edge glow, and `MEMORY 001: Title [MM.DD.YYYY]` typography in self-hosted @fontsource woff;
  - explicit links drawn as plain lines.
- **Camera rig**:
  - third-person kinematic avatar on the path graph with a damped follow cam;
  - proximity highlight with metadata HUD and link illumination;
  - click to select;
  - generic first-person flight.
- **HUD**:
  - ArchetypePicker with one-line descriptions.
  - NodeEditor: date with precision and an optional referenceDate, tags, volatility/significance sliders, visibility, links, attachments.
  - After saving: select the node, fly to it, and show an undo toast.
  - Inspector, Library and a Cmd+K palette for navigation and actions.
- **Demo seed**: about 30 nodes with biographical dates (when ideas entered the user's life) and referenceDates for history.
- **Exit checklist (agent, in the pane)**:
  1. From a wiped profile, complete first-run.
  2. Add one node of each archetype and link two of them.
  3. Reload: all nodes are present with no console errors.
  4. Export, wipe and import: record hashes are identical.

### Phase 2: volumetric splat dioramas ("glass terrariums")
- **Ingest pipeline** as described above; SplatFramingModal as a camera mode; OPFS storage.
- **Rendering**: SplatDiorama (SplatMesh plus a SplatEdit BOX clip) inside the tesseract, using the renderOrder bands, and the tier manager:
  - impostor thumbnail;
  - ≤ 6 resident proxies of ≤ 100k each;
  - one focused LoD interior, with "crystallising" progress.
- **Fly-in/out** as specified.
- The demo seed gains 4 fixture-backed memories.
- Attachments get image cards in the Inspector.
- **Exit checklist**:
  1. Via `__wv.ingestFromUrl`, ingest lion.v3.spz, tomatoes.v4.spz (converted in the browser) and apartment.sog.
  2. Frame each, fly in and out 20×. renderer.info, `performance.memory` and the Spark mesh count show no growth.
  3. The user uploads one Scaniverse export through the UI and confirms its orientation.

### Phase 3: field physics, time and plasticity
- **Physics core and worker**: the full physics core and test tiers, then the worker (stable slots, births, ramp, spawn regeneration, checkpoints with IDB cache, progressive recompute, seek), then NodeLayer motion with interpolation.
- **GPU dust**: allocation, k-step loop, checkpoints, CPU-computed edit rows. Dust condenses on a memory at its date and diffuses with age.
- **Timeline HUD**:
  - a year-ticked bar from T0 through now to the future, with birth markers;
  - playhead seek, play/pause, ±0.1/0.5/1/2/5/10 speeds and a "Present" button;
  - readouts: date, step, S (shown as "—" when |A| < 5), the energy ledger, checkpoints and a "settling" state;
  - ghosts for future items.
- **Overlays**: Hebbian (events, signed elevation, mist, citadels, synapse filaments sized by w), demons (DemonPanel, placement, lattice, ledger) and Kepler satellites.
- **Worldline**: a Catmull-Rom ribbon through memory poses in date order, plus Autonav.
- **`#/lab` demos and checks**:
  - an N = 1000 birth-free Past-Hypothesis world with a stronger landscape to show chaos;
  - a live S(t) plot;
  - exact reversal and the Loschmidt flip `F`;
  - **arrow-of-time demo**: run forward ≥ 300 s, perturb, then reverse. Entropy keeps rising, and `(S_ret − S0)/(S_fwd − S0) ≥ 0.5`;
  - CPU↔GPU dust bit-identity;
  - a measured growth rate, documented in PHYSICS.md.
- **`#/lab/perf`**: a fixed fixture scene with a scripted 30 s camera path and 10× scrub, at 1920×1080 CSS and DPR 1.5. Outputs JSON.

## Spec deviations (recorded in `docs/DECISIONS.md`)
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
| Dissolve-swap fallback (only if S1 fails) | — | Spark #347 |
| FLOAT[1536] | float[512] (Phase 4) | A Matryoshka size every candidate embedding model supports |

## Acceptance criteria (replacing spec §8 items 1–3; item 4 is Phase 4)
Test tiers:
- `npm test` (< 60 s): N ≤ 1k, n ≤ 6000, 10 schedules of ≤ 2000 frames.
- `npm run test:accept` (full sizes): run at each phase gate, with results recorded in DECISIONS.md.

| ID | Criterion |
|---|---|
| R1 | Forward n then back n restores identical hashes, for n ∈ {1, 600, 6000} at N = 1k with births, and n = 36000 at N = 10k (accept tier). Random scrub schedules pass. The integer property test passes. |
| R2 | Identical results with shuffled neighbour lists. Checkpoint hashes match across runs. **Dust CPU ≡ GPU.** |
| L | f64 shadow map (N ≤ 8): `|det J − 1| < 1e-6` and mass-weighted symplectic defect < 1e-6. |
| E | Birth-free lab world: `|E_n − E_0| / ⟨KE⟩ ≤ 2e-3` over 36k steps, with no secular slope. The main world shows the birth-compensated ledger. |
| D | Minimum distance ≥ σ/2 among pairs older than 720 steps, over 36k steps at N = 10k. Newborn overlaps are reported separately. |
| B | `max|u_xz| ≤ 12 u`, `max|u_y| ≤ 0.5 u`, and the i32 overflow sentinel never trips. |
| S | Lab: `(S(t) − S0) / (S_plat − S0) ≥ 0.95` by 20 s, with a bit-identical return. The arrow-of-time ratio is ≥ 0.5. |
| G | The dust kernel matches the TS reference bit for bit and self-reverses. Agent checks in the pane; user checks in Safari. |
| P | **Safari is the gate**. At native refresh in `#/lab/perf`, ≤ 1% of frames exceed 1.5× the vsync interval, and median main-thread frame work is < 8 ms. Chrome results are recorded with a waiver for Spark #407. Measured by the user. |
| U0 | The Phase-1 exit checklist passes. |
| U | Archive round-trip, including an archive of ≥ 1 GB. SPZ v3/v4, PLY and SOG ingest entirely in the browser. 20 fly cycles show no growth. Undo/trash works. |
| Budgets | Cold start < 1 s and edit-to-visible < 500 ms at N = 1k. Real-time 10× up to N ≈ 5k. |

## Roadmap after review (`docs/ROADMAP.md`; not built now)
- **Engine**: `node:sqlite` on Node 26 with sqlite-vec 0.1.9 (`vec0 float[512] cosine`), behind a WorldStore HTTP adapter and a Vite proxy. The existing store migrates through the export zip.
- **Embeddings**: EmbeddingGemma 2 q4 in a worker via transformers.js 4.3.1, using the text-only AutoModel path and local wasm paths.
- **Omnibox**:
  1. Optimistic provisional spawn in < 1500 ms.
  2. Refinement with `claude-haiku-5-5`: `messages.create` with an `output_config.format` json_schema, effort low and thinking disabled, then a manual `safeParse` with a fallback on refusal. The key stays server-side.
- **Layout**: anchored incremental UMAP with Kabsch-aligned "re-crystallise" events.
- **Capture**: ffmpeg → COLMAP 4.2.1 (CPU) + orientation aligner → msplat 1.1.4 (`--input/--output/--num-iters`; Brush as fallback) → splat-transform `--spz-version 3`. Scaniverse is the pragmatic path.
- **Desktop**: requires Rust ≥ 1.90. Run a Tauri 2.12 vs Electron 44 spike first. The points at issue: the WKWebView 60 Hz cap, no cross-origin isolation under `tauri://`, and asset-protocol ranges capped at 1000 KiB. The app is already free of SharedArrayBuffer. Optional WGSL backend.
- **Publish**: Cloudflare Workers Static Assets + R2 (Range Worker; 25 MiB per-asset cap) + Access. Export strips private nodes, edges and embeddings, and CI runs canary greps.

## Verification
- `npm run typecheck && npm run lint && npm test` on every change; `npm run test:accept` and `npm run bench` at phase gates.
- The agent uses the built-in browser pane via `preview_start` (`.claude/launch.json`):
  - screenshots;
  - console-error checks;
  - `__wv`-driven U and U0 flows through `javascript_tool`;
  - `#/lab` G and exactness demos;
  - a `#/lab/perf` smoke run.
- **Checks only the user can run**: P in Safari 26 and in Chrome (window visible); G in Safari; a Scaniverse upload through the file picker; the ≥ 1 GB export with the save dialog.
- `npm run build && npm run serve` checks that the static build runs with no server and hash routes resolve.
- Each phase ends with its CHECKLISTS.md items. Execution pauses for the user's review after Phase 3.
