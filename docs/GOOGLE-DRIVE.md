# Google Drive connection

Worldview has an explicit selected-files bridge to Google Drive. Open **Sources → Google Drive** in the local app to configure it, authorize an account, retain selected originals, or send a saved writing document to Google. This does not enable cloud AI. A ChatGPT or Codex Google connection is separate: its credentials are never copied into this app.

## Configure the app

1. Open [Google's personal setup](https://console.cloud.google.com/auth/overview/personal) with the Google account whose files you want to use. Choose a new personal project and **Desktop app**. Leave the AI-agent option off. Review Google's terms yourself, continue, then **Download JSON** while the new-client dialog is open.
2. In that same project, open **APIs & Services → Library**, find **Google Drive API**, and select **Enable**. Do the same for **Google Picker API**.
3. Return to Worldview, choose that downloaded JSON in the connection form, and select **Save Google client**. It stays in the local service. No API key or project number is required for this Desktop flow.
4. Select **Connect Google Drive**, then **Continue to Google**. In your browser, authorize the app and pick a file. After returning, Worldview reads its metadata for review. Select **Keep a local copy** only when you want to import it. **Choose in Google** opens the same flow when you want another file.

Personal mode works only with the Google account that creates it and cannot later become a shared app. Use a dedicated personal project. If you already have an External or Internal project, keep it separate or use the standard setup below. Google's terms, login, and account authorization require your own action; Worldview cannot create credentials before those steps are complete. See [Google's current personal setup guide](https://support.google.com/cloud/answer/15544987?hl=en).

The service requests only `https://www.googleapis.com/auth/drive.file`. This grants access to files you explicitly choose and files the app creates. File search lists only authorized files; it does not discover or scan your whole Drive. The Desktop picker runs on Google's browser page using `trigger_onepick=true`. Its return must match a live PKCE/state request and contain exactly one valid file ID. Selection expires after ten minutes or a workspace replacement, and never imports anything automatically. Browser selection works independently of the main app's COEP policy and never gives an access token to the app's JavaScript UI.

### Standard setup and web fallback

If personal onboarding is unavailable, create a project and open **Google Auth platform → Branding → Get Started**. Use **Worldview** as the app name and your email for support and contact. Choose **External** for a personal Gmail account, then add your email in **Audience → Test users**; **Internal** is only for a suitable Google Workspace organization. Review Google's policy yourself. In **Clients → Create Client**, choose **Desktop app**, name it, create it, and download JSON. Enable Drive and Picker as above. The [standard consent guide](https://developers.google.com/workspace/guides/configure-oauth-consent) and [Desktop client guide](https://developers.google.com/workspace/drive/api/quickstart/nodejs) show these console paths. External testing authorization can expire after seven days; [Personal mode avoids that testing limit](https://support.google.com/cloud/answer/15549945?hl=en).

An explicitly configured **web** OAuth client retains the embedded JavaScript Picker fallback. In advanced setup, enter a Google Picker API key and the project's numeric project number. Restrict the key to Google Picker API; website restrictions must include your local origin and `https://docs.google.com/*`, as required by [Google's web Picker guide](https://developers.google.com/workspace/drive/picker/guides/web-picker). This fallback receives a short-lived selected-file token only when explicitly opened. It rejects isolated windows before requesting that token: Google's embedded Picker does not opt into `Cross-Origin-Embedder-Policy: require-corp`. Use the Desktop browser flow for isolated app windows. The web API loader uses anonymous CORS and a bounded timeout with retry. Public Google headers were inspected on 2026-11-23; authorized Picker behavior still requires a live account test.

Desktop OAuth uses a loopback callback, PKCE S256, and a single-use ten-minute state value. For a web OAuth client, register the exact callback shown by the service, such as `http://127.0.0.1:5173/api/connections/drive/callback`, in its authorized redirect URIs. The origin and port must match the running local service. Desktop clients opened at `localhost` use `127.0.0.1` for Google's callback and return to the original app origin.

Configuration can instead come from server-only environment variables in the gitignored `.env.local`, followed by a service restart:

```dotenv
GOOGLE_DRIVE_CLIENT_ID=your-desktop-client.apps.googleusercontent.com
GOOGLE_DRIVE_CLIENT_SECRET=your-desktop-client-secret
# Only for the advanced embedded web Picker:
GOOGLE_PICKER_API_KEY=your-restricted-picker-key
GOOGLE_DRIVE_APP_ID=your-numeric-project-number
```

Environment client configuration is treated as a Desktop OAuth client. Use the UI JSON form for a web client with registered redirect URIs. Never use a `VITE_` prefix or paste tokens into a document or chat.

### Cost

Google documents standard Drive API use as available at no additional cost. Normal personal transfers use that standard tier; this setup does not require starting a trial or increasing quota. Google has announced charges for usage above standard thresholds and billing-enabled quota increases, so this is not an unlimited-free promise. Existing Drive storage limits still apply. See [current Drive pricing and quotas](https://developers.google.com/workspace/drive/api/guides/limits) and [Google's 2026 usage changes](https://developers.google.com/workspace/tools-safety).

## Keep originals locally

Choose a file, review its name and Google revision, and select **Keep a local copy**. The service downloads the selected file, reads its metadata again, and rejects a revision that changed during transfer. It writes the original bytes before attempting local text extraction. Importing never overwrites an earlier retained version.

Google documents are exported as DOCX, with text extracted locally from the retained file. Google Sheets and Slides can be retained as PDF exports. Stored files such as PDFs, images, Office documents, and text files retain their original bytes. Other native Google formats require a supported PDF export; unsupported exports report Google's error without inventing a local copy. Native exports use Google's 10 MB export limit; stored-file transfers are bounded to 20 MiB. Local PDF extraction requires the app's installed PDF tooling. Files without supported text extraction remain available as retained originals, with their actual extraction status shown.

Each source version records the Google file ID, Google revision, observed Google link, retained format, and extraction status. An unchanged native Google revision reuses its local version only after complete extraction, retained original bytes and asset metadata pass validation, followed by another remote and local revision check. This avoids duplicate versions from changing export ZIP timestamps. Missing, corrupt or purged originals and failed extraction trigger a fresh transfer instead. Stored files with the same revision and exact bytes also reuse their existing version. A later revision becomes another immutable version of the same source. Excluded or deleted local sources must be restored before importing another version. These imports add no objects or coordinates to the 3D world.

## Send writing back

Choose a saved writing document, then **Create a new Google copy**. The default creates a native Google document from the app's self-contained HTML export. Turn the native-document option off to create a formatted HTML file instead. Transfers are bounded to 5 MiB of HTML, including embedded media. Google conversion can change page design and unsupported media; the original designed writing stays in Worldview.

To replace an existing file, select it explicitly in the Google file list or picker, choose the saved local writing, and check the confirmation naming that target and revision. The update replaces the file's **entire contents**. It is available only for editable Google documents or HTML files with both a current revision and a strong ETag. Selection creates a short-lived server ticket; the service re-reads the target and sends `If-Match` on the upload. A changed target or local writing revision stops the update. The app does not automatically retry a rejected replacement. If Google provides no usable ETag, create a new copy instead.

After either transfer, the service re-reads the resulting file's metadata before showing its observed Google link. This is a manual import/export bridge, not two-way background synchronization. Editing a local retained copy does not silently modify Google, and changes in Google appear locally only after another explicit import.

## Local credentials and recovery

OAuth client configuration and tokens live in `<world-data-directory>/connections/google-drive.private.json`, written atomically with mode `0600`. They are outside world KV, the asset table, and portable workspace backups. Do not share this private file. A portable backup retains imported source originals and local writing, but restoring on another device requires configuring and connecting Google there.

Disconnect removes this app's locally stored tokens and pending selection tickets; retained source copies remain. To revoke Google's account grant as well, remove the app in your Google account's third-party access settings. Local credentials are separate from the portable world and survive a workspace data reset until explicitly disconnected or reconfigured.

Management endpoints require the local loopback service, its same-origin checks, and the app client header. The OAuth callback additionally requires its live single-use state. In-flight imports and exports check the connection epoch, the workspace replacement generation, and local revision guards. A restore invalidates an earlier operation even if the restored backup repeats the same portable revision number.

## Verification and current setup

Thirty-eight focused tests cover OAuth state/PKCE/scope checks, Desktop browser selection without a key, malformed/replayed/cancelled selections, web fallback configuration, private credential storage, byte-exact retained originals, Google Docs text extraction, unchanged native revision reuse and original recovery, changing remote revisions, explicit guarded replacements, local revision and size checks, post-transfer metadata verification, HTTP origin checks, workspace replacement during transfer, isolated-window web Picker rejection, loader timeout/retry, out-of-order connection status, cancellation recovery, and the actual connection UI's setup and writing flows. These automated tests use a real local database and controlled Google responses; the live account checks below were performed separately.

The Desktop client is configured and the account is connected after the user's explicit approval of selected-file access. Drive API and Picker API were enabled through Dia. Local credentials have mode `0600`, and a refresh token is available; no credential values are included in this documentation or portable backups. Cloud AI remains off.

A clearly labeled synthetic test draft was saved through the Writing studio and exported as a new Google document. Its headings, bold, italic, and list formatting were verified in Google Docs through Dia. The same document was selected with Google's Desktop picker and imported into the local Library: its original DOCX, readable text, and exact test marker were verified. The test leaves a labeled draft, Library source, and Google document available for inspection. All original 15 world notes, four links, 25 asset rows and blob files, and three existing writing documents remained unchanged. Replacement correctly remained unavailable because Google supplied no strong ETag; no existing Google document was replaced.

Live repeat import verified the native revision reuse correction: the app displayed “This exact Google version is already kept locally” and added no further version. Earlier pre-fix exports remain preserved in history; a later revision from Google was retained as a new version. This is an explicit manual import/export bridge, with no background synchronization.

Implementation: [local service](../server/connections/googleDrive.ts), [connection UI](../src/connections/GoogleDriveConnection.tsx), [server regressions](../tests/server/googleDrive.test.ts), and [UI regressions](../tests/workspace/googleDrive.test.tsx).

Primary references: [OAuth for native apps](https://developers.google.com/identity/protocols/oauth2/native-app), [Desktop browser Picker](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker), [Drive file scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Drive download and export limits](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [uploads and native-document conversion](https://developers.google.com/workspace/drive/api/guides/manage-uploads), and [cross-origin isolation and popup limitations](https://github.com/GoogleChrome/web.dev/blob/main/src/site/content/en/secure/cross-origin-isolation-guide/index.md).
