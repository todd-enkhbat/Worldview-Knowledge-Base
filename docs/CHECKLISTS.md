# Phase checklists

## Phase 0 — scaffold and spikes
- [x] Scaffold: pinned deps, npm scripts, launch.json, doc stubs
- [x] Minimal integer kernel + fast tests (R1-lite N=100, random full-range inverse incl. wrap, overflow sweep)
- [x] Fixtures fetched (user-approved), CREDITS.md filled
- [x] S2: GPU dust kernel bit-identical to TS after 500 steps; 500 fwd + 500 back = identity (agent: pane; user: Safari) — agent ✓ (pane, ANGLE Metal; N = 4k/16k/131k; negative controls fail as expected). **User: Safari pending** (`#/lab`)
- [x] S1: Spark spike measured (pane; user: Safari + Chrome); #347, #407, proxy tween, forceSinglePass, layers, depth proxies, decimation quality — agent ✓ (pane). **User: Safari + Chrome pending** (`#/lab/s1`)
- [ ] Primary browser chosen; DECISIONS.md updated

### How to measure S1 in Safari and Chrome (user)
The agent's numbers from the built-in pane are in DECISIONS.md under "Phase 0 — S1 (agent, built-in pane)". Repeat them on this Mac:

1. Run `npm run dev`. In each browser, open `http://localhost:5173/#/lab/s1` in a normal (non-private) window, maximised on the built-in display. Close other heavy tabs. Keep the machine on power.
2. Wait until all four dioramas in the bottom-right panel say **ready** (about 10 s). Leave the page alone for a further 30 s: the first run after load is consistently worse.
3. In the left panel, click **measure → orbit**. The camera flies a 20 s path. When it stops, click **copy json** and paste the result somewhere. Then run **orbit** a second time. Variance between runs is large, so keep both results.
4. Bisect. Untick everything in the first group except `forceSinglePass` and `depth proxies`, run **orbit**, then re-enable one feature at a time and run **orbit** after each: reflector floor, composer + bloom, 100k points, moving LoD mesh, proxy scale tween. Each run uses the toggles as they are when you click.
5. Run these tests:
   - **#347**: untick everything except `moving LoD mesh`, then click **static**. Watch the lion that slides left and right in front of the dioramas. Note whether it moves smoothly or in steps, and whether its detail visibly pops.
   - **Proxy tween**: tick only `proxy scale tween` and watch the box behind the row grow 12× and shrink every 6 s. Note any hitch.
   - **Decimation**: click **dioramas → lod / proxy** with **proxy method → cut**, then **level**. Press **H** to hide the panels and compare each box.
6. In the copied JSON, report:
   - `gl.unmaskedRenderer` and `userAgent`;
   - `fps`, `vsyncMs`, `interval` (p50/p95/p99), `shareOver1_5Vsync` and `gpuMs` (Chrome only; Safari has no timer query);
   - `spark.sorts`, `spark.getBufferSubDataMs` and `spark.lodTraversals`.

   `getBufferSubDataMs` p95 above about 10 ms together with a high `shareOver1_5Vsync` is the #407 signature (a sort readback stalling the main thread).
7. **Decide the primary browser.** Pick Safari if Chrome shows the #407 signature and Safari does not, at the same toggles. Record the choice in DECISIONS.md.

In the console, `await __s1()` runs the same 20 s orbit and returns the JSON. `__s1({ path: 'static', toggles: { reflector: false } })` overrides toggles for one run, and `__s1.set({...})` and `__s1.hud(false)` change the page state.

## Phase 1 — exit (agent, in the pane)
- [x] From a wiped profile, complete first-run
- [x] Add one node of each archetype and link two of them
- [x] Reload: all nodes present, no console errors
- [x] Export, wipe, import: record hashes identical

## Phase 2 — exit
- [x] `__wv.ingestFromUrl` lion.v3.spz, tomatoes.v4.spz (in-browser v4→v3), apartment.sog — 1.9 / 5.2 / 2.2 s
- [x] Frame each, fly in/out 20×: renderer.info, performance.memory, Spark mesh count show no growth — 20 cycles on the lion (156 s): programs 54→54, textures 70→70, geometries 109→109 (cycles 10→20), Spark meshes 0, settled heap 139–156 MB vs 144 MB at cycle 10
- [ ] User: upload one Scaniverse export through the UI and confirm orientation

## Phase 3 — exit
- [x] `npm run test:accept`: R1 R2 L E D B S pass; results in DECISIONS.md — all pass after the kY = 64 fix (B u_y 0.482 u)
- [ ] G: dust CPU ≡ GPU in the pane (agent) and Safari (user) — agent ✓ (pane, ANGLE Metal: `__wv.dustCheck()` bit-identical in 16/16 live checks across scrubs, reverse play, past/future edits and frees; `#/lab` panel G 15/15 and 35/35 checks). **User: Safari pending** (`#/lab` → G → run, or `await __dustIdentity()`)
- [x] `#/lab` arrow-of-time ratio ≥ 0.5; growth rate documented in PHYSICS.md — pane: 300 s run PASS, ratio 0.999, 998/1000 did not come home, control bit-identical; Reverse to 0 from step 4781 returns hash `0x5a5b8348`; growth panel τ = 0.770 s (PHYSICS.md: 0.75 ± 0.01 s over 60 s). See DECISIONS Phase 3c
- [ ] `#/lab/perf` smoke run (agent); P measured in Safari + Chrome (user) — agent ✓ (pane visible, 120 Hz: 4 fixtures attached, 0 slow frames in path + scrub, main 1.3 ms median, JSON from `await __perf()`). **User: P in Safari + Chrome pending**
- [x] Overlays (agent, pane): repeated selection raises E, Y_h (≤ 2.5 u) and the citadel and logs one `dwell` per visit; a demon query sorts its match onto the lattice in XZ only; DemonPanel ledger shows recorded bits and unpaid debt = bits·kT·ln2; the interior hides the overlays
- [x] Worldline + autonav (agent, pane): the ribbon runs through the memories in date order; "Ride the worldline" follows it, ends back in orbit, and Esc exits mid-ride
- [ ] Budgets: cold start < 1 s, edit-to-visible < 500 ms at N = 1k (bench) — cold start OK with cache (33–99 ms), 1.0 s first visit without one (30 y); hold frame 0 ms; full settle OK ≤ ~9 years back, **over for older edits** (569 ms node at 6000 steps; 1.0 s browser at 18 000). See DECISIONS Phase 3b
