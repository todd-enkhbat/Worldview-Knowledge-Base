# CRM connections: evidence, access, and implementation contracts

Research checked 23 November 2026. This is a connector audit and implementation specification; a connection visible inside Codex is not an authorization granted to the Worldview application. No provider token should be copied from another application's connector.

## Useful capabilities and honest boundaries

| Source | Supported path | Useful records | Boundary |
| --- | --- | --- | --- |
| Google Calendar | App-owned read-only OAuth; choose accounts and calendars | Events, organizers, explicitly exposed attendees, RSVP, dates and event links | Calendar presence does not prove attendance or friendship. Private events and shared calendars may omit details. |
| Google Contacts | People API read-only OAuth or vCard/CSV import | Saved contacts, their organizations, URLs and supported fields | Saved contacts and auto-created Other contacts are distinct capabilities. Do not import a university directory by default. |
| Gmail, multiple accounts | Separate app-owned grants; metadata only | Sender/recipient headers, message identity and dates; optional subject | Metadata is a restricted Google scope. This path does not download bodies or attachments, send mail, or promise full Gmail search. |
| Drive | Existing selected-file bridge and explicit extraction action | A chosen document/export and its retained original | Existing `drive.file` grant stays unchanged. No background whole-Drive crawl. |
| Luma | Host/manager CSV; optional calendar-key API | Names/emails where supplied, registrations, answers, status, tickets, check-in | API requires active Luma Plus. A calendar key is powerful; locally allowlist read methods. Access is limited to managed/permitted events. |
| Partiful | Official host guest CSV; private personal calendar feed | Names, RSVP, invited-by, questionnaire answers, check-in when exported | Phone/email are not shared by default. A calendar feed is not a complete guest API. No supported public developer endpoint was verified in the official material reviewed. |
| Happenstance | Official optional API/MCP; user-provided exports | Explicit search/research results and visible connection paths/groups | Search and research consume service credits. No verified bulk export of every network contact through its documented API. Keep paid/cloud research explicitly initiated outside automatic local sync. |
| LinkedIn / websites | User-selected visible profile capture; downloaded exports | Profile URL, selected text, supplied identity fields and source evidence | Current Reader is an article capture tool. Do not bypass authentication, hidden guest lists or platform permissions. |
| Other email/contact systems | CSV, vCard, ICS and selected EML files | User-chosen originals and reviewable candidates | File import is not continuous authenticated synchronization. Avoid interpreting every email recipient as a personal relationship. |

The read-only account audit found two Gmail profiles, two Calendar links and one Contacts profile. Seven and two calendars were visible respectively, with one overlap. Account names, emails, IDs and raw responses are kept only in ignored `data/crm-migration/connections-2026-11-23/account-inventory.private.json`. No mail body or event content was needed for this inventory.

## Google permissions and account setup

Request only the capabilities the user selected. Keep CRM authorization separate from the established Drive grant and its private file.

| Capability | Exact scope |
| --- | --- |
| Calendar selection | `https://www.googleapis.com/auth/calendar.calendarlist.readonly` |
| Calendar event reading | `https://www.googleapis.com/auth/calendar.events.readonly` |
| Saved contacts | `https://www.googleapis.com/auth/contacts.readonly` |
| Optional Other contacts | `https://www.googleapis.com/auth/contacts.other.readonly` |
| Email headers | `https://www.googleapis.com/auth/gmail.metadata` |
| Existing Drive bridge only | `https://www.googleapis.com/auth/drive.file` |

Account binding additionally requests `openid` and `https://www.googleapis.com/auth/userinfo.email`, displayed in setup. Optional sending is a distinct, default-off `https://www.googleapis.com/auth/gmail.send` capability. It is unnecessary for discovery and is never included unless selected.

Calendar supports selecting visible calendars and incremental event synchronization. Process deleted/cancelled records and reset an expired cursor when Google returns 410. Keep the cursor bound to its original account, calendar and filter parameters. [Calendar list](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list), [Events list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [Synchronization guide](https://developers.google.com/workspace/calendar/api/guides/sync).

Use People API rather than the retired Contacts API. Retain Google's resource/source identities and pagination. Other contacts have a separate read-only scope, limited fields and seven-day sync-token expiry; deleted records are tombstones. [Saved contacts](https://developers.google.com/people/v1/contacts), [Other contacts API](https://developers.google.com/people/api/rest/v1/otherContacts/list), [People API overview](https://developers.google.com/people).

Gmail `gmail.metadata` permits headers and labels, excluding bodies, but Google still classifies it as restricted. `messages.list?q=...` cannot be used with this scope. Page message IDs using labels, fetch `format=METADATA` with selected headers, then filter locally; retain history cursors for subsequent changes. Never silently upgrade to `gmail.readonly` to make search work. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [List messages](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [Read metadata](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).

New-project Gmail quotas changed in May 2026: the per-user/project minute allowance is 6,000 units, and a metadata `messages.get` costs 20 units. Discovery therefore reads one 50-ID page by default (maximum 100), spaces reads by at least 250 ms, and checkpoints pending IDs before metadata work. Every five successes and any quota interruption retain/stage completed metadata before advancing the pending list. HTTP 403 quota errors and 429 respect `Retry-After`, expose a resume time, and never trigger an automatic retry. Resuming uses saved unread IDs rather than rereading completed messages. [Current Gmail quota table](https://developers.google.com/workspace/gmail/api/reference/quota), [Error handling](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

Google's current Personal mode is restricted to the Google account that created that OAuth application. A second account can fail with `client_user_mismatch`; support a client configuration per account rather than promising the existing Columbia client can authorize personal Gmail. Personal mode avoids verification and seven-day test-user token expiry; Workspace administrator restrictions can still apply. An External/testing application has different user and token limits. [Personal mode setup and audience](https://support.google.com/cloud/answer/15544987), [Verification exemptions](https://support.google.com/cloud/answer/13464323), [OAuth audience settings](https://support.google.com/cloud/answer/15549945).

Use a Desktop OAuth client, system browser, loopback redirect, PKCE S256, single-use expiring state, exact scope checks and account-bound private refresh tokens. Desktop loopback remains supported; the deprecated mobile loopback and out-of-band copy/paste approaches should not be used. [Google native OAuth](https://developers.google.com/identity/protocols/oauth2/native-app).

## Luma, Partiful and Happenstance details

Luma's official guest CSV includes the host-visible export fields, supports filters, and can require a one-time Confirm Access code. Keep ticket/order identifiers separately because multiple tickets can belong to one person. Registration approval is not attendance: checked-in timestamps are stronger evidence. Calendar contacts include imported people and followers as well as event guests; keep unsubscribed status. [Guest CSV](https://help.luma.com/p/download-guest-csv), [Guest management](https://help.luma.com/p/managing-your-guest-list), [Calendar contacts](https://help.luma.com/p/managing-calendar-contacts).

Luma's API requires Luma Plus and uses a calendar-specific `x-luma-api-key`. Never describe a full calendar key as a read-only credential: Worldview must restrict its own methods and routes. A central Tech Week calendar does not automatically own independent organizers' guest data. [Luma API](https://help.luma.com/p/luma-api), [Developer setup](https://docs.luma.com/reference/getting-started-with-your-api), [Tech Week data access](https://help.luma.com/p/tech-weeks).

Partiful's official CSV exports names, RSVP, RSVP date, invited-by, answers and other available event fields. Full names may require a questionnaire, and default guest lists do not provide contact email or phone. Preserve unknown columns and require identity review for first-name-only rows. Its private calendar-feed URL is a secret; Google may update it only about once a day. [Guest CSV](https://help.partiful.com/en-us/articles/15525419-can-i-download-the-names-of-my-guests), [Export fields](https://help.partiful.com/en-us/articles/18518878-what-info-can-i-export), [Contact privacy](https://help.partiful.com/en-us/articles/15525536-someone-i-don-t-know-invited-me-to-an-event-do-they-have-my-phone-number), [Calendar sync](https://help.partiful.com/en-us/articles/15525660-sync-to-google-calendar).

Happenstance publishes a real API, MCP endpoint (`https://happenstance.ai/mcp`) and CLI. The documented workflows are asynchronous network search, person research, chats, groups and credit checks. API search can return 402 when credits are insufficient; ambiguous person research must not be assigned automatically. A network result or AI-generated introduction draft is not permission to contact someone. [Developers](https://happenstance.ai/developers), [MCP setup](https://happenstance.ai/developer/mcp), [API quickstart](https://developer.happenstance.ai/quickstart), [OpenAPI contract](https://developer.happenstance.ai/openapi.json).

Happenstance describes local preview of imported network exports and using email participants/times rather than message bodies. That is a useful design precedent for a local CRM, independently of its optional hosted research. Worldview should keep source evidence readable and all cloud enrichment off by default. [Happenstance security](https://happenstance.ai/security).

## Existing Worldview components to reuse

- `server/connections/googleDrive.ts`: scoped selected-file bridge, PKCE, private credentials, retained originals and workspace replacement guards. It rejects scopes beyond `drive.file`; leave those checks intact.
- `server/connections/assistant.ts`: reviewed proposals, compare-and-swap baselines, provenance checks, proposal ledger and explicit approval. Extend these concepts to people; do not imply old source-reader tokens can read the CRM.
- `server/memoryAccess.ts`: client-specific source/document/book visibility. Add explicit people/group permissions before exposing CRM data through MCP.
- `extensions/worldview-reader`: explicit active-tab visible text/selection, local pairing and durable outbox. Add a reviewed profile-capture path rather than a hidden crawler.

## Data contract and review behavior

1. **Stable identity:** an internal person ID is distinct from each provider/account/external record ID. Exact verified email or explicit profile URL can suggest a match. Do not merge solely on name or strip Gmail dots/plus aliases indiscriminately; shared and role addresses need review.
2. **Durable provenance:** preserve an immutable original/hash, provider, account, external identity, source field, observed time, occurrence time/timezone, source URL/version and extraction method. Retain unknown export columns. Imported assertions and the user's own assertions remain distinguishable.
3. **Candidate inbox:** capture → parse → review → accept/merge → audit/undo. A changed provider field produces a proposed difference, not a silent overwrite of a manually edited field. Dismissed candidates stay dismissed unless their source changes.
4. **Events as participation records:** keep organizer, attendee, invited-by, RSVP and check-in as separate fields. Avoid generating a friendship clique from an event guest list. Calendar selection adds an idempotent local interaction; it does not send an invite, change an RSVP or write to Google.
5. **Explainable graph:** confirmed relationships, organizations, groups and event participation are distinct edge types. Show why a path exists, its source/date, and whether it was user-confirmed. Filter by source, relationship type and date; show large events as event nodes instead of thousands of pair edges.
6. **Scoped assistant enrichment:** export selected contacts or authorize selected-person MCP scopes. Stage suggested field changes with URLs and evidence. Require review for merging, relationship assertions and enrichment, check the original baseline, and reject stale/revoked proposals. The application does not require a model API to perform these steps.

## Connector service contract

The implementation uses a separate private CRM Google vault with one configuration and granted capability set per account. No credentials appear in portable workspace KV, API status or client storage. Public status exposes configuration/connection state and coverage rather than secrets. Disconnect invalidates in-flight operations and pending OAuth state; workspace replacement invalidates capture/import operations.

`/api/crm/connections` is the local authenticated UI surface. A calendar picker lists explicitly selected calendars and bounded event windows. Contacts and header discovery produce review candidates. File imports retain original bytes/hash and accept supported CSV, vCard, ICS and selected EML sources. Provider operations are bounded, paginated and resumable with honest coverage counts. Cloud/credit-consuming Happenstance operations are optional and explicitly initiated; file imports and local CRM functions remain usable without them.

The existing Drive grant remains a separate connection. The explicit “Use existing Google client configuration” action reuses the local OAuth client configuration only after an explicit user action; it must never reuse, expose or broaden the Drive token. A separate Google consent screen is still required for CRM permissions.

## Implemented connection surface

The local implementation is in `server/crmConnections.ts`, with parsers in `server/crmConnectionParsers.ts`, and the account/source UI in `src/crm/CrmConnections.tsx`. OAuth activation requires the user's fresh Google consent; these features do not claim that the pre-existing Codex grants activate the app.

| Local action | Behavior |
| --- | --- |
| `google/configure`, `google/connect`, `google/disconnect` | Configure distinct account clients/capabilities, use PKCE, bind verified account identity, and disconnect locally. |
| `google/calendars`, `google/events`, `google/event/stage` | Select a calendar and bounded date window; stage chosen events and optionally non-declined attendee candidates. |
| `google/contacts/sync`, `google/gmail/sync` | Stage saved/Other contacts or email-header participants. Gmail scans save bounded-page progress before switching to history synchronization. |
| `import/preview`, `import/stage` | Preview mappings and original hash before staging CSV/vCard/ICS/EML candidates. Recurrence and unresolved floating/ambiguous ICS times are retained, not invented. |
| `sources`, `source/stage`, `profile/stage` | Explicitly select an existing retained Drive/Reader source, find exact emails, or stage a named captured profile. Verify the original/current version and attach source evidence; no new browser access. |
| `folk/configure`, `folk/interactions` | Optional user-created Folk key, stored privately; GET-only paginated interaction lists for already imported source identities, staged with original privacy metadata. No individual message-body endpoint or remote mutation. |
| `happenstance/configure`, `happenstance/request` | Private optional key; read groups/usage and explicitly credit-confirmed search/research. The REST credit-balance endpoint is `/v1/usage`; `get-credits` is the MCP tool name. |
| `mail/prepare`, `mail/send` | Optional sending permission only. A five-minute one-use confirmation binds the account, recipients, subject and full message hash. Persist an uncertain-delivery marker before dispatch and accept success only with Google's receipt. No automatic retry. |

Folk's optional fallback follows its documented list endpoint and retains associated entities, past/upcoming context and pagination rather than inferring history from a summary timestamp. [Official interaction-list API](https://developer.folk.app/api-reference/interactions/list-interactions).

`src/crm/CrmOutreach.tsx` provides campaign/template/sequence draft editing, recipient selection and personalized previews. Sequence steps are planning drafts; they do not run a background scheduler. Optional Gmail delivery is individual and explicitly reviewed. No message was sent during implementation; provider delivery paths are exercised with mocks.

## Live acceptance: 23 November 2026

The user approved enabling the three Google APIs and a new app-owned read-only Calendar, saved Contacts and Gmail metadata grant for the Columbia account. The existing selected-file Drive grant remained separate. Basic verified account identity accompanies this grant; Other contacts and email sending remain off.

| Live operation | Observed result | Coverage |
| --- | --- | --- |
| Calendar list | HTTP 200, seven calendars | Calendar selection works. |
| Selected calendar events | HTTP 200, 100 events and a next-page token | A bounded page was read; this does not claim the entire calendar history. |
| Saved Google Contacts | HTTP 200, zero saved records | The authorized saved address book is empty. Other contacts and the university directory were not scanned. |
| Gmail metadata discovery | HTTP 200, 50 message headers read, 54 review candidates stored | The page completed without a quota error. The overall scan remains incomplete, with a next-page continuation and no unread IDs from this page. Resume is explicit. |

The 54 Gmail candidates were not automatically accepted into people records, and no friendship was inferred. No message bodies or attachments were downloaded and no mail was sent. The earlier oversized pass reached Google's quota; the 50-message/checkpoint/resume implementation above was verified afterward against the live account. Quota interruption, saved pending IDs, restart/resume without rereading completed messages and idempotent duplicate passes also have focused mocked regression tests.

The user declined activating the optional Folk REST history fallback. No old Folk interaction request was made through that path, and old interaction history remains explicitly incomplete.
