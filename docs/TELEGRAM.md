# Telegram capture setup

Telegram intake is implemented in the existing local app service. It uses outbound HTTPS long polling, so it needs no public webhook or tunnel. A bot token and an explicit sender/chat allowlist are still required before it can receive real messages.

1. Create a dedicated bot with [BotFather](https://t.me/BotFather). Keep its token private.
2. Set `TELEGRAM_BOT_TOKEN` in `.env.local`, then restart the local app service. Alternatively, enter the token in **Sources & activity → Telegram inbox**. Service configuration is private and excluded from portable backups. Never put a bot token in a `VITE_` variable or in chat.
3. Send `/start` to your bot in Telegram. Choose **Test bot connection**, then **Find my sender/chat IDs**. Discovery shows numeric sender/chat pairs; it does not import message content or acknowledge pending messages.
4. Select your own pair, or enter `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_ALLOWED_CHAT_IDS` in the local environment. Both allowlists are required. A group chat is allowed only when explicitly selected alongside authorized sender IDs.
5. Choose an optional saved investigation, speaker attribution, speech language, and local automatic transcription. Forwarded material remains third-party even when you declare your own original messages human-authored. Speech event time remains unknown; Telegram send/capture dates are separate provenance.
6. Save the connection and choose **Start capture**. Optional reply receipts send only a short static acknowledgement into an allowed chat; they are off by default.

The connector preserves an existing webhook and refuses to start when that bot is already used through one. It does not delete a webhook, change bot privacy settings, or send to unallowlisted recipients. Use a dedicated bot to avoid competing pollers.

## What is retained

Each allowed update first gets a byte-retained JSON original and durable import receipt. Text and captions become attributed source versions with exact passage offsets. Media downloads retain their bytes and hash before local decoding/inference. Audio/video is also placed in the shared voice inbox. The standard Bot API download limit is 20 MB; this connector bounds its download stream to 20 MiB and retains a visible failed receipt when Telegram cannot provide an original.

Automatic voice transcription uses the pinned local Whisper model and ffmpeg, including when the browser is closed. The model is installed through the app's explicit speech-model setup; it does not send audio to an AI provider. Originals survive decoding/model errors. Failed captures can be retried from the Telegram inbox or shared voice inbox. An investigation association commits with source/receipt publication. Captured Telegram sources do not create or move 3D records.

Offsets advance only after an outcome is durable. Repeated updates do not duplicate sources or citations; edited messages create retained versions. Credentials and polling offsets remain private service state. Changing the active world, disabling capture, revoking source/voice AI access, or changing its configured investigation prevents a pending transcript from publishing.

One service instance holds the polling lease. A server transcription advertises a 90-second renewable processing lease; an expired lease becomes retryable instead of staying busy forever. Independent manual/Telegram captures can share original bytes while retaining separate provenance.

## Verification and current live boundary

The connector's deterministic tests cover allowlists, original-first publication, forwards, edits, duplicate updates, project association, download failure/retry, source revocation, same-store restore, token redaction and competing pollers. Route tests cover account isolation, origin/client-header/loopback protection, AI status/probe routing, QMD controls and pinned public model assets.

`node scripts/verify-telegram-voice.ts` runs a synthetic Telegram transport through **real local OGG decoding and Whisper inference**. The retained original, two timed exact passages, Aurora/December 12/$312 content checks and unchanged pinned world record all passed. Its report explicitly distinguishes simulated Telegram transport from real speech inference: [telegram-local-voice-2026-11-23.json](evaluations/telegram-local-voice-2026-11-23.json).

`node scripts/verify-browser-memory.ts` verifies the actual browser-produced synthetic voice through the running isolated QA service using the official MCP client. It searches and reads two exact timed passages, verifies their source/version identities and final context delivery, revokes the test client, and confirms 401 afterward. No token appears in [browser-memory-2026-11-23.json](evaluations/browser-memory-2026-11-23.json). This script requires the intentionally isolated single-source QA world; it refuses unexpected workspace contents.

No real Telegram bot token was present during this setup. Real Bot API authentication, allowed-chat delivery and a real Telegram voice message remain unverified until the owner supplies a token and sender/chat pair. The app does not claim to be connected merely because the connector code and local speech path pass.

Official protocol references: [Bot API getUpdates](https://core.telegram.org/bots/api#getupdates), [getFile](https://core.telegram.org/bots/api#getfile), [webhook status](https://core.telegram.org/bots/api#getwebhookinfo).
