# Worldview for Mac

Worldview now has a local macOS application wrapper. It opens the same application and 3D world in a native, sandboxed window, backed by the SQLite workspace folder you explicitly choose. It does not replace your current library with an empty app database, copy personal data into the application bundle, or enable a cloud AI provider.

## Open your existing workspace

Download **Worldview for Mac** from the desktop connection panel, unzip it, and open `Worldview.app`. Choose the folder containing `world.sqlite` and `blobs`; choosing the repository folder also recognizes its existing `data/world.sqlite` automatically. A folder without an existing database requires an explicit **Create new workspace** confirmation. Existing files are not overwritten or automatically imported just because their folder was opened.

The app remembers the chosen folder in its private application preferences. **Worldview → Open Workspace…** changes it; **Show Workspace in Finder** reveals it. The in-app desktop connection panel offers the same controls.

On opening a workspace, the native launcher first checks the canonical `http://127.0.0.1:5173` service. It reuses a running service only when its workspace fingerprint matches the selected physical folder and `/api/ai/status` verifies cloud AI is off. An enabled or unverified provider refuses reuse instead of displaying a false “Off” label. The `localhost` alias is checked second for compatibility, without migrating or replacing browser IndexedDB data at either origin.

When no matching service is running, the bundled Node runtime starts the normal local API against that selected folder. It binds to loopback IPv4 and serves the packaged client at the same origin. Cloud AI is explicitly disabled and provider keys are not inherited. Existing local model/tool paths can be reused from that workspace's `models` and `tools` directories. Optional external services retain their separate setup requirements.

A different workspace occupying port 5173 requires an explicit separate-port choice. The app displays its actual local address; MCP configurations must use that address. The browser reader uses the canonical port 5173 and cannot silently redirect captures to a different vault. Closing the app stops a service it started, but leaves an existing shared browser service running.

## Local files and security

The folder's `world.sqlite` and retained `blobs` remain authoritative. Opening a workspace does not import, reset, migrate between browser origins, or rewrite the user's 3D records. Normal schema migration and verified backup/recovery controls remain in the app's existing storage layer.

The renderer has context isolation, process sandboxing, web security, and no Node integration. The preload exposes only native workspace information, a folder picker, and revealing the current folder. IPC checks the local window and frame origin; it does not expose arbitrary files, paths, shell commands, or raw Electron APIs. Main-frame navigation is confined to the selected local origin. External HTTP(S) links open in the ordinary browser; unsupported schemes are refused. Microphone permission is limited to the local app's explicit audio request and still requires the operating system's consent. Camera and unrelated permissions are denied.

The application bundle contains public built assets, application source/runtime dependencies, the official Electron runtime, and a checksum-verified official Node executable. It excludes `.env.local`, personal SQLite databases, original blob directories, and local service credentials. Google OAuth credentials, if configured, stay in the selected workspace's private connection file rather than in the application download.

The supplied build is **ad-hoc signed for local use**, with its canonical build checked by `codesign`; it is **not Apple-notarized and has no trusted Developer ID certificate**. Do not describe it as an Apple-approved or notarized distribution. Distribution outside this local workflow requires the owner's signing identity and notarization setup. Windows/Linux applications and automatic updates are not included in this Mac build.

## Build and maintain the app

Contributor commands, run from the repository:

```sh
node node_modules/electron/install.js
node scripts/desktop/prepare-node.mjs
node scripts/desktop/icon.mjs
npm run build
node scripts/desktop/package.mjs
```

The installed development packages are pinned to Electron **45.4.1** and `@electron/packager` **20.3.0**. The native Node runtime is **26.5.0**, fetched from the official Node distribution and verified against its SHA-256 manifest. Its source/checksum receipt is retained next to the cached runtime. The app uses an explicit production dependency closure with relative links retained; it does not ship the development dependency tree or any workspace data.

The native icon and 192/512 px maskable web icons derive from the supplied NASA Earth photograph, without adding a NASA logo. The globe remains within the maskable safe area. The generated `.icns` and build intermediates remain under ignored `data/desktop`; web icons live under `public/brand`.

Packaging builds and verifies a canonical app in a temporary directory, creates an atomic ZIP, then copies the app to the local release folder. Only generated Finder display metadata may be removed during this process; quarantine and security provenance attributes are not cleared. The fixed download endpoint serves only the built public archive and rejects foreign origins and arbitrary file paths.

Outputs:

- `data/desktop/releases/Worldview-darwin-arm64/Worldview.app` on this arm64 Mac.
- `data/desktop/releases/Worldview-mac-arm64.zip` for the in-app download.
- `data/desktop/releases/worldview-desktop-build.json` recording runtime versions, dependency versions, and local signing status.

For a development native window, `node_modules/.bin/electron electron` opens the same folder picker. The optional `--workspace /absolute/path/to/data` and `--profile /absolute/path/to/test-profile` arguments support isolated acceptance without silently changing the user's saved world.

## Verification

The packaged app's **own bundled Node** has been exercised against an isolated workspace: SQLite health, cloud AI off, workspace identity, local assistant review, Google Drive's honest unconfigured status, and bundled HTML all returned successfully. The ZIP was inspected for the app executable, bundled Node, backend/preload/static entry points, and absence of private workspace paths. Native window launch and live UI acceptance remain separate checks; an HTTP smoke test does not prove that an app window was observed.

The [reuse policy test](../tests/desktop/policy.test.ts) covers workspace identity and refusal of active/unverified cloud providers. The [desktop download test](../tests/server/desktopConnection.test.ts) verifies same-origin access and fixed public file selection. The final [desktop acceptance record](evaluations/desktop-app-acceptance-2026-11-23.json) records Worldview 0.1.0, archive hashes, runtime versions, privacy/source parity, signatures, and the 14 read-only packaged-backend checks. Native-window observations remain separate and must be added only after the window is directly observed. Reproduce archive validation with `python3 scripts/desktop/verify-package.py`; this refreshes the archive-only record, so append backend/native observations afterward.

The native app was directly observed opening the existing SQLite workspace and rendering the bookshelf and 3D world. That observation keeps its original timestamp and prior archive hash in the acceptance record. A later package refresh includes the Google native-file import deduplication fix, with fresh source, signature, privacy, and isolated-backend verification; it does not claim a new native-window observation. The privacy scan checks configured Google client-secret/access/refresh values as well as environment secrets, recording only symbolic labels and counts.

Implementation: [native main process](../electron/main.cjs), [preload](../electron/preload.cjs), [backend launcher](../scripts/desktop/server.mjs), [runtime preparation](../scripts/desktop/prepare-node.mjs), [packaging](../scripts/desktop/package.mjs), and [desktop connection UI](../src/connections/DesktopConnection.tsx).

Official references: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security/), [context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation/), and [application packaging](https://www.electronjs.org/docs/latest/tutorial/application-distribution/).

The native launcher keeps its current service alive until a replacement is ready and native navigation succeeds. A service failure or unsaved-writing navigation cancellation restores the preceding workspace/context. Microphone checks and requests both enforce the local audio-only boundary; rejected OS prompts and workspace changes deny the pending request. See [launcher regressions](../tests/desktop/main.test.ts). The [static-server check](../tests/desktop/server.test.ts) verifies that canonical static paths and fallback HTML remain inside the bundled client directory; desktop downloads reject symbolic-link archives. Electron documents the paired permission handlers in its [session API](https://www.electronjs.org/docs/latest/api/session).
