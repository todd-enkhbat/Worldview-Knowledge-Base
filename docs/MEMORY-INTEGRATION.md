# Shared memory in Worldview

Open **Sources & activity → Agent access**, choose the sources that an agent needs, and create a named token. Copy it while displayed. Tokens expire after 30 days; revoke one in the same panel. Only its hash is retained. Tokens are service credentials and do not travel in portable backups. Restoring a workspace replaces the credential registry, invalidating previous access.

The running app exposes a stateless MCP endpoint at `http://localhost:5173/api/mcp`. Configure an MCP client with that URL and the header `Authorization: Bearer YOUR_TOKEN`. For a remote deployment use HTTPS and its own URL. The app must be running. Clients share the current source/version ledger; there is no separate agent database.

For clients supporting only stdio, run Node 26 with the repository's bridge:

```json
{
  "mcpServers": {
    "worldview": {
      "command": "node",
      "args": ["/absolute/path/to/Worldview-Knowledge-Base/scripts/memory-mcp-bridge.ts"],
      "env": {
        "WORLDVIEW_MCP_URL": "http://localhost:5173/api/mcp",
        "WORLDVIEW_MEMORY_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

Default read-only tools are `search`, `read_passage`, `read_record`, `get_project_context`, `get_memory_context`, and `status`. They are read-only. Source consent, deletion, current version, client scope, and requested authorship/date filters are checked on every request. Revocation takes effect on the next request. A project with inaccessible dependencies is withheld as a whole. Accepted pages with stale or inaccessible evidence cannot enter model context. Evidence packets budget the final UTF-8 rendering and report omissions; byte counts are not token counts. Retrieved material remains untrusted reference text.

The equivalent HTTP interface uses `POST /api/memory/search`, `/read_passage`, `/read_record`, `/get_project_context`, `/context`, and `/status`, with the same Bearer header and a JSON body. Search accepts `query`, `limit`, and `filters` (`sourceIds`, `role`, `kinds`, `authoredAfter`, `authoredBefore`). A requested source list can only narrow the client's authorization. The HTTP memory interface remains read-only. Optional MCP editing capabilities require explicit scopes and retain proposals for approval in the app; see [personal workspace connections](PERSONAL-WORKSPACE.md). Automatic tool-observation capture remains disabled.

Voice transcription and semantic search run only after an explicit action. The local follow-up installs QMD and pinned Whisper assets, with Sources controls for indexing and capture. Telegram intake is implemented and remains inactive until a bot and sender/chat allowlists are configured; hosted Supermemory remains optional and unconfigured. QMD mirrors are disposable projections of selected AI-permitted sources; reimporting a QMD snippet cannot change authoritative evidence. Search & ask can select native QMD for the companion; the external read-only MCP service retains its independent lexical search over the same source authority.

Physical migration and pre-integration backups retain earlier data for recovery. A permanent source purge affects the active workspace; remove older backup copies separately when you intend to remove their retained history.


## Reviewed local assistant editing

The agent connection panel now lets you choose permitted writing drafts and source evidence, allow creation of new drafts, and optionally expose folder/topic metadata for organizing selected sources. These are independent permissions. Source AI policy, deletion, scope, token expiry, and revocation are rechecked; a client does not acquire access to every draft by receiving permission to create a new one. Existing read tokens do not gain editing privileges.

For an editing token, the initial tool set adds `list_writing`, `read_writing`, `list_topics`, `propose_create_writing`, `propose_update_writing`, `propose_filing`, and `get_edit_status`. The client reads current revision/timestamp values, supplies a unique request ID and exact expected head, and proposes a validated change. A same-ID/same-payload retry returns the prior receipt; a different payload cannot reuse that request ID. Large draft reads disclose when rich content was omitted; `appendText` can extend an existing draft without replacing an incomplete body.

Proposals appear in the app's **Changes to review** interface. Expand the comparison before **Approve change** becomes available, or choose **Reject**. Approval rechecks the client's current authorization and target baseline, saves the prior writing in recovery History, and commits the rich draft, history, and audit through one revision-checked SQLite transaction. Unrelated newer records remain intact. A conflict preserves both the current draft and the pending proposal. Approval does not automatically publish a new Library source or alter 3D records.

New citation nodes must refer to permitted retained evidence; PDF citations must match an existing version/page quotation. Media references are limited to retained originals already present in permitted writing. There is no arbitrary path/file operation, remote shell, automatic cloud write, or provider API key attached to the MCP token. `assistantEdits.v1` records the proposed/apply/reject trail without bearer tokens; portable backups retain its referenced originals. Restored pending requests cannot be approved under a missing/revoked old client authorization.

The panel provides a one-time private STDIO or Streamable HTTP configuration. Creating a token does not automatically install or connect a different app. Add it to a supported desktop client's MCP settings, using the current local address and the supplied bridge command; restart that client if needed. A client can generate/edit with its own authorized assistant session while Worldview's cloud AI stays off. Worldview does not reuse Codex/ChatGPT/Drive account credentials as application API credentials.

See [the Mac desktop guide](DESKTOP.md) for the standalone local app and its selected SQLite folder. ChatGPT's local MCP setup is documented in the official [desktop MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=app). This implementation does not expose a private corpus through a public tunnel.

Bookshelf scopes add `list_books`, `read_book`, `propose_create_book`, and `propose_update_book`. Select existing records explicitly; creation permission grants collection names and approved new entries, without granting unrelated book details or linked source originals. Book updates retain the complete previous details in History. Full structured review and JSON download include all rich-document formatting, hyperlinks, media, appearance, topics, and book fields beyond the bounded text preview. See [Scoped assistant editing](ASSISTANT-EDITING.md) for the complete capability and recovery contract.
