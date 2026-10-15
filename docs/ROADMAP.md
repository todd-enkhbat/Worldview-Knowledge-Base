# Roadmap (after the Phase 3 review — not built yet)

- **Engine**: `node:sqlite` on Node 26 with sqlite-vec 0.1.9 (`vec0 float[512] cosine`), behind a WorldStore HTTP adapter and a Vite proxy. The existing store migrates through the export zip. Target DDL: `src/domain/schema.sql`.
- **Embeddings**: EmbeddingGemma 2 q4 in a worker via transformers.js 4.3.1, using the text-only AutoModel path and local wasm paths.
- **Omnibox**:
  1. Optimistic provisional spawn in < 1500 ms.
  2. Refinement with `claude-haiku-5-5`: `messages.create` with an `output_config.format` json_schema, effort low and thinking disabled, then a manual `safeParse` with a fallback on refusal. The key stays server-side.
- **Layout**: anchored incremental UMAP with Kabsch-aligned "re-crystallise" events (replaces tag-hash sector placement).
- **Capture**: ffmpeg → COLMAP 4.2.1 (CPU) + orientation aligner → msplat 1.1.4 (`--input/--output/--num-iters`; Brush as fallback) → splat-transform `--spz-version 3`. Scaniverse is the pragmatic path.
- **Desktop**: requires Rust ≥ 1.90. Run a Tauri 2.12 vs Electron 44 spike first: WKWebView 60 Hz cap, no cross-origin isolation under `tauri://`, asset-protocol ranges capped at 1000 KiB. The app is already free of SharedArrayBuffer. Optional WGSL backend.
- **Publish**: Cloudflare Workers Static Assets + R2 (Range Worker; 25 MiB per-asset cap) + Access. Export strips private nodes, edges and embeddings; CI runs canary greps.
