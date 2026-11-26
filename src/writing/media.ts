import { cleanFileName, MAX_ATTACHMENT_BYTES, readHead, sniffBlob, sniffImageMime } from '../data/attachments.ts'
import { getStore, getWorldGeneration, isRepoReady, retainWorldBlob } from '../data/repo.ts'
import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import type { WorldStore } from '../data/WorldStore.ts'

export interface WritingMediaAttributes { assetId: string; kind: 'image' | 'video' | 'audio'; name: string; mime: string; alt: string; caption: string; width: 'normal' | 'wide' | 'full'; displayWidth?: number }
export interface WritingMediaScope { store?: WorldStore; generation?: number }
export const WRITING_ASSET_ID = /^writing-[a-f0-9]{64}$/
const images = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
const ascii = (bytes: Uint8Array, start = 0, end = bytes.length) => String.fromCharCode(...bytes.subarray(start, end))
const starts = (bytes: Uint8Array, signature: readonly number[]) => signature.every((value, index) => bytes[index] === value)
function activeScope(input: WritingMediaScope = {}) {
  const store = input.store ?? getStore(), generation = input.generation ?? getWorldGeneration()
  const check = () => { if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) throw new Error('The workspace changed before the original media could be saved or opened.') }
  check()
  return { store, generation, check }
}
export async function writingMediaHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()))
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** Magic bytes constrain inline rendering; a filename or declared MIME cannot turn HTML into media. */
export async function sniffWritingMedia(blob: Blob, name?: string): Promise<{ kind: WritingMediaAttributes['kind']; mime: string }> {
  if (!blob.size || blob.size > MAX_ATTACHMENT_BYTES) throw new Error('Writing media must be between 1 byte and 256 MiB.')
  const [sniffed, head] = await Promise.all([sniffBlob(blob, name), readHead(blob)])
  const image = sniffImageMime(head)
  if (image && images.has(image)) return { kind: 'image', mime: image }
  if (sniffed.mime === 'image/svg+xml' || image) throw new Error('Use a PNG, JPEG, WebP, GIF or AVIF image. SVG and active documents are not inline writing media.')
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav' }
  if (ascii(head, 0, 4) === 'fLaC') return { kind: 'audio', mime: 'audio/flac' }
  if (ascii(head, 0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg' }
  if (ascii(head, 0, 3) === 'ID3' || head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0 && ![0xf1, 0xf9].includes(head[1])) return { kind: 'audio', mime: 'audio/mpeg' }
  if (head[0] === 0xff && [0xf1, 0xf9].includes(head[1])) return { kind: 'audio', mime: 'audio/aac' }
  if (starts(head, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: sniffed.mime === 'audio/webm' ? 'audio' : 'video', mime: sniffed.mime === 'audio/webm' ? 'audio/webm' : 'video/webm' }
  if (ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12)
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime' }
    if (['M4A ', 'M4B ', 'M4P '].includes(brand) || sniffed.mime === 'audio/mp4') return { kind: 'audio', mime: 'audio/mp4' }
    if (/^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |dash|MSNV|3g[pe][0-9])$/.test(brand)) return { kind: 'video', mime: 'video/mp4' }
  }
  throw new Error('Choose a supported image, MP4/WebM/QuickTime video, or MP3/WAV/OGG/FLAC/AAC audio original. HTML and SVG cannot be embedded.')
}

export async function uploadWritingMedia(files: readonly File[], options: WritingMediaScope = {}): Promise<WritingMediaAttributes[]> {
  if (!files.length) return []
  if (files.length > 32) throw new Error('Add up to 32 media files at a time.')
  const scope = activeScope(options)
  // Validate the whole batch before retaining anything. Document insertion belongs to the editor.
  const inspected = await Promise.all(files.map(async (file) => ({ file, ...(await sniffWritingMedia(file, file.name)) })))
  scope.check()
  const results: WritingMediaAttributes[] = []
  for (const item of inspected) {
    const bytes = new Uint8Array(await item.file.arrayBuffer()), assetId = `writing-${await writingMediaHash(bytes)}`
    scope.check()
    await retainWorldBlob({ meta: { id: assetId, kind: item.kind === 'image' ? 'image' : 'file', mime: item.mime, bytes: bytes.byteLength, createdAt: Date.now(), nodeId: null }, data: bytes }, { store: scope.store, generation: scope.generation })
    scope.check()
    results.push({ assetId, kind: item.kind, mime: item.mime, name: cleanFileName(item.file.name, 'Writing media'), alt: '', caption: '', width: 'normal' })
  }
  return results
}
/** Track the insertion point while the original bytes are retained locally. */
export async function insertWritingMedia(files: File[], editor: Editor, options: WritingMediaScope = {}) {
  const scope = activeScope(options)
  let bookmark = editor.state.selection.getBookmark()
  const map = ({ transaction }: { transaction: Transaction }) => { bookmark = bookmark.map(transaction.mapping) }
  editor.on('transaction', map)
  try {
    const media = await uploadWritingMedia(files, scope)
    scope.check()
    if (editor.isDestroyed || !editor.isEditable) throw new Error('Reopen this document before inserting more media.')
    const position = bookmark.resolve(editor.state.doc).to
    editor.chain().focus().insertContentAt(position, media.map(attrs => ({ type: 'writingMedia', attrs }))).run()
  } finally { editor.off('transaction', map) }
}
export async function uploadWritingBackground(file: File, options: WritingMediaScope = {}): Promise<string> {
  const scope = activeScope(options)
  if ((await sniffWritingMedia(file, file.name)).kind !== 'image') throw new Error('Choose a PNG, JPEG, WebP, GIF or AVIF background image.')
  scope.check()
  return (await uploadWritingMedia([file], { store: scope.store, generation: scope.generation }))[0].assetId
}

/** Both preview and export verify a local immutable original; arbitrary URLs never reach media tags. */
export async function readWritingMedia(assetId: string, options: WritingMediaScope = {}): Promise<{ blob: Blob; bytes: Uint8Array; mime: string; kind: WritingMediaAttributes['kind'] }> {
  if (!WRITING_ASSET_ID.test(assetId)) throw new Error('This writing block has an invalid local original reference.')
  const scope = activeScope(options), [blob, meta] = await Promise.all([scope.store.getBlob(assetId), scope.store.getAssetMeta(assetId)])
  scope.check()
  if (!blob || !meta || blob.size !== meta.bytes) throw new Error('A writing original is missing or incomplete. Restore its verified backup before opening or exporting it.')
  const safe = await sniffWritingMedia(blob), bytes = new Uint8Array(await blob.arrayBuffer())
  scope.check()
  if (safe.mime !== meta.mime || `writing-${await writingMediaHash(bytes)}` !== assetId) throw new Error('A writing original failed its content check. The media was not opened or exported.')
  scope.check()
  return { blob: blob.type === safe.mime ? blob : blob.slice(0, blob.size, safe.mime), bytes, ...safe }
}

export interface WritingEmbed { provider: 'youtube' | 'vimeo'; url: string; embedUrl: string }
export function parseWritingEmbed(value: string): WritingEmbed | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    let id: string | null = null
    if (host === 'youtu.be') id = parsed.pathname.slice(1)
    else if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) id = /^\/(?:embed|shorts)\/([^/]+)\/?$/.exec(parsed.pathname)?.[1] ?? (parsed.pathname === '/watch' ? parsed.searchParams.get('v') : null)
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return { provider: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, embedUrl: `https://www.youtube-nocookie.com/embed/${id}` }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') { const video = /^\/(?:video\/)?([0-9]{1,15})\/?$/.exec(parsed.pathname)?.[1]; if (video) return { provider: 'vimeo', url: `https://vimeo.com/${video}`, embedUrl: `https://player.vimeo.com/video/${video}?dnt=1` } }
  } catch { /* A malformed or unsupported URL stays a normal text link. */ }
  return null
}
