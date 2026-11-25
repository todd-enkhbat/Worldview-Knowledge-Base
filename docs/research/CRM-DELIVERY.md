# Worldview People delivery audit

Audited 23 November 2026 against the current code, migration receipts and isolated
integration tests. This is a substantial local CRM replacement, with explicit
limits below. It does not claim full Folk feature parity.

The primary-source research and complete product requirements are in
[FOLK-CAPABILITIES.md](FOLK-CAPABILITIES.md). The storage, API and review contracts are
in [CRM-ARCHITECTURE.md](CRM-ARCHITECTURE.md). Connection configuration and provider
boundaries are in [CRM-CONNECTIONS.md](CRM-CONNECTIONS.md).

## Migrated and verified

The authorized migration copied every accessible contact, company, group, note and
task exposed by the connected Folk tools. It did not edit or delete anything in
Folk. The applied migration contains:

| Collection | Migrated records |
| --- | ---: |
| People | 1,389 |
| Companies | 799 |
| Groups | 21 |
| Notes and replies | 290 |
| Tasks | 23 |
| Group memberships, people and companies | 1,911 |
| Group-scoped field definitions | 22 |
| Custom field values | 1,000 |
| Pipeline/saved views reconstructed from available metadata | 19 |
| Explicit relationships derived from source contact-reference fields | 1,476 |

Some source groups declare only people while their retained memberships also contain companies. Worldview exposes both record types from the actual memberships and preserves the original group declaration; it does not silently discard company memberships or rewrite source metadata.

Blank names remain blank and use an email/phone display fallback. Distinct source
IDs were preserved even when two records share an email address. Source payloads,
unknown fields, option order, authors, visibility, task assignments, dates and
reference values remain available in the local archive. Known select values use
stable option identities; unknown original values remain retained and visible.

The initial import and identical reimport passed the 27 checks recorded privately
under `data/crm-migration/folk-2026-11-23/applied-1795487735931`. The migration added
one original Folk export ZIP to the pre-existing assets. The original 15 3D nodes,
94 spatial interaction events and 71 knowledge sources were preserved.

A separate consistent SQLite clone of the actual migrated app was exported and
parsed through both ZIP and directory backups. Both reproduced the exact canonical
CRM snapshot, 3D nodes, events and all 75 asset metadata records. CRM originals were
SHA-256 checked; portable state contained no connection/client credentials. The
private proof is in
`data/crm-migration/folk-2026-11-23/roundtrip-31a70dd5-bf49-4be6-80be-b88e6db1b7bd/proof.json`.
Private exports, backup databases and source originals are excluded from Git.

### The unavailable source history

**Zero source interaction events were migrated.** The connected Folk tools
advertised interaction-list capabilities but returned tool-not-found errors. The
approximate interaction counts/dates on contacts were retained as metadata; these
are not event history and do not prove attendance. Import receipts correctly state
that source history and unavailable table layouts are incomplete.

The user declined retrieving old Folk interactions through an additional Folk REST
API key. That optional code path remains inactive. No Folk REST history request
was made, and no blank timeline is described as a complete history.

Original note markup and any source attachment metadata were retained. The source
connector did not provide downloadable attachment binaries. Such remote originals
were not silently claimed to have been downloaded. New local comment attachments
are stored and backed up as actual bytes.

## Capability matrix

“Built” means working local code with persistence, not merely a schema or button.
“Connection required” means the adapter exists but needs that provider's explicit
app-owned authorization. Provider-fixture tests are distinguished from live
account acceptance. The observed live account acceptance is recorded below and in
[CRM-CONNECTIONS.md](CRM-CONNECTIONS.md); further accounts still need their own grants.

| Folk capability / user need | Delivered behavior | Boundary or remaining gap |
| --- | --- | --- |
| Global people records | Built: create, search, select, inspect, edit, archive and restore; multiple channels, role, location, labels and context | Less-common imported native fields remain preserved in raw data rather than all having dedicated controls |
| Company records | Built: company list, creation, notes and durable edits; associations retained on people | Company inspector is smaller than the person inspector; no company dedupe/merge workflow |
| Custom objects and deals | Built: typed custom records, group membership, custom fields and notes | No specialized sales forecasting, opportunity revenue dashboard or deal automation |
| Groups and taxonomy | Built: original groups, independent memberships, parent hierarchy, bulk membership and organization controls | Source group sharing/ACL settings are preserved metadata, not a new team authorization system |
| Custom fields | Built: group-scoped definitions, typed values and editors; select options, numbers, dates, booleans, contact/member references and raw unknown types | Unsupported source types remain explicit original data; no paid field-generation engine |
| Select option identity | Built: writes normalize a known label to its option ID; filters accept IDs/labels; old unknown values survive | Ambiguous labels require choosing an ID; removing a used known option is rejected |
| Tables | Built: virtual rows, pagination, search, bulk selection, column selection, sorting and visible filter controls | No full spreadsheet formula language or all Folk keyboard shortcuts |
| Saved views | Built: named layout, filters, sort, columns and group scope | Unavailable source saved layouts were not recovered or invented as faithful originals |
| Pipelines | Built: group-specific select lanes, drag or accessible select movement, saved views and original-value lane | Lane totals cover the loaded page; no full-group numeric aggregation or arbitrary card-field designer |
| Contact comments | Built: immediate composer, save/retry states, editing, replies, pinning, Markdown formatting and local privacy flags | Source HTML is displayed safely; this is not a full shared rich-text collaboration editor |
| Mentions | Built: explicit local people or workspace-member mentions | Mentions create local context only; they send no notification |
| Attachments | Built: local original upload/download, SHA-256 identity, durable references, archived/history retention and backups | Old remote Folk attachment binaries were unavailable; no claim of recovered binaries |
| Tasks and follow-ups | Built: global/contact tasks, dates, assignments, complete/reopen, overdue visibility | No background notification delivery or push reminder service |
| Recurring tasks | Built: weekday, weekly, biweekly, monthly, quarterly, yearly and daily schedules; one next occurrence per completion; month-end clamping | Calendar arithmetic is UTC-based; there is no full per-source timezone/DST recurrence engine or reminder worker |
| Interaction timeline | Built: explicit sourced event records, status, context and attendance labels | Old Folk events remain unavailable; approximate source counts are not fabricated into events |
| Calendar event picker | Built and live-tested: app-owned read-only grant returned seven calendars and a bounded 100-event page with continuation | Additional accounts require authorization; an invitation stays scheduled/unconfirmed until explicitly confirmed attended; no complete-history claim |
| Event dedupe and changes | Built: stable provider/account/event identity, candidate versions and revision-checked updates | No unattended background calendar sync scheduler |
| Contacts and multiple Google accounts | Built: separate accounts, explicit readonly Contacts capability and review staging; live saved-Contacts request returned HTTP 200 with zero records | Additional accounts require their own grants; Other contacts and directory access remain off; no direct Microsoft/Outlook account adapter |
| Gmail contact discovery | Built and live-tested: 50 message headers returned HTTP 200 and staged 54 review candidates; paging/checkpoints, incremental history and quota-safe explicit resume | Overall inbox scan remains incomplete; no bodies, attachments, automatic person edits, inbox mutation or inferred personal familiarity |
| Google Drive | Existing selected-file Drive connection retained; built extraction from an explicitly selected retained Drive import | Does not scan all Drive files or treat Drive file access as Contacts/Calendar authorization |
| Website and LinkedIn capture | Built: reuse explicitly captured Reader sources, editable profile candidate and source evidence | No covert browsing, automated LinkedIn connection scraping or bypass of site access controls |
| Luma and Partiful | Built: original-backed CSV/ICS/EML import, mapping/preview and candidate review | No live authenticated Luma/Partiful integration or automatic event-account monitoring |
| Happenstance | Built: optional private key configuration and explicit provider request/research controls | API key/service credits required; no paid request was made during implementation; no recreated proprietary global network |
| Search | Built: CRM field/context search and nested AND/OR filters; selected-contact lookup from other views | CRM search is separate from knowledge evidence retrieval; no full universal semantic contact index |
| Duplicate comparison | Built: exact email/profile overlap reasons; names alone never merge | Similar-name or company-name probabilistic dedupe is not implemented |
| Person merge and undo | Built: reviewed survivor, unioned channels, source aliases, redirected references, audit and guarded undo | Conflicting field values are retained; resolving every value conflict is a manual review task |
| Relationship map | Built: animated local people graph, group filtering, search and explicit typed/evidenced edges | Not a proof of friendship, contact consent or complete event history; no proprietary relationship-strength model |
| Local assistant enrichment | Built: downloadable brief, reviewed JSON proposals and scoped MCP tools | An external assistant researches; Worldview cloud AI stays off and does not enrich automatically |
| MCP permissions | Built: explicit people/groups/new-person grants; readonly lists and reviewed changes; expiry/revocation/stale revision checks | Existing knowledge allSources grants never include CRM; group grants intentionally include future group members |
| Email templates and personalization | Built: editable local templates/campaign drafts, allowlisted variables, recipient selection and personalized preview | Rendering a preview is not email delivery |
| Manual email sending | Built: optional separate Gmail send capability, exact message confirmation, expiry, durable attempt receipt and ambiguous-delivery protection | Requires explicit provider grant and user confirmation for each message; no real message was sent during implementation |
| Sequences | Built: editable local multistep sequence drafts and delays | No execution scheduler, stop-on-reply engine, automatic follow-up sending or unsubscribe/bounce lifecycle |
| Email scheduling | Not included | Saved dates/delays are not a delivery scheduler |
| Engagement analytics | Not included beyond actual local counts and draft metadata | No opens, clicks, delivered-rate reporting or invented campaign metrics |
| Dashboards | Local record counts, pipeline lanes and follow-up lists | No complete Folk chart/dashboard builder or full-group revenue analytics |
| Cloud AI automation | Deliberately off; manual review and local data tools work without it | No automatic recap, autonomous research, field generation or workflow-assistant parity |
| History, trash and recovery | Built: per-record revisions, audit before/after images, archive/restore, guarded merge undo and history restoration | No automatic permanent CRM deletion policy; newer edits are never silently overwritten |
| Exports and backups | Built: full CRM JSON, selected/view table CSV and full-app ZIP/directory backups including originals and history | No public share-link service; full originals belong in the complete app backup |
| Full-data import | Built: original-backed Folk migration and mapped CSV/vCard/ICS/EML ingestion | Missing third-party permissions/data remain explicitly incomplete |
| Collaboration and roles | Existing local writer lock and hosted account isolation retained; imported privacy preserved | No production multi-user Folk role/ACL/integration-sharing parity |
| Public view sharing | Not included | Private raw source payloads are not published as share links |
| Mobile experience | Responsive web layout inside the existing app | No new native mobile app, business-card OCR, telephony integration or mobile call recording |
| WhatsApp and Microsoft mail | Not included as live connectors | Export/import paths can retain available external data; a URL is not a live integration |
| Webhooks and automations | Not included | Manual sync and import do not imply a deployed durable webhook/scheduler service |
| Existing 3D world and notes | Preserved; People uses the existing shell and separate records | CRM does not rewrite spatial nodes, anchors, physics, original knowledge sources or cloud AI settings |

## Verification and final audit fixes

Focused tests cover paginated records, safe literal search, custom fields, nested
filters, comments/retries, stale edits, initial/repeat/newer imports, source aliases
after merge, merge undo conflicts, calendar invitation semantics, connector review
versions, task recurrence and local campaign rendering. Portable tests include
archived originals, corrupted bytes, credential exclusion and original retention.

A real MCP SDK client negotiated the new tools against a disposable app host, read
only its selected person, proposed enrichment and observed the result after local
HTTP approval. Unrelated people, mixed-scope records, old allSources grants,
revoked grants, removed group memberships and stale target revisions were denied.
The same permission tests retain the existing writing/books/evidence behavior.

Independent review fixed durability/privacy issues before delivery:

1. Explicitly merged source IDs now resolve to the canonical survivor during
   reimport; source-version continuity prevents duplicate or ambiguous matches.
2. Hash-invalid CRM uploads cannot replace retained bytes, and uploads arriving
   after workspace replacement cannot repopulate the new asset index.
3. OAuth JSON/credential persistence and captured-source staging recheck workspace
   generation/connection state; deleted or unavailable source originals are not
   offered for new extraction.
4. Lost/uncertain command responses keep their request identity for a safe retry;
   duplicate flights coalesce. Multi-step contact creation retains its created ID,
   and stale record data/forms do not survive query or workspace replacement.
5. Accepted service CRM edits trigger the existing debounced auto-backup in the
   writer window, including edits accepted through MCP.
6. A live oversized Gmail discovery reached the current provider quota. Discovery
   now reads one 50-ID page by default, paces reads by at least 250 ms, checkpoints
   pending IDs and retains successful metadata before reporting a quota pause.
   HTTP 403 quota errors and 429 honor `Retry-After`; explicit resume reads only
   the saved unread IDs. The subsequent live 50-header pass succeeded.

### Live Google acceptance

The user approved the Google API terms and an app-owned read-only Calendar,
saved Contacts and Gmail metadata grant for the Columbia account. Calendar list
returned seven calendars (HTTP 200); a selected bounded event window returned a
100-event page with a next-page token (HTTP 200). Saved Contacts returned zero
records (HTTP 200). Gmail returned 50 headers and staged 54 review candidates
(HTTP 200), with the page fully read and the overall scan awaiting continuation.
The candidates remain unaccepted; no person record was automatically edited.

Other contacts and Gmail sending remain ungranted. The separate existing Drive
grant was not broadened. No message body, attachment, invitation or outbound email
was part of this acceptance. Old Folk history remains unavailable because the
user declined the optional REST history retrieval.

Google's May 2026 quota model allows 6,000 units per minute per user/project for
new projects; a metadata message read costs 20 units. The previous 1,000-message
pass is no longer used. Cooldown times and saved progress are visible in the UI;
there is no automatic retry loop. [Official Gmail quota table](https://developers.google.com/workspace/gmail/api/reference/quota).

The final release passed TypeScript, ESLint, the production build and the full
bounded test run: 227 test files passed, two skipped; 1,477 tests passed, four
skipped. The live Google reads above are distinguished from mocked provider
regressions and the separate portable data proof.
No implementation step sent email, purchased credits, ran paid Happenstance
research or changed a remote Folk record.

## Final UI and release verification

The real Calendar picker was checked against the authorized Columbia account with 100 selectable events and seven calendars. Badge dates and timestamps use the same event/calendar timezone; all-day source dates remain unchanged. No test event was logged onto a real contact. Comment/profile save and reload were verified with synthetic contacts in an isolated local workspace. A final preservation check confirmed that all imported Folk records, existing knowledge/writing, the 15 spatial nodes, 94 spatial events and pre-existing original bytes remained unchanged after live discovery. Cloud AI and Gmail sending remain off.

The Apple silicon desktop archive was rebuilt from the final source. Package
verification matched all 797 source/build files, found no private data paths or
configured credentials, and verified executable modes, the bundled Node runtime
and the ad-hoc signature. The archive is not notarized. Its receipt is
[desktop-app-acceptance-2026-11-23.json](../evaluations/desktop-app-acceptance-2026-11-23.json).
The Mac locked before a final native-window check, so browser acceptance and
package verification do not claim native-window acceptance. The implementation
and release artifacts have not been committed or pushed as part of this delivery.

The subsequent profile/visual update adds saved portraits, social profiles, a Gallery
view, customizable group pictures/covers and scoped presentation restoration. Its
latest live counts, Dia/Reader acceptance and release checks are recorded in
[CRM-PROFILE-MEDIA.md](CRM-PROFILE-MEDIA.md).
