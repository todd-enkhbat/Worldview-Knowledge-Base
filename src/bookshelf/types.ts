export const BOOKSHELF_KV = 'bookshelves.v1'
export type ShelfStatus = 'wish' | 'unread' | 'reading' | 'read'
export type ShelfKind = 'book' | 'article'
export type ShelfFormat = 'print' | 'digital' | 'both'
export interface BookDesign { color: string; ink: string; style: 'classic' | 'modern' | 'type'; pattern: 'none' | 'lines' | 'grid' | 'arch' }
export interface BookField { id: string; label: string; value: string }
export interface ShelfBook {
  id: string; title: string; subtitle: string; authors: string[]; kind: ShelfKind; format: ShelfFormat; status: ShelfStatus
  rating: number; recommendedBy: string; notes: string; url: string; isbn: string; year: number | null; pages: number | null
  startedAt: string | null; finishedAt: string | null; shelfIds: string[]; fields: BookField[]; coverAssetId: string | null
  design: BookDesign; sourceId?: string; createdAt: number; updatedAt: number; archivedAt: number | null
}
export type BookPatch = Partial<Omit<ShelfBook, 'id' | 'createdAt' | 'updatedAt' | 'archivedAt'>>
export type CreateBookInput = Pick<ShelfBook, 'title'> & BookPatch
export interface BookCollection { id: string; name: string; createdAt: number; archivedAt: number | null }
export interface BookRevision { id: string; bookId: string; recordedAt: number; kind: 'created' | 'edit' | 'archive' | 'restore' | 'named'; label: string; book: ShelfBook }
export interface BookshelfImport { id: string; name: string; assetId: string; createdAt: number; added: number; skipped: number; errors: { row: number; message: string }[] }
export interface BookshelfSnapshot { schemaVersion: 1; revision: number; books: ShelfBook[]; shelves: BookCollection[]; history: BookRevision[]; imports: BookshelfImport[] }
