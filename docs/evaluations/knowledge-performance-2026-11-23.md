# Knowledge storage and command measurements

Measured on 2026-11-23 with Node 26.5.0, an Apple M5 Pro, 64 GiB RAM, and macOS/Darwin 25.6.0. Each operation has 30 measured samples after three warmups. The fixture contains current-version documents with one passage per source and an actual retained NDJSON original. At 50,000 sources, its logical legacy JSON representation is 80,744,564 bytes. UUIDs are generated for each run; content, source counts, queries and command workload are unchanged between the comparison runs.

## Actual application commands

The benchmark invokes `captureThought` and `searchKnowledge` through an initialized repository backed by real localhost HTTP and a durable temporary SQLite database. Capture includes original retention, source/version/passage creation, pending and published projection phases, client diffing, database/index publication, and repository world updates. Captured thoughts become world nodes. Existing fixture documents are unprojected: these measurements do not represent 50,000 rendered 3D nodes.

The before/after comparison uses 430–431-byte notes. Freezing the owned cache and avoiding traversal of unchanged collections stopped Immer from materializing unchanged passage trees. Both reports are retained, including the search regression in this run.

| Sources | Capture before p50 / p95 (ms) | Capture after p50 / p95 (ms) | Search before p50 / p95 (ms) | Search after p50 / p95 (ms) |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 21.557 / 23.096 | 14.760 / 18.246 | 6.300 / 6.749 | 6.705 / 7.354 |
| 10,000 | 133.681 / 142.645 | 54.556 / 91.166 | 23.094 / 26.667 | 30.800 / 49.710 |
| 50,000 | 703.817 / 823.505 | 428.780 / 442.495 | 141.272 / 179.167 | 230.525 / 325.953 |

A separate run checks the plan's 10 KiB text capture target at 10,000 sources. With exactly **10,240 UTF-8 bytes** per captured thought, capture p50/p95 is **75.260 / 111.809 ms**; warm search is **33.299 / 47.449 ms**. This meets the recorded p95 capture acknowledgement target of 500 ms and warm search target of 1 s on this machine for this fixture.

Background organization is drained between captures and measured separately in the JSON reports. It is not part of the acknowledgement result. Browser rendering, disk exhaustion, inference, semantic model initialization, native QMD, and real-user relevance are outside this benchmark. These are measured synthetic workloads, not general latency guarantees.

Reports: [before](knowledge-commands-before-2026-11-23.json), [after](knowledge-commands-after-2026-11-23.json), [10k sources / 10 KiB](knowledge-commands-10k-10kib-2026-11-23.json).

Reproduce the full command run:

```sh
WORLDVIEW_KNOWLEDGE_BENCH=1 npm test -- tests/perf/knowledgeBench.test.ts
WORLDVIEW_KNOWLEDGE_BENCH=1 WORLDVIEW_BENCH_SIZES=10000 WORLDVIEW_BENCH_CAPTURE_BYTES=10240 npm test -- tests/perf/knowledgeBench.test.ts
```

The opt-in test is skipped by ordinary `npm test`. `WORLDVIEW_BENCH_SAMPLES` and `WORLDVIEW_BENCH_SIZES` allow diagnostic runs. Fresh reports go to ignored `bench-results/`; the checked-in reports above preserve this comparison.

## Storage/API boundary

This separate script measures one original upload, cheap revision read, client identity diff, and atomic delta/node/asset commit over HTTP. It does not call the entire application capture command.

| Sources | Boundary capture p50 / p95 (ms) | HTTP FTS search p50 / p95 (ms) | HTTP revision p50 / p95 (ms) |
| ---: | ---: | ---: | ---: |
| 1,000 | 6.370 / 7.566 | 4.517 / 4.979 | 1.688 / 1.892 |
| 10,000 | 13.449 / 18.580 | 19.020 / 28.705 | 1.562 / 1.819 |
| 50,000 | 59.282 / 74.795 | 117.131 / 131.572 | 1.524 / 1.571 |

Serialized command payloads remain **3,081–3,090 bytes** at all three sizes. Routine writes update changed normalized rows and changed FTS entries; they do not rewrite the 80.7 MB logical snapshot. Small command receipts retain SHA-256 digests, rather than another copy of source text. A regression test protects an unchanged version with a SQLite trigger and verifies that an unchanged FTS row retains its rowid.

Reproduce with `node scripts/bench-knowledge.ts`. The script uses throwaway databases/originals and removes them afterward. [Full API report](knowledge-api-2026-11-23.json) includes initial corpus bytes, client diff timings, direct SQLite search, sample counts and maxima.

## Optional QMD comparison

Worldview exports a disposable Markdown mirror of selected current, AI-permitted sources. Filenames are opaque hashes; a manifest retains full source/version/passage identities and exact text hashes. Native result paths are hints: the resolver returns fresh authoritative text only after checking current policy, live projection, version, bounds, attribution scope and exact text. A revoked or edited source is withheld even if an older mirror still contains it.

`server/qmdMirror.ts` and the comparison harness are newly written adapters. They use QMD's documented collection and lexical search interface, inspected at the downloaded [pinned QMD revision](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/README.md). No QMD runtime code or model weights are bundled into the authoritative app. QMD's MIT notice remains in the downloaded reuse kit.

```sh
node scripts/compare-qmd.ts
node scripts/compare-qmd.ts --qmd-binary /absolute/path/to/an/already-installed/qmd
```

The first form runs the built-in baseline and mirror preparation and explicitly records that native QMD was not executed. The second is an explicit opt-in to the chosen executable. It invokes lexical `search` only, with a fresh temporary `INDEX_PATH`, config and cache, then compares resolved ranking overlap and latency for five queries. Native startup/subprocess overhead and authoritative result validation are included. Temporary index, mirror, config and cache are removed afterward. Neither form installs a package or initiates embedding/model downloads.

The native comparison was **not run** in this integration: no native QMD installation was requested or executed. Mirror export, source-policy revocation, malformed result paths, version changes, exact offsets and safe file writing are covered by integration tests. Ranking overlap is not a measurement of factual support or answer quality.
