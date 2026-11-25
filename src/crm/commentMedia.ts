import { cleanFileName, sniffBlob, sniffImageMime } from '../data/attachments.ts'
import { getStore, getWorldGeneration, isRepoReady, retainWorldBlob, useRepoStatus } from '../data/repo.ts'
import type { WorldStore } from '../data/WorldStore.ts'

export interface CrmCommentAttachment { assetId: string; name: string; mime: string; bytes: number }
export const MAX_CRM_COMMENT_FILE_BYTES = 32 * 1024 * 1024
export const MAX_CRM_COMMENT_FILES = 8
export const MAX_CRM_PORTRAIT_BYTES = 12 * 1024 * 1024
/** Downloadable originals only. No chosen file is interpreted as HTML or an external URL. */
export async function retainCrmCommentFiles(files: readonly File[], options: { store?: WorldStore; generation?: number; shouldWrite?: () => boolean } = {}): Promise<CrmCommentAttachment[]> {
  if (!files.length) return []
  if (files.length > MAX_CRM_COMMENT_FILES || files.some(file => !file.size || file.size > MAX_CRM_COMMENT_FILE_BYTES) || files.reduce((total, file) => total + file.size, 0) > 128 * 1024 * 1024) throw new Error('Add up to 8 files, 32 MiB each and 128 MiB in total. Empty files cannot be attached.')
  const store = options.store ?? getStore(), generation = options.generation ?? getWorldGeneration()
  const check = () => {
    if (!isRepoReady() || store !== getStore() || generation !== getWorldGeneration() || options.shouldWrite && !options.shouldWrite()) throw new Error('The workspace changed before these attachments could be retained.')
    if (!useRepoStatus.getState().writer) throw new Error('Open the writer window to add attachments.')
  }
  check()
  const result: CrmCommentAttachment[] = []
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer()), sniffed = await sniffBlob(file, file.name)
    if (bytes.byteLength !== file.size) throw new Error('An attachment changed while it was being read.')
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join(''), assetId = `crm-file-${hash}`
    check()
    const existing = await store.getAssetMeta(assetId)
    check()
    if (!existing) await retainWorldBlob({ meta: { id: assetId, kind: 'file', mime: sniffed.mime || 'application/octet-stream', bytes: bytes.byteLength, createdAt: Date.now(), nodeId: null }, data: bytes }, { store, generation, shouldWrite: options.shouldWrite })
    check()
    result.push({ assetId, name: cleanFileName(file.name, 'Attachment'), mime: existing?.mime || sniffed.mime || 'application/octet-stream', bytes: bytes.byteLength })
  }
  return result
}

/** A portrait must be an actual raster image; names and browser MIME hints are insufficient. */
export async function retainCrmPortrait(file: File, options: { store?: WorldStore; generation?: number; shouldWrite?: () => boolean } = {}): Promise<CrmCommentAttachment> {
  if (!file.size || file.size > MAX_CRM_PORTRAIT_BYTES) throw new Error('Choose a PNG, JPEG, WebP, GIF or AVIF portrait up to 12 MiB.')
  const store = options.store ?? getStore(), generation = options.generation ?? getWorldGeneration()
  const check = () => {
    if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation || options.shouldWrite && !options.shouldWrite()) throw new Error('The workspace changed before this portrait could be retained.')
    if (!useRepoStatus.getState().writer) throw new Error('Open the writer window to change a portrait.')
  }
  check()
  const bytes = new Uint8Array(await file.arrayBuffer()), mime = sniffImageMime(bytes.subarray(0, 4096))
  if (bytes.byteLength !== file.size || !mime || !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(mime)) throw new Error('Choose a real PNG, JPEG, WebP, GIF or AVIF image. HTML and SVG cannot be portraits.')
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join(''), assetId = `crm-avatar-${digest}`
  check()
  await retainWorldBlob({ meta: { id: assetId, kind: 'image', mime, bytes: bytes.byteLength, createdAt: Date.now(), nodeId: null }, data: bytes }, { store, generation, shouldWrite: options.shouldWrite })
  check()
  return { assetId, name: cleanFileName(file.name, 'Portrait'), mime, bytes: bytes.byteLength }
}
