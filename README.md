# Worldview Knowledge Base

The researched second-brain integration adds maintained knowledge pages, incremental corpus storage, scoped MCP memory, durable voice capture and portable vault output. See [integration and validation](docs/SECOND-BRAIN-INTEGRATION.md), [agent setup](docs/MEMORY-INTEGRATION.md), and [capture/export usage](docs/CAPTURE-PORTABILITY.md). The spatial world remains available through **Explore in 3D**. The [local workspace UX update](docs/LOCAL-WORKSPACE-UX.md) adds persistent navigation, quick commands, retained drafts, both themes and responsive controls.

A personal knowledge workspace with retained sources, evidence-backed retrieval, and an explorable 3D world. XYZ represents space; the timeline represents history.

The [local reading archive](docs/READING-ARCHIVE.md) adds document covers, folders, highlights with comments, reading progress, topic organization, and a connected 2D graph. The optional [Dia/Chrome/Edge reader companion](docs/BROWSER-READING.md) saves explicitly selected articles to the local app; no cloud AI is required.

The [writing studio](docs/WRITING-STUDIO.md) adds rich documents, local media, page design, autosaved drafts, explicit Library revisions, and HTML/Markdown/ZIP exports alongside quick thoughts. Print-to-PDF uses your browser's print dialog.

The [connected reading and writing update](docs/SIX-IMPROVEMENTS.md) brings research citations, unified topic homes, original PDF annotation, browser approval and retry, tables/footnotes/section tools, version recovery and Trash, indexed search, bulk filing, and expandable graph neighborhoods. Cloud AI stays optional and off in this workspace.

The [personal workspace update](docs/PERSONAL-WORKSPACE.md) adds a physical-style bookshelf with reading details and full edit history, animated graph exploration, shared 3D navigation, scoped assistant editing with review, a Google Drive connection, and a downloadable macOS vault app. Cloud generation remains off.

## Run locally

Use Node 26 or newer, then run `npm ci` and `npm run dev`. Open [localhost:5173](http://localhost:5173). Keep this origin and port: browser storage belongs to it. The local service stores SQLite and original files under `data/`; existing browser worlds keep their current storage until explicitly migrated in Settings.

`npm run check` runs TypeScript, ESLint and the test suite. `npm run build` creates the production build. Environment options are documented in `.env.example`; provider credentials belong only on the server. Cloud AI is off by default (`AI_PROVIDER=none`). Capture, reading, search, local transcription and exports work without paid API access. To opt in later, explicitly set `AI_PROVIDER=openai` with `OPENAI_API_KEY`, or choose Anthropic, in `.env.local`. Local QMD and Whisper setup use `node scripts/qmd-setup.ts` and `node scripts/setup-whisper.ts`. Sources & activity contains the QMD, Telegram and AI connection controls. Telegram requires a dedicated bot token and explicit sender/chat allowlists; cloud generation requires active API credit.

## Workspace

- **Today:** save a thought immediately, without configuring AI, and return to recent work.
- **Search & ask:** search complete indexed passages, filter speakers, dates and sources, and open exact evidence. The optional companion has bounded search/read tools and validated citations.
- **Library:** read retained versions and download originals. Editing a projection creates a revision while preserving imported text.
- **Projects & topics:** save investigations with their query and source filters, and keep open questions.
- **Review:** inspect lexical connection suggestions, keep or reject them, and undo decisions.
- **Sources & activity:** import ChatGPT/Claude exports, Markdown, text, PDFs and DOCX; repeat imports without duplicates; inspect jobs and control inclusion and AI access separately. Register an explicit local folder for background capture while the service runs.
- **Explore:** open the same record in the existing molecular 3D world and return to the reading context. Daily capture and reading do not require WebGL.

PDF text extraction uses the locally installed Poppler `pdftotext` executable. Without it, originals are still retained and the failed extraction can be retried. Scanned PDFs require OCR outside this release. Continuous folder capture is available only on the local service, with explicit roots and visible scan limits. Hosted accounts do not expose the local filesystem.

## Recovery and privacy

Settings supports the existing ZIP backups and a segmented directory backup with verified manifests, record hashes and original hashes. Directory replacement requires a separately verified backup before clearing the destination. Keep independent backups: deleting a source does not erase previously exported copies.

Corpus exclusion removes a source from search and the world. AI access also controls optional local embeddings and companion context. Semantic model download/inference remains opt-in; lexical capture and retrieval work without it. Permanent deletion of one conversation also purges its shared raw export bundle when that bundle contains the deleted conversation; other conversations keep their retained normalized text and explicitly lose that original download.

The [implementation status and remaining roadmap](docs/WORKSPACE-UPDATE-PLAN.md) distinguish shipped functionality from future work. Packaged desktop/mobile delivery, cloud account connectors, encrypted offline multi-device sync, and a full assertion/belief revision system remain future work.

## Second-brain source study

The [eight-project source study](docs/research/second-brains/2026-11-23/README.md) compares GBrain, LLM Wiki, Claude-Mem, Agent Second Brain, Supermemory, Basic Memory, QMD and Obsidian Skills against this implementation. It includes pinned local downloads, code-level evidence, component licenses, a small inert reuse kit and a concrete integration plan. Full vendor checkouts stay under the ignored `data/research/` directory; no upstream apps or agent skills are activated by the study.
