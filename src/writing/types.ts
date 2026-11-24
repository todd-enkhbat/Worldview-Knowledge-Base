export const WRITING_KV = 'writing.v1'
export type WritingFormat = 'note' | 'essay' | 'newsletter' | 'journal' | 'poem' | 'research'
export interface WritingMark { type: string; attrs?: Record<string, unknown> }
/** Tiptap JSON, validated against the studio's explicit node/mark allowlists. */
export interface WritingNode { type: string; attrs?: Record<string, unknown>; content?: WritingNode[]; text?: string; marks?: WritingMark[] }
export interface WritingAppearance {
  fontFamily: 'serif' | 'sans' | 'mono'
  fontSize: number
  lineHeight: number
  pageWidth: number
  pageColor: string
  textColor: string
  accentColor: string
  backgroundColor: string
  background: 'solid' | 'gradient' | 'waves' | 'dots' | 'image'
  backgroundAssetId: string | null
  waveColor: string
  waveIntensity: number
  pageStyle: 'paper' | 'seamless'
}
export interface WritingDocument {
  id: string; title: string; subtitle: string; byline: string; format: WritingFormat
  content: WritingNode; appearance: WritingAppearance; createdAt: number; updatedAt: number
  sourceId?: string; basedOnSourceId?: string; baseVersionId?: string; archivedAt: number | null
  publishedUpdatedAt?: number; publishedFingerprint?: string; lastPublishedAt?: number
  topicIds?: string[]
}
export interface WritingSnapshot { schemaVersion: 1; revision: number; docs: WritingDocument[] }
export type WritingDocumentPatch = Partial<Pick<WritingDocument, 'title' | 'subtitle' | 'byline' | 'format' | 'content' | 'topicIds'>> & { appearance?: Partial<WritingAppearance> }
export type CreateWritingInput = Partial<Pick<WritingDocument, 'title' | 'subtitle' | 'byline' | 'format' | 'content' | 'basedOnSourceId' | 'topicIds'>> & { appearance?: Partial<WritingAppearance> }
