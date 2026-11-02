import { describe, expect, it } from 'vitest'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import type { Attachment, NodeRecord, SplatBlock } from '../../src/domain/types.ts'
import { PEEK_H, PEEK_W, peekKey, peekLabelSize, peekOf } from '../../src/world/nodes/peek.ts'

const att = (id: string, kind: Attachment['kind'], mime: string, thumb?: string): Attachment =>
  ({ id, kind, mime, name: id, bytes: 1, blobId: `b-${id}`, ...(thumb ? { thumbBlobId: thumb } : {}), createdAt: 0 }) as Attachment

const rec = (extra: Partial<NodeRecord>): NodeRecord => ({ ...(makeNodeDraft('memory', { id: 'm' }) as NodeRecord), ...extra })

describe('peeks', () => {
  it('shows a scene thumbnail first, then a picture, then a video', () => {
    const splat = { thumbAssetId: 'thumb' } as SplatBlock
    const pic = att('p', 'image', 'image/jpeg', 't-p')
    const vid = att('v', 'file', 'video/mp4')
    expect(peekOf(rec({ splat, attachments: [pic, vid] }))).toEqual({ kind: 'scene', assetId: 'thumb' })
    expect(peekOf(rec({ attachments: [vid, pic] }))).toEqual({ kind: 'image', blobId: 't-p' })
    expect(peekOf(rec({ attachments: [vid] }))).toEqual({ kind: 'video', blobId: 'b-v' })
    expect(peekOf(rec({ attachments: [att('d', 'file', 'application/pdf')] }))).toBeNull()
    expect(peekOf(rec({ splat: { thumbAssetId: null } as SplatBlock, attachments: [] }))).toBeNull()
  })

  it('keys peeks by what they show and makes room for them in the label', () => {
    expect(peekKey({ kind: 'scene', assetId: 'a' })).not.toBe(peekKey({ kind: 'image', blobId: 'a' }))
    expect(peekLabelSize({ w: 60, h: 34 })).toEqual({ w: PEEK_W + 12, h: 34 + PEEK_H + 4 })
    expect(peekLabelSize({ w: 300, h: 34 }).w).toBe(300)
  })
})
