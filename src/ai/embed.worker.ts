/// <reference lib="webworker" />
import { env, pipeline, type FeatureExtractionPipeline, type ProgressInfo } from '@huggingface/transformers'
import { EMBED_DIM, EMBED_MODEL, truncateNormalize } from './embedText.ts'

// EmbeddingGemma 2 in a module worker: the model downloads from Hugging Face on first use
// and the browser caches it (Cache Storage). q4 (~175 MB) needs onnxruntime's WebGPU backend
// (its GatherBlockQuantized op has no WASM kernel), so: WebGPU + q4 where the worker has
// WebGPU, else WASM + the 8-bit model (~315 MB). The 'ready' message names the config, and
// embeddings are tagged with it, so vectors from the two never mix. Outputs are truncated to
// 512 dimensions (Matryoshka) and re-normalised: a dot product is the cosine similarity.

declare const self: DedicatedWorkerGlobalScope

export type EmbedRequest = { id: number; texts: string[] }
export type EmbedReply =
  | { type: 'result'; id: number; vectors: Float32Array[] }
  | { type: 'error'; id: number; error: string }
  | { type: 'progress'; loaded: number; total: number; file: string }
  | { type: 'ready'; config: string }

env.allowLocalModels = false

let extractor: Promise<FeatureExtractionPipeline> | null = null
const files = new Map<string, { loaded: number; total: number }>()

type Config = { device: 'webgpu' | 'wasm'; dtype: 'q4' | 'q8' }

function configs(): Config[] {
  const gpu = (self.navigator as Navigator & { gpu?: unknown }).gpu
  return gpu ? [{ device: 'webgpu', dtype: 'q4' }, { device: 'wasm', dtype: 'q8' }] : [{ device: 'wasm', dtype: 'q8' }]
}

function progress(p: ProgressInfo): void {
  if (p.status !== 'progress') return
  files.set(p.file, { loaded: p.loaded, total: p.total })
  let loaded = 0
  let total = 0
  for (const f of files.values()) {
    loaded += f.loaded
    total += f.total
  }
  self.postMessage({ type: 'progress', loaded, total, file: p.file } satisfies EmbedReply)
}

async function open(): Promise<FeatureExtractionPipeline> {
  let last: unknown = null
  for (const c of configs()) {
    try {
      files.clear()
      const fx = await pipeline('feature-extraction', EMBED_MODEL, { device: c.device, dtype: c.dtype, progress_callback: progress })
      // A session can open and still fail on its first run (missing kernels): probe it.
      await fx(['title: none | text: probe'], { pooling: 'mean', normalize: true })
      self.postMessage({ type: 'ready', config: `${c.device}/${c.dtype}` } satisfies EmbedReply)
      return fx
    } catch (e) {
      last = e
      console.warn(`[embed] ${c.device}/${c.dtype} unavailable`, e)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

function load(): Promise<FeatureExtractionPipeline> {
  extractor ??= open()
  extractor.catch(() => {
    extractor = null // let a later request retry (e.g. after going back online)
  })
  return extractor
}

self.onmessage = async (e: MessageEvent<EmbedRequest>) => {
  const { id, texts } = e.data
  try {
    const fx = await load()
    const out = await fx(texts, { pooling: 'mean', normalize: true })
    const [n, dim] = out.dims as [number, number]
    const data = out.data as Float32Array
    const vectors: Float32Array[] = []
    for (let i = 0; i < n; i++) vectors.push(truncateNormalize(data.subarray(i * dim, (i + 1) * dim), EMBED_DIM))
    self.postMessage({ type: 'result', id, vectors } satisfies EmbedReply, vectors.map((v) => v.buffer))
  } catch (err) {
    self.postMessage({ type: 'error', id, error: err instanceof Error ? err.message : String(err) } satisfies EmbedReply)
  }
}
