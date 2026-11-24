# Scoped assistant editing

Open **Sources & activity → Agent access** (`#/sources?connection=memory`) in the local SQLite workspace. Select sources, writing drafts, or bookshelf records, and grant creation or organization only when needed. A connection receives a revocable, 30-day token. The configuration is shown once; its private download contains that token. Worldview does not enable a cloud model or require a cloud AI key to serve these tools.

Existing read-only connections retain the six memory tools documented in [Memory integration](MEMORY-INTEGRATION.md). An explicitly scoped editing connection also receives the tools below. Authorization is checked for each request, again after its body arrives, and again when a proposal is approved.

| Tool | Access and result |
| --- | --- |
| `list_writing`, `read_writing` | Selected active drafts and drafts this connection previously created through approval. Published writing also respects its current source consent. |
| `list_topics` | Topic assignments on permitted drafts; granting organization also permits folder and topic names. |
| `propose_create_writing` | Requires **Propose new writing** and the current `writingRevision`. Accepts plain text or validated rich content, appearance, and topic assignments. |
| `propose_update_writing` | Requires a permitted draft, current revision and `expectedUpdatedAt`. `appendText` preserves existing rich content when the full draft exceeds the reading budget. |
| `propose_filing` | Requires **Propose organization**, a selected permitted source, and the current `readingRevision`. Supports topic, folder, reading status, and favorite changes; optional `newTopic` or `newFolder` creates local taxonomy. |
| `list_books`, `read_book` | Selected active book/article details and entries previously created by this connection through approval. A linked source ID does not grant its original text. |
| `propose_create_book` | Requires **Propose books & articles** and the current `bookshelfRevision`. Collection names are available with this permission. |
| `propose_update_book` | Requires a selected record, current revision, and `expectedUpdatedAt`. Metadata changes preserve other fields; `appendNotes` preserves existing notes. |
| `get_edit_status` | Returns the status and result of one proposal made by this connection. |

Every proposal needs a unique `requestId`. Retrying identical input returns the existing result; reusing the ID for different input fails. Proposal creation writes only to `assistantEdits.v1`. It does not edit the source, draft, bookshelf, or 3D world.

## Review before application

Pending changes appear under **Changes to review**. Open **Review changes** before approving. The compact text and book previews are limited to 20,000 characters. **Full validated proposal · all details** displays the complete current and proposed records, including formatting, colors, citations, topic assignments, collections, and original references. **Download complete proposal** saves the same complete JSON without truncation.

Approval checks the connection's current permissions and the target's baseline. A newer human edit, changed organization, revoked token, unavailable source, or mismatched restored record identity blocks approval. Applying a change commits its review receipt and affected ledger atomically. Previous writing and complete book details, including cover references, remain in their respective histories. Rejection leaves current work unchanged.

New quotations must match a retained source version or an existing page-bound PDF highlight. Their attribution and optional URL must match retained provenance. New topic links must use existing permitted topic identities. Assistants may reference only retained media/covers already available in their permitted records; the tools do not upload files or fetch remote media.

## Local boundaries and recovery

The management and approval endpoints require the local app's same-origin/loopback access checks. This is a local trust boundary, not proof that a separate human is operating the computer. A bearer token grants only the chosen tool scopes; it does not grant management or approval access. Keep the configuration private and revoke unused connections.

Portable backups retain proposals, decisions, and their referenced originals. Client credentials stay outside portable backups. Restoring pending proposals never applies them automatically: approval still requires a currently authorized connection and a matching target. Historical and pending book proposals reference covers through `entries[].book.coverAssetId`; backup collection preserves those originals alongside writing media.

The active assistant ledger supports at most 100 pending proposals, 10,000 total entries, and 16 MiB of serialized review history. Export a verified backup when a storage boundary is reached. Large draft/book reads return `complete: false` with a bounded excerpt; preserve omitted data by using append operations or narrow metadata patches.
