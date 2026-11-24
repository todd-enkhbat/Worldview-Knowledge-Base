# Reading, thinking, and writing in one workspace

This update connects the existing reading archive, writing studio, topics, and graph. It adds six improvements without requiring cloud AI or changing the 3D world's coordinate, rendering, or physics model. Drafts, retained originals, citations, annotations, and recovery history remain local workspace data.

## 1. Use saved research while writing

Open **Writing studio**, choose a document, and open **Research**. Its four views are **Highlights**, **Notes**, **Sources**, and **Topics**. Search matches saved quotations, your comments, source titles/text, and topic names locally.

- **Highlights:** choose **Insert quotation** to insert the exact quotation with its source title, immutable source/version identity, and character range. PDF quotations also keep their page number. The source link returns to the retained version rather than silently following a later edit.
- **Notes:** choose **Insert my note** to insert your own reading remark as an editable paragraph. Personal notes remain distinct from quoted source text.
- **Sources:** inspect an opening excerpt, follow its source link, or choose **Quote opening** to insert up to the first 400 characters with provenance. This does not generate or paraphrase the source.
- **Topics:** assign topics to the draft, create a topic, or insert an inline topic link. Typing `[[an existing topic name]]` also resolves a matching topic supplied to the editor. Unknown names remain ordinary text rather than creating an unintended topic.

A published writing document can show **Writing that cites this document** in the Research panel. These backlinks derive from explicit citation nodes in other active drafts. Merely similar wording does not create a citation or a semantic graph relationship.

Research results are bounded to 60 quotations, notes, or sources per view; refine the search to find another result. External source URLs are optional provenance. The retained source/version IDs remain the internal authority even when a website changes or disappears.

Implementation: [WritingResearch](../src/writing/WritingResearch.tsx), [structured editor nodes](../src/writing/extensions.ts), and [document validation](../src/writing/model.ts).

## 2. Give each topic one home

Choose **Topics** in the workspace, or follow a topic link from a reader, draft, or graph. A topic home brings together:

| View | What appears |
| --- | --- |
| Sources | Included sources with the matching original tag or an explicitly assigned reading topic. |
| Highlights & notes | Exact-version text/PDF quotations and personal remarks from those sources. |
| Writing | Active drafts assigned to this topic, plus writing connected through its published source. |
| Knowledge pages | Pages with explicitly shared sources or a matching normalized title. |
| Projects | Saved investigations explicitly scoped to related sources or with a matching normalized title. |

Original tags and assigned topic names are reconciled using Unicode normalization, case folding, and equivalent spaces/hyphens/underscores. A saved topic becomes the canonical identity for its matching original tags. Aliases keep existing links useful. This is a unified view over existing records; it does not rewrite the wording of imported metadata or merge unrelated source histories.

Use **Sources → Add or remove sources** to assign membership. Membership inherited from an original source tag is shown as such and cannot be removed through a checkbox that would pretend to edit the retained original. Assign a writing document through **Research → Topics**. Topic sections offer **Show 100 more** for longer collections, and the topic index asks you to refine a search after its first 100 matches.

The old saved-investigation workflow remains under **Saved investigations**. It retains its scope and evidence controls. A title match is labeled as a title match; it is not presented as a manually confirmed evidence relationship.

Implementation: [topic identity](../src/reading/topics.ts), [topic home](../src/reading/TopicHome.tsx), and [reading commands](../src/reading/store.ts).

## 3. Capture articles with less setup, and read original PDFs

### Browser companion

Open **Sources & activity → Browser reader**. Download and extract the companion once, then load its folder through Chrome/Edge's **Developer mode → Load unpacked** control. Browser installation is still a browser-managed step; the app does not silently install an extension.

After installation:

1. Open the extension and choose **Connect to Worldview**.
2. In the app's Browser reader panel, approve the request from the browser you just used.
3. Reopen the extension popup to finish connecting automatically. No ID or token copying is needed.
4. On an ordinary article page, choose **Save and follow this article**. Select text, reopen the popup, and save it with an optional comment.

The connection request expires after five minutes. Its secret is bound to the extension's exact origin; the extension cannot approve itself. Approved handoffs are memory-only on the local service until claimed or expired. The companion uses Origin-bearing JSON POSTs to claim them; an absent or different extension origin is still rejected. The resulting pairing lasts 90 days and can be revoked immediately in the app. The advanced manual-token flow remains available.

The popup reports pending captures, last confirmed delivery, and the latest failure. Retry when the local service returns. An invalid pending capture can be removed individually so the rest can be delivered; the UI confirms intentional removal of unsent data. The bounded outbox retains up to 20 entries in trusted extension storage. Queued means retained on the browser, not confirmed in Library.

Following remains an explicit choice for one tab. Navigation and browser restart stop it. There is no history permission, all-sites permission, automatic all-page content script, or external messaging interface. The fixed service endpoint is `http://localhost:5173`; browser network access remains loopback-only. Article sources retain extracted text and URL provenance rather than a full copy of the publisher's page. See the [browser guide](BROWSER-READING.md) for permissions, request limits, security boundaries, and recovery.

### Original PDF reader

Import a PDF through the existing file import flow, then open it in Library. **Original PDF** displays its retained page appearance with a selectable PDF.js text layer. Use page controls, **Fit width**, or numeric zoom. Select text on a page, add a comment/color in the same annotation controls, and choose **Save highlight**. A saved PDF quotation records normalized page-relative rectangles, exact selected wording, page number, and immutable source/version IDs.

Choose a PDF highlight's **Show context** action to return to its page. Reopening preserves its saved anchor; zoom changes do not rewrite its coordinates. PDF citations use the same page-aware links. **Extracted text** remains available, including the existing exact-offset annotations for that representation. Highlight exports include PDF page numbers. Page progress uses the displayed page and its inner scroll, rather than assuming that the surrounding reader viewport represents the whole PDF.

PDF.js 6.5.438, its worker, CMaps, standard fonts, and image-decoding resources are bundled locally. Upstream licenses are retained in [the license directory](../public/licenses/pdfjs-6.5.438/README.txt). There is no CDN, cloud OCR, document conversion service, or automatic execution of PDF actions/forms. The original bytes are size/hash-checked before opening. Limits are 64 MiB per PDF, 5,000 pages, and bounded rendering dimensions. Scanned pages without a text layer can be viewed and have source notes, but do not acquire OCR text automatically. Encrypted or damaged PDFs may require extracted-text reading or an external PDF application.

The local app service must be running to supply its application/assets. Bundling resources locally does not claim that every feature works after the local server has stopped.

Implementation: [pairing setup](../src/reading/BrowserCaptureSetup.tsx), [capture handler](../server/articleCapture.ts), [extension](../extensions/worldview-reader/README.md), [PDF reader](../src/reading/PdfReader.tsx), and [page anchors/original validation](../src/reading/pdfModel.ts).

## 4. Make the editor easier to work in

The writing studio keeps its document design, presets, local media, keyboard formatting commands, preview, and focus mode. New editing controls include:

- A **selection formatting** toolbar for bold, italic, highlighting, and links without returning to the top of a long page.
- A keyboard-operated **slash menu** for paragraphs, headings, lists, quotations, tables, dividers, footnotes, images, and videos. Type `/` in a text block; use arrow keys, Enter, or Escape.
- **Tables** with a header row, add/remove row and column controls, merge/split, and table removal. The document schema validates table structure and limits rather than retaining arbitrary pasted table HTML.
- **Footnotes** with editable text, inline references, and a Notes section/definitions in HTML or Markdown exports.
- **Sections** ordering: heading-based sections can move through drag handles or explicit Up/Down buttons. Moving a section moves its contained blocks together.
- **Image resizing** through a visible handle, keyboard arrow keys, or a 20–100% width slider. Alternative text, captions, and normal/wide/full presets remain available.
- **Upload status** that identifies the current media file and completed/total originals retained. It reports local retention progress, not an invented estimate of byte-level network progress.
- A compact mobile toolbar with **More formatting** for secondary controls.

Editor read-only/preview guards still reject changing transactions. Same-document autosave does not reset selection or undo history. Imported sources use **Edit a copy** so authoring a derivative does not rewrite its original. Unsupported pasted active resources are omitted, and external YouTube/Vimeo players still require an explicit load action.

HTML/Markdown/ZIP exports include supported tables, citations, topic notation, footnotes, and image width. HTML preserves the designed page most faithfully; Markdown rendering depends on the viewer. Internal topic notation is exported as `[[topic]]`, not as a claim that an external Markdown app shares this workspace's topic database. Browser printing remains the PDF-output workflow. See [Writing studio](WRITING-STUDIO.md) for the existing 256 MiB per-file retention and smaller portable-export budgets.

Implementation: [editor](../src/writing/RichEditor.tsx), [media views](../src/writing/WritingMediaView.tsx), and [exports](../src/writing/export.ts).

## 5. Recover earlier work visibly

Open **History** in a writing document. The timeline includes automatic checkpoints, named snapshots, and retained Library versions of that writing.

- Name a snapshot when you reach a milestone.
- Select a version to compare its title, text, and design with the current draft. Expand **Read this version** for side-by-side plain-text previews.
- Choose **Restore this version** to restore rich content, appearance, and topic assignments. The current draft is retained before restoration. Restoring a Library version changes the editable draft; it does not rewrite the immutable publication history.
- Use **Export → Move to Trash** to remove an editable document from the active desk. The desk's **Trash** view provides **Restore**. There is no permanent-purge control introduced by this flow. Existing Library publications remain retained sources.

Autosave and recovery history serve different purposes. Draft edits still autosave locally; automatic history captures the preceding saved draft at bounded intervals rather than recording every keystroke as a separate version. Automatic snapshots are deduplicated and rate-limited to approximately one minute. History bounds automatic checkpoints around 100 entries per document and 32 MiB overall; named/restore snapshots are not silently removed to meet the budget. If those protected snapshots fill the available history budget, an explicit error is shown. Comparison previews are bounded to 30,000 characters per side; restore uses the full validated rich snapshot.

`writingHistory.v1` is portable with world backups, including media referenced by historical writing. Named milestones, automatic snapshots, Library publications, and the current editable draft remain distinct records. Expected timestamps/revisions and store/world-generation checks protect concurrent changes. This is recovery/conflict handling rather than real-time collaborative merging.

Implementation: [history ledger](../src/writing/history.ts), [history interface](../src/writing/WritingHistory.tsx), and [restore commands](../src/writing/store.ts).

## 6. Find and connect a growing library

Writing-desk search now includes body text, not only the title/subtitle. Library search covers current retained text, draft content, tags/topics, highlights, and personal annotations. A disposable local trigram index reuses unchanged records and narrows candidates before exact matching. Unicode normalization and case folding improve matching. It is not cloud search, semantic inference, or a claim of a server-paginated million-document corpus.

In Library:

- Combine search, reading-status filters, folder, topic, sort, and grid/list layout.
- Choose **Save this view** to retain that combination under a name.
- Select files individually or with **Select visible files**, then move them to a folder, add a topic, favorite them, or mark them finished. Bulk selection/commands are bounded to 500 items.
- Source-backed items and unpublished writing drafts support filing. Original source text/media remain unchanged.

Archive and graph URLs retain useful query/filter/neighborhood state. Saved views are portable `reading.v1` data; a local search index is derived and can be rebuilt.

In **Knowledge graph**, selecting a node prioritizes its neighbors in the bounded canvas instead of relying solely on alphabetical pages. Visible counts identify connections outside the displayed canvas or current filters. **Show selected neighborhood** opens the selected node's neighborhood; depth controls can include one or two hops, and **Expand neighborhood** adds more nodes in bounded steps. The connection list names incoming/outgoing relationships and remains paginated/searchable independently of the canvas. Offscreen links are counted rather than silently implying that the displayed subset is the entire graph.

The global canvas pages 80 nodes at a time. A local neighborhood starts at 80 and can expand to a maximum of 320 nodes; drawn edges remain bounded to 400. Panning, zooming, fitting, source/topic filters, and keyboard-accessible node/connection lists remain available. Edges still come from original source tags, assigned topics, or explicit named relationships. Layout proximity is not evidence, and none of this moves records in the separate 3D world.

Implementation: [local index](../src/reading/search.ts), [archive and saved views](../src/reading/ReadingArchive.tsx), and [graph](../src/reading/KnowledgeGraph.tsx).

## Data and verification boundaries

The existing `knowledge.v1` authority retains source/version/passages and originals. `reading.v1` carries reading annotations, optional PDF anchors, saved views, folders, topic assignments, and explicit graph connections. `writing.v1` carries editable rich documents, appearance, and topic IDs; `writingHistory.v1` adds recovery snapshots. Validation remains backward-compatible with existing ledgers, and portable backups include their referenced originals. Pairing credentials/receipts remain private service state, excluded from portable exports.

No cloud generation, embedding, OCR, or transcription provider is required by these six improvements. The user's explicit `AI_PROVIDER=none` setting remains the cloud-AI boundary. Existing 3D records, original assets, and spatial/physics source files are preservation targets, not replacement content for this update.

Focused validation includes [editor](../tests/writing/editor.test.tsx), [exports](../tests/writing/export.test.ts), [history](../tests/writing/history.test.ts), [reader](../tests/reading/reader.test.tsx), [capture HTTP](../tests/server/articleCapture.test.ts), [extension runtime](../tests/reading/browserExtension.test.ts), [PDF anchor integrity](../tests/reading/pdfModel.test.ts), [PDF page/context navigation](../tests/reading/pdfReader.test.tsx), and the [actual two-page PDF parser fixture](../tests/reading/pdfParser.test.ts). The shipped [PDF fixture](../tests/fixtures/reading-pages.pdf) can also be imported for visual page rendering, selection/comment, page navigation, and cold-reopen acceptance.

A real extension installation, live capture, and actual PDF rendering/selection are separate browser acceptance steps. Automated HTTP/runtime/parser tests alone do not establish that a browser installed the companion or decoded the PDF page correctly.

Final November 23 acceptance passed typecheck, lint, the production build, and **1,261 tests** (4 skipped). In actual Chrome, reader 0.2.1 installed and connected with explicit approval, saved an article and selected passage/comment, retained an unconfirmed capture, and delivered it on retry without duplicating the passage or comments. The test connections were revoked; the installed reader was paired with the original local workspace and left with no followed tab or pending captures. Edge installation was not tested on this machine.

The production build rendered the original two-page PDF with selectable text. Its highlight/comment survived reopening and returned from page two to page one through Show context. The same highlight became a source/version/page citation in a draft. A named snapshot restored correctly while keeping the newer title in history; a document with a table, footnote, and reordered section returned from Trash with its identity and content retained. Shared topics, bulk assignment, body searches, a saved view, and graph expansion were checked through the actual interface. Mobile writing actions and topic pages fit a 390 px viewport without horizontal document overflow.

All baseline original records/assets and 152 spatial source files matched their backup. Additional records that appeared during the work were retained separately. Full evidence and scope are in the [acceptance record](evaluations/six-improvements-acceptance-2026-11-23.json).

Actual captures: writing with research (local-only capture: `design/knowledge-writing-research-2026-11-23.jpg`), version history (local-only capture: `design/knowledge-writing-history-2026-11-23.jpg`), PDF highlights (local-only capture: `design/knowledge-pdf-highlights-2026-11-23.jpg`), topic home (local-only capture: `design/knowledge-topic-home-2026-11-23.jpg`), connected graph (local-only capture: `design/knowledge-connected-graph-2026-11-23.jpg`), mobile writing (local-only capture: `design/knowledge-mobile-writing-2026-11-23.jpg`), and mobile topic (local-only capture: `design/knowledge-mobile-topic-2026-11-23.jpg`). The sample documents are from the isolated acceptance world.
