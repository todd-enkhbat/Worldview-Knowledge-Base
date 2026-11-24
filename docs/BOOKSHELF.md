# Your bookshelf

Bookshelf is a personal catalog of books and articles, separate from the retained-source archive. It works locally with cloud AI off. A book entry does not create a 3D world record or reposition anything in the world.

## A shelf for every reading stage

Open **Bookshelf**, then choose **Books** or **Articles**. The stage tabs are **All**, **Want to buy**, **Unread**, **Reading**, and **Read**. Search finds titles, authors, recommenders, ISBNs, personal notes, and your own custom details. Sort by recent changes, title, author, or rating.

Add a title manually, or use **Add from Library** to link an existing retained article or document. The linked source keeps its original bytes, annotations, topic assignments, and version history in Library. Adding the same source again opens its existing shelf entry, including when it is in Trash; it does not overwrite personal edits or create another projection.

The books are code-native physical objects: front covers, spines, page edges, subtle linen-like texture, and slim shelf ledges. Cover motifs use original CSS geometry and your actual title/author. No third-party cover artwork or fake personal books are seeded. Pointer tilt has a keyboard focus alternative and respects reduced motion. The warm-paper light appearance and dark-study appearance follow the existing workspace theme.

## Details that stay editable

Open a book or article to edit its title, subtitle, authors, print/digital edition, reading stage, rating from 0–5, recommender, personal notes, web URL, ISBN, publication year, page count, and reading dates. Separate multiple authors with semicolons. Add your own named fields for details the standard form does not cover.

Changes stay in the editor until **Save changes**. Pending work is visibly labeled, closing offers a discard choice, and navigation/unload guards protect unsaved details. Saved updates use the previous `updatedAt` and ledger revision. If another writer wins, your local edits remain available; reload the saved details or save your changes as a copy.

**Collections** are user-named groups independent of reading stage. Create or rename a collection on the shelf, then assign a title from its detail page. Archiving a collection hides it from the active picker while retaining its identity and membership; it can be restored. A book can belong to multiple collections.

## Covers and original files

Upload a PNG, JPEG, WebP, GIF, or AVIF cover up to **12 MiB**. File signatures determine accepted image types; HTML and SVG cannot become cover images through their extension or MIME declaration. Original bytes are retained under a `bookshelf-cover-<SHA256>` asset identity, verified again on read, and shown through scoped local Blob URLs. No remote cover image is fetched automatically.

Without an uploaded cover, choose a palette, literary/modern/typeset typography, a contour/grid/arch/quiet motif, and your own cover/ink colors. Replacing or removing a current cover keeps older covers referenced by saved history.

## Full detail history and recoverable Trash

Every saved detail edit retains the previous complete record, including authors, ratings, notes, collection membership, custom fields, and its original cover reference. **History** shows these versions and lets you keep named milestones. Restoring an earlier version retains the current version first. It changes the editable details while preserving entry identity and the current Trash state.

**Move to Trash** is recoverable; it does not purge a book, its revisions, or its originals. Open **More → Trash**, choose the title, then **Restore to bookshelf**. There is no permanent deletion control in this workflow.

History is not silently pruned. The portable ledger supports up to 10,000 entries, 5,000 collections, 30,000 full revisions, and 64 MiB of metadata. A limit error preserves the authority and leaves your current edited form available for recovery; it does not claim that exporting frees the limit.

## Import and export

**More → Import CSV / JSON** accepts a CSV with a `Title` column, or a Worldview bookshelf JSON export. Suggested CSV columns:

```csv
Title,Author,Kind,Format,Status,Rating,Recommended by,Notes,URL,ISBN,Year,Pages,Started,Finished,Collections
```

Quoted cells support commas, newlines, and doubled quotes. Semicolons separate multiple authors and collection names. Common Goodreads headings—including `Exclusive Shelf`, `My Rating`, `My Review`, and `Date Read`—are recognized. Valid rows are added, invalid rows receive explicit row receipts, and existing titles with the same authors are skipped rather than overwriting personal edits. CSV imports are limited to 16 MiB and 10,000 rows.

**Export bookshelf** creates a self-contained JSON document containing books, articles, collections, complete detail history, and verified original cover bytes. Imports merge without replacing current books; matching identities or title/author pairs remain untouched. Exported cover data is bounded to 64 MiB and the whole artifact to 128 MiB.

Raw CSV/JSON import files are privately retained as `bookshelf-file-<SHA256>` originals and included in full world backups. The standalone bookshelf JSON omits raw import receipts/files to avoid recursively embedding old JSON exports inside future exports. It retains the actual catalog, full detail history, and cover originals. Use the existing verified world backup flow to recover the complete workspace and import receipts together.

## Implementation and verification

`bookshelves.v1` is a versioned compare-and-swap ledger bound to the active store, account lifecycle, and world generation. Existing originals are preserved on failed writes. Cover/reference collection includes archived titles, historical revisions, and raw import receipts. Nothing in this module enables a cloud provider, syncs a third-party account, or changes spatial rendering.

Entry points: [view](../src/bookshelf/Bookshelf.tsx), [model](../src/bookshelf/model.ts), [commands/history](../src/bookshelf/store.ts), [originals](../src/bookshelf/media.ts), [portability](../src/bookshelf/portability.ts). Focused tests cover [storage/history/covers](../tests/bookshelf/store.test.ts), [CSV parsing](../tests/bookshelf/portability.test.ts), and [actual editing flow](../tests/bookshelf/ui.test.tsx).
