# Cloud AI setup and live verification

Cloud AI is off by default. The app supports the direct OpenAI Responses API and the existing Anthropic provider when explicitly enabled. The default OpenAI model is `gpt-6.2-sol`; the server uses `openai@7.62.0`. The 3D world, pins, timeline and local corpus do not depend on cloud AI being configured.

## Configure OpenAI

1. If `.env.local` does not exist, copy `.env.example` to it. If it already exists, add only the relevant variables while retaining existing credentials and Telegram settings.
2. Set `AI_PROVIDER=openai`, `OPENAI_API_KEY` and, optionally, `OPENAI_CHAT_MODEL` / `OPENAI_REFINE_MODEL`.
3. Restart `npm run dev` or the preview server after changing credentials. The standalone `server/main.ts` process uses its process environment, so launch it with the same private environment configured.
4. In Sources, check the AI connection. `GET /api/ai/status` reports configuration without contacting the provider. `POST /api/ai/status` checks model access through the provider's model-retrieval endpoint, without generating text. A successful connection check does **not** verify remaining API credit or prove that generation will succeed.

Keys remain on the server and must never use a `VITE_` prefix. Explicit `AI_PROVIDER` selects that provider; with no explicit provider, cloud AI remains off even if keys are present. `AI_PROVIDER=none` disables cloud generation and provider connection probes. Local capture, source search and retained originals remain available. An explicit OpenAI selection with a missing or rejected key does not silently send the request to Anthropic.

Create a key in the [OpenAI API dashboard](https://platform.openai.com/api-keys). Check the correct organization's [billing overview](https://platform.openai.com/settings/organization/billing/overview) and [limits](https://platform.openai.com/settings/organization/limits). API requests need API credit and model access. A zero credit balance, a project or organization spending limit, or an approved usage limit requires an account/billing change; waiting and retrying does not restore access. The provider bridge reports these separately from temporary rate limits and disables automatic OpenAI SDK retries.

## Implemented behavior

- Chat streams Responses API text through the existing app protocol. Browser tools retain their existing validation and permission rules.
- Tool rounds preserve the complete provider output, including encrypted reasoning continuity and function-call IDs, in opaque provider state. Raw reasoning is not displayed. Requests use `store:false`, with no dependency on a previous server-stored response ID.
- Existing text, image, PDF and tool-result messages are translated to Responses input. Unsupported attachments produce a clear error while retaining the original locally.
- Refinement uses a strict JSON schema, validates the result with the existing Zod schema, and permits links only to supplied candidates. Dates and timeline history do not move spatial anchors.
- Provider errors are normalized without exposing keys, raw request URLs or raw provider payloads. Usage separates uncached input, cached reads, cached writes and output tokens.
- Switching to Anthropic removes OpenAI's opaque provider state from replayed messages. A refused response never executes accompanying tool calls; the local transcript is retained and the next provider turn starts fresh context.

## Verification record — 2026-11-23

The implementation tests exercise a two-turn tool round trip, encrypted reasoning replay, message metadata, image/PDF conversion, missing tool references, truncation, refusals, strict refinement, provider selection, connection probing and credential/billing error redaction with injected SDK clients. These are deterministic integration tests, not proof of a successful live generation.

The existing Anthropic credential was rejected with HTTP 401 during the live setup session. No real OpenAI generation or refinement request was performed while the new OpenAI key and usable API credit were pending. The supplied billing screenshot showed zero credits. The remaining cloud acceptance step is to configure an authorized key with available credit, check model access, then complete the live checks below if cloud AI is deliberately enabled later. The current user preference is to keep cloud AI off; no acceptance step below should run until that changes. Local speech has separate real-model evidence in [LIVE-VOICE.md](./LIVE-VOICE.md).

## Live acceptance after credit is available

1. Run the connection check and confirm the expected provider/model, then request a short answer in chat and verify streaming, completion and usage.
2. Ask a source-grounded question that invokes search/read tools; confirm the final answer cites the expected retained source and that a follow-up question continues the tool conversation successfully.
3. Refine a disposable record, verify the preview and candidate links, and apply it only if desired. Check that its 3D position/pin does not move when changing a date.
4. Exercise cancellation and an invalid key in an isolated configuration; confirm a sanitized error and retained local data. Restore the intended configuration afterward.

Official API references: [Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses), [function calling](https://developers.openai.com/api/docs/guides/function-calling), [reasoning continuity](https://developers.openai.com/api/docs/guides/reasoning), and [model capabilities](https://developers.openai.com/api/docs/models/gpt-6.2-sol).
