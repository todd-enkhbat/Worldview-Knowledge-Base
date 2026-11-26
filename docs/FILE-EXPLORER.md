# Nested pages and connected workspace tabs

Worldview's Library contains a dedicated files explorer alongside its content. The main application sidebar retains its vertical tool navigation. Existing imported Obsidian paths and filing memberships are reused. This organizes the local Worldview workspace; it does not rewrite or rename files in an external Obsidian vault.

## Organizing

Open Library or a page in **Your files**. Use **Add inside** to create another folder, section, concept, or note page at that level. Every type can contain more pages and library files; the hierarchy has no fixed two-level or type-order restriction. **New note** opens Writing Studio and files the new document in the current page. Search in the Library explorer reveals matching files with their ancestor path. Existing Library selection controls can move saved sources, writing documents, and books into any available page.

**Customize** changes a page's name, parent, type, custom type label, Markdown page text, icon, cover, and cover position. Moving a page preserves its ID, contents, descendants, and links. The parent picker excludes the page itself and its descendants, and the store rejects cyclic moves independently of the UI. Removing a page requires a second confirmation, reparents its files and children, and retains original source bytes. A sibling-name collision must be resolved before removing a page.

## Editing documents

Opening a text source in Library shows its editable title and content directly. Changes autosave locally after a short pause, and pending changes flush when leaving. The first edit creates a working document linked to the imported source; reopening uses that document. Its title and wording appear in Library without duplicating the imported file. The original bytes, text, and annotations remain accessible through **Original & annotations**. PDF files and explicitly linked historical versions retain their original reader.

The compact document bar puts version history, source dates, original download, and other secondary actions under **Details & tools**. Routine backup reminders are suppressed while a document is open; durability errors still appear. On narrow screens the files tree starts collapsed when a document is selected.

## Images and concepts

Existing page names suggest icons and locally bundled cover photos. Books and academics use the library cover; philosophy, civilization, and humanities use architecture; personal/life categories use forest; space/time categories use the existing galaxy image. General pages use the existing Earth image. All can be changed, including removing the cover. Preset attribution is in `public/covers/CREDITS.md`.

Uploaded icon and cover images use the existing immutable local media store. The backup reference collector includes their IDs and verifies their SHA-256 content on export/restore. Images are not uploaded to an image service.

A concept page has a linked Reading Topic. Filing material under that concept (including a nested page) adds that topic membership while retaining existing memberships. Converting an existing page to a concept also connects material in its subtree. Links open the existing Topics and Knowledge Graph views, with writing backlinks available in Topics. Removing the organizational page retains its topic and existing semantic memberships.

## Navigation

The workspace shows one section at a time. Use the vertical application sidebar to switch tools and the Library explorer to open folders and files. There is no top tab bar or open-tab persistence. Existing browser history, saved content, and per-page scroll positions remain available.

The explorer supports up/down navigation, left/right collapse/expand, and Home/End. Long paths remain available in breadcrumbs, parent choices, and tooltips. Mobile navigation uses the existing keyboard-trapped drawer. Light/dark appearance and reduced-motion behavior remain inherited from the application; the explorer adds no motion.

## Verification

Focused and regression tests cover mixed types through 25 nested levels, persistent moves and cycle rejection, validated metadata, name collisions, custom media export/restore, concept-topic membership, the changed create/customize/remove UI, and existing reading/backup behavior. Browser checks exercised desktop and mobile layouts, light/dark customization, uploaded images and positioning, file creation within a concept, linked topic backlinks, tab switching, and folder movement. The desktop application update copies application code/assets and checks that the existing source and filing counts remain unchanged.
