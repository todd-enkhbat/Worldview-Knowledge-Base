# Local workspace UX update

Cloud AI is off by default. Existing credentials are retained privately; saving a key alone does not activate a provider. This app's current configuration is `AI_PROVIDER=none`. Local capture, original attachments, reading, search, QMD, Whisper and exports remain usable.

## Interface

The workspace has a consistent light/dark/system palette, a collapsible desktop sidebar, a mobile navigation drawer, a focused Today composer and a local Quick capture panel. Cmd/Ctrl+K opens commands and local record search; Cmd/Ctrl+Shift+N focuses capture. Cmd/Ctrl+Enter saves locally. Connector setup is grouped behind disclosures in Sources rather than mounted as a wall of forms. Optional cloud setup stays closed and makes no provider probe on its own.

The account-keyed shell remains mounted while changing sections. Visited capture, search and Library views keep their filters, DOM and scroll through React Activity while hidden effects pause. Account changes and workspace replacement clear the relevant view state. Quick-capture drafts survive closing and navigation, remain separate from saved notes and conversations, and are bounded/account-scoped.

The review and browser pilot fixed capture focus while mobile navigation was inert, collapsed desktop styles leaking into mobile, historical version selection resetting on Activity reveal, a pending save clearing newer draft text, stale save completion crossing world generations, and full-screen capture focus escaping behind its panel. Capture receipts now open the readable note in the workspace, while the world retains its spatial action. Calendar dates render consistently in receipt labels.

Motion uses short native opacity/transform transitions, clear focus/hover feedback and native modal dialog behavior. Reduced-motion preferences disable physical transitions. No animation framework, stock asset pack or third-party product stylesheet was added. The existing self-hosted fonts and Phosphor icon family remain.

## Verification

Typecheck, ESLint and the production build pass. The final regression run passes **1,117 tests across 173 files**, with four existing opt-in tests skipped. Focused cases cover retained filters/scroll, account isolation, pending saves, historical versions, keyboard capture, modal focus, draft retention, cloud-off behavior, receipt navigation and dates.

Real production-browser acceptance used an isolated SQLite world: Today shortcut save, Quick capture with a Markdown original, exact note text and original SHA-256, restart retention, and receipt-to-Library navigation. The ordinary workspace was used to inspect both themes, responsive navigation, command search, mobile capture/Escape/draft retention, Sources disclosures and the existing 3D view. Synthetic test notes stay in ignored QA data. No cloud generation was used.

Reports: [local capture acceptance](evaluations/local-ui-acceptance-2026-11-23.json) and [final integrity/validation](evaluations/local-ui-validation-2026-11-23.json).

Saved browser previews: [dark workspace](design/local-ui-dark-2026-11-23.png), [light workspace](design/local-ui-light-2026-11-23.png), [mobile capture](design/local-ui-mobile-today-2026-11-23.png), [mobile reader](design/local-ui-mobile-reader-2026-11-23.png), and [preserved 3D world](design/local-ui-world-2026-11-23.png).

Primary references reviewed: [React Activity](https://react.dev/reference/react/Activity), [WAI modal dialog patterns](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [Motion accessibility](https://motion.dev/docs/react-accessibility), and [Radix dialog behavior](https://www.radix-ui.com/primitives/docs/components/dialog). They informed implementation choices; no third-party product branding or styles were copied.
