# Collecting profiles and organizations

Profile collection turns an explicitly saved person or company page into a
retained source and a field review. It runs locally with cloud AI off. Education,
employment, membership and advisory records keep the organization, role or degree,
field of study, stated dates and source evidence. A school appearing on a company’s
aggregate employee chart is not evidence of an individual’s education.

Worldview Reader uses the page already open in the browser. Its explicit profile
action is separate from reading tracking and photo-only capture. The installed
extension keeps its existing `activeTab`, `scripting`, `storage` and local-service
permissions. It does not gain browsing-history or all-sites access.

The archive retains the supplied readable text, bounded HTML snapshot and
structured extraction as an original JSON file with a SHA-256 identity. A snapshot
captures loaded content; it is not a pixel-perfect reproduction of an entire
website, a hidden section or a paywall. Source HTML is untrusted content and must
not be executed by the app.

## Matching and review

Saved profile URLs establish exact existing-record suggestions. Names alone do
not merge people or companies. LinkedIn entity URLs are distinguished from their
Education, Experience and People subviews; the original captured page URL remains
in provenance. An ambiguous match requires a choice. Creating a new person or
company is explicit.

Review selects which fields to apply. Contact channels and structured affiliations
are combined with existing data; chosen scalar changes use the current record
revision. Original source payloads, existing notes and edit history are retained.
The generic discovery approval endpoint cannot bypass profile field review.

Profile sources and drafts belong to People. They are not published into the
general Knowledge/Reading archive by profile capture, and existing knowledge-only
assistant grants do not gain access to them. Source originals travel with the full
CRM backup; browser pairing credentials and delivery receipts remain device-local.

## Using the collected data

People filters include Alma mater, Education & degrees, Employers, Memberships,
Advisory roles, All affiliations and Connected companies. Directory search includes
affiliation details and connected company names. Person detail sections retain
source excerpts alongside editable education and employment records. Personal
connection edges continue to mean explicit relationships; attending the same
school does not imply that two people know each other.

## Primary references

Structured extraction follows the meanings of Schema.org’s
[alumniOf](https://schema.org/alumniOf),
[worksFor](https://schema.org/worksFor),
[memberOf](https://schema.org/memberOf) and
[affiliation](https://schema.org/affiliation).
Browser injection uses Chrome’s existing
[scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting).
These are extraction sources, not a universal enrichment service or a guarantee
that every website exposes structured profile information.

## Collection entry points

- **People → Collect profiles → From Dia** explains the Reader action. Person
  and company details can open the same collection flow with their saved URL.
- **Public URL** reads a public HTML page with a primary, identity-bound
  Schema.org Person or Organization. Fetching uses pinned public addresses and
  bounded responses. Login-only pages, including LinkedIn, require Reader.
- **Saved sources** scans retained Reader originals in small batches. A source
  must still be current, permitted, intact and bound to its retained original.
  A changed or purged source cannot silently supply new facts.
- **Capture archive** retains accepted and dismissed originals. A captured-source
  link in record details reopens the source and review receipt later.

Older LinkedIn article captures contain flattened text without reliable section
boundaries. They may include unrelated profiles or grouped job titles. These are
skipped with a recapture instruction rather than converted into education or
employment. Explicit structured captures can retain an empty affiliations list
without triggering a fallback guess.

## Verification

Live acceptance covered a public personal website, an existing-record education
update, source excerpts, an Alma mater filter, reopening an accepted original,
and real LinkedIn person and company pages captured through the installed Reader
0.4.1 in Dia. The person capture retained four dated roles under the correct
employer, matched the existing record by its profile URL, and supplied no
education when that section was absent. A timed-out delivery stayed in the
browser outbox and its exact original sequence was successfully retried. The
accepted source reopened after a workspace reload.

The newer LinkedIn header without an H1 requires a visible name that agrees with
the page title and shares a bounded header with the exact profile’s Contact info
link. The title or a generic root link alone cannot establish identity. Grouped
job titles inherit the employer from its non-dated organization label rather
than mistaking each dated role link for a company name. An unknown whole-body
LinkedIn layout is refused instead of capturing messaging or unrelated areas.

Selected facts were applied only after field review. Original contact fields,
photos, notes, group membership and relationship records were preserved.

Automated coverage exercises extraction, source identity and integrity, retained
originals, paired-browser delivery, retries, revision conflicts, reviewed field
selection, search and filters, backups and UI flows. Private acceptance snapshots
and data-preservation reports stay under the ignored local QA directory. Cloud
AI remains disabled; profile collection adds no requirement for an AI API key.

The final run passed 1,751 tests with four skipped, plus repository-wide lint,
TypeScript and the production build. Preservation checks verified all 1,119
pre-existing source originals and the five new profile originals. Only reviewed
affiliations on two existing people and one explicitly created company were
added; the 3D world and other saved content remained intact.
