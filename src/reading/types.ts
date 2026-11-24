export const READING_KV = 'reading.v1'
export type ReadingStatus = 'unread' | 'reading' | 'read'
export type HighlightColor = 'yellow' | 'blue' | 'rose'
export interface ReadingFolder { id: string; name: string; parentId: string | null; createdAt: number; deletedAt?: number | null }
export interface ReadingItem {
  sourceId: string
  folderId: string | null
  status: ReadingStatus
  progress: number
  lastOpenedAt: number | null
  readAt: number | null
  /** Reader scroll offset in pixels. */
  position: number
  favorite: boolean
  topicIds: string[]
  activeReadMs?: number
  following?: boolean
}
export interface ReadingHighlight {
  id: string; sourceId: string; versionId: string; start: number; end: number; quote: string
  prefix: string; suffix: string; note: string; color: HighlightColor; createdAt: number; updatedAt: number
}
export interface ReadingNote { id: string; sourceId: string; text: string; createdAt: number; updatedAt: number }
export interface ReadingPdfHighlight {
  id: string; sourceId: string; versionId: string; page: number; quote: string; prefix?: string; suffix?: string
  rects: { x: number; y: number; width: number; height: number }[]
  note: string; color: HighlightColor; createdAt: number; updatedAt: number
}
export interface ReadingSavedView {
  id: string; name: string; query: string; filter: string; folderId: string | null; topic: string
  view: 'grid' | 'list'; sort: 'modified' | 'opened' | 'title'; createdAt: number
}
export interface ReadingTopic { id: string; name: string; createdAt: number }
export interface ReadingEndpoint { kind: 'source' | 'topic'; id: string }
export type ReadingRelation = 'related' | 'supports' | 'contradicts' | 'builds-on'
export interface ReadingConnection { id: string; from: ReadingEndpoint; to: ReadingEndpoint; relation: ReadingRelation; createdAt: number }
export interface ReadingSnapshot {
  schemaVersion: 1; revision: number
  folders: ReadingFolder[]; items: ReadingItem[]; highlights: ReadingHighlight[]; notes: ReadingNote[]
  topics: ReadingTopic[]; connections: ReadingConnection[]
  pdfHighlights?: ReadingPdfHighlight[]
  savedViews?: ReadingSavedView[]
}
export type ReadingItemPatch = Partial<Omit<ReadingItem, 'sourceId'>>
export type HighlightInput = Pick<ReadingHighlight, 'sourceId' | 'versionId' | 'start' | 'end' | 'quote'> & Partial<Pick<ReadingHighlight, 'prefix' | 'suffix' | 'note' | 'color'>>
