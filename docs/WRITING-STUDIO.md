# Writing studio

Writing studio adds a local document editor alongside the existing quick-thought capture. It keeps rich drafts, page design, and original media in your workspace, then lets you explicitly save a retained version to Library. It runs without cloud AI, an editor subscription, or a remote conversion service. The existing 3D world and its spatial/physics behavior remain unchanged.

## Start with a thought or a document

Use **Today → Quick thought** for immediate plain capture, or choose **Writing studio** from Today, the workspace navigation, or the command menu. The writing desk shows your saved drafts and six starting forms:

| Form | Starting structure |
| --- | --- |
| Blank page | An empty paragraph. |
| Essay | The idea, A closer look, What follows. |
| Newsletter | This week, Worth your attention, One last thought. |
| Journal | What happened, What I noticed, What I want to remember. |
| Poem | An open page with roomier line spacing. |
| Research note | The question, Observations, Evidence & sources, Open questions. |

These are editable starting sections, not generated prose. Add a title, subtitle, and byline directly on the page. Drafts are also discoverable in Library's **My files** archive; opening a writing document returns to its editor.

## Write and format

Select text, then use the toolbar to apply bold, italic, underline, strikethrough, inline code, text color, highlighting, a font family, or a font size. Use **Text style** for normal text, headings 1–3, quotations, and code blocks. Bulleted/numbered lists, paragraph alignment, links/unlinking, dividers, undo, and redo are included. Standard editor keyboard commands such as Cmd/Ctrl+B, I, U, and undo/redo work through the editor's command system.

Formatting buttons preserve the selected range, including when you choose a font, color, or link URL. The toolbar works on an empty document before you type. **Edit link** accepts HTTP, HTTPS, or mailto URLs; unsupported schemes and embedded credentials are rejected.

Supported pasted HTML is converted through a restricted document schema. Scripts, remote images, arbitrary frames, active documents, and unsupported resources are omitted. Upload an image from your device or insert an approved video URL instead of relying on a pasted remote image to load.

**Preview** hides the formatting toolbar and makes the page read only while retaining playable local media. **Focus mode** reduces surrounding workspace chrome. **Outline** lists document headings and moves the editor to the chosen section. Word count and estimated reading time appear below the page.

## Give the document its own design

Open **Design** to change this document's appearance. Presets include **Paper**, **Clean**, **Midnight**, **Sage**, and **Ocean**. They provide starting colors and typography; you can continue adjusting them.

- Choose serif, sans-serif, or monospace document typography, text size, line spacing, text color, and accent color.
- Change the page width and paper color, or switch between a sheet of paper and a seamless canvas.
- Set a solid background, soft gradient, waves, dotted paper, or your own uploaded image.
- Adjust pattern/wave color and strength, replace or remove a background image, or reset the document design.

Design settings are saved with the document rather than changing the workspace theme or the 3D world's materials. The waves and dots are static CSS patterns; they do not run an animation or simulation. Selected-text styling in the toolbar can override the document's base typography for a passage.

## Add local media or an explicit video link

The image, video-file, and audio-file toolbar buttons accept files from your device. File paste and drop use the same retention path. Media originals are checked by their bytes and retained under content-addressed asset IDs; a filename or declared MIME type cannot turn HTML or SVG into an inline media block. Accepted raster images include PNG, JPEG, WebP, GIF, and AVIF. Audio/video use supported containers and native browser playback, with no transcoding service; actual codec support depends on the browser.

Select a media block to edit its caption, choose normal/wide/full width, remove the block, or add an image description for alternative text. Media is loaded through local Blob URLs that are revoked when the view or world changes. Upload completion is scoped to the same document and workspace; editing while an upload runs does not make its insertion target a different document.

**Embed video** accepts validated YouTube or Vimeo URLs. The editor initially shows a placeholder; loading the external player requires an explicit action. That action contacts the video provider. Arbitrary iframe HTML is not accepted, and exported documents keep external videos as explicit links rather than automatically loading players.

The per-file retention limit is 256 MiB. Portable writing exports have the smaller combined budgets described below; retaining a large original does not imply that it fits into a self-contained export.

## Local drafts and Library versions

Typing, formatting, and design changes autosave the editable draft locally. The header reports **Unsaved changes**, **Saving locally…**, **Saved locally**, or an actionable save error. A pending save advances its saved baseline without replacing newer text typed while it was running. Navigation/visibility changes attempt to flush pending work, and an unfinished save can trigger the browser's leave-page prompt.

Autosaving a draft does not silently publish every keystroke into the evidence corpus. Choose **Save to Library** to create a retained source version, or **Save revision** for a document that already has one. Publication first flushes the draft. Rich JSON, appearance, and media references are retained with the original, while a plain-text representation supplies readable/searchable source passages. Repeating publication without a content/design change does not create another identical version. Changed published revisions retain earlier versions and their highlight anchors.

From a retained source in Library, **Edit a copy** creates a writing draft based on that source and remembers its source/version provenance. The imported original is not rewritten. A source already linked to your own writing offers **Edit document** to return to its draft. **Make a copy** in the writing export menu creates another editable document.

Writes use expected revisions and timestamps. If another saved version conflicts with your work, local edits remain visible; the UI offers reload, retry, or saving your edits as a copy. The rich editor also preserves an active same-document draft when a different external content value arrives, offering an explicit version choice. These protections are conflict handling, not real-time collaborative merging.

## Export or print

| Action | Delivered artifact |
| --- | --- |
| Formatted HTML | A standalone `.html` document with the saved appearance, supported inline formatting, and embedded local media data. External videos remain links. |
| Markdown | A `.md` file when there is no local media; with media, a `-markdown.zip` containing Markdown, retained assets, and the writing JSON manifest. |
| Document + original media (ZIP) | A `-writing.zip` containing `document.html`, `document.md`, `writing.json`, original files under `assets/`, and a short README. |
| Print / save PDF | The browser's print dialog. Choose its PDF destination when available. This is not an automated PDF renderer or DOCX export. |

HTML is the format for preserving the designed page. Markdown retains common document structure and links; some features use inline HTML, and font/color/layout fidelity depends on the Markdown viewer. A ZIP's JSON manifest retains the structured document and appearance even when a Markdown renderer cannot show every style. The ZIP is an export artifact, not a new ZIP-import workflow in the writing UI; use the existing verified world backup/restore flow for workspace recovery.

Writing exports permit at most **64 MiB of distinct retained media** and a **128 MiB output budget**. Self-contained HTML estimates count each base64 embedding, so repeating one asset many times can exceed the output budget even when its distinct original is small. ZIP generation also checks its uncompressed file payload. Missing or mismatched originals and over-budget exports produce an error rather than an artifact with dangling media. Use a verified world backup for larger retained originals.

Browser print settings affect pagination, backgrounds, and available PDF destinations. There is no paid conversion integration, automatic DOCX conversion, or guarantee that an arbitrary external editor will reproduce the designed page exactly.

## Architecture and portability

The editor uses the MIT-licensed open-source Tiptap/ProseMirror stack, with the installed Tiptap packages pinned to **3.35.0**. It uses StarterKit, TextStyleKit, text alignment, highlight, placeholder, and application-owned media/embed nodes. It does not depend on Tiptap's paid AI, conversion, or real-time collaboration products. See the official [React integration](https://tiptap.dev/docs/editor/getting-started/install/react), [TextStyleKit](https://tiptap.dev/docs/editor/extensions/functionality/text-style-kit), [JSON persistence guidance](https://tiptap.dev/docs/editor/core-concepts/persistence), and [MIT license](https://github.com/ueberdosis/tiptap/blob/main/LICENSE.md).

`writing.v1` is a versioned, portable snapshot of document JSON, appearance, identity, provenance, publication metadata, and archive state. The shared validator restricts node/mark types, style values, link schemes, embed providers, and media asset IDs. Commands serialize through the repository writer and use compare-and-swap revisions, expected `updatedAt`, active-store identity, and world-generation checks. The draft UI separates its current local edit from the last committed baseline.

The rich editor instance is owned by document identity. Same-document autosave echoes do not call `setContent` or reset the active selection. Toolbar state uses `useEditorState`; React transaction-wide rerendering is disabled. An Activity hide/reveal can rehydrate the latest local JSON and selection, while switching documents creates a separate editor/history session. Read-only mode also rejects content-changing transactions rather than relying only on disabled toolbar buttons.

`writing.v1` is included in ZIP and segmented directory world backups. Referenced media and background originals are included by the shared asset-reference collector; published historical versions retain their referenced originals too. Publishing uses the existing source/version ledger with `project: false`, so it does not create or reposition a 3D world record. No spatial renderer, reversible physics code, or visible XYZ mapping was changed by the writing studio.

Implementation entry points are [studio](../src/writing/WritingStudio.tsx), [rich editor](../src/writing/RichEditor.tsx), [extensions and paste boundary](../src/writing/extensions.ts), [draft autosave](../src/writing/useWritingDraft.ts), [model](../src/writing/model.ts), [store/publication](../src/writing/store.ts), [media](../src/writing/media.ts), [media views](../src/writing/WritingMediaView.tsx), [design panel](../src/writing/WritingDesign.tsx), and [exports](../src/writing/export.ts).

Browser checks exercised typing, bold and yellow highlight, heading/italic changes, the Ocean wave preset, image alternative text/caption, decoded MP4 playback, Library publication, and an actual downloaded HTML export. Focused validation entry points are [editor](../tests/writing/editor.test.tsx), [autosave](../tests/writing/autosave.test.tsx), [store/publication](../tests/writing/store.test.ts), [media](../tests/writing/media.test.tsx), and [export](../tests/writing/export.test.ts). See also the [reading archive guide](READING-ARCHIVE.md) for retained-source annotations and graph connections.

Final November 23 verification passed typecheck, lint, the production build, and 1,212 tests (4 skipped). Cold reopen preserved the complete rich draft and originals; repeated unchanged publication kept one version. Additional browser checks confirmed the empty-page toolbar, local background-image upload, focus/preview, and the 390 px editor/design panel without horizontal overflow. The user’s original spatial data and 152 spatial source files matched their baseline. Full evidence is in the [acceptance record](evaluations/writing-studio-acceptance-2026-11-23.json).

Actual interface captures: desktop editor and design (local-only capture: `design/writing-studio-2026-11-23.jpg`), preview (local-only capture: `design/writing-preview-2026-11-23.jpg`), mobile editor (local-only capture: `design/writing-mobile-2026-11-23.jpg`), and mobile design controls (local-only capture: `design/writing-mobile-design-2026-11-23.jpg`). These use isolated acceptance documents, not changes to the user’s retained sources.
