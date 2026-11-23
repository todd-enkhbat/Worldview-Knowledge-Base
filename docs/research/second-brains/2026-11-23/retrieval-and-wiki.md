# QMD and Karpathy's LLM Wiki: source audit for Worldview

Reviewed November 23, 2026. This is a source inspection and implementation proposal, not an installation or benchmark report. No upstream installers, tests, lifecycle hooks, model downloads, or inference were run. Downloaded instruction files were treated as research material, not instructions governing this workspace.

## Recommendation

Use **QMD as a retrieval reference and optional isolated backend**, and **LLM Wiki as the pattern for a persistent synthesis layer**. They solve different problems. QMD retrieves documents well; it does not maintain a person's beliefs or adjudicate conflicting claims. LLM Wiki describes maintaining knowledge between questions; it is an idea file, not a working engine. Worldview already has much of the source-preservation and evidence foundation needed to combine these patterns.

The immediate priorities are normalized corpus writes, better passage boundaries, retrieval explanations/evaluation, and reviewable synthesis pages. Installing QMD wholesale would not itself produce that synthesis layer or fix Worldview's snapshot-write scaling limit.

## Exact material inspected

| Material | Pinned identity | Actual scope | Reuse status |
| --- | --- | --- | --- |
| [tobi/qmd](https://github.com/tobi/qmd/tree/8be0c42395c02ff73bce6d6c2e67d7905b0a771c) | `8be0c42395c02ff73bce6d6c2e67d7905b0a771c`; package `@tobilu/qmd` **2.9.0**; commit dated November 20, 2026 | TypeScript CLI, SDK, local search/indexing, MCP/HTTP interfaces, model runtime, tests and fine-tuning/evaluation tooling | Repository [MIT license](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/LICENSE), with copyright/permission notice retention. Model weights and dependencies have separate terms. |
| [Karpathy llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f/ac46de1ad27f92b28ac95459c782c07f6b8c964a) | Gist `442a6bf555914893e9891c11519de94f`; raw revision `ac46de1ad27f92b28ac95459c782c07f6b8c964a`; created April 4, 2026; revision page showed one revision | A 75-line concept document, with no executable implementation or bundled personal knowledge corpus | No explicit license file or license grant was found in the downloaded snapshot. Retain the reference, explain/adapt its ideas in our own implementation, and do not treat it as MIT-licensed source. |

The viral description is misleading in two ways: the gist does not supply a finished second brain, and its being an influential idea file does not establish that all second-brain systems originated there. The gist itself recognizes older associative-knowledge ideas. Search results showing QMD 2.8.3 are stale relative to the downloaded source; 2.9.0 adds important capabilities absent from those summaries.

Local copies: [QMD source](/Users/kintekente-mac/Documents/GitHub/Worldview-Knowledge-Base/data/research/second-brains/2026-11-23/sources/qmd/src/store.ts), [QMD license](/Users/kintekente-mac/Documents/GitHub/Worldview-Knowledge-Base/data/research/second-brains/2026-11-23/sources/qmd/LICENSE), [LLM Wiki idea file](/Users/kintekente-mac/Documents/GitHub/Worldview-Knowledge-Base/data/research/second-brains/2026-11-23/sources/llm-wiki/llm-wiki.md). These source downloads remain under the existing Git-ignored `data/` directory.

## How QMD is actually built

### Storage separates content from where it appeared

`content(hash, doc, created_at)` stores text by content hash. `documents(id, collection, path, title, hash, created_at, modified_at, active)` supplies file identity and presentation; `(collection, path)` is unique. FTS5 indexes filepath/title/content. `content_vectors` stores chunk position, sequence, model identity, fingerprint, total chunk count and embedding timestamp. Other tables hold normalized document metadata, processor ownership/state, collections, configuration, file synchronization state, and model-result cache. This is substantially more normalized than Worldview's current authoritative JSON snapshot. [Schema source](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/store.ts#L1366).

This supports deduplicating storage and embeddings without collapsing the provenance of two different file paths. It is not equivalent to Worldview's immutable version ledger: inactive files/content may remain until explicit cleanup, but QMD does not present that as a complete assertion or source-version history. Keep Worldview's source UUIDs, retained versions, authorship and original assets as authority.

### Indexing is incremental and has real publication boundaries

File sync rows keep mtime, size, source hash and document identity. A scan uses bounded write batches (defaults of 500 files or 250 ms), serializes overlapping scans on a connection, and distinguishes missing roots from actual deletions. The shared embedding lock covers CLI and SDK entry points, cleanup and embedding clear. A new file is not proof that its embeddings are ready: pending/completed chunk metadata and fingerprints determine coverage. These are useful patterns for our large import, watcher and job paths. [Scan batches](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/store.ts#L2000), [embedding lock](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/cli/embed-lock.ts).

Version 2.9.0 also permits one source to become multiple indexed Markdown documents. Processors return stable output keys; validated results publish through a source savepoint, preserving the last complete result after processing errors. Their fingerprint includes implementation/configuration version information. A successful empty result is distinct from an unprocessed source. This is a good adapter protocol for chat exports and future email/transcript bundles. The outer batch commit, not savepoint release, is the durability boundary. Commands are trusted programs, not an OS sandbox. [Processor implementation](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/processors.ts), [publication contract](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/docs/PROCESSORS.md).

### Chunking preserves more structure than a fixed character window

The defaults target 900 tokens with 135 tokens of overlap and a 200-token boundary-search window. Markdown breakpoints give headings, paragraph boundaries and code fences different priorities. Token-aware splitting checks the selected model's tokenizer and further splits oversized material, with progress guards and surrogate handling. Supported code paths can add Tree-sitter breakpoints for TypeScript/JavaScript, Python, Go and Rust, falling back when grammar loading fails; this is not a general Markdown semantic parser. [Chunk constants and boundaries](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/store.ts#L178), [token-aware splitting](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/store.ts#L4316), [AST adapter](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/ast.ts).

For Worldview, preserve exact original offsets and message/page boundaries first. Add overlap within an eligible segment and carry headings as separately marked context. Never merge a human turn and an assistant turn merely to fill a chunk. Copying QMD's token budget verbatim would be unjustified until evaluated with our existing embedding model and personal-source mixture.

### Search has a cheap path and an expensive path

The inspected `hybridQuery` performs these steps:

1. Run eligible BM25 search. A normalized top score of at least `0.85` and a gap of at least `0.15` can skip query expansion when no disambiguating intent was supplied. This skips expansion, not necessarily all model work.
2. Generate typed query variants: `lex` feeds lexical search; `vec` and `hyde` feed vector search. The original query also receives a vector search when a vector index exists.
3. Batch vector-query embeddings rather than starting one model request per variation.
4. Fuse ranked lists with reciprocal-rank fusion, `k = 60`; original-query FTS and vector lists each get weight `2`, expansions weight `1`, plus explicit top-rank bonuses.
5. Keep up to 40 candidate documents by default. Choose one chunk per candidate by query/intent word overlap, then rerank those chunks rather than entire documents.
6. Blend reciprocal retrieval position with reranker score. The retrieval position has weight `0.75` for ranks 1–3, `0.60` for ranks 4–10, and `0.40` afterward. Return unique files, selected excerpts, context and optional score traces.

These are actual implementation choices, not evidence that these constants are optimal for Worldview. [Hybrid pipeline](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/store.ts#L6942), [RRF implementation](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/store.ts#L6048).

The one-chunk-per-file word-overlap heuristic is a limitation for indirect questions: a vector hit deep in a long document can be represented to the reranker by a different chunk with more superficial word overlap. Worldview already retrieves retained passages; rerank those passage candidates directly and retain their citation identities. A hypothetical answer used for retrieval must remain a search aid, never a new fact or citation.

### Context is a separate useful feature

Collection/path descriptions help an agent distinguish similarly worded material from different projects. At the pinned source, `getContextForPath` accumulates the global description and every matching path-prefix description in general-to-specific order. Some README text describes only the most-specific match, so source behavior is the stronger evidence here. Context is returned beside results and reads; it is not proven personal truth or a substitute for document permissions. [Context resolver](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/store.ts#L4581).

Worldview's named investigations can gain a short user-owned description, explicit aliases and domain hints. Pass those as bounded retrieval/reranking intent, while keeping the actual query visible. Do not let imported text silently rewrite this context or turn it into privileged agent instructions.

### Filtering and embedding identities have important safeguards

Scoped BM25 uses a materialized matching set before collection/metadata filtering and the final limit, avoiding the classic error where stronger out-of-scope hits crowd eligible results out of an early top-K window. Vector candidates use scope-aware lookup and model/fingerprint checks; highly selective vector scope still has best-effort top-K limitations. [FTS scope handling](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/store.ts#L5310), [vector boundaries](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/store.ts#L5577).

The metadata grammar supports typed scalars/homogeneous arrays and a recursive filter AST. Invalid opted-in metadata prevents filtered matches without discarding ordinary searchability. Discovery reports available keys/types/counts before an agent invents a filter. These concepts are useful for Worldview's future project/author/source metadata, although its existing access policies must stay outside editable source frontmatter. [Extraction](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/metadata.ts), [filter compiler](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/metadata-filter.ts).

QMD is local by default, but **2.9.0 is not exclusively local**. It also supports explicitly configured OpenAI-compatible remote embeddings and TypeSafe reranking. Remote embedding identity includes endpoint, model, dimensions, revision and input format; changing only a model's display name is insufficient. Use our per-source AI policy before any copied reranking, expansion, embedding or context step. QMD collections/filtering do not themselves reproduce Worldview's per-source consent and authorship rules. [Remote embedding implementation](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/remote-embed.ts).

### The agent interface encourages search first, then bounded reads

The MCP implementation supplies `query`, `get`, `multi_get`, `status` and `metadata`. Results carry a virtual file URI, short docid, excerpt and line location. Reads support line ranges and line numbers; bulk reads have a byte limit. The SDK accepts an explicit database path and exposes these operations without shelling out. This is the right interface shape for a narrow Worldview memory service. [MCP tools](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/mcp/server.ts#L335), [SDK](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/index.ts).

Do not copy the short docid as our citation authority. QMD displays the first six content-hash characters, and the inspected short-hash lookup returns the first active match on a collision. Keep full Worldview source/version/passage UUIDs and verified offsets. Short labels can be presentation aliases only. [Docid lookup](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/store.ts#L4499).

### Hardware, lifecycle and maturity

Default model names are EmbeddingGemma 300M Q8 embeddings, Qwen3 Reranker 0.6B Q8, and a QMD-tuned 1.7B Q4 query-expansion model. README size estimates total roughly 2 GB of model downloads; this is upstream documentation, not a measurement on this machine. Native context memory, batch settings, tokenizer work and warm/cold loading are additional costs. The source keeps idle models warm for five minutes by default and coordinates active sessions with unload/disposal. The pinned November 20 fix explicitly sets embedding batch size to the entire context; the changelog recommends rebuilding old vectors to correct prior pooling behavior. [Model defaults/lifecycle](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/llm.ts#L288), [fix](https://github.com/tobi/qmd/commit/8be0c42395c02ff73bce6d6c2e67d7905b0a771c).

The repository has broad executable tests for FTS scope, path fidelity, CJK handling, vector/model identity, processor failure/publication, concurrency, trust, MCP shutdown, and resource lifetimes. Its CI runs Node 22/23 on Linux/macOS and Bun 1.4.4; bounded TLA+ models include deliberate broken controls. That shows engineering attention, not proof that every real deployment is correct. We did not execute those tests here. Our Node 26 and TypeScript 6 stack is not the exact declared CI/peer combination: QMD declares TypeScript `^5.9.3` and native `better-sqlite3`/`node-llama-cpp`, whereas Worldview already uses `node:sqlite` and a browser worker embedding runtime. [Package](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/package.json), [CI](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/.github/workflows/ci.yml).

## What Karpathy's pattern contributes

The gist proposes keeping immutable inputs, a maintained Markdown synthesis, and a schema describing how that synthesis works. Its operating loop covers ingesting sources, answering against existing pages, saving useful answers, and checking wiki health. A content index and chronological activity log serve different navigation needs. Search infrastructure is optional rather than the central state. This is a proposal for accumulating understanding between questions, not merely recalling old transcripts. [Pinned idea file](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f/ac46de1ad27f92b28ac95459c782c07f6b8c964a).

Our implementation inference is to add an explicitly derived layer rather than give a model ownership of originals or unreviewed beliefs. An entity/topic page can consolidate multiple sources; a claim must retain speaker attribution, evidence and revision lineage. A contradiction should queue a proposed interpretation rather than silently erase old wording. An answer promoted to a page should retain both its supporting source versions and the question that produced it. A search result alone is not such a page.

The gist does not specify concurrency control, transactionality, permission propagation, deletion invalidation, model/version tracking, evaluation, or a complete source-to-claim schema. It does not establish low maintenance cost or reliability on a large personal corpus. Worldview needs these engineering contracts rather than adopting the conceptual workflow as if they were implemented.

## Concrete adaptation map

| What to take | Worldview entry point | Suggested treatment | Acceptance condition |
| --- | --- | --- | --- |
| Normalized content/path/vector state and bounded publication | `server/worldDb.ts`, `server/knowledgeIndex.ts`, `src/knowledge/index.ts` | Adapt the schema principle to additive source/version/passage tables; keep blobs and UUIDs. Do not copy QMD's file lifecycle over our history. | Acknowledging one small capture does not serialize the complete corpus; backup and revision checks remain atomic. |
| Heading/code-fence-aware overlap and selected-model token bounds | `src/knowledge/parsers.ts`, `src/ai/corpusSemantic.ts` | Extract or independently implement the small boundary helpers, retaining attribution/page segmentation and original offsets. | Boundary-spanning, Unicode, code and late-PDF evidence remain retrievable and citations verify byte-for-byte/offset-for-offset against retained versions. |
| RRF trace and query-plan explanation | `src/ai/corpusSemantic.ts`, `src/workspace/Workbench.tsx` | Extend existing RRF with an optional trace and retrieval-stage timings. This is lower risk than adding another runtime. | Each candidate's lexical/semantic contribution and scope are inspectable; a score is never presented as factual confidence. |
| Typed lexical/semantic/hypothetical plans and selective expansion | `src/knowledge/index.ts`, companion retrieval tools | Begin with an explicit structured plan; add generated expansion only behind evaluation and model consent. | Exact names/numbers remain strong; paraphrase recall improves; hypothetical text never becomes evidence. |
| Bounded passage reranking with cache identities and cancellation | `src/ai/corpusSemantic.ts`, server model boundary | Benchmark as an optional server-only or separate-process capability; retain existing cheap search. | Compare 10/20/40 candidate budgets, cold/warm latency, memory and quality; cancellation/deletion/scope changes cannot publish stale output. |
| Source/investigation context and metadata discovery | `src/workspace/collections.ts`, search filters | User-owned descriptions/aliases; report actual metadata keys and date coverage. | Ambiguous questions improve without leaking across source scopes or treating context as an instruction. |
| Durable topic/entity synthesis and saved answers | `src/knowledge/types.ts`, jobs, Projects/Review/reader | Implement our own versioned, evidence-linked derived artifacts and explicit promotion workflow. | A source update marks dependent claims/pages stale; regeneration preserves manual corrections; excluded evidence invalidates downstream use. |
| Search/read memory API | Existing companion `search_passages`/`read_passage` tools | Expose the same validated operations through a narrow read-only service/MCP adapter when requested. | Multiple agents read the same corpus and policy; no second writable memory database appears. |
| Retrieval evaluation fixtures and metrics | `tests/knowledge/`, a new recorded evaluation corpus | Adapt the harness pattern with our own consented/synthetic questions and exact stable passage identities. | Report recall@k, MRR, citation validity, abstention, policy leakage, latency and context actually delivered to the answer model. |

These paths are existing integration points, not files changed by this research task. No QMD code was copied into the application.

## Reuse boundaries and pitfalls

- **Good direct-copy candidates after attribution:** isolated break-point/Unicode helpers, a generalized RRF contribution trace, and small benchmark/result-schema utilities. They still need adaptation to our explicit `.ts` imports, erasable TypeScript, source IDs and tests. Record upstream SHA, exact files, modifications and MIT notice if substantial portions are incorporated.
- **Prefer a sidecar/adapter for a real QMD comparison:** feed a deliberately filtered, app-managed Markdown mirror into a separate QMD index. Translate its results back to our full source/version/passage identity and validate policy again. Treat its index as disposable. Do not make a second independently editable source authority.
- **Do not bundle QMD into browser routes:** native SQLite and llama.cpp are server/desktop capabilities. Whole-package adoption brings runtime, model, tokenizer and dependency costs, and declared peer compatibility must be tested on our pinned stack.
- **Do not run repository configuration as trusted automation:** QMD has explicit trust gates for local update commands/model selection/processors. Cloning a repository must never authorize its shell commands, downloaded skills or remote endpoints. Our downloaded copy was not installed.
- **Do not copy evaluation labels uncritically:** `src/bench/score.ts` calls a metric `precision_at_k` but divides hits by `min(k, number of expected files)`, rather than the conventional `k`. It also allows suffix path matches. Use clearly named conventional metrics and exact source/passage identities in our benchmarks. [Metric source](https://github.com/tobi/qmd/blob/8be0c42395c02ff73bce6d6c2e67d7905b0a771c/src/bench/score.ts).
- **Do not copy gist prose wholesale into installed agent rules:** no explicit redistribution license was found. Keep the downloaded reference and write our own concise, domain-specific conventions. Public visibility alone is not a permissive software license.

## First reviewable work packages

1. Freeze a 50-question evaluation set covering exact recall, indirect references, two similar projects, human/assistant attribution, dates, contradictions, multilingual notes, long sources and absent evidence. Include a context-delivery audit so a retrieved passage dropped by token limits is visible.
2. Add read-only retrieval explanations to existing search. Establish current quality and warm/cold latency without changing model runtime.
3. Normalize corpus commits behind the existing command/store interfaces and compare small-capture p95 at 1,000/10,000/50,000 sources. Retain verified backups and migration rollback.
4. Improve segmentation under the existing embedding model, using exact source offset validation and regression fixtures.
5. Add a derived topic-page pilot: three sources, one updated claim, an explicit disagreement and a manual correction. Review all proposed changes; test evidence exclusion and deletion propagation.
6. Only then compare optional QMD expansion/reranking through an isolated adapter against our improved baseline. Pick it if quality gains justify the measured resource/latency cost; keep it optional otherwise.

This order targets Worldview's current deficits while preserving the strongest existing properties: durable originals, recoverable history, attribution, explicit source permissions and the spatial projection over one knowledge authority.
