# Personal library, connected assistants, and desktop workspace

This update keeps cloud generation off and preserves the existing 3D engine. Bookshelf records, writing, reading annotations, and their histories live beside the current SQLite world. Existing records and originals are not replaced.

## Start here

- **Bookshelf**: add books or short articles, upload a cover or design one, and track Want to buy, Unread, Reading, and Read. Keep ratings, authors, recommenders, dates, collections, notes, and custom details. Save edits explicitly; History retains preceding details and covers. Trash is recoverable. Use Add from Library to link a retained source, or the reader's Add to bookshelf action. CSV and self-contained JSON imports and exports are available under More. See [Bookshelf](BOOKSHELF.md).
- **Knowledge graph**: follow a source or topic, focus its neighborhood, inspect original excerpts, and start writing from a source. Layout and camera transitions are finite; motion can be paused and follows reduced-motion preferences. Dragging or pinning changes only the open 2D view. Existing saved 3D relationships also appear, with links back to their world records. See [Graph exploration](GRAPH-EXPLORATION.md).
- **Sources & activity → Agent access**: choose evidence and editable documents, grant only the capabilities needed, and copy a local MCP connection configuration. An assistant can propose changes; Worldview holds each proposal for review before applying it. Revocation and stale-revision checks remain authoritative. No model API key is needed by Worldview to serve its local MCP tools. The assistant application has its own account and connectivity requirements. See [Assistant editing](ASSISTANT-EDITING.md).
- **Sources & activity → Google Drive**: configure this application's OAuth client locally, connect your Google account, and select files explicitly. Import retains originals; export sends chosen writing to Drive. Updates check the selected target's revision before replacement. OAuth credentials and tokens stay outside portable world backups. See [Google Drive setup](GOOGLE-DRIVE.md).
- **Sources & activity → Desktop workspace**: download the local macOS build and open your existing workspace folder. For this checkout, select `data/` or its containing project folder. The native app reuses a matching local service or starts its bundled service. Opening another folder is explicit.
- **Sources & activity → Browser reading**: Worldview Reader works in Dia, Chrome, and Edge. Follow only the tab you choose; save quotations and comments explicitly. Browser following does not grant browsing-history access. [Browser setup](BROWSER-READING.md) describes pairing and limitations.

## Connection boundaries

The local app does not turn a ChatGPT web tab into a local-file client by itself. Local desktop clients can use the supplied MCP endpoint or STDIO bridge. ChatGPT web requires a supported remote connection or tunnel; this update does not publish the private local corpus. Current official setup references: [local MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=app), [custom MCP servers](https://developers.openai.com/api/docs/guides/custom-mcp-server).

Google Drive needs a separate OAuth client and account consent. Existing Codex connector credentials are never copied into Worldview. Selected-folder capture remains explicit and bounded. The desktop vault contains the SQLite database and retained originals; its native bridge exposes only workspace selection, workspace information, and revealing the selected folder.

## Visual and motion implementation

Two generated, section-specific references established the bookshelf and constellation directions; actual screens use HTML, SVG, CSS transforms, and retained data. The bookshelf's covers have real spine and page edges. Graph transitions preserve a stable mental map, and relationship traces are tied to an explicit focus action. The decorative ASCII orbit runs for under four seconds and stops when hidden or reduced motion is requested. There is no third-party animation runtime or tracking image request.

Brand imagery is a locally served NASA Blue Marble composite with [source and usage attribution](../public/licenses/earth-image.md). User-uploaded book covers are retained locally. The 3D scene, physics, spatial coordinates, and original assets retain their existing implementation; its navigation now exposes Writing, Bookshelf, and Knowledge graph directly.

## Verification evidence

Before changes, a consistent SQLite backup and original/spatial file hashes were retained at `data/backups/before-personal-library-2026-11-23/`. Bookshelf and assistant-editing tests use an isolated copy under `data/live-tests/personal-library-2026-11-23/`, served on a separate port. Demonstration books in screenshots belong only to that test workspace.

The browser acceptance flow edited book details, reloaded them, inspected the preceding version, and restored it while preserving the newer version. A real MCP SDK client proposed writing; the UI displayed it pending, required comparison review, and approval persisted the draft. The original 15 world nodes and four links remained present. Full regression, desktop packaging, connection setup requirements, and final acceptance status are recorded in the evaluation artifact for this update.


Final checks passed: **1,345 tests**, four skipped, typecheck, lint, and production build. Native acceptance opened the existing vault, confirmed shared SQLite/cloud AI off, and rendered the 15-note/four-link world. [Full acceptance record](evaluations/personal-workspace-acceptance-2026-11-23.json) and [desktop package verification](evaluations/desktop-app-acceptance-2026-11-23.json) distinguish automated checks, actual UI observations, and distribution limits.

Google Drive is connected after the user's explicit approval of selected-file access. Drive API and Picker API were enabled in Dia, and credentials are stored privately with mode `0600` and a refresh token available. A clearly labeled synthetic writing draft was exported to a new Google document; headings, bold, italic, and list formatting were verified in Dia, then Google's Desktop picker selected that document for a verified DOCX-original and readable-text import. The labeled draft, Library source, and Google document remain available for inspection. Original 15 world notes, four links, and three existing writing documents are unchanged; cloud AI remains off.

The connection remains a manual bridge. Google supplied no strong ETag for the test document, so the app correctly disabled replacement. The native-export duplicate-version issue is fixed: a live repeat import of the unchanged revision displayed “already kept locally” and added no fourth version. The two pre-fix exports remain preserved alongside a later revision from Google. Thirty-eight focused Drive tests pass; retained-byte validation, extraction recovery, and remote/local revision guards protect reuse.
