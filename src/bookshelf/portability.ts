import { getStore, getWorldGeneration, isRepoReady } from '../data/repo.ts'
import { createShelfBook, decodeBookshelf, getBookshelfOriginalReferences, validateShelfBook } from './model.ts'
import { bookshelfHash, readBookshelfOriginal, retainBookshelfImport, uploadBookshelfCover } from './media.ts'
import { importBookRecords, mergeBookshelfImport, useBookshelf } from './store.ts'
import type { BookshelfSnapshot, CreateBookInput } from './types.ts'

/** RFC4180-style quoted cells, including embedded commas/newlines and doubled quotes. */
export function parseBookshelfCsv(text: string): { books: (CreateBookInput & { collectionNames?: string[] })[]; errors: { row: number; message: string }[]; total: number } {
  if (new TextEncoder().encode(text).byteLength > 16 * 1024 * 1024) throw new Error('CSV imports must fit within 16 MiB.')
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false
  const input = text.replace(/^\ufeff/, '')
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"') { if (!quoted && (cell === '=' || cell.startsWith('="'))) cell += ch; else if (quoted && input[i + 1] === '"') { cell += '"'; i++ } else if (!cell || quoted) quoted = !quoted; else throw new Error('A CSV quote appears inside an unquoted cell. Export the file as quoted CSV and try again.') }
    else if (!quoted && (ch === ',' || ch === '\n' || ch === '\r')) { row.push(cell); cell = ''; if (ch !== ',') { if (row.some((value) => value.trim())) rows.push(row); row = []; if (ch === '\r' && input[i + 1] === '\n') i++ } }
    else cell += ch
  }
  if (quoted) throw new Error('The CSV ends inside a quoted cell. Export the complete file and try again.')
  row.push(cell); if (row.some((value) => value.trim())) rows.push(row)
  if (rows.length > 10001) throw new Error('Import up to 10,000 books or articles in one CSV.')
  const header = rows.shift()?.map((value) => value.trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, '')) ?? []
  if (!header.includes('title')) throw new Error('Your CSV needs a Title column. Author, Status, Rating, Notes, and Collections are optional.')
  const books: (CreateBookInput & { collectionNames?: string[] })[] = [], errors: { row: number; message: string }[] = []
  rows.forEach((cells, index) => {
    const get = (...names: string[]) => { for (const name of names) { const at = header.indexOf(name); if (at >= 0) return (cells[at] ?? '').trim() } return '' }
    try {
      const statusText = get('status', 'exclusiveshelf').toLocaleLowerCase().replace(/[-_]/g, ' '), status = ['wish', 'wishlist', 'want to buy', 'want to read', 'to buy'].includes(statusText) ? 'wish' : ['reading', 'currently reading'].includes(statusText) ? 'reading' : ['read', 'finished'].includes(statusText) ? 'read' : 'unread'
      const number = (value: string) => value ? Number(value.replace(/^=/, '').replace(/^"|"$/g, '')) : null
      const date = (value: string) => { if (!value) return null; const clean = value.replaceAll('/', '-'); if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean; const time = Date.parse(value); if (!Number.isFinite(time)) throw new Error('A reading date is invalid. Use YYYY-MM-DD.'); return new Date(time).toISOString().slice(0, 10) }
      const details: CreateBookInput = { title: get('title'), subtitle: get('subtitle'), authors: get('authors', 'author').split(';').map((value) => value.trim()).filter(Boolean), kind: get('kind', 'type').toLowerCase() === 'article' ? 'article' : 'book', format: ['digital', 'ebook', 'e book', 'web'].includes(get('format').toLowerCase()) ? 'digital' : get('format').toLowerCase() === 'both' ? 'both' : 'print', status, rating: number(get('rating', 'myrating')) ?? 0, recommendedBy: get('recommendedby', 'recommender'), notes: get('notes', 'myreview', 'review'), url: get('url', 'link'), isbn: get('isbn13', 'isbn').replace(/^="|"$/g, ''), year: number(get('year', 'originalpublicationyear', 'yearpublished')), pages: number(get('pages', 'numberofpages')), startedAt: date(get('started', 'startedat', 'datestarted')), finishedAt: date(get('finished', 'finishedat', 'dateread')) }
      const book = createShelfBook(details), collectionNames = get('collections', 'shelves', 'bookshelves').split(';').map((name) => name.trim()).filter(Boolean)
      if (collectionNames.some((name) => name.length > 160)) throw new Error('Collection names must fit within 160 characters.')
      books.push({ ...details, design: book.design, collectionNames })
    } catch (cause) { errors.push({ row: index + 2, message: cause instanceof Error ? cause.message : String(cause) }) }
  })
  return { books, errors, total: rows.length }
}
const base64 = (bytes: Uint8Array) => { let value = ''; for (let i = 0; i < bytes.length; i += 32768) value += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(value) }
const fromBase64 = (value: string) => { if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('A cover in this export has invalid encoded bytes.'); return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)) }
export async function exportBookshelfJSON(snapshot: BookshelfSnapshot = useBookshelf.getState()): Promise<Blob> {
  const store = getStore(), generation = getWorldGeneration(), current = () => { if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) throw new Error('The workspace changed before export completed.') }
  // Import receipts are retained by world backups. Omitting their raw files avoids recursive JSON-in-JSON exports.
  const clean = decodeBookshelf({ schemaVersion: 1, revision: snapshot.revision, books: snapshot.books, shelves: snapshot.shelves, history: snapshot.history, imports: [] }), assets: { id: string; mime: string; bytes: number; base64: string }[] = []
  let total = 0
  for (const id of getBookshelfOriginalReferences(clean)) { const file = await readBookshelfOriginal(id, { store, generation }); current(); total += file.bytes.length; if (total > 64 * 1024 * 1024) throw new Error('This portable JSON exceeds 64 MiB of original covers. Use a verified world backup for the full library.'); assets.push({ id, mime: file.mime, bytes: file.bytes.length, base64: base64(file.bytes) }) }
  const json = JSON.stringify({ format: 'worldview-bookshelf.v1', exportedAt: new Date().toISOString(), snapshot: clean, assets }, null, 2)
  if (new TextEncoder().encode(json).byteLength > 128 * 1024 * 1024) throw new Error('This JSON exceeds the 128 MiB output budget. Use a verified world backup.')
  current(); return new Blob([json], { type: 'application/json' })
}
export async function importBookshelfFile(file: File) {
  const store = getStore(), generation = getWorldGeneration(), current = () => { if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) throw new Error('The workspace changed. Reopen import in your current bookshelf.') }
  if (!file.size || file.size > 128 * 1024 * 1024) throw new Error('Choose a CSV or bookshelf JSON file up to 128 MiB.')
  const text = await file.text(); current()
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') { const parsed = parseBookshelfCsv(text); if (!parsed.books.length) throw new Error(parsed.errors[0]?.message ?? 'The CSV contains no books or articles.'); const assetId = await retainBookshelfImport(file, { store, generation }); current(); return importBookRecords({ books: parsed.books, errors: parsed.errors, original: { name: file.name, assetId } }) }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Choose a valid bookshelf JSON export or a CSV with a Title column.') }
  if (!value || typeof value !== 'object' || !('format' in value) || value.format !== 'worldview-bookshelf.v1' || !('snapshot' in value) || !('assets' in value) || !Array.isArray(value.assets)) throw new Error('This file is not a Worldview bookshelf export.')
  const snapshot = decodeBookshelf(value.snapshot), assets = value.assets as unknown[], expected = getBookshelfOriginalReferences(snapshot), retained = new Set<string>(); let total = 0
  for (const item of assets) {
    if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string' || retained.has(item.id) || !expected.has(item.id) || !('mime' in item) || typeof item.mime !== 'string' || !('base64' in item) || typeof item.base64 !== 'string' || !('bytes' in item) || !Number.isSafeInteger(item.bytes)) throw new Error('A cover in this export has invalid metadata.')
    const bytes = fromBase64(item.base64); total += bytes.length; if (total > 64 * 1024 * 1024 || bytes.length !== item.bytes || !item.id.endsWith(`-${await bookshelfHash(bytes)}`)) throw new Error('A cover in this export failed its original content check.')
    current()
    // The upload boundary independently checks magic bytes rather than trusting exported MIME.
    const id = await uploadBookshelfCover(new File([bytes], 'restored-cover', { type: item.mime }), { store, generation }); current()
    if (id !== item.id) throw new Error('This export contains an unsupported original type.')
    retained.add(id)
  }
  if ([...expected].some((id) => !retained.has(id))) throw new Error('A cover original is missing from this export. No bookshelf records were changed.')
  for (const book of snapshot.books) validateShelfBook(book)
  const assetId = await retainBookshelfImport(file, { store, generation }); current(); return mergeBookshelfImport(snapshot, { name: file.name, assetId })
}
export const bookshelfImportColumns = 'Title,Author,Kind,Format,Status,Rating,Recommended by,Notes,URL,ISBN,Year,Pages,Started,Finished,Collections'
