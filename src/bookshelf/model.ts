import { z } from 'zod'
import type { BookDesign, BookPatch, BookshelfSnapshot, CreateBookInput, ShelfBook } from './types.ts'

export const BOOKSHELF_ASSET = /^bookshelf-(?:cover|file)-[a-f0-9]{64}$/
export const BOOKSHELF_COVER_ASSET = /^bookshelf-cover-[a-f0-9]{64}$/
export const BOOKSHELF_MAX_BYTES = 64 * 1024 * 1024
const id = z.string().min(1).max(1000), time = z.number().finite().nonnegative(), color = z.string().regex(/^#[a-f\d]{6}$/i)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => { const result = new Date(`${value}T12:00:00Z`); return Number.isFinite(result.getTime()) && result.toISOString().slice(0, 10) === value })
export const safeBookUrl = (value: string) => { if (!value) return true; try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false } }
const design = z.object({ color, ink: color, style: z.enum(['classic', 'modern', 'type']), pattern: z.enum(['none', 'lines', 'grid', 'arch']) }).strict()
const bookSchema = z.object({ id, title: z.string().trim().min(1).max(500), subtitle: z.string().max(2000), authors: z.array(z.string().trim().min(1).max(300)).max(30), kind: z.enum(['book', 'article']), format: z.enum(['print', 'digital', 'both']), status: z.enum(['wish', 'unread', 'reading', 'read']), rating: z.number().finite().min(0).max(5), recommendedBy: z.string().max(2000), notes: z.string().max(100000), url: z.string().max(4000).refine(safeBookUrl), isbn: z.string().max(100), year: z.number().int().min(1).max(9999).nullable(), pages: z.number().int().min(1).max(1000000).nullable(), startedAt: date.nullable(), finishedAt: date.nullable(), shelfIds: z.array(id).max(500), fields: z.array(z.object({ id, label: z.string().trim().min(1).max(160), value: z.string().max(20000) }).strict()).max(100), coverAssetId: z.string().regex(BOOKSHELF_COVER_ASSET).nullable(), design, sourceId: id.optional(), createdAt: time, updatedAt: time, archivedAt: time.nullable() }).strict().refine((book) => book.updatedAt >= book.createdAt && new Set(book.shelfIds).size === book.shelfIds.length && new Set(book.fields.map((field) => field.id)).size === book.fields.length)
const snapshotSchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), books: z.array(bookSchema).max(10000), shelves: z.array(z.object({ id, name: z.string().trim().min(1).max(160), createdAt: time, archivedAt: time.nullable() }).strict()).max(5000), history: z.array(z.object({ id, bookId: id, recordedAt: time, kind: z.enum(['created', 'edit', 'archive', 'restore', 'named']), label: z.string().min(1).max(200), book: bookSchema }).strict()).max(30000), imports: z.array(z.object({ id, name: z.string().max(1000), assetId: z.string().regex(/^bookshelf-file-[a-f0-9]{64}$/), createdAt: time, added: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), errors: z.array(z.object({ row: z.number().int().nonnegative(), message: z.string().max(1000) }).strict()).max(10000) }).strict()).max(5000) }).strict()
const invalid = () => new Error('Your bookshelf uses incomplete or unsupported data. Its retained copy was not changed.')
export const emptyBookshelf = (): BookshelfSnapshot => ({ schemaVersion: 1, revision: 0, books: [], shelves: [], history: [], imports: [] })
export function decodeBookshelf(value: unknown): BookshelfSnapshot {
  if (value === undefined) return emptyBookshelf()
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > BOOKSHELF_MAX_BYTES) throw new Error('Your bookshelf reached its 64 MiB metadata limit. Existing books and full history were preserved.')
  const parsed = snapshotSchema.safeParse(value)
  if (!parsed.success) throw invalid()
  const result = parsed.data
  for (const entries of [result.books, result.shelves, result.history, result.imports]) if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw invalid()
  const shelves = new Set(result.shelves.map((shelf) => shelf.id)), books = new Set(result.books.map((book) => book.id))
  for (const book of result.books) if (book.shelfIds.some((id) => !shelves.has(id))) throw invalid()
  for (const revision of result.history) if (revision.book.id !== revision.bookId || !books.has(revision.bookId) || revision.book.shelfIds.some((id) => !shelves.has(id))) throw invalid()
  return result
}
export function validateShelfBook(value: unknown): ShelfBook { const result = bookSchema.safeParse(value); if (!result.success) throw new Error('Check the title, reading details, dates, and cover colors before saving.'); return result.data }
export const defaultBookDesign = (): BookDesign => ({ color: '#a64433', ink: '#faf1da', style: 'classic', pattern: 'lines' })
export const BOOK_PALETTES: BookDesign[] = [defaultBookDesign(), { color: '#d7b64c', ink: '#26322f', style: 'modern', pattern: 'arch' }, { color: '#174a43', ink: '#f0e9d2', style: 'classic', pattern: 'none' }, { color: '#d8d3c6', ink: '#282620', style: 'type', pattern: 'grid' }, { color: '#39446a', ink: '#fff5db', style: 'modern', pattern: 'lines' }, { color: '#c97b88', ink: '#442f37', style: 'type', pattern: 'none' }]
export const bookValue = (book: ShelfBook): BookPatch => { const { id: _id, createdAt: _created, updatedAt: _updated, archivedAt: _archived, ...value } = book; return value }
export function createShelfBook(input: CreateBookInput, now = Date.now()): ShelfBook {
  return validateShelfBook({ id: crypto.randomUUID(), subtitle: '', authors: [], kind: 'book', format: 'print', status: 'unread', rating: 0, recommendedBy: '', notes: '', url: '', isbn: '', year: null, pages: null, startedAt: null, finishedAt: null, shelfIds: [], fields: [], coverAssetId: null, design: defaultBookDesign(), ...input, createdAt: now, updatedAt: now, archivedAt: null })
}
/** All originals remain referenced through live/archived details and every retained revision. */
export function getBookshelfOriginalReferences(value: unknown): Set<string> {
  const snapshot = decodeBookshelf(value), result = new Set<string>()
  for (const book of [...snapshot.books, ...snapshot.history.map((entry) => entry.book)]) if (book.coverAssetId) result.add(book.coverAssetId)
  for (const receipt of snapshot.imports) result.add(receipt.assetId)
  return result
}
