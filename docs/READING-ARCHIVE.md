# Local reading archive, annotations, and connections

Library now opens a document archive with paper-like text previews, folders, reading filters, favorites, and a dedicated annotated reader. The Knowledge graph connects the same retained sources to topics and relationships you choose. These workflows run locally without a cloud AI provider. The existing 3D world remains available through **Explore in 3D**.

## Keep something worth reading

1. Open **Library → Save article**. Enter a title, the original HTTP(S) URL, and the article text. Add an optional first impression, then choose **Save to my files**. The URL records provenance; the server does not fetch that page.
2. Alternatively, use **Import files** for supported documents and conversation exports, or save a thought from Today. Existing retained sources remain in the same Library.
3. Choose a document cover or its title to read it. Switch between grid and list views; sort by last modified, last opened, or name. Search matches saved titles, source text, tags, topic names, highlight quotes, and personal annotations.
4. Use **Continue reading**, **Finished**, **Highlighted**, **Favorites**, **Articles**, **Notes**, and **Documents** to narrow the archive. The file list loads in bounded batches rather than rendering the entire archive at once.

Article capture retains the submitted or extracted text and a downloadable JSON capture envelope with its URL and title. It does not retain a screenshot, the publisher's full HTML, cookies, or a PDF rendering. Imported file originals keep their existing original-download behavior. Document covers are previews of retained text, not screenshots or remotely fetched images.

## Read, highlight, and leave your own remarks

Select text in the reader by mouse, touch, or keyboard, choose a highlight color, add an optional comment, and select **Save highlight**. The **Highlights** panel keeps the quotation alongside your comment. **Show in article** locates it in its retained source version; an older-version highlight opens that historical context. Comments can be edited independently of the quoted text.

Use **Notes** for a response to the whole source. These notes and highlight comments remain separate from the original author's words. **Export highlights and notes** downloads a readable Markdown document containing quotations, comments, notes, and source-version references. A full world backup retains the structured annotation metadata as well.

The **Reading status** control lets you choose **To read**, **In progress**, or **Finished**. Opening a source records an interaction and can put it in progress; opening alone does not mark it finished. Automatic progress uses visible reader time and scroll position, with completion at the stored 90% threshold. It is an approximate activity signal, not proof of comprehension. You can set the status explicitly.

The source-version selector still opens retained earlier wording. Highlights are attached to the version that was actually selected, so a later article edit does not silently move an old quotation onto new text. Sources without extracted readable text still retain their original-download path; there is no text to highlight until extraction is available.

## File by place; connect by topic

In the reader's **Organize** tab, choose a folder and assign any number of topics. You can create and connect a new topic there. Create or rename folders from Library; removing a folder reparents its files and child folders rather than deleting source text or annotations.

| Concept | What it stores |
| --- | --- |
| Folder | One filing location per source, with optional nested folders. |
| Reading topic | A named subject that can include many sources; each source can belong to several. Topic IDs survive renaming. |
| Source tag | Existing source metadata. It remains distinguishable from a topic you manually assign. |
| Personal annotation | Your exact highlight comment or whole-source note, stored separately from source text. |
| Manual relationship | A source/topic link you choose: `related`, `supports`, `contradicts`, or `builds-on`. |

Reading topics are separate from maintained **Knowledge pages** and from the saved investigations in **Projects & topics**. Organizing an article does not create a generated wiki claim or approve an interpretation of it.

## Follow a connection

Open **Knowledge graph**, the **Graph** link in Library, or **Connections** in the reader. A source-specific link opens its local neighborhood; the global graph can show all included sources, saved topics, and source tags.

- Search by title or tag, toggle sources/topics, and choose a one- or two-link neighborhood.
- Drag to pan, scroll or use the zoom buttons, and choose **Fit graph to view**. With the canvas focused, arrow keys pan, `+`/`−` zoom, and `0` fits.
- The node list provides equivalent keyboard selection with arrow keys, Home, and End. Selecting a graph node opens its details, backlinks, and neighboring records. **Open original source** returns to the exact Library source.
- Use **Connect sources & topics** to choose two retained sources or saved topics and a relationship. `related` is symmetric; the other relations preserve direction. Connections can be removed from the inspector.
- A source-tag node is labeled as metadata. **Save as topic** makes it available for manual relationships. A saved topic with the same normalized name shares that tag membership in the graph.

The graph uses a finite deterministic layout, with at most 80 nodes per page and a bounded set of drawn edges. Inspector connections are searchable and paged. Labels and markers retain readable screen sizes as the canvas fits or resizes. There is no continuously running force animation.

Graph lines represent source metadata, explicit topic membership, or your saved relationships. Distance is a layout aid, and a user-selected `supports` edge is not verification that a claim is true. Excluded or deleted sources and their incident graph edges disappear from the active view; hiding a source does not itself erase its retained reading metadata.

## Capture from Chrome or Edge

The optional **Worldview Reader** companion is a Chrome/Edge Manifest V3 unpacked extension for the local service at `http://localhost:5173`. Use the local service's SQLite world as the active workspace; companion captures are committed to that service, rather than to a separate browser-only IndexedDB world. In **Sources & activity → Browser reader**, download and extract the companion ZIP, use the browser's **Load unpacked** action, then pair its extension ID with the local app. The app creates a revocable 90-day token shown once for entry in the extension popup. This is an explicit install-and-pair flow; the implementation does not install an extension into a user's browser profile automatically.

Choose **Save and follow this article** in the selected article tab. The **ON** badge identifies that tab's following session. It can capture selected text with a comment and record approximate visible/focused reading activity. It does not follow unrelated browsing. Navigation, restart, or an explicit stop ends following. A bounded local outbox retains unsent captures for manual retry while the app is unavailable.

See [browser reading setup and request boundaries](BROWSER-READING.md) for pairing, revocation, offline behavior, exact limits, and verification. This build does not support Firefox; PDFs, protected browser pages, cross-origin iframe content, virtualized pages, and paywalls can prevent extraction. Manual article paste remains available. The companion's protocol and scripts are tested separately from installing the unpacked extension in a real user browser.

## Storage and exact anchors

The original corpus remains authoritative in `knowledge.v1`: source identity, immutable retained versions, original blob references, and passages. The separate portable `reading.v1` snapshot contains folders, per-source reading items, highlights, personal notes, topics, and manual connections. It does not become a second writable copy of source text.

Reading mutations are serialized and committed through the repository's revision-checked compare-and-swap operation. Each command reads the current snapshot, validates its source/topic references, increments its revision, and refuses a stale write. Active store and world-generation checks prevent an old operation from applying to a replaced world. The browser capture service can commit a source/version and its requested reading annotation together in a SQLite transaction.

`reading.v1` is on the portable world-key allowlist, so ZIP and segmented directory backups include it alongside the corpus and retained originals. Restore/wipe events refresh the bound reading store. Browser pairing tokens, private capture receipts, and device handles are not portable world keys and do not enter those backups.

A highlight stores `sourceId`, `versionId`, a zero-based inclusive `start`, an exclusive `end`, the exact `quote`, and optional `prefix`/`suffix` context. Offsets count **JavaScript UTF-16 code units in the retained version text**, including whitespace. Saving validates `version.text.slice(start, end) === quote` and any supplied context. For example, in `A😀B`, the emoji occupies `[1, 3)` in this schema.

The quote-and-context approach is informed by the [W3C Text Quote Selector](https://www.w3.org/TR/annotation-model/#text-quote-selector), but `reading.v1` is an application schema, not a complete W3C Web Annotation/JSON-LD implementation. W3C's character model uses Unicode code points and normalization rules; converting these UTF-16 offsets requires an explicit interoperability layer. Historical annotations stay attached to their original version rather than being heuristically reassigned.

## Boundaries and reference material

This is a local reading and organization layer, with no paid AI dependency, handwriting engine, freehand ink, PDF page-coordinate annotation, or e-ink device integration. The 2D reading graph is separate from the 3D world. Article capture and reading metadata do not automatically create or move 3D records, and no world renderer, spatial coordinate mapping, or reversible physics kernel was changed for this feature.

The organizational reference is reMarkable's [Organize your ideas](https://support.remarkable.com/s/getting-started/step-4): folders, tag-based retrieval, and document-oriented browsing. Readwise's [Saving Content to Reader](https://docs.readwise.io/reader/docs/saving-content) informed the explicit capture/highlight/note workflow; this app's companion has its own narrower local permissions and installation model. Graph interactions draw on [Obsidian's graph documentation](https://obsidian.md/help/plugins/graph). These are product references, not integrations with those services or copies of their proprietary assets.

The app browser workflow has been exercised through article save, text selection, highlight/comment, folder filing, multiple topic assignments, a manual semantic connection, and reload persistence. Validation entry points include [storage](../tests/reading/storage.test.ts), [archive](../tests/reading/archive.test.tsx), [reader](../tests/reading/reader.test.tsx), [graph](../tests/reading/graph.test.tsx), [article capture](../tests/reading/articleCompanion.test.tsx), [companion scripts](../tests/reading/browserExtension.test.ts), and [HTTP capture](../tests/server/articleCapture.test.ts).

## Verified implementation

Typecheck, ESLint and the production build pass. The final full suite passes 1,167 tests across 181 files, with four opt-in tests skipped. The browser pilot saved an article, highlighted an exact sentence with a comment, added a personal note, filed the source, assigned two topics, saved a supports connection and verified restart retention. The downloaded Markdown retained the quote, remarks, source URL and exact version locator. Browser companion installation remains a manual setup step.

The [acceptance and integrity report](evaluations/reading-archive-acceptance-2026-11-23.json) records the checks. Saved previews: archive (local-only capture: `design/reading-archive-2026-11-23.jpg`), annotated reader (local-only capture: `design/reading-annotations-2026-11-23.jpg`), graph (local-only capture: `design/reading-graph-2026-11-23.jpg`), mobile archive (local-only capture: `design/reading-mobile-archive-2026-11-23.jpg`), mobile reader (local-only capture: `design/reading-mobile-reader-2026-11-23.jpg`), and mobile graph (local-only capture: `design/reading-mobile-graph-2026-11-23.jpg`).
