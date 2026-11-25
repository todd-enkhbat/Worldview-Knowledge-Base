# Worldview People storage and integration contract

People is part of the existing app and database. It does not create knowledge nodes or
change spatial anchors, physics, the 3D scene, or cloud AI preferences.

## Authoritative data

`WorldDb.crm` is one `SqliteCrmStore` on the existing SQLite connection. Collections
are individual JSON records in `crm_rows`; identities, revisions, archive state,
group/entity scope, search text and source identities have indexed columns/tables.
A global revision is an invalidation signal, while writes compare each affected
record's revision. Comments do not rewrite all contacts.

Collections cover people, companies, custom objects, hierarchical groups,
memberships, group-scoped field definitions/options/values, notes/replies/mentions,
interactions, tasks, saved views, explicit relationships, discovery candidates,
enrichment proposals, import receipts, audit history, local members, campaign drafts,
templates and sequence drafts. Custom/unknown source metadata remains in `raw` and
extension fields. Same-named fields in separate groups keep distinct IDs.

People retain source IDs through import and merge redirects. Blank names remain
blank; the UI display fallback is email, then phone. Normalization does not infer
country codes or treat Gmail aliases as identical. Matching emails/profile URLs
produce comparison candidates, never automatic merges.

## Browser API

All routes use the host's existing account authentication plus same-origin and
`x-wv-client` checks. Connector routes precede generic CRM routes.

- `GET /api/crm/status`: revision, per-collection active/total counts, pending review
  counts, due task count, workspace fingerprint; cloud enrichment and sending false.
- `GET /api/crm/collections`: collection names and maximum page size (500).
- `GET /api/crm/<collection>`: `{revision,collection,rows,total,nextOffset}`.
  Query accepts `q`, `groupId`, `entityId`, `entityType`, `status`, `archived`,
  `offset`, `limit`, JSON `filter` and JSON `sort`. Lists omit top-level raw/extra.
- `GET /api/crm/<collection>/<id>`: record, typed `related` collections,
  `relatedPagination` completeness indicators, and person canonical redirect ID.
  Related records are bounded to 200; list routes page the remaining records.
- `GET /api/crm/duplicates`: exact identity overlap candidates with reasons.
- `GET /api/crm/snapshot`: explicit JSON export of all portable CRM records.
- `POST /api/crm/command`: JSON command with a unique `requestId`.

Filters are bounded AND/OR trees. A custom field is addressed as `field:<fieldId>`.
There is no executable filter language. Built-in sorts and custom fields use the
same saved-view contract. The server paginates before returning normal list reads.

Commands include create, update, archive/restore, comment, task completion,
membership, custom-field/pipeline changes, calendar selection, candidate/proposal
review, batch import, merge, undo merge, history restoration and campaign preview.
Updates require `expectedRecordRevision`. Existing candidates additionally require
`expectedTargetRevision`. A request receipt replays retries and rejects reusing a
request ID for different input. Every command is one SQLite transaction.

## Provenance and review

Source identity is `(provider, accountId, externalId)` with optional version,
observation time, original asset, and source URL. Initial imports are incremental
and additive. Identical source versions are unchanged; changed upstream records
become pending updates instead of replacing local edits. Imports do not delete
records missing from a later batch.

Candidate acceptance unions contact arrays and fills empty fields. Nonempty
conflicting values require an explicit reviewed patch. Source version changes
remain reviewable after earlier versions were accepted or dismissed. Imported
revision/identity/archive metadata cannot overwrite local identity controls.

An invitation remains scheduled and attendance-unconfirmed, including invitations
in the past. Logging attendance is explicit, optimistic, and requires a past,
uncancelled event. Future events remain scheduled. Coattendance and communication
frequency are signals; neither creates a confirmed person-to-person relationship.
Folk's workspace-user strongest-connection metadata is preserved as source data.

Enrichment proposals store evidence, proposed changes, originating client, and the
target revision. Review rechecks the originating assistant's current grant. Stale,
revoked or expired proposals cannot apply. App cloud AI stays off. Campaign and
sequence content is editable local draft data. A separate, optional Gmail connector
can send an individually confirmed message; no automatic sequence worker exists.

Merges preserve losers as archived redirects and rewrite explicit local references.
Audit records retain before/after images. Undo compares every affected revision and
refuses to overwrite subsequent edits. Conflicting group field values survive for
manual review rather than being silently discarded.

## Portability, recovery, credentials and retention

`crm.v1` is an allowlisted portable materialization, not a browser-authored giant
state blob. World snapshots read it in the same SQLite transaction as nodes and
other state. Restore hooks share the enclosing transaction. Reset/wipe clears CRM
rows, provenance indexes, receipts and head alongside the existing world. A private
workspace instance fingerprint changes on replacement to isolate browser drafts.
Async request/capture work checks the replacement generation before committing.

Portable backups include CRM source originals, portraits, attachments, archived
records and audit versions. Archive and directory formats verify content hashes and
refuse missing originals. Node trash cleanup preserves bytes still referenced by
CRM; direct asset metadata deletion also refuses retained CRM originals.

Google CRM account tokens live in a separate private device vault outside portable
keys; the existing selected-file Drive token remains separate. Calendar/Contacts/
mail discovery needs its own explicitly selected readonly Google capabilities.
Luma, Partiful, Happenstance and other providers can enter through original-backed
CSV/vCard/ICS/EML import and review. No access is inferred from a connected app's
name. No account credentials enter the CRM snapshot or Git.

The private consistent SQLite backup created before CRM schema integration is under
`data/backups/before-crm-schema-3f68f24c-e905-4a10-b14c-07e13036fd99`.

## Assistant scope extension

Explicit `crmPersonIds`, `crmGroupIds` and `allowCreateCrmPeople` grants extend the
existing MCP client registry. The knowledge allSources scope never implies CRM
access. Group grants cover current/future members and are disclosed in the UI.
`list_crm_records`, `read_crm_record`, `propose_crm_change` and
`get_crm_edit_status` expose bounded canonical records and reviewed patches; raw
imports, account secrets and arbitrary asset bytes are excluded. Review rechecks
current grants, membership, every referenced entity and the target revision.

Task completion supports the Inspector recurrence choices and creates one durable
next occurrence in the same transaction. Retry receipts cannot create duplicates.
Month/year dates retain their month-end anchor; weekday schedules skip weekends.
Calendar arithmetic is UTC-based, not a full timezone-specific recurrence engine.

Browser commands use a memory-only retry map scoped to the current store and world
generation. Identical flights share one request; transport/malformed/5xx uncertainty
retains the same identity. Known success or definite rejection releases it. Explicit
caller IDs are unchanged. Query path/scope replacement hides previous record data
immediately, and import/wipe remounts the People session. Service CRM SSE changes
notify the existing debounced backup controller only in the SQLite writer window.
