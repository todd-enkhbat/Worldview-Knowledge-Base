# Live local voice transcription

Worldview now uses one pinned Whisper base model for browser WASM and the local service. The installed assets are `onnx-community/whisper-base` at revision `27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c`, q8 weights, Apache-2.0, 79,664,191 bytes. The [official model](https://huggingface.co/onnx-community/whisper-base) and [Transformers.js ASR API](https://huggingface.co/docs/transformers.js/en/api/pipelines#automaticspeechrecognitionpipeline) describe the source runtime. No audio is sent to a transcription provider.

Install or verify model assets explicitly:

```sh
node scripts/setup-whisper.ts
```

The installer verifies the pinned upstream revision/license, file sizes and upstream LFS SHA-256 hashes, then writes a local manifest under ignored `data/models/onnx-community/whisper-base/`. An interrupted download never publishes the ready manifest. `WORLDVIEW_MODELS_DIR` selects an alternate model root; the installer accepts `--directory` for the same root. Model identity and source metadata are retained with the local installation.

The local service also needs FFmpeg. Existing installations at `/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg`, or on PATH are detected; `WORLDVIEW_FFMPEG_PATH` can select one. No global package installation is performed. Server inference accepts audio/video up to 128 MiB and 30 minutes, with bounded decoding, a cancellable native CPU worker, and serialized model requests. Aborting work terminates its worker; retry loads a fresh one. Originals are retained by the calling capture connector before this service runs.

The browser checks the local model status on **Transcribe locally**. A matching installation supplies only the fixed public model allowlist through revision-qualified URLs, so model versions cannot share stale cache entries. Browser inference uses local WASM/q8 and retains audio on the device. Static deployments without the local service retain the pinned official model-download path. The 3D renderer and physics are unchanged.

## Measured live test

Synthetic macOS Samantha speech says:

> Project Aurora decided to launch on December twelve. The copper orchard budget is three hundred twelve dollars. This is synthetic speech for an integration test.

Generate it on macOS, then run the live local suite:

```sh
node scripts/create-voice-fixture.ts
WORLDVIEW_LIVE_ASR=1 npx vitest run tests/live/voiceInference.test.ts tests/server/localTranscription.test.ts tests/server/whisperModels.test.ts
```

Speech synthesis may require running outside the command sandbox; it does not request a microphone. No real person's recording or private corpus is used. The opt-in test exercises real FFmpeg and Whisper inference through original capture, SQLite HTTP persistence, timed passage publication, exact source offsets, source-role/date filtering, restart and duplicate prevention. Cancellation/retry and local asset GET/HEAD/Range boundaries are also exercised with the real model.

The measured ten-second PCM WAV returned two real chunks, about 0–7.16 and 7.16–9.96 seconds. Critical dates and amounts were recognized as **December 12** and **$312**. The recognizer wrote **copper-orchored** for **copper orchard**; the retained transcript preserves that actual output rather than silently correcting evidence. This one synthetic speaker is a regression fixture, not a general transcription-quality benchmark.

Reports: [WAV original→citations→restart](evaluations/live-voice-2026-11-23.json), [Telegram-style OGG/Opus inference](evaluations/live-voice-ogg-2026-11-23.json). The [browser UI verification](evaluations/browser-voice-2026-11-23.json) passed through file upload, original retention (SHA-256 match), real WASM transcription, Library, passage search and a later timed citation. The original audio loaded at the cited 7.2-second position with media ready state 4; [screenshot](design/live-voice-citation-2026-11-23.png). Browser and native inference can produce slightly different chunk boundaries; each citation retains its actual run’s metadata.

Connector voice entries may retain a distinct `externalId`, such as a Telegram message identity. Browser retries use that identity and preserve original connector provenance; they do not merge independent messages solely because audio bytes match.
