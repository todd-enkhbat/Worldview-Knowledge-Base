import type { WorldStore } from '../data/WorldStore.ts'
import { getStore, getWorldGeneration, isRepoReady, retainWorldBlob, useRepoStatus } from '../data/repo.ts'
import { readHead, sniffImageMime } from '../data/attachments.ts'
import { BOOKSHELF_ASSET, BOOKSHELF_COVER_ASSET } from './model.ts'
export const MAX_BOOK_COVER_BYTES = 12 * 1024 * 1024
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
export async function bookshelfHash(data: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data.slice()))].map((value) => value.toString(16).padStart(2, '0')).join('') }
function scope(input: { store?: WorldStore; generation?: number } = {}) { const store = input.store ?? getStore(), generation = input.generation ?? getWorldGeneration(); const check = () => { if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) throw new Error('The workspace changed before this original could be opened or saved.') }; check(); return { store, generation, check } }
export async function uploadBookshelfCover(file: File, options: { store?: WorldStore; generation?: number } = {}): Promise<string> {
  const active = scope(options)
  if (!useRepoStatus.getState().writer) throw new Error('This bookshelf is read only.')
  if (!file.size || file.size > MAX_BOOK_COVER_BYTES) throw new Error('Choose a cover image between 1 byte and 12 MiB.')
  const mime = sniffImageMime(await readHead(file))
  if (!mime || !imageTypes.has(mime)) throw new Error('Use a PNG, JPEG, WebP, GIF or AVIF cover. SVG and active documents are not accepted.')
  const bytes = new Uint8Array(await file.arrayBuffer()), id = `bookshelf-cover-${await bookshelfHash(bytes)}`
  active.check(); await retainWorldBlob({ meta: { id, kind: 'image', mime, bytes: bytes.length, createdAt: Date.now(), nodeId: null }, data: bytes }, { store: active.store, generation: active.generation }); active.check(); return id
}
export async function retainBookshelfImport(file: File, options: { store?: WorldStore; generation?: number } = {}): Promise<string> {
  const active = scope(options)
  if (!useRepoStatus.getState().writer) throw new Error('This bookshelf is read only.')
  if (!file.size || file.size > 128 * 1024 * 1024) throw new Error('Bookshelf imports must fit within 128 MiB.')
  const bytes = new Uint8Array(await file.arrayBuffer()), id = `bookshelf-file-${await bookshelfHash(bytes)}`
  active.check(); await retainWorldBlob({ meta: { id, kind: 'file', mime: file.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/json', bytes: bytes.length, createdAt: Date.now(), nodeId: null }, data: bytes }, { store: active.store, generation: active.generation }); active.check(); return id
}
export async function readBookshelfOriginal(id: string, options: { store?: WorldStore; generation?: number } = {}) {
  if (!BOOKSHELF_ASSET.test(id)) throw new Error('This bookshelf original reference is invalid.')
  const active = scope(options), [blob, meta] = await Promise.all([active.store.getBlob(id), active.store.getAssetMeta(id)])
  active.check()
  if (!blob || !meta || blob.size !== meta.bytes) throw new Error('This retained bookshelf original is missing. Restore its verified backup.')
  const bytes = new Uint8Array(await blob.arrayBuffer()), hash = await bookshelfHash(bytes)
  if (!id.endsWith(`-${hash}`)) throw new Error('This bookshelf original failed its content check.')
  if (BOOKSHELF_COVER_ASSET.test(id)) { const mime = sniffImageMime(await readHead(blob)); if (!mime || !imageTypes.has(mime) || mime !== meta.mime) throw new Error('This cover is not a verified safe raster image.') }
  active.check(); return { blob: blob.type === meta.mime ? blob : blob.slice(0, blob.size, meta.mime), bytes, mime: meta.mime }
}
