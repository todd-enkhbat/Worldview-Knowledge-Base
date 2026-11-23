# Live local QMD

QMD is installed and connected to Worldview. The pinned official package is **`@tobilu/qmd@2.9.0`** (`qmd 2.9.0`, build `aa247d0`). It has an isolated package-lock under `data/tools/qmd/`; the app's React/Three/TypeScript dependency stack is unchanged.

## Use it

In **Sources & activity → Local QMD search**, choose permitted sources and lexical or hybrid mode, then build the index. The explicit **Follow all included AI-permitted sources, including new captures** option includes later thoughts, Telegram captures and completed transcripts automatically. Without that option, source selection remains fixed. Choose a QMD engine in **Search & ask** once status is ready. Lexical is the initial control setting; hybrid runs the downloaded local models.

This panel requires the same SQLite-backed workspace. A browser-only world is directed to **Settings → Storage engine → Move to SQLite**; it cannot accidentally configure a different server world. The existing personal SQLite workspace has been configured to follow current and future permitted sources. Its current source/passage counts reflect the authoritative corpus: title-only legacy records are not fabricated into evidence bodies.

Reproduce the isolated installation:

```sh
node scripts/qmd-setup.ts
node scripts/qmd.ts status
node scripts/qmd-live-eval.ts
```

`qmd-setup.ts --lexical-only` installs/checks the runtime without downloading models. The repository-local launcher never changes global QMD configuration or installs agent skills. Model files are in **`data/tools/qmd-cache/qmd/models/`**, outside per-world disposable index directories. Destructive cleanup refuses any ancestor or equal path of the runtime or shared model cache. This separation fixes a cache-path collision caught during live integration.

## Models and source attribution

The downloaded files total **2,255,183,040 bytes**:

| Role | File | Bytes | Model license/source |
| --- | --- | ---: | --- |
| Embedding | embeddinggemma-300M-Q8_0.gguf | 333,590,944 | Google's Gemma terms; [GGUF conversion](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF), [upstream model and terms](https://huggingface.co/google/embeddinggemma-300m) |
| Reranking | qwen3-reranker-0.6b-q8_0.gguf | 639,153,184 | [Apache-2.0 model card](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF) |
| Query expansion | qmd-query-expansion-1.7B-q4_k_m.gguf | 1,282,438,912 | [MIT model card](https://huggingface.co/tobil/qmd-query-expansion-1.7B-gguf) |

QMD's own code is MIT; that does not relabel the model weights. Current file SHA-256 hashes are retained with the [live evaluation report](evaluations/qmd-live-2026-11-23.json). Installation followed the [official QMD documentation](https://github.com/tobi/qmd). No personal source text was sent to a remote inference service for QMD; inference runs locally in an isolated child process, without provider credentials in its environment.

## Authority and cancellation

Each world/account has a separate disposable Markdown mirror and native index. The native process communicates over IPC; raw native stdout and native snippets never become evidence. Source, version, passage, authorship and date identities are rechecked against current Worldview authority after inference. Native metadata filters narrow candidate selection before inference as well. Every returned quote still resolves to exact immutable source offsets.

A one-second reconciliation loop watches the database generation, including direct watcher commits and same-revision restores. Source/version/permission changes cancel the old native process, erase its mirror/index and rebuild the selected scope. Restore/wipe removes private QMD settings and clears the old index. The shared model cache is retained. Disable removes the private mirror/index while retaining original sources. Sources above the 64 MiB mirror limit produce a visible error and do not preserve an obsolete index.

## Live verification and limits

The installed runtime actually embedded **17 valid synthetic passages into 22 chunks**, expanded queries, searched vectors and reranked results. The first complete report covers **42 current, AI-permitted fixture queries**, including 35 ranked tasks, at 10/20/40 candidates. Historical, non-AI-local and mutation cases are explicitly excluded from the native quality run and covered by authority/cancellation tests instead.

| Mode | Source recall@5 | MRR@5 | nDCG@5 | Negative queries returning empty |
| --- | ---: | ---: | ---: | ---: |
| Native lexical | 0.9429 | 1.0000 | 0.9906 | 7/7 |
| Hybrid, 10 candidates | 1.0000 | 1.0000 | 1.0000 | 2/7 |
| Hybrid, 20 candidates | 1.0000 | 1.0000 | 1.0000 | 2/7 |
| Hybrid, 40 candidates | 1.0000 | 1.0000 | 1.0000 | 2/7 |

Every result in that completed run passed exact-citation and authorization checks. Hybrid nearest-neighbor retrieval still returns unrelated permitted material when the requested fact is absent. Its high blended score includes rank bonuses and **is not factual confidence or automatic abstention**. The response trace separates lexical/vector signals, reranker score and fusion bonus. Keep exact-source verification in the companion and use lexical search for strict missing-evidence checks.

Candidate configurations ran in increasing order and reused local expansion/reranker caches. Reported timings are descriptive, not comparable cold benchmarks or broad quality guarantees. A later full rerun was interrupted by native request timeout during severe machine load/sleep; it did not overwrite the completed quality report. The actual production HTTP integration subsequently passed: the isolated app's hybrid query returned HTTP 200 in about **2.6 seconds**, with two exact current timed transcript passages. Personal and QA indexes reported hybrid ready. This distinguishes a working live flow from the interrupted stress run.

Focused runtime, metadata, mirror, purge/restore, explicit-follow and UI lifecycle tests pass. No world/physics/GPU source was modified by this integration; QMD only writes private integration settings and disposable retrieval files.
