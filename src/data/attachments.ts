import type { Attachment } from '../domain/types.ts'

// Attachment helpers for repo.addAttachment: content sniffing (the browser's File.type is
// derived from the extension and is empty for many text formats) and a small webp
// thumbnail so the Inspector never decodes a full-size photo just to list it.

export type AttachmentKind = Attachment['kind']

/** Hard cap per attachment. Browser storage is the only copy; huge blobs belong in a splat or an export. */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
/** Longest thumbnail edge in pixels. */
export const THUMB_MAX_PX = 256
export const THUMB_QUALITY = 0.8

const SNIFF_BYTES = 4096

const TEXT_EXTENSIONS: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  tex: 'text/x-tex',
  bib: 'text/x-bibtex',
  org: 'text/x-org',
  rst: 'text/x-rst',
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  heif: 'image/heif',
}

const TEXT_MIMES = new Set([
  'application/json',
  'application/x-ndjson',
  'application/yaml',
  'application/xml',
  'application/x-yaml',
])

function extensionOf(name: string | undefined): string {
  if (!name) return ''
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false
  return true
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0))

/** Image type from magic numbers, or null. */
export function sniffImageMime(head: Uint8Array): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return 'image/webp'
  if (startsWith(head, ascii('BM'))) return 'image/bmp'
  if (startsWith(head, ascii('ftyp'), 4)) {
    const brand = String.fromCharCode(...head.subarray(8, 12))
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1') return 'image/heic'
  }
  return null
}

/**
 * True when the sample decodes as UTF-8 (BOM allowed) with no NUL and few control bytes.
 * A truncated multi-byte sequence at the very end of the sample is tolerated.
 */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return true
  let control = 0
  for (const b of head) {
    if (b === 0) return false
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) control++
  }
  if (control / head.length > 0.02) return false
  // Trim a possibly split trailing code point before strict decoding.
  let end = head.length
  for (let k = 1; k <= 3 && end - k >= 0; k++) {
    const b = head[end - k]
    if ((b & 0xc0) === 0x80) continue
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    if (need > k) end -= k
    break
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, end))
    return true
  } catch {
    return false
  }
}

/**
 * Best mime for an attachment. Content wins over the declared type for images (a renamed
 * PNG is still a PNG); text formats fall back to the extension, then to a UTF-8 check.
 */
export function sniffMime(head: Uint8Array, name?: string, declared?: string): string {
  const image = sniffImageMime(head)
  if (image) return image
  const ext = extensionOf(name)
  const textHead = new TextDecoder().decode(head.subarray(0, 512)).trimStart().toLowerCase()
  if (ext === 'svg' || textHead.startsWith('<svg') || (textHead.startsWith('<?xml') && textHead.includes('<svg'))) {
    return 'image/svg+xml'
  }
  const declaredBase = (declared ?? '').split(';')[0].trim().toLowerCase()
  if (TEXT_EXTENSIONS[ext] && looksLikeText(head)) return TEXT_EXTENSIONS[ext]
  if ((declaredBase.startsWith('text/') || TEXT_MIMES.has(declaredBase)) && looksLikeText(head)) return declaredBase
  if (IMAGE_EXTENSIONS[ext] && declaredBase.startsWith('image/')) return declaredBase
  if (!declaredBase && looksLikeText(head)) return 'text/plain'
  if (declaredBase && !declaredBase.startsWith('text/') && !TEXT_MIMES.has(declaredBase)) return declaredBase
  return looksLikeText(head) ? 'text/plain' : 'application/octet-stream'
}

/** The attachment kind for a mime, or null when the app cannot store it as an attachment. */
export function attachmentKindOf(mime: string): AttachmentKind | null {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('text/') || TEXT_MIMES.has(mime)) return 'text'
  return null
}

export async function readHead(blob: Blob, n = SNIFF_BYTES): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(0, n).arrayBuffer())
}

export interface SniffResult {
  mime: string
  kind: AttachmentKind | null
}

export async function sniffBlob(blob: Blob, name?: string): Promise<SniffResult> {
  const mime = sniffMime(await readHead(blob), name, blob.type)
  return { mime, kind: attachmentKindOf(mime) }
}

/** Thumbnail size that fits within max×max, preserving aspect and never upscaling. */
export function thumbSize(width: number, height: number, max = THUMB_MAX_PX): [number, number] {
  if (!(width > 0) || !(height > 0)) return [0, 0]
  const scale = Math.min(1, max / Math.max(width, height))
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]
}

/** True when this runtime can rasterise thumbnails off the main thread. */
export function canMakeThumbnails(): boolean {
  return typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function'
}

/**
 * Downscaled webp (≤ THUMB_MAX_PX) via createImageBitmap + OffscreenCanvas. Returns null when
 * either API is missing, the image cannot be decoded (e.g. SVG or HEIC in some browsers), or
 * the encoder ignores the webp request: the attachment then simply has no thumbnail.
 */
export async function makeThumbnail(blob: Blob, max = THUMB_MAX_PX): Promise<Blob | null> {
  if (!canMakeThumbnails()) return null
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(blob)
    const [w, h] = thumbSize(bitmap.width, bitmap.height, max)
    if (w === 0 || h === 0) return null
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, w, h)
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: THUMB_QUALITY })
    return out.type === 'image/webp' ? out : null
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}

/** Display name with path separators and control characters removed. */
export function cleanFileName(name: string | undefined, fallback = 'attachment'): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200)
  return cleaned || fallback
}
