# Workspace update: research and current-state evidence

Research date: November 22, 2026. Companion: [implementation proposal](WORKSPACE-UPDATE-PLAN.md).

This is a public-documentation and source-code study. Product claims below were not independently tested. The Mindcorpus website walkthrough was inspected visually; it is a demonstration, not access to the installed product. No private corpus was uploaded, no account was connected, and no software was installed. Competitor documentation establishes available design patterns, not market share or user satisfaction.

## Mindcorpus

Documented claims, untested. Mac beta status conflicts; Windows and Linux planned.

| Area | Scope |
|---|---|
| Capture | Live history, browser chats, exports, folders, notes, documents, voice, highlights, messaging, cloud imports. |
| Record | Authorship, dated originals, derivations, deduplication, versions, exclusions, deletion. |
| Organization | Tags, links, folders, summaries, schemas, batching, coverage, review, undo. |
| Views | Brain, sourced answers, notes, timelines, tables, waves, themes, natural language control. |
| Writing | Markdown, wikilinks, daily notes, Obsidian. |
| Agents | Discovery, configuration, permissioned tools: search, read, edit, import, maintenance. |
| Models | Local, external, or none; caps. |
| Protection | Local files, encryption checks, lock, consent, redaction, encrypted sync, recovery, timestamps, mandatory anonymous beta telemetry. |
| Research | Future custody, licensing, royalties, studies; independent review and benchmark pending; synthetic records only. |
| Access | White paper locked; no unrestricted download or code found. |

Source: [Mindcorpus](https://mindcorpus.org/), [guide](https://mindcorpus.org/#download), [tutorial](https://mindcorpus.org/#tutorial), [questions](https://mindcorpus.org/#questions), [privacy](https://mindcorpus.org/privacy), [evidence](https://mindcorpus.org/#evidence).

## Adjacent products and useful patterns

The final column is our design judgment. It does not assert that copying a feature guarantees usefulness.

| Product | Current documented behavior and boundary | What to borrow |
|---|---|---|
| Obsidian | Local Markdown files; external edits are reflected in the vault. Backlinks include contextual linked/unlinked mentions. Search offers exact phrases and operators. Automatic AI organization is a separate concern. [Storage](https://obsidian.md/help/data-storage), [backlinks](https://obsidian.md/help/plugins/backlinks), [search](https://obsidian.md/help/plugins/search). | Durable content independent of its renderer; useful textual relationship context; rebuildable indexes. |
| Tana / Tana Outliner | Outliner supertags define typed nodes and reusable fields. Current Tana supports workspace reading/search and reviewable AI changes. These are related but distinct product surfaces. [Supertags](https://outliner.tana.inc/learn/features/supertags), [AI workflow](https://tana.inc/help/working-with-ai). | A small understandable ontology; proposed changes with before/after, destination, accept/reject and undo. |
| Capacities | Typed objects, daily notes, full-text/intent search and type/tag filters. Markdown/CSV/media exports, including scheduled full export. Offline support uses application storage rather than guaranteeing a plain-file vault. [Types](https://docs.capacities.io/tutorials/custom-content-types), [daily notes](https://docs.capacities.io/reference/use-cases/daily-notes), [search](https://docs.capacities.io/reference/search), [export](https://docs.capacities.io/reference/export), [offline](https://docs.capacities.io/misc/offline-support). | Capture first, organize by recognizable things, expose source and export health. |
| Reflect Open | Local Markdown, daily notes, backlinks, clips/audio and optional BYOK AI with links to notes. Official implementation describes SQLite indexes, local embeddings and excluding private notes from AI tools. Semantic search has platform limitations. Reflect Classic remains distinct. [Product](https://reflect.app/), [privacy implementation](https://github.com/team-reflect/reflect-open/blob/master/docs/privacy.md). | Files plus SQLite and optional inference; enforce source-level AI exclusions. Do not assume all hardware supports local models. |
| NotebookLM / Gemini Notebook | Current Google documentation uses Gemini Notebook branding. Users select sources; citations expose quotations and open their context. Saved answers retain citations. New agentic artifact functions are marked experimental. [Chat and citations](https://support.google.com/gemininotebook/answer/16179559). | Source-scoped research and one-click evidence inspection; keep generated answers tied to original passages. |
| Khoj | Open-source personal AI with document indexing, local-model options, embedding search plus reranking, and reference notes in chat. Self-hosting adds operational work; remote model selection changes where context goes. [Overview](https://docs.khoj.dev/features/all-features/), [search](https://docs.khoj.dev/features/search/), [chat](https://docs.khoj.dev/features/chat/), [privacy](https://docs.khoj.dev/privacy/). | Evaluate retrieval quality; distinguish corpus search from web research; expose model/data routes. |
| Graphiti | A temporal graph framework: episodes support extracted facts, validity intervals and supersession; retrieval combines semantic, keyword and graph methods. It requires an application and backend around it. [Official repository](https://github.com/getzep/graphiti). | Evidence-backed assertions and temporal relationships. Implement the needed concepts in SQLite before considering another database. |

The independent architectural reference is [Ink & Switch's local-first essay](https://www.inkandswitch.com/essay/local-first/): ownership, offline use and long-term access should survive dependence on a particular service. Our recommendation is to preserve usable originals and make models, indexes and visual layouts replaceable.

## Current workspace audit

Evidence refers to the working tree as inspected, including existing uncommitted changes. Line numbers are starting locations, not immutable references. “Consequence” is an inference from implementation, not a measured result with the user's data.

| Finding | Implementation evidence | Consequence |
|---|---|---|
| Capture has reusable foundations | [Local save and intake](../src/ai/chat/session.ts#L358), [folder intake](../src/hud/chatIntake.ts#L24). | Keep local Save, optional Send, originals and proposed notes. |
| Integrations are manual workflows | [Sources](../src/hud/Sources.tsx#L9), explicit scope at line 99. | Service names do not represent continuous authenticated ingestion. |
| Structured conversation import is missing from the intake path | [JSON preview](../src/ai/chat/preview.ts#L67). | Generic export previews do not preserve a searchable conversation's turns, branches and speakers. |
| AI retrieval returns labels, not readable evidence | [WorldHit/searchWorld](../src/ai/chat/apply.ts#L159), [tool contract](../src/ai/chat/protocol.ts#L101). | Search results expose ID/title/kind/date/tags; there is no existing-record reading tool in this contract. |
| Long-source search is incomplete | [2,000-character embedding input](../src/ai/embedText.ts#L11), [Library title/tag search](../src/hud/Library.tsx#L62). | Material late in a long source or attachment can be missed. |
| Provenance is too coarse | [NodeRecord and provenance](../src/domain/types.ts#L109). | No source-version/message/span ledger supports precise authorship and quotation attribution. |
| History is not content revision history | [Record mutations](../src/data/repo.ts#L725), [event types](../src/domain/types.ts#L189). | Birth/replay of current records cannot reconstruct prior belief wording. |
| Map geography is tag/link based | [Spatial model](../src/domain/spatial.ts#L44), region/member placement at lines 118–202. | Untagged unlinked saves lack meaningful semantic organization; geometric distance does not establish conceptual similarity. |
| Agents are local saved queries | [Agent scope](../src/hud/Agents.tsx#L67). | Animated matching does not supply durable background extraction/indexing work. |
| Repeat imports need source identity | [Fresh IDs for ordinary vault notes](../src/data/obsidian.ts#L125), [import handling](../src/data/repo.ts#L555). | An ordinary vault reimport can duplicate notes. Lossless Worldview exports carrying IDs are a separate case. |
| Originals need durable import receipts | [Staged original lookup/expiry](../src/ai/chat/originals.ts#L3), [attachment handling](../src/ai/chat/apply.ts#L403). | Filename collisions, staged-item expiry and partial attachment failures need visible recovery. |
| Reading depends on a world-shaped shell | [Always-mounted canvas](../src/world/WorldPage.tsx#L61), [navigation](../src/hud/Workspace.tsx#L29). | Search and reading cannot currently become independent workspaces. |
| Data foundations are worth preserving | [Store adapter](../src/data/WorldStore.ts#L20), [hash-checked engine migration](../src/data/engine.ts#L103), [archives](../src/data/archive.ts#L8). | Additive migration is safer than replacing the application. |
| Storage modes and scale need explicit contracts | [Engine selection](../src/data/engine.ts#L28), [full node listing](../server/worldDb.ts#L98), [ZIP32 limits](../src/data/archive.ts#L31). | A local SQLite server, hosted server and browser store have different offline behavior; full hydration and single archives will limit corpus scale. |

## Verification boundary

The current worktree already contains extensive tracked modifications and untracked implementation assets. This study must not reset them or treat them as its own implementation. Historical passing counts in design documentation are not a fresh baseline. The companion plan records the checks attempted during this study and separates them from the acceptance work still required.
