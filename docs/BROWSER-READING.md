# Local article capture and the browser reader

The app can retain an article pasted into Archive without a browser extension. Give it a title, its original web URL and the article text; an optional personal remark is stored separately from the third-party source. The URL is provenance, never a server-side fetch request. Article sources do not automatically create or move 3D records.

The optional **Worldview Reader** companion adds explicit article capture, highlights with comments, and visible/focused reading progress in Chrome or Edge. It does not observe general browsing, infer which unrelated pages were read, or prove comprehension. No cloud AI provider is called.

## Setup

1. Run the local app at `http://localhost:5173` and open **Sources & activity → Browser reader**.
2. Click **Download browser companion** and extract `WorldviewReader.zip`. Its contents are generated from an explicit allowlist of the extension’s static source files; credentials and runtime data are never included. Alternatively use `extensions/worldview-reader` directly.
3. Open `chrome://extensions` or `edge://extensions`, enable Developer mode, click **Load unpacked**, and choose the extracted `WorldviewReader` folder. There is no build or dependency installation step. Installation is managed by Chrome or Edge rather than silently performed by the app.
4. Open its toolbar popup and choose **Connect to Worldview**. The local app opens its Browser reader panel. Click **Approve browser** on the request you just made, then reopen the extension popup. The approved 90-day pairing is claimed automatically, without copying an extension ID or token. An advanced manual-token flow remains available as a fallback.
5. In the chosen article tab, click **Save and follow this article**. The blue **ON** badge identifies following for that tab. Select a passage on the page, reopen the popup, add an optional comment, and choose **Save selected text + comment**.
6. Stop through the popup, or navigate the tab away. Following is session-only and stops on browser restart. Saved sources and highlights remain in Archive and Reader. **Revoke pairing** in the app disables the token immediately.

A connection request expires after five minutes and reveals no token before explicit local approval. Its one-time secret is bound to the exact extension origin. An approved handoff token exists only in service memory until claimed or expired; restarting the service requires a fresh request. Pairing tokens are stored in trusted extension storage and as SHA-256 hashes on the local service. They are never sent into page content scripts, embedded in the download, placed in URLs, or included in portable backups. Moving an unpacked extension directory can change its ID; create a new pairing when its ID changes. If browser storage or its sequence state was cleared, creating a fresh pairing is the safest recovery.

## What is retained

- Extracted article text, title, exact original browser URL, canonical URL and hostname. The original capture envelope is retained as downloadable JSON with an `application/json` MIME type. This is a capture of extracted text, not the publisher’s full original HTML.
- A stable document source identified by the canonical article URL. Tracking parameters and ordinary in-page anchors are removed only from the deduplication identity. Meaningful query parameters and hash-router paths remain. Changed text creates a retained source version; older highlight anchors keep their exact version IDs.
- Exact highlight quote, source/version IDs, character offsets and surrounding context. Ambiguous quote-only anchors are rejected. Comments and article notes remain personal reading annotations; the article passages are attributed to a third party and their authored date remains unknown.
- Approximate focused/visible dwell, scroll position and maximum observed progress, only after following was explicitly enabled for the selected tab. Progress cannot complete an article until at least 15 seconds of visible/focused dwell have accumulated. A read status derived from progress is an observation, not a claim that the content was understood. A different comment on the same highlight is appended, preserving earlier wording.

The extractor uses `article`, then `main`, then the document body as a fallback. It excludes navigation, forms, inputs, scripts, styles and hidden text. Selection anchors are computed against the exact same extracted text, including selections spanning inline text nodes. Full HTML, cookies, screenshots and history are not captured.

## Authentication and request boundaries

`GET /api/reading-capture` lists nonsecret pairing status. `POST /api/reading-capture` creates a pairing; `DELETE /api/reading-capture/{id}` revokes it. `GET /api/reading-capture/download` produces the unpacked ZIP. These management routes require the local workspace origin and `x-wv-client` header. Both the request Host and socket peer must be loopback. Account-hosted servers disable the companion route.

`POST /api/reading-capture/connect` accepts a connection request only from a valid extension origin on loopback. It gives that extension a short-lived secret. `POST /api/reading-capture/connect/{id}` with `action: "check"` checks only that request using its exact origin and secret; it cannot approve itself. Chromium can omit Origin on privileged extension GETs, so the shipped companion deliberately uses JSON POSTs for both checking and acknowledgement; a header-less request is still refused. A legacy GET remains check-only when its exact Origin is supplied. Local management explicitly approves through `POST /api/reading-capture/connect/{id}/approve`. After the extension has durably stored the delivered token, a secret-bound JSON POST with `action: "acknowledge"` removes the in-memory handoff. Pending requests are bounded to eight; none of this creates an externally connectable extension interface.

`POST /api/reading-capture/capture` requires an active pairing’s exact `chrome-extension://…` origin and bearer token. Its CORS preflight permits only that paired origin, POST, authorization and JSON headers; no wildcard origin or unauthenticated upload endpoint exists. The body is limited to 1 MiB and extracted article text to 512 KiB. Highlight quotes and personal comments are limited to 20,000 characters. Article URLs allow only HTTP(S), forbid embedded credentials, and are never fetched by the service, preventing a URL from becoming an SSRF request.

An example body (the extension manages sequence numbers):

```json
{
  "sequence": 1795450000001,
  "url": "https://example.com/article#paragraph",
  "title": "An article",
  "text": "Exact article text.",
  "selection": { "quote": "article text", "start": 6, "end": 18, "note": "My own reaction." },
  "progress": { "fraction": 0.25, "position": 320, "activeMs": 15000, "following": true }
}
```

Later progress-only requests can omit text when the source already exists. A monotonic sequence and payload fingerprint make a retried request idempotent. A stale or reused sequence with different contents is rejected. Original bytes are written before source metadata. The source/version/passages, `reading.v1`, and private capture receipt commit in one SQLite transaction; a conflict cannot leave a published source without its requested annotation. Private pairing/receipt keys are excluded from portable backups. Excluded/deleted sources are not silently revived.

The background worker talks only to the fixed `http://localhost:5173` service. The two loopback `host_permissions` are required for extension network access; Chrome match patterns do not restrict them by port, so the implementation itself fixes the endpoint. `activeTab` grants access only after user invocation, and `scripting` injects the tracker only into the chosen tab. There is no `history`, broad all-sites access, automatic content-script match rule, or externally connectable message interface. Chrome’s documentation describes [activeTab’s temporary grant](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [script injection permissions](https://developer.chrome.com/docs/extensions/reference/api/scripting), and [extension network boundaries](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

## Offline behavior and limitations

Pending captures are durably queued in trusted browser storage, with a maximum of 20 entries and the browser’s storage quota. A queued message means the browser retained it; it does not mean the service committed it. The popup shows the pending count, capture titles, last delivery, and the latest delivery failure. Use **Retry pending captures** when the local app is available. Successful delivery removes each entry. A permanently invalid request can block later entries; remove that individual pending capture and retry the rest. Removing a pending item, discarding the outbox, or disconnecting prompts first and intentionally removes unsent data. If the unsent initial article was removed, save that article again before retrying progress-only captures. No cloud relay is used.

Follow state does not survive navigation or restart, and the last few seconds of dwell can be lost on an abrupt tab/browser termination. SPA URL changes clear the badge and do not attribute the new page’s geometry to the old article. A page restored from the back/forward cache can be explicitly followed again; its timers restart. No additional idle, history or global tab permission is requested. Focused dwell cannot establish attention. PDFs, browser-internal pages, extension stores, cross-origin iframe content, virtualized text and paywalls may prevent extraction; manually paste text you are authorized to save into Archive instead. Firefox is not supported by this MV3 service-worker build. The HTTP and extension-runtime tests below verify the shipped code independently of browser installation. A real installed-browser acceptance check remains a separate verification step; tests alone do not prove that Chrome or Edge has installed it.

## Verification

`tests/server/articleCapture.test.ts` exercises the real HTTP handler and host mount against temporary SQLite/blob directories: pairing, approval handoffs and expiry, secret-free status, exact-origin CORS, missing/revoked credentials, rebinding-host refusal, body limits, URL identity, source revisions, original bytes, exact highlights, separate comments, progress retry idempotence, atomic conflict recovery, account-host refusal and static ZIP contents.

`tests/reading/articleCompanion.test.tsx` verifies the real pasted-article helper, retained provenance and exact text, URL deduplication, separate personal notes, no 3D projection, DOM extraction/selection anchors, and refusal to pair a different SQLite world while the active library uses browser storage. `tests/reading/browserExtension.test.ts` executes the shipped background/content scripts in controlled browser-API runtimes, checking the minimal manifest, restricted token storage, bounded offline queue, serialized retries, forged-message refusal, navigation stop, BFCache re-follow and visible/focused dwell measurement. `tests/reading/popupDrafts.test.ts` verifies that newer comments and queued/unconfirmed comments are not cleared. These tests do not substitute for loading the unpacked extension in the user’s browser.

```sh
npx vitest run tests/server/articleCapture.test.ts tests/reading/articleCompanion.test.tsx tests/reading/browserExtension.test.ts tests/reading/popupDrafts.test.ts --maxWorkers=1
```

The HTTP test needs permission to bind an ephemeral loopback port. It never contacts an external provider or an article website.

## Original PDF reading

Imported PDF originals now open through the local PDF.js page reader, with page navigation, fit-width/numeric zoom, a selectable text layer, and page-relative highlights with comments. Normalized page rectangles, quote, page number, and immutable source/version IDs are retained in portable `reading.v1.pdfHighlights`; they do not pretend that PDF.js page text has the same offsets as an extraction engine. Earlier PDF versions keep their own annotations. Extracted-text reading and its existing UTF-16 highlights remain available through an explicit format switch. Highlight exports include PDF page numbers.

PDF.js 6.5.438 and its worker, CMaps, standard fonts, and decoding WASM resources ship with the app, under the upstream Apache-2.0 license. There is no CDN, cloud OCR, remote document conversion, or automatic execution of PDF actions/forms. Original bytes are size/hash-checked; the page reader limits each PDF to 64 MiB and 5,000 pages, and bounds render dimensions. A scanned image-only page remains viewable but requires an existing text layer for selecting text; source notes still work. The original file is retained unchanged.

The real two-page fixture in `tests/fixtures/reading-pages.pdf` is decoded by `tests/reading/pdfParser.test.ts`. `tests/reading/pdfModel.test.ts` verifies original-byte integrity and zoom-independent selection rectangles. Browser rendering, selection, saved comments, and reopen behavior are checked separately against that same fixture.
