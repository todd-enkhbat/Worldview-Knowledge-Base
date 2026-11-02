import type { NodeRecord } from '../../domain/types.ts'
import { getStore } from '../../data/repo.ts'
import { loadSplatBytes } from '../splats/assets.ts'

// Peeks: a note that holds a picture, a video or a captured scene shows it in its screen label,
// at a constant, legible size, however far away the note is. The grains in the world are the
// impression; the peek is the thing itself. Click it to open the note.

export type Peek = { kind: 'image' | 'video'; blobId: string } | { kind: 'scene'; assetId: string }

/** Peek box (CSS px). */
export const PEEK_W = 132
export const PEEK_H = 84

/** What a note can show: its scene's thumbnail, else its first picture, else its first video. */
export function peekOf(rec: NodeRecord): Peek | null {
  if (rec.splat?.thumbAssetId) return { kind: 'scene', assetId: rec.splat.thumbAssetId }
  const img = rec.attachments.find((a) => a.kind === 'image')
  if (img) return { kind: 'image', blobId: img.thumbBlobId ?? img.blobId }
  const vid = rec.attachments.find((a) => a.mime.startsWith('video/'))
  if (vid) return { kind: 'video', blobId: vid.blobId }
  return null
}

export const peekKey = (p: Peek) => (p.kind === 'scene' ? `s:${p.assetId}` : `${p.kind[0]}:${p.blobId}`)

/** A label with a peek: the picture above the title and tag. */
export function peekLabelSize(base: { w: number; h: number }): { w: number; h: number } {
  return { w: Math.max(base.w, PEEK_W + 12), h: base.h + PEEK_H + 4 }
}

/** An object URL for the peek's bytes (the caller revokes it), or null when they are gone. */
export async function peekUrl(p: Peek): Promise<string | null> {
  try {
    if (p.kind === 'scene') {
      const bytes = await loadSplatBytes(p.assetId)
      return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]))
    }
    const blob = await getStore().getBlob(p.blobId)
    return blob ? URL.createObjectURL(blob) : null
  } catch {
    return null
  }
}
