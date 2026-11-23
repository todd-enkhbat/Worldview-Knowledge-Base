# Worldview implementation plan from the eight-repository study

Implementation status: [SECOND-BRAIN-INTEGRATION.md](../../../SECOND-BRAIN-INTEGRATION.md) records delivered behavior, verification and optional external-service boundaries. The original proposal follows.

Proposed November 23, 2026. This is the next engineering plan, not a list of features implemented by the research task. Existing working code and the prior workspace rebuild remain in place. The [comparison](README.md) and three source audits contain pinned upstream evidence.

## Preserve these existing contracts

Keep one authority for originals, source versions, passage identity, consent and accepted edits. Keep the `WorldStore` and node projection interfaces additive. Preserve UUIDs, attachments, trash, source policy, saved investigations, recovery markers and existing archives. Maintain XYZ as spatial layout and time as explicit history; semantic improvements do not authorize global repositioning or overwriting pins. Keep Node 26, TypeScript 6 and current exact dependency versions until an evaluated addition has a recorded decision.

Do not transplant the complete GBrain/Postgres, Basic Memory/Python, Claude-Mem worker or QMD/native model runtime into the browser bundle. Importing all four would create overlapping databases and incompatible lifecycle assumptions. Borrow small suitable modules with retained notices, independently adapt architecture where appropriate, and compare complete engines behind explicit disposable adapters only when useful.

## A. Baseline, retrieval explanations and evaluation

Land in `server/knowledgeIndex.ts`, `src/knowledge/index.ts`, `src/ai/corpusSemantic.ts`, `src/ai/chat/apply.ts`, and a dedicated evaluation fixture/harness.

Expose a retrieval trace beside existing results: normalized query and explicit scope, source version, lexical rank, semantic rank, fusion contributions, optional rerank score, stage timings, index/model identity and any omitted/unindexed source coverage. Add an inspectable distinction between relevance score and evidence support. A strong lexical result should remain useful without invoking another model.

Create an initial 50-question synthetic/consented set covering exact names and numbers, paraphrases, aliases, duplicate basenames, contradictory statements, changing decisions, attribution, unknown dates, long PDF/code passages, multilingual notes and absent evidence. Record expected full passage IDs and evidence versions. Evaluate recall@5, MRR, conventional precision@k, exact citation validity, abstention, context actually delivered, policy leakage, warm/cold latency, memory and inference usage. Do not copy QMD's nonstandard denominator or suffix-path matching.

Acceptance: every permitted answer reference resolves to retained source text; no excluded evidence reaches a model; the trace reveals if a retrieved passage was later dropped by context budgeting. The previous 90% top-five relevance and sub-500 ms capture targets remain targets until measured, not inherited upstream claims.

## B. Incremental corpus storage

Land behind the current knowledge command layer, `server/worldDb.ts`, `src/data/WorldStore.ts`, HTTP/IDB adapters and archive snapshot/export code. The problem is serializing the complete `knowledge.v1` ledger for a small capture; the solution is a command/transaction boundary, not a different UI.

Proposed normalized authority:

| Entity | Identity and responsibilities |
| --- | --- |
| Source | Existing UUID, scoped external identity, source kind, inclusion/AI policy and current version |
| Version | Existing UUID, immutable text/content hash, raw-original reference, previous version, parser version, capture/authored time and precision |
| Passage | Existing citation UUID or an explicit migration alias, version/message/page identity, attributed speaker and exact UTF-16 offsets |
| Job / outcome | Idempotency key, input version/config hash, state, cursor, lease, retry/error record and produced artifact IDs |
| Accepted knowledge | Versioned claims/pages/relationships, explicit evidence edges and correction/withdrawal events |
| Index state | Disposable FTS/vector rows with source revision and complete model/formatter/chunker identity |

Add a delta command such as `commitKnowledge(command, { expectedRevision, idempotencyKey })`. Commit affected source/version/passage rows, projection metadata and queued jobs in one transaction. Preserve content-addressed originals written before acknowledgment; garbage-collect only after reference changes commit. One input can produce multiple stable outputs, with atomic publication of a complete parser result. An extraction failure retains the previous complete version and a visible failed attempt.

For browser-only mode, use equivalent IndexedDB object stores/transaction semantics through the same command contract. Do not introduce silently divergent source authority. Version the storage migration, create and verify a backup first, migrate in bounded batches, compare IDs/counts/hashes/pins, and refuse older writers after cutover. Preserve portable logical archives even if their streaming implementation changes; do not continuously dual-write the full legacy snapshot and reintroduce the same bottleneck.

Acceptance: acknowledged capture survives restart and model failure; repeated commands produce no duplicates; watcher/UI races conflict safely; imports resume; export reads a consistent snapshot; rollback uses the verified pre-migration copy. Measure p50/p95 capture and search at 1k/10k/50k sources on recorded hardware. No small capture should rewrite the whole corpus.

## C. Better passages and an actual vault graph

Land in `src/knowledge/parsers.ts`, `src/data/obsidian.ts`, `server/folderCapture.ts` and retrieval tests. Preserve page/message/role boundaries. Within them, prefer Markdown headings, paragraphs and intact code fences; respect Unicode and model token limits, with bounded overlap and guaranteed progress. Heading context is additional labeled context, not invented source text. Keep every citation offset verifiable against the immutable version.

Unify the two Obsidian paths: the newer corpus import preserves full paths/raw content, while the legacy importer resolves wikilinks using a basename map that can choose the wrong same-named file. Implement exact normalized path first, then unambiguous relative/suffix identity, then a unique stem only when safe. Preserve aliases, heading/block references, embeds, tags and properties. Record unresolved or ambiguous links explicitly; never silently use the last filename match. Shared file hashes can deduplicate bytes without merging two independent provenances.

Acceptance: two `notes.md` files in different folders stay distinct; `[[folder/notes#section|label]]` resolves correctly; ambiguous shorthand remains unresolved with a receipt; edits retain source IDs and create versions. A code-fence boundary and a Unicode boundary do not corrupt retrieval or citations. A missing/unmounted watched root is not treated as a mass deletion.

## D. Shared agent memory and bounded context

Reuse the existing companion's validated passage search/read operations. Expose a small read-only interface first: `search`, `read_passage`, `read_record`, `get_project_context`, and `coverage/status`. An MCP wrapper and a local HTTP client should call the same functions, with the same account/project/source scope and source policy. Add a declared client identity and capability boundary before supporting external writers; a convenient local header alone is not a complete multi-client authorization design.

Context packets should contain a user-approved profile slice, project intent, recent relevant events, retrieved evidence handles, full-version citations and coverage/omission information. Budget the final rendered packet rather than claiming character count equals model tokens. Reserve room for the user's question and tool protocol. Search results are compact; evidence details are fetched progressively with explicit limits. Never combine unrelated projects because their wording is similar.

Later, a proposed observation write can include client, project, session, timestamp, tool/event type, idempotency key and source references. Persist the capture receipt before expensive compression; redact credentials/private spans before outbound processing. A tool observation is an attributed observation, not automatically a user belief. External messaging and broad filesystem access are separate capabilities.

Acceptance: two agent clients retrieve the same authorized decision without duplicating databases; project A never gets project B's hidden evidence; permission revocation invalidates packets/citations and running jobs; stale session work cannot overwrite a restored world. Context can explain its origin and omissions.

## E. Maintained wiki and claim history

Add derived artifacts alongside sources: topic/entity/project pages, answer notes and explicit assertions. Start with a small pilot, not whole-world automatic synthesis. Proposed contracts:

```ts
type EvidenceRef = { passageId: string; sourceVersionId: string; relation: 'supports' | 'opposes' | 'context' }
type ClaimRevision = {
  id: string; claimId: string; text: string; attributedTo: string | null
  recordedAt: number; validFrom: number | null; validUntil: number | null
  evidence: EvidenceRef[]; previousRevisionId: string | null
  status: 'proposed' | 'accepted' | 'rejected' | 'withdrawn'
}
```

These are proposed shapes, not shared contracts added to the app. Keep source authored time, capture time, claimed event time and claim validity separate. Preserve unknown precision and do not let `Date.parse` silently decide ambiguous human dates. Similarity identifies review candidates; it cannot by itself establish contradiction or replacement. Repetition of a generated summary does not create independent support.

A derived page records evidence dependencies, generation/config version, accepted manual edits and stale sections. Source changes queue only dependent work. Proposed changes show a diff and the evidence; accepted corrections constrain regeneration. A useful answer can be explicitly promoted into a page with the question and supporting versions attached. Maintain an index and activity log, plus checks for orphan pages, broken references, stale citations and unsupported assertions.

Withdrawal and deletion need durable tombstones and invalidation across derived pages, vectors, context caches, queued/running jobs and reimports. Historical reads still enforce present permission and purge boundaries. A rejected relationship must not reappear unchanged on the next scan. These are stronger requirements than a graph full of attractive links.

Acceptance pilot: import three attributed sources, form a topic page, introduce conflicting evidence and a later correction, accept one revision, reject another, restart, regenerate and recover from backup. Every retained statement resolves to its evidence; the manually corrected interpretation survives; deleted/AI-excluded material cannot return through derived context. The existing spatial projection renders only intentional accepted objects and relationships, retaining pins.

## F. Portable output, durable voice and optional retrieval engines

Use the MIT Obsidian format references in the reuse kit for Markdown properties, wikilinks/embeds/callouts, `.canvas` and `.base` interchange. Export identity/provenance beside readable text; make any reimport conflicts visible. A Canvas map is a portable 2D investigation, not a new source of 3D coordinates. Export a safe subset of Bases; postpone arbitrary formula evaluation.

Build a voice inbox around `src/ai/transcribe.ts` and its existing local Whisper worker. Save original audio/video and receipt before decoding/transcription, retain timed chunks as locators, expose unsupported/failed states, and retry from the original. A Telegram adapter can later normalize media/text/forwards into the same inbox with allowlisted users and source attribution. Do not inherit Smixs's fixed Russian transcription setting or its loss of original voice files.

For a QMD comparison, generate an app-managed Markdown mirror containing only opted-in sources, index it in a separate disposable service, map results back to full Worldview IDs, and recheck policy before reading. Record its native/model dependencies and model licenses. Compare lexical-only, our existing semantic fusion, and optional expansion/reranking at 10/20/40 candidates. Test cold/warm resources and cancellation. Integrate only if measured gains justify the cost; a second writable source database is not an acceptable shortcut.

## Deliverable order and decisions

Implement A and the migration design first; then B, C and D; then the E pilot; then F as separate vertical slices. Each slice should finish a user journey and pass its gate. The ordering is an engineering recommendation based on our source inspection and earlier measurements, not a calendar estimate.

Keep copies traceable: exact upstream commit/file, license/notice, adaptations and tests. MIT/Apache source references can seed a reviewed module; Basic Memory core and the unlicensed gist have different reuse boundaries. A process/API boundary is not, by itself, a universal exemption from license obligations. Current public Supermemory code does not supply its private engine. Record new dependency or storage decisions in `docs/DECISIONS.md` when implementation actually adopts them.
