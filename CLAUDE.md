# Architectural Hyperspace

A spatial second brain and 4D worldview engine. The build plan is [docs/PLAN.md](docs/PLAN.md); its latest product amendment takes precedence over the historical Y=time presentation. It is the source of truth for scope, stack, physics and acceptance criteria. Decisions that deviate from it go in [docs/DECISIONS.md](docs/DECISIONS.md).

## Commands
- `npm run dev`: Vite on http://localhost:5173 (strictPort; storage is partitioned by origin, so never change the port)
- `npm run check`: typecheck + lint + fast tests. Run it before declaring work done.
- `npm run test:accept` / `npm run bench`: full-size physics acceptance and benchmarks (Node 26 runs `scripts/*.ts` directly)
- `npm run serve`: production build + preview on the same origin
- The dev/preview server also hosts the SQLite engine and `/api` (`server/`). Data in `data/` (gitignored). Put `ANTHROPIC_API_KEY` in `.env.local` (see `.env.example`) for omnibox refinement; never give it a `VITE_` prefix.

## Hard rules
- **Pinned stack.** Exact versions only (`.npmrc` has `save-exact`). three must stay at 0.186.1 (postprocessing requires <0.187). Do not add dependencies without recording why in DECISIONS.md. TypeScript stays on 6.0.x (typescript-eslint needs <6.1).
- **WebGL2 only.** No WebGPURenderer, no WGSL, no MeshPortalMaterial for splats, no transmission materials. Exactly one `SparkRenderer`.
- **Physics is integer-only** (`src/physics/`, `src/gpu/dust/`): no floats inside the kick K or the integrator; every op must have a bit-identical GLSL ES 3.00 translation. No DOM imports in `src/physics/`.
- **Erasable-only TypeScript everywhere** (`erasableSyntaxOnly`): no `enum`, `namespace`, parameter properties, or `import =`. Use relative imports with explicit `.ts`/`.tsx` extensions and `import type` for types (`verbatimModuleSyntax`).
- **Positions/velocities are never persisted.** They are derived from (records, settings, step).
- **Visible XYZ is spatial; time is the fourth dimension through history.** The latest user direction overrides the old Y=time display rule. Topic/relationship neighborhoods determine visible XYZ; dates control births, ghosts and replay, not elevation. Editing only a date must not rearrange spatial neighborhoods. The old date-derived Y may remain inside the integer engine for compatibility, but must be mapped into the shared spatial render poses rather than shown as calendar height. Keep presentation motion bounded and the reversible kernel unchanged.
- Shared contracts: `src/domain/types.ts`, `src/domain/constants.ts`, `src/domain/time.ts`, `src/app/store.ts`, `src/world/poses.ts`. Extend them additively; never rename or remove fields that other modules use.
- Node ids are uuids; `crypto.randomUUID()`.
- Tests live in `tests/` (vitest, node environment by default; add `// @vitest-environment jsdom` per file when needed; `fake-indexeddb/auto` for IDB).

## Style
- Small modules, named exports (React route pages default-export). Comments explain *why*, not *what*.
- Tailwind v4 plus shared HUD primitives and `src/workspace.css`. The current product UI uses readable sans-serif, restrained rounded surfaces, integrated navy navigation and Companion surfaces, silver text and amber/cyan accents; the 2026-11-04 redesign in DECISIONS.md supersedes the original brutalist HUD direction.
- Colors: tokens in `@theme` in `src/index.css` (void, concrete, bone, brass, ember, signal, glass).
