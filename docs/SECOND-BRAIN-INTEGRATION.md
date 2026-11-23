# Second-brain integration delivered

Implemented November 23, 2026 in the existing working tree, preserving the preceding workspace rebuild and the current 3D world. The [research plan](research/second-brains/2026-11-23/INTEGRATION-PLAN.md) remains the original specification.

## Connected behavior

| Slice | Delivered |
| --- | --- |
| Retrieval | SQLite FTS and portable lexical search, optional existing local semantic fusion, GBrain page-grain reciprocal-rank fusion, exact full-version citations, relevance-only ranks/votes, timing and coverage inspector. Lexical-only scores are labeled separately without invented fusion votes. |
| Storage | Normalized source/version/passage/job/proposal/import authority across SQLite, IndexedDB, HTTP and memory. Idempotent delta commands use revision checks, atomic projections/sidecars and hashed replay receipts. Migration backups are verified before cutover; older writers are rejected. Portable snapshots materialize on demand. |
| Capture | Original-first manual/folder ingestion, structural Unicode-safe passages, shared vault resolution, ambiguity diagnostics, frontmatter/aliases/heading/block/embed retention and explicit links preserving pins. Durable voice originals, retry/recovery, timed locators/playback and transcription cancellation. |
| Shared memory | Named, scoped, expiring/revocable read clients; stateless MCP, equivalent HTTP operations and stdio bridge. Account/project/source boundaries and present consent apply to reads. Companion and MCP share bounded evidence-packet construction with approved current pages, exact citations and omission reporting. |
| Maintained knowledge | Topic/entity/project/answer/profile pages; evidence-backed claim history; separate authored/recorded/event/validity dates; manual corrections, diffs, review/undo, durable jobs, health/activity and stale-source invalidation. Answers can be explicitly promoted. Intentional reference objects appear in 3D. |
| Interchange | Markdown, identity-preserving JSON, Canvas and conservative Bases exports. Validated JSON reimport preserves UUIDs/history/policy/investigations and rejects collisions. Canvas/Bases inputs remain passive sources. Optional QMD mirrors/comparison commands revalidate full identities and consent. |

**Knowledge pages** is in workspace navigation. **Sources & activity** includes voice/media, portability and shared memory. Large access/selection lists use bounded batches and filters. A failed workspace download presents a reload action.

Permanent source deletion atomically removes associated voice receipts and scrubs dependent page/claim bodies and reference nodes. Hashed withdrawal/replay decisions do not retain deleted prose. Older recovery backups remain independent retained copies. Async capture, transcription, generation, export and conversation work guard world/account replacement and recovery.

## Downloaded code reused

GBrain commit `47512aa50fa2be1ab3af55bf60c242a11be76392` supplies MIT `rrf-page-fusion.ts` (local narrow type adapter) and unchanged `supersede-interval.ts`. License and attribution are in `src/vendor/gbrain/`. Claude-Mem's Apache-2.0 context-budget design informed the independently implemented packet builder; reference license/NOTICE are retained in `src/vendor/claude-mem/`. MIT Obsidian format references informed the interchange implementation.

Basic Memory's AGPL core and Karpathy's unlicensed gist were not copied into the runtime. Supermemory's private engine is absent from its public repository. No overlapping external memory database or downloaded agent instructions are installed. The pinned research inventory and inert reuse kit remain available.

New exact dependencies: `immer@11.2.10`, `@modelcontextprotocol/sdk@1.32.2`; see [decisions](DECISIONS.md). Registry audit reported no advisory against either addition. All ten reported dependency entries matched their pre-integration versions and belong to development tooling (ESLint/minimatch and jsdom/undici); no blanket upgrade was applied.

## Verification

- `npm run check`: typecheck, lint, **1,025 passing tests across 159 passing files**. One opt-in benchmark is skipped by the ordinary suite; actual benchmark runs are separately retained.
- `npm run build`: production bundle succeeds. Existing Tailwind sourcemap/dependency deprecation warnings remain.
- Fifty synthetic evaluation cases per lexical engine: 700 policy/citation/delivery checks and all 12 abstentions pass. Controlled recall@5/MRR@5 are 1.0; this does not establish real-user or semantic-model quality. See [methodology](evaluations/README.md).
- Real SDK MCP negotiation/tool calls and equivalent HTTP reads cover client scope, account isolation, revocation, expiry, origin, projects, consent, exact evidence and same-revision restore.
- Production browser pilot: three captures → reviewed page/statement rejection → exact original citation → intentional 3D reference → return to workspace. Source exclusion hides dependent wording/history. A synthetic WAV saves an original without starting inference. Portable export and responsive search/trace controls work.
- Apple M5 Pro/Node 26 command benchmarks: 50k-source capture p95 **823.505 → 442.495 ms**; separate 10k-source/10 KiB capture p95 **111.809 ms**. Browser rendering/inference are excluded. See [complete distributions and limitations](evaluations/knowledge-performance-2026-11-23.md).
- All **152** pre-integration world/physics/GPU files are unchanged. Personal data matches the verified pre-integration backup: **14 node rows and 4 link rows identical; all 23 originals match SHA-256**.

Synthetic pilot screenshots are in `docs/design/integration-{knowledge-page,search,world}-2026-11-23.jpg`. The temporary QA preview was shut down; the user's existing development server was preserved.

## Live-services follow-up — 2026-11-23

The current app now exposes installed native QMD, Telegram capture setup, pinned browser/server Whisper and an OpenAI/Anthropic provider selector. The real browser pilot saved a synthetic WAV, verified the original SHA-256, produced two timed passages, searched them through native QMD hybrid, and loaded original audio at the cited 7.2-second position. A real MCP SDK client read those same exact passages and context; its revoked token returned 401. Telegram intake with simulated Bot API transport also ran real local OGG/Whisper inference. Actual Telegram delivery and cloud generation remain unverified until credentials and API credit are supplied.

Typecheck, ESLint and the production build pass. The final broad regression run passed 1,072 tests, with a physics-clock timeout and one UI worker-start timeout; both affected files then passed in isolation (18 tests). Focused provider/conversation/delivery/usage tests passed 33/33, and Telegram/host/voice tests passed 23/23. No test timeout was loosened to obtain a pass. See the [complete current validation record](evaluations/live-services-validation-2026-11-23.json), [browser voice/QMD evidence](evaluations/browser-voice-2026-11-23.json), and [MCP evidence](evaluations/browser-memory-2026-11-23.json).

The final integrity check again matches the backup: 14 node rows, 4 link rows, 23 originals and 152 world/physics/GPU files unchanged. The temporary IPv6 QA server is stopped; the current workspace development server remains available on 127.0.0.1:5173. No credentials were committed and no successful paid OpenAI request was made. Setup: [OpenAI](LIVE-AI.md), [QMD](LIVE-QMD.md), [Telegram](TELEGRAM.md), [voice](LIVE-VOICE.md).

## Optional boundaries

The initial integration run tested deterministic failure/retry/cancellation/corruption paths and original-file capture without running inference. The subsequent local-services follow-up executes real pinned Whisper in both browser WASM and native workers, and real native QMD retrieval. Companion provider protocol delivery uses scripted responses until a usable cloud key and API credit are provided; no successful paid live generation is claimed.

Native QMD 2.9.0 and its three local models are now installed in an isolated runtime. The app exposes scoped lexical/hybrid search and opt-in following of future AI-permitted captures. See [live QMD setup and evaluation](LIVE-QMD.md) for measured retrieval quality and limitations. Whisper q8 is installed for browser and server transcription; [voice verification](LIVE-VOICE.md) records real WAV/OGG inference, original retention and timed citations. Telegram capture and OpenAI Responses are implemented; live Telegram transport still requires a bot token and allowed sender/chat IDs, and live cloud generation requires a usable provider API key and available API credit. No live transport or cloud-generation success is claimed without those credentials. Hosted Supermemory remains optional and unconfigured. External observation writes remain disabled: shared memory implements the plan's initial read-only boundary. User-global agent configuration and external service accounts were not changed.

Usage: [capture and portability](CAPTURE-PORTABILITY.md), [MCP/HTTP setup](MEMORY-INTEGRATION.md).
