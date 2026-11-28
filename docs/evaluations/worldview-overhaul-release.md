# Worldview overhaul acceptance

The implementation used separate ownership for the workspace shell, the core knowledge journeys, and Reader, Enki, and CRM. A separate acceptance agent exercised the integrated browser build. All writes used synthetic fixtures and disposable workspace or browser profiles. The previous Mac package was retained at its existing path.

## Defects reproduced and fixed

| Severity | Entry point | Reproduction and fix | Evidence |
| --- | --- | --- | --- |
| High | Reader → Application | The form aggregator used an all-frame injection. A denied descendant could block capture, and unrelated descendants could enter the preview. It now verifies the visible provider frame and its document identity. Permission denial leaves a retry; stale tab or form observers are cleaned up. | Reader frame and permission regressions, public Alive Prize read-only |
| High | Reader → Application → confirmation | A failed context lookup could leave a saved application without its workspace token. Confirmation could then never arm. The save receipt now provides the authoritative token. Confirmation uses a durable outbox and an idempotent receipt. | Paired local fixture, HTTP and application capture tests |
| High | Reader → CRM → saved person | A profile could omit education when LinkedIn used a full institutional name or provided education in shared Highlights. The selected person’s exact school evidence is accepted and Columbia aliases match under the same school filter. | Legacy and current DOM fixtures, saved-person update and search regressions |
| High | To-do → edit across surfaces | Concurrent edits could leave the editor showing a stale draft with no explanation. Revision conflicts now preserve the draft and show the current saved text before an explicit retry. | Enki editor and To-do API conflict tests |
| High | Worldview ↔ Enki while both windows are open | The second editor had to receive focus or attempt a save before noticing a change. Successful writes now notify same-origin windows. Open Reader surfaces refresh periodically across origins. | Signed native two-window acceptance and visible-panel refresh regression |
| Medium | Library → file or folder actions | File actions were hard to find, and recovery wording pointed to the wrong place for drafts and books. File Actions and a single New menu are visible. Confirmations identify the appropriate Trash and explain folder reparenting. | Keyboard and recovery browser checks, Library tests |
| Medium | Search → exact passage | The citation opened the correct retained version, but the reader lacked a clear return route. The result now carries a local return marker and Search restores its filters and query. | Browser round trip and deep link tests |
| Medium | Explore → semantic settings | Regrouping moved saved anchors immediately. Preview lists the exact proposed coordinates, preserves explicit pins, and applies only if the workspace revision still matches. | Preview, stale commit and Undo regression |
| Medium | Narrow workspace → Commands | The mobile navigation dialog competed with the Commands dialog for focus. The navigation now yields focus and restores it on Escape. | Isolated Chromium at 320 and 390 px |
| Low | Narrow workspace → Navigation | The click-to-close scrim was also announced as a second close button. The scrim is skipped by assistive technology. | Independent keyboard and accessibility-tree review |

## Automated gates

| Gate | Result |
| --- | --- |
| TypeScript, ESLint, Vitest | 2,055 passed and 4 skipped across 305 test files |
| Production assets | Build succeeded, including a freshly generated Reader To-do bundle |
| Original 50-case retrieval fixture | Both engines reached 100% source recall at 5 and 12/12 correct abstentions. Each engine passed all 700 evidence invariants |
| Persisted SQLite corpus | Both engines reached 100% source recall at 5 and 3/3 correct abstentions. Each engine passed 112 invariants over aliases, conflicts, retained versions, and consent revoked after caching. This is evidence retrieval and delivery, independent of answer generation |
| Existing knowledge performance gate | 10,000 sources, 10 KiB capture. Capture p95 106.7 ms and warm search p95 110.7 ms |
| Local scan fixture | Two image-only PDF pages, recognized locally. Both citations resolve to their exact page and character span |
| Mobile-share intake | Chromium navigation POST, service worker, review and durable import receipt checked with synthetic text |

The public Alive Prize page publishes November 25 without a year. The deadline can be transcribed as given. A submitted date is recorded from successful confirmation and the public form was left unsubmitted. [Alive Prize application](https://aliveprize.com/apply)

Gemini ingestion covers dated prompt records in the My Activity JSON export. When the archive includes a response, the reply has assistant attribution and its own timestamp remains unknown. Codex ingestion covers rollout JSONL, preserving human and assistant text, with the complete original available in the receipt. [Gemini export instructions](https://support.google.com/gemini/answer/16920332) · [Codex rollout format example](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/common/rollout.rs)

## Route and integration coverage

All 16 workspace routes opened in the signed Mac app without horizontal page overflow at its default window size and at 768 × 1024. Chromium navigation, focus and overflow checks also ran at 320, 390 and 1440 px. The table distinguishes direct acceptance from automated regression coverage.

The final Mac bundle passed `codesign --verify --deep --strict` with an ad-hoc signature. The packaged entry point, Workbench chunk, Reader popup and To-do bundle matched the built files byte for byte. After restart, the app reported the same disposable workspace and its own loopback service. Worldview automatically showed Enki’s concurrent change alongside the unsaved desktop draft. The explicit save then appeared in Enki.

| Surface | Direct acceptance | Automated coverage or remaining check |
| --- | --- | --- |
| Today | Saved a thought, opened its record, and resumed investigations and reading after reload | Empty states, drafts, and failed import links |
| To-do | Created by keyboard in narrow Chromium. Desktop and Enki shared a task and preserved a concurrent draft | Create, complete, edit, list changes, stale revisions and offline loads. Actual paired extension UI remains open |
| Library | Per-file Actions, Cancel and Escape focus, Trash, Undo, restore with annotation and reading progress | Folder reparenting, source and version opening, exact offsets |
| Search and Ask | Searched, read an exact citation, returned to the focused search field, and resumed a saved investigation | Scope, authorship, dates, policy and packet filters. Live provider answer quality remains unmeasured |
| Writing | Draft, save to Library, file Actions → Writing Trash → restore with body intact | Versioning, editing, restore and export tests |
| People | Route initialized in the native app | Existing-contact updates, shared education, alias matching and CRM grouping fixtures. No private LinkedIn account used |
| Projects & topics | Saved and resumed a scoped investigation | Decision history across multiple sources, unsupported/excluded evidence, review, regeneration and backup round trip |
| Knowledge pages | Route initialized in the native app | Reading, decision review, historical citations and restrictions |
| Bookshelf | Route initialized in the native app | Bookshelf Trash deep link, recovery and reading tests. Full GUI restore was outside this acceptance pass |
| Quotes | Route initialized in the native app | Quote storage, citation and backup tests |
| Maps | Route initialized in the native app | Map fixture and local permission tests. Personal Photos was outside this acceptance pass |
| Knowledge graph | Route initialized in the native app | Relationship rendering, evidence and routing tests |
| Review | Route initialized in the native app | Accept, reject, Undo and source policy tests |
| Vocabulary and Dictionary | Route initialized in the native app | Lookup, cards and offline data tests. Live dictionary provider was outside this acceptance pass |
| Applications | Route initialized and live form inspected read-only | Verified frames, denied permissions, save on confirmation, replay and tab cleanup. A public submission was outside scope |
| Sources & activity | Browser share intake saved with a visible import receipt | Reimport, cancellation, failure and retry, PDF text and OCR, Gemini, Codex, and retention. Physical phone share sheet remains open |
| Explore | Reader selected passage carried into Research context, then returned to the original search | Layout preview, stale revision, pin and Undo checks |
| Enki and Reader | Native Enki window and installed unpacked Chromium extension inspected | Actual paired toolbar popup activation blocked by the isolated Chromium window state. Reader test fixtures and paired HTTP checks passed |
| Workspaces and backups | Exported and validated a ZIP, added a disposable marker, then restored using the import confirmation. The pre-backup note and task were recovered and the later marker was absent. Export used a test writable target. A second simultaneous native profile on another port could see neither the first workspace’s note nor its task | Account isolation, replace, export and restore automated tests. The interactive native folder chooser remains open |

The initial signed build was held at the paired Reader toolbar check. Chrome for Testing enabled the unpacked extension but refused to activate the toolbar popup in its isolated window. The physical phone share sheet and live provider answer quality remain unverified. Encrypted sync remains deferred by the plan.

### Reader 0.10.1 follow-up

The unpacked Reader opened its persistent capture window in Chromium using the production worker opener. Normal Worldview approval paired it to a disposable service on port 5186. The window populated the opportunity, organization, two form questions, and the December 18, 2026 deadline from the synthetic page. It retained a link to the visible deadline even though the server could not fetch that page. Worldview recorded the submitted answers and applied date only after the fixture showed its success acknowledgement.

Navigating the pinned tab to a different page prompted a return to the original source. The paired To-do surface remained available, including keyboard activation and creating a task that appeared in Worldview. Reader had no horizontal overflow at widths of 320 and 760 px. The browser harness invoked the production opener through Chromium’s debugger. Native toolbar and shortcut activation in Dia remain unverified.

## Reproduce

```sh
npm run check
npm run build
node scripts/eval-retrieval.ts /tmp/worldview-retrieval.json
node scripts/eval-retrieval.ts --persisted /tmp/worldview-retrieval-persisted.json
WORLDVIEW_KNOWLEDGE_BENCH=1 WORLDVIEW_BENCH_SIZES=10000 WORLDVIEW_BENCH_CAPTURE_BYTES=10240 npm test -- tests/perf/knowledgeBench.test.ts
WORLDVIEW_DESKTOP_RELEASE_DIR=/tmp/worldview-release node scripts/desktop/package.mjs
```

For native acceptance, use the packaged executable with `--profile`, `--workspace`, and `--port` set to disposable locations and an unused loopback port. Compare the packaged web entry point, Workbench chunk and Reader popup with the files that passed the checks. Use the included Reader with an isolated browser profile and pair it to the disposable workspace.
