# Substack in Writing Studio

Writing Studio reads the public profile at https://substack.com/@thetallerpoppy and the most recent 20 posts from https://thetallerpoppy.substack.com. The author photo opens the public profile. The published-writing section supports search and an in-app text reader; each post also links to its original. The same profile menu is available in the document toolbar.

This is a public reader connection. It does not authenticate a Substack account, read private drafts or subscribers, or publish anything. Substack's public response formats are not a versioned integration contract; errors retain the last saved profile/list and link to the original publication. Full post bodies require a connection and are displayed as text, without executing remote HTML. Refresh rechecks the service; upstream results are cached for up to five minutes.

The latest successful profile and post list are saved as `writing.substack.v1` in the active Worldview store and included in portable exports. Full post bodies are cached briefly in service memory, not retained in world backups. This panel sends requests only for public profile/posts; it does not send Worldview drafts to Substack. The profile photo loads from Substack's public image host.

In the installed local desktop workspace used when this feature was added, records and writing drafts live in `data/world.sqlite`, and retained uploaded originals live in `data/blobs/` within this repository. The desktop app can choose other workspace folders. Its Sources → Desktop workspace → Show folder in Finder action reveals the active folder. Browser-only worlds may use IndexedDB/OPFS for the same origin; hosted account worlds instead live on their configured Worldview server.

Autosaving updates the working copy. Save to Library creates a Worldview revision. Export now downloads a separate portable archive; a local working copy alone does not protect against losing the computer. Do not copy only `world.sqlite` while the service is running: SQLite may have pending data in its WAL. Use the app's export or a consistent SQLite backup together with retained originals.

Verification: profile/archive parsing, URL restrictions, and portable-key inclusion have focused tests in `tests/connections/substack.test.ts`.
