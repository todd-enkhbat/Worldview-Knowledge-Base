# Worldview Reader

Load this directory as an unpacked Manifest V3 extension in Chrome or Edge. No build or dependency install is required. The downloaded ZIP contains the same files in its WorldviewReader folder.

1. Start the Worldview app locally at http://localhost:5173.
2. Open chrome://extensions (or edge://extensions), turn on Developer mode, click Load unpacked, and choose this folder.
3. Open the extension popup and click Connect to Worldview. In the local app’s Browser reader panel, approve the browser request you just made.
4. Reopen the extension popup to finish connecting automatically. No ID or token copying is needed. The token is saved only in this browser’s trusted extension storage; content scripts never receive it. Requests expire after five minutes; pairings last 90 days. The advanced token flow remains available as a fallback.
5. On an ordinary article page, explicitly choose Save and follow this article. A blue ON badge identifies the selected tab. Select text and reopen the popup to save it with an optional comment.

Stop following through the popup. Navigation and browser restart also stop following. This extension has no history permission, no all-sites permission and no automatic content-script injection. The localhost host permissions allow the extension service worker to contact the fixed local endpoint; the page cannot choose a server URL.

If Worldview is offline, captures are kept in a bounded local outbox. The popup shows capture titles, delivery status, and the last failure. Reopen it and use Retry pending captures. You can remove one permanently invalid pending capture to deliver the rest. A queued message is not confirmation that the app received it. Discarding or disconnecting requires confirmation and deletes pending unsent captures. Follow state is session-only; pending captures and pairing survive browser restarts. Revocation in Worldview invalidates the token immediately. Pairings expire after 90 days.

Captures contain extracted article text and URL provenance, not screenshots, full-page HTML, cookies, form input, or browsing history. Restrictive pages, PDFs, iframes and paywalls can prevent extraction. Progress measures scroll and approximate visible/focused dwell; it does not prove comprehension. A last few seconds of progress may be lost if the browser or page is abruptly terminated. Never use this on a page you do not intend to save.

See docs/BROWSER-READING.md in the Worldview repository for architecture, security boundaries, HTTP verification and limitations. Firefox is not supported by this build.
