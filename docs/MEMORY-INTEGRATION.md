# Shared memory in Worldview

Open **Sources & activity → Shared agent memory**, choose the sources that an agent needs, and create a named token. Copy it while displayed. Tokens expire after 30 days; revoke one in the same panel. Only its hash is retained. Tokens are service credentials and do not travel in portable backups. Restoring a workspace replaces the credential registry, invalidating previous access.

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

Available tools are `search`, `read_passage`, `read_record`, `get_project_context`, `get_memory_context`, and `status`. They are read-only. Source consent, deletion, current version, client scope, and requested authorship/date filters are checked on every request. Revocation takes effect on the next request. A project with inaccessible dependencies is withheld as a whole. Accepted pages with stale or inaccessible evidence cannot enter model context. Evidence packets budget the final UTF-8 rendering and report omissions; byte counts are not token counts. Retrieved material remains untrusted reference text.

The equivalent HTTP interface uses `POST /api/memory/search`, `/read_passage`, `/read_record`, `/get_project_context`, `/context`, and `/status`, with the same Bearer header and a JSON body. Search accepts `query`, `limit`, and `filters` (`sourceIds`, `role`, `kinds`, `authoredAfter`, `authoredBefore`). A requested source list can only narrow the client's authorization. No external writer or automatic tool-observation capture is enabled.

Voice transcription and semantic search run only after an explicit action. The local follow-up installs QMD and pinned Whisper assets, with Sources controls for indexing and capture. Telegram intake is implemented and remains inactive until a bot and sender/chat allowlists are configured; hosted Supermemory remains optional and unconfigured. QMD mirrors are disposable projections of selected AI-permitted sources; reimporting a QMD snippet cannot change authoritative evidence. Search & ask can select native QMD for the companion; the external read-only MCP service retains its independent lexical search over the same source authority.

Physical migration and pre-integration backups retain earlier data for recovery. A permanent source purge affects the active workspace; remove older backup copies separately when you intend to remove their retained history.
