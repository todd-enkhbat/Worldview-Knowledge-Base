# Topics and local retrieval

The Topics workspace gives an idea one home across retained sources, margin notes, writing drafts, knowledge pages, and saved investigations. It runs locally with cloud AI off and does not change the 3D graph or coordinates.

## One topic home

Open **Topics**, choose a topic, or create one. Source tags and assigned topics with the same normalized name share one view. Name matching uses Unicode normalization, case folding, and equivalent spaces/hyphens/underscores. Retained tag spelling, topic IDs, annotations, and source originals are not rewritten. If older data contains duplicate named topics, their identities remain aliases of the oldest topic for browsing.

A topic home shows:

- Sources with a matching retained tag or an explicit topic assignment.
- Exact-version highlights, page-bound PDF highlights, and your own source notes.
- Writing drafts assigned to the topic, drafts filed through Library, and writing already published to a related source.
- Knowledge pages and saved investigations sharing explicitly scoped sources or the exact topic name. Each result explains that relationship. The page's evidence, authorship, and review decisions remain independent.

The **Sources** tab lets you assign or remove membership. A retained source tag is displayed as original metadata and cannot be erased by unchecking an assignment. **Explore connections** opens the selected topic's graph. **Saved investigations** still provides the existing project-management view.

Topic identity is resolved by [topics.ts](../src/reading/topics.ts), and the unified view is [TopicHome.tsx](../src/reading/TopicHome.tsx). Writing assignments use the document's topic IDs; Library filing metadata for an unpublished draft uses a `writing:<document-id>` reading item. These are portable metadata, not new spatial records.

## Search and saved Library views

Library searches titles, retained source text, draft bodies, source tags, topic names, highlight quotations, highlight remarks, and source notes. A disposable local trigram index narrows queries before verifying complete terms; it is rebuilt from the authority and reuses unchanged records. No search text or evidence is sent to a provider. One- and two-character queries use a local scan rather than claiming an indexed posting that does not exist.

**Save this view** retains the current query, file filter, folder, topic, grid/list layout, and sort. Saved views live in the portable `reading.v1` snapshot. Library's URL reflects these filters for a cold reopen. Searches inside a reader remain scoped to their explicit source route.

Use the file checkboxes or **Select visible files** to select up to 500 available files, then move them to a folder, add a topic, favorite them, or mark them finished. A batch commits one checked reading revision; if any selected item is unavailable, the whole filing operation fails. It does not partially move the remaining files or rewrite their originals.

The archive continues to incrementally reveal document cards, with browser content visibility for offscreen cards. The search index improves query work; the corpus snapshot and index are still held in memory. This is not a claim of unbounded corpus size or server-side query pagination.

## Follow graph connections across the canvas boundary

The global graph displays bounded pages of 80 nodes and reports the count of connections that continue outside the current canvas. Select a node and use **Show selected neighborhood** to bring its neighbors together. In a larger neighborhood, **Expand neighborhood** adds 80 nodes at a time, up to the explicit 320-node canvas budget. Beyond that budget, select another neighbor or narrow the filters to continue. The inspector retains paginated connection lists even when an endpoint is not drawn.

Source tags and assigned topics use the same canonical identities as topic homes. Manual semantic edges remain exactly the user's saved relationships. A line from a source tag or explicit assignment is labeled as membership; proximity never creates a supports/contradicts claim. The selected node, query, local mode, and depth are reflected in the graph URL. These are 2D reading controls and do not alter the existing 3D world.

## Validation

Focused regression coverage exercises Unicode/body/annotation retrieval, stale index removal, canonical identity without original mutation, one-revision bulk filing and rollback, saved-view reload, version-bound PDF page coordinates, unified topic content, and off-page graph expansion. See [search/topics](../tests/reading/searchTopics.test.ts), [topic home](../tests/reading/topicHome.test.tsx), [archive](../tests/reading/archive.test.tsx), [graph](../tests/reading/graph.test.tsx), and [reading storage](../tests/reading/storage.test.ts).
