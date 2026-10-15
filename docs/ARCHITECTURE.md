# Architecture

See the architecture tree in [PLAN.md](PLAN.md#architecture). This file records how the pieces actually connect as they land.

## Layers
- **Domain** (`src/domain/`): record types, constants, time ↔ Y ↔ step mapping, validation.
- **Data** (`src/data/`): `WorldStore` adapter (IndexedDB records/events/settings, OPFS blobs), archive export/import, locks.
- **Physics P** (`src/physics/`, `src/gpu/dust/`): integer reversible microdynamics. Never reads overlays.
- **Overlays O** (`src/overlay/`): pure functions of (wall-clock t, event log).
- **World** (`src/world/`): R3F scene. Render pose = O(P(n), t, log), published through `src/world/poses.ts`.
- **HUD** (`src/hud/`): DOM overlay on top of the canvas.

## Data layer
Browser storage is the only copy of the world, so every path below is written to fail without losing data.

### Modules
| Module | Role |
|---|---|
| `domain/validate.ts` | Pure record/settings validation (`validateNode`, `validateSettings`), slugs, drafts with per-archetype defaults. σ conflicts come back as `spacing: snap` (a free spot ≤ 2σ away) or `reject`. |
| `domain/placement.ts` | Deterministic anchors: ring radius per archetype, sector from the primary-tag hash, id-seeded jitter, Vogel-spiral nudge to keep ≥ σ in 3D. Catwalk spur geometry and the core-clearance test. |
| `data/WorldStore.ts` | The storage contract. `memoryStore.ts` (tests, fallback) and `idbStore.ts` (IndexedDB records/events/settings/kv/asset meta; blob bytes in OPFS `blobs/`, or in IndexedDB where OPFS `createWritable` is missing). |
| `data/opfs.ts` | OPFS blob directory and `backups/`. All writes go through `createWritable` (swap file, atomic on close). |
| `data/locks.ts` | Web Locks single writer (`hyperspace-writer`), BroadcastChannel sync, `withSync` (refuses writes in read-only tabs, announces committed ones). |
| `data/archive.ts` | Streaming zip export (stored entries through fflate `Zip`) and validating import (reads the central directory, not fflate `Unzip`). |
| `data/backupTargets.ts` | Where the pre-import backup goes: OPFS, else a separate IndexedDB database (`hyperspace-backups`). |
| `data/autoBackup.ts` | Optional rolling backups to a user-picked folder (Chrome): debounced 60 s, at least every 10 min, newest 5 kept; backup-age nag. |
| `data/storage.ts` | `persist()`, quota estimate, private-window and Safari-eviction heuristics into `useWorld.storage`. |
| `data/repo.ts` | The façade the app calls. Serialises actions through one queue; validates; updates `useWorld` optimistically and rolls back on failure. Status in `useRepoStatus`. |
| `app/boot.ts`, `app/devApi.ts` | `bootData()` runs once from `main.tsx` (outside React): `initRepo()` and, in dev, `window.__wv`. |

### Flows
- **First run.** `initRepo` opens IndexedDB (memory fallback if it cannot), takes or queues for the writer lock, hydrates `useWorld`, probes storage, purges trash older than 30 days. With no settings the UI asks for T0; `completeFirstRun({T0, start})` writes the demo or empty world's records first and the settings row last. The settings row is the commit marker, so a failed first run is retried rather than half-done.
- **Create.** `createNode`: defaults from the archetype, unique slug, `placeAnchor` against live anchors, validate (σ conflicts are rejected, not snapped, for a fresh placement), optimistic upsert, `putNode`, select, "Created …" toast. Undo hard-deletes the never-wanted node with its blobs. Anchors are frozen afterwards. Only a primary-tag change (`updateNode`) or a drag (`moveAnchor`, snaps within 2σ) moves one, and a date change keeps XZ unless σ breaks.
- **Delete / undo.** `softDelete` sets `deletedAt` (the node moves to `useWorld.trash`) and toasts Undo → `restore`. Restore re-validates and nudges if its old spot was taken meanwhile. Links to a trashed node only warn. `purgeExpiredTrash` / `emptyTrash({confirm})` hard-delete: other records' links are removed, then the records, then their blobs. If a purge fails part-way, `useWorld` is reloaded from the store.
- **Export.** `exportWorld(sink)` runs inside the action queue (a consistent snapshot) and streams nodes, events, then each asset (fetched one at a time), then `assets.json` and `manifest.json` (counts, settings with T0, `recordsHash`). zip32 limits are checked before the first byte. A finished export sets `lastBackupAt`. Chrome streams to `showSaveFilePicker`; Safari and Firefox fold Blob parts and download.
- **Import = replace.** `importWorld(file)`: (1) parse and validate everything (central directory, manifest, every record and event line, records hash, CRC of every asset) with no writes; (2) stream a backup of the current world to OPFS `backups/pre-import-<ISO>.zip` (IndexedDB fallback) and keep the newest 3; (3) wipe, write the `importInProgress` kv marker, write settings, records, events, blobs, restore device kv (`autoBackupDir`), and remove the marker. If (3) throws, the backup is restored automatically. If the tab dies during (3), the next `initRepo` finds the marker and sets `useRepoStatus.interruptedImport`, and the UI offers `recoverInterruptedImport()` or `dismissInterruptedImport()`. Afterwards other tabs get one `import` notice and rehydrate.
- **Multi-tab.** The first tab holds the Web Lock for its lifetime. Later tabs are read-only (`useRepoStatus.writer = false`, writes throw `ReadOnlyError`, `logEvent` drops) and queue for the lock. When the writer closes, the next tab takes over and rehydrates. Every committed write is broadcast (`StoreChange`). Readers re-read the named records in arrival order, or rehydrate on `settings`/`wipe`/`import`. A tab whose IndexedDB connection is closed by an upgrade elsewhere releases the lock. A memory-fallback tab is private and always its own writer. Auto-backups run in the same queue, so they never interleave with edits.

## World scene (Phase 3c)
`WorldPage`'s `Scene` sets the frame order: the playhead clock at −3, then the pose writer at −2. The pose writer calls `applyOverlays` after it writes the physics poses. After those come the children:
- environment, nodes and links;
- the `overlays` group (`world/overlays/`: citadels, mist, synapses, demon lattice, Kepler satellites, plus dwell logging);
- the worldline ribbon (`world/worldline/`), which autonav rides;
- dust, splats, the camera rig and post.

The interior hides the top-level groups named in `WORLD_GROUP_NAMES`: environment, node-layer, links, dust and overlays. The worldline hides itself.

`#/lab/perf` composes the same scene without the HUD or camera rig. For the run it swaps the repo onto a private in-memory fixture world (`lab/perf/fixtureWorld.ts`) and swaps the IndexedDB world back afterwards.
