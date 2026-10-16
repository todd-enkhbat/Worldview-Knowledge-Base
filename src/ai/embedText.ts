import { fnv1a32 } from '../domain/placement.ts'
import type { NodeRecord } from '../domain/types.ts'

// Pure helpers for the semantic index (no DOM, no workers: tested in node).

export const EMBED_MODEL = 'onnx-community/embeddinggemma-2-ONNX'
/** Matryoshka truncation of the native 768 (PLAN: float[512]). */
export const EMBED_DIM = 512
/** Bump to re-embed everything (prompt format or model change). */
export const EMBED_VERSION = `${EMBED_MODEL}@${EMBED_DIM}/v1`
const MAX_CHARS = 2000

/** EmbeddingGemma's document format ("title: … | text: …"). */
export function nodeText(r: Pick<NodeRecord, 'title' | 'tags' | 'contentMd' | 'archetype'>): string {
  const body = [r.tags.length ? `tags: ${r.tags.join(', ')}` : '', r.contentMd.trim()].filter(Boolean).join('\n')
  const text = `title: ${r.title.trim() || 'none'} | text: ${r.archetype}${body ? `. ${body}` : ''}`
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text
}

/** EmbeddingGemma's retrieval-query format. */
export function queryText(q: string): string {
  return `task: search result | query: ${q.trim().slice(0, MAX_CHARS)}`
}

/**
 * Identifies the exact text, model and runtime config (e.g. 'webgpu/q4') an embedding came
 * from (cheap, not cryptographic). A different config re-embeds rather than mixing vectors.
 */
export function textHash(text: string, config: string): string {
  return `${EMBED_VERSION}/${config}:${text.length}:${(fnv1a32(text) >>> 0).toString(16)}`
}

/** First `dim` components, re-normalised to unit length (a fresh, owned array). */
export function truncateNormalize(v: ArrayLike<number>, dim: number): Float32Array {
  const out = new Float32Array(dim)
  let s = 0
  for (let i = 0; i < dim; i++) {
    out[i] = v[i]
    s += v[i] * v[i]
  }
  const k = s > 0 ? 1 / Math.sqrt(s) : 0
  for (let i = 0; i < dim; i++) out[i] *= k
  return out
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Brute-force k nearest by cosine (unit vectors); distance = 1 − similarity, like vec0. */
export function bruteKnn(query: Float32Array, all: ReadonlyMap<string, Float32Array>, k: number, exclude?: ReadonlySet<string>): { id: string; distance: number }[] {
  const scored: { id: string; distance: number }[] = []
  for (const [id, v] of all) if (!exclude?.has(id)) scored.push({ id, distance: 1 - dot(query, v) })
  scored.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1))
  return scored.slice(0, k)
}

export function toBase64(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): Float32Array {
  const s = atob(b64)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}
