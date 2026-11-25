# Contact photos and social profiles

Worldview keeps downloaded contact photos as local, content-addressed original
image files. A portrait records the attached profile URL, the selected image URL,
the observation time and the retained original asset. Record history and full-app
backups preserve those bytes. Displaying an avatar never hotlinks the remote site.

## Sources and identity

- Existing imported photo metadata is preferred. Default Google placeholder images
  are excluded. The Contacts sync requests the `photos` person field within its
  existing read-only grant; it does not request a broader scope.
- Explicitly attached personal and academic pages can supply a matching JSON-LD
  `Person` image, or a headshot whose alt text exactly matches the contact's name
  on a page with that name as its primary heading.
- `rel="me"` links and `sameAs` on that matching Person record can fill website and
  social links. Generic department/publisher footer links are not assigned to an
  individual. Names are never searched across the web to guess an identity.
- Generic Open Graph images appear as candidates for explicit selection; a banner
  or publisher logo is not silently presented as a person's headshot. This also
  applies to pages declaring `og:type=profile`: their preview can still be a
  marketing card. Gravatar downloads request HTTP 404 for a missing photo and
  remove forced-default parameters, so default silhouettes are not saved.
- An explicitly attached, retained Reader capture can supply profile images and
  links. Deleted/excluded sources, purged/missing originals, changed text hashes
  and mismatched captured subject names are rejected or omitted.
- A Reader capture also appears automatically for an existing contact when its
  canonical profile URL matches a URL already on that contact and a primary
  profile photo or annotated profile link explicitly names that same person.
  Both checks must match; a name alone never links a capture. This discovery is
  read-only. Saving a chosen photo or running the bounded population action is
  still an explicit action.
- A manually chosen image URL needs an attached source URL and an explicit
  confirmation. Uploading the actual photo remains available.

LinkedIn's Profile API requires authenticated, authorized access, and retrieving
another member's profile depends on limited-access APIs and the member's privacy
settings. Sign in with LinkedIn supplies the authenticated member's profile; it
does not unlock everybody in an address book. Worldview does not read browser
cookies, bypass login pages or present a universal LinkedIn photo lookup as
available. An imported or explicitly captured LinkedIn image URL can be retained
when its actual raster bytes remain accessible.
[LinkedIn Profile API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api),
[LinkedIn API access](https://learn.microsoft.com/en-gb/linkedin/shared/authentication/getting-access).

Google's People API exposes photo URL and default-photo metadata. URLs can include
image-size parameters. Worldview retains the returned original rather than
depending on the URL to remain accessible indefinitely.
[People resource](https://developers.google.com/people/api/rest/v1/people),
[image sizing](https://developers.google.com/people/image-sizing).

## Download boundaries

Public reads use no credentials or browser cookies. Every initial address and
redirect is checked for private networks; the real HTTP socket is pinned to the
validated DNS address. Credential-bearing URLs, local hosts, unsupported protocols,
nonstandard ports and HTTPS downgrade redirects are rejected. Redirects, response
bytes and time are bounded. Photos must have an allowed raster signature: PNG,
JPEG, WebP, GIF or AVIF. HTML and SVG are not accepted as portraits.

Each write checks workspace generation and the contact's revision. Existing
portraits stay intact unless replacement is explicitly selected. Original file
hashes are checked before an existing local file is reused.
New social/website links are compared canonically against existing values, while
every original imported URL string and duplicate occurrence stays untouched.

## Local API

All routes retain the existing account boundary, same-origin check and
`x-wv-client` requirement.

- `GET /api/crm/profile-media/:personId`: inspect retained/imported candidates.
- Add `?discover=true` to preview up to three attached public websites without
  editing the contact.
- `POST /api/crm/profile-media/:personId`: provide a unique `requestId`,
  `expectedRecordRevision`, optional `discover`, and optionally `photoUrl`,
  `sourceUrl` and `replacePhoto`. Explicit manual selection additionally requires
  `confirmManualPhoto: true`.
- `POST /api/crm/profile-media/populate`: provide a unique batch `requestId`,
  `limit` (1–25), `offset`, optional `groupId`, `discover: true` and
  `eligibleOnly: true` for an attached-website backfill. A new offset uses a new
  request ID. Repeating an identical batch replays its result; interrupted batches
  retain initial record revisions and per-record checkpoints.

Batch results distinguish updated, unavailable, skipped and error outcomes. They
include actual downloaded-photo and added-link counts. No cloud AI or paid
enrichment service participates in these operations.

## Profile visuals and groups

People now offers a saved Gallery view alongside tables, pipelines and the network.
Cards show local portraits, role, organization, location, group marks and recognizable
social icons. The filter builder includes Portrait photo and Websites & social
profiles. Gallery pages are bounded to 48 records. Existing pipeline cards also use
saved portraits. Hover, entrance and dialog animations respect reduced motion.
Navigation, layout, applied filters, search, columns, sort and saved view survive
refresh/reconnect in session storage scoped to the account and verified server
workspace fingerprint. Records, selections, edit revisions and drafts are not cached;
replacement workspaces retain the existing generation and revision safeguards.

Each group can have an uploaded picture, uploaded cover, custom emoji or one of 16
icons. Appearance controls include five cover patterns, accent and title colors,
cover positioning/shading/height, title typography and compact/comfortable spacing.
The editor previews changes before a revision-checked save. Cover and picture
originals remain in archived records, edit history and full-app backups. Existing
group names, memberships, imported emoji and source metadata are preserved.

## Earlier acceptance, 23 November 2026

The public-source pass checked all 169 eligible existing website profiles. Independent
review retained 24 usable portraits and 26 genuinely new profile/website links. URL
aliases were removed from the new additions while restoring every original imported
URL string and duplicate occurrence. A default silhouette and an Open Graph preview
card were removed as active portraits; their prior bytes and history were preserved.

The installed Reader extension was refreshed and tested in Dia against an existing
LinkedIn contact. It captured the visible profile photo with the exact subject name,
then stopped following the tab. Worldview retained the real 859,638-byte raster
original and verified its SHA-256 identity. That initial pass produced
**25 saved contact portraits and 26 new links**. This test adds one retained LinkedIn
source to the knowledge archive; it does not mark it as a completed human reading.

For subsequent captures, Reader references are discoverable from an existing contact
without a separate source-linking step when both the canonical saved profile URL and
annotated subject name match. Ordinary article capture does not edit the contact. Reader 0.3.3 adds the separate, explicit **Save contact photo** action, which saves a matched contact's visible portrait directly. The contact's Details → Find photos & profiles → Save photo and Fill profiles remain available. A missing, excluded, deleted, purged or altered source is not eligible.

This is not a complete photo directory: contacts whose photos are not accessible
still need an explicit profile capture, a selected image URL or a local upload. No
browser cookies, paid enrichment or cloud AI were used. At that stage, 1,364 contacts
did not yet have a saved portrait. See the later audit for current coverage.

Release verification passed 1,557 tests (four skipped), TypeScript, ESLint and the
production build. Dia verified the gallery, source-backed photo and detail controls;
browser acceptance also checked the group preview/editor and gallery restoration
after reload. An isolated workspace saved an uploaded group picture and cover,
verified both exact source-file hashes and rendered them after reload. The Apple silicon desktop
archive was rebuilt and verified against all 811 source/build files, with no private
data paths or configured credentials included. It is ad-hoc signed, not notarized.


## Reader and photo audit, 24 November 2026

The full public-source review checked all 148 websites attached to people still
missing portraits. Explicit visual and page-context review selected 63 additional
images, with original source URLs and redirects retained in private audit evidence.
Generic preview cards, group photos, landscapes and default silhouettes were
withheld. Automated matching additionally recognizes an exact “photo of NAME” alt
on a page with the same named heading.

People → **Photo check** audits every active contact, checks local image bytes,
MIME signatures, file lengths and hashes, and distinguishes missing records from
damaged or missing originals. It paginates all results and can open the missing
portrait Gallery. Counts reflect verified files rather than the presence of a URL.

The installed Dia extension was tested with an existing LinkedIn contact: explicit
photo save retained the real image and source; a second save kept the existing
portrait. Follow, selected text plus comment, and Stop were each confirmed in the
popup and in persisted local source/highlight records. No cloud AI was used.

Folk capture uses a separate CRM-only route. Ordinary article capture of Folk
pages is rejected on the server, including outdated queued requests. Visible photo
rows are retained as a private JSON original, never as general Knowledge/Reading
sources. Group photo updates require a rendered same-workspace/group person UUID link,
matching name, imported account/group membership and current record revision.
Search has a separate explicit matched-photo action: its account must be proven
by completed group captures, and a visible email plus display name must identify
exactly one imported person in that account. The primary loaded avatar label must
also match. Shared emails, company-logo fallbacks, secondary images and conflicting
identities are skipped. Search permits only the People view (default or one exact
`type=person`); other or ambiguous entity types cannot write pictures.
Diagnostic-only Search capture remains read-only inside Connection settings.
Existing photos stay intact, and no photo action creates a person.

The optional **Follow visible Folk photos** action watches only the explicitly
chosen group while it is visible. Scrolling and image load events capture new
rendered rows; unloaded or stale image sources are withheld. Stop, navigation,
browser restart or a full outbox ends the session. Inactive tabs pause; current-tab,
nonce and top-frame checks support single-page view changes, and observer-health
checks clear stale following indicators. Retry shows the actual retained save receipt.
Durable per-row receipts allow
interrupted delivery to resume without duplicating photo edits.


An explicitly rejected default/incorrect image is recorded by content hash against
the person. Automatic capture cannot reinstall those bytes; manual selection or
upload remains available. Rejected originals and prior picture edits stay in history.
One source-default initial tile found during visual review was replaced using an
official institutional headshot after matching the saved name, role and organization.
Every pre-existing URL remained unchanged, with the verified source appended.

The final live recovery traversed all 21 imported Folk groups and the 471-person
ungrouped Search view. Worldview now has **829 saved pictures for 1,389 people**;
**560 people still need a verified picture**. Search added two genuine pictures
after the group pass. Six Folk demo smiley icons were excluded after visual
review, with their bytes and history preserved. Unmatched newer Folk contacts
were not created, and generic
silhouettes, secondary company images and ambiguous identities were skipped.
Reader following was explicitly stopped with an empty outbox after the pass.
Known `documents.folk.app/sample-contact-avatar-*.webp` demo images cannot activate
automatically, including redirects to those files. Deliberate manual selection
and local uploads remain available.

The remaining 560 records comprise 424 with no attached profile/source, 95 needing
an explicit LinkedIn capture, and 41 whose attached public sites supplied no
verified usable portrait. The final audit found zero damaged or missing picture
originals. All original CRM records and assets, knowledge/reading originals,
writing, bookshelves, workspace settings, 15 spatial nodes and 94 spatial events
were preserved. The six excluded demo pictures and earlier rejected initial tile
remain in original storage and edit history.

Release checks passed **1,671 tests** (four skipped), TypeScript and ESLint.
The rebuilt Apple silicon archive matched all 1,000 source/build files, including
the bundled Reader, with no private data paths, configured secrets or escaping
symlinks. The signature is ad-hoc; native desktop-window acceptance and
notarization remain separate from the verified Dia and package checks.
Private evidence, source originals, contact identities and screenshots remain in
the ignored local QA directory; they are not shipped in the public application.
Cloud AI remains off. The existing 3D world, notes, writing and reading records
remain intact.
