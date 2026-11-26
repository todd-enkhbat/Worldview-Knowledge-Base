import { useBookshelf } from '../bookshelf/store.ts'
import { useBookshelfCover } from '../bookshelf/useCover.ts'
import type { ShelfBook } from '../bookshelf/types.ts'

const stages = { wish: 'Wishlist', unread: 'Unread', reading: 'Reading', read: 'Read' }

/** Show the user's changed details first; complete structured records remain available below. */
export function BookChangePreview({ before, after }: { before?: ShelfBook; after: ShelfBook }) {
  const shelves = useBookshelf((state) => state.shelves)
  const oldCover = useBookshelfCover(before?.coverAssetId ?? null), newCover = useBookshelfCover(after.coverAssetId)
  function details(book?: ShelfBook): Record<string, string> {
    if (!book) return {}
    return {
      Title: book.title, Subtitle: book.subtitle, Authors: book.authors.join(' · '),
      Kind: book.kind === 'book' ? 'Book' : 'Article', Edition: book.format,
      'Reading stage': stages[book.status], Rating: book.rating ? `${book.rating} / 5` : 'Not rated',
      'Recommended by': book.recommendedBy, Notes: book.notes,
      Collections: book.shelfIds.map((id) => shelves.find((shelf) => shelf.id === id)?.name ?? 'Saved collection').join(' · '),
      ISBN: book.isbn, 'Publication year': book.year?.toString() ?? '', Pages: book.pages?.toString() ?? '',
      'Started reading': book.startedAt ?? '', 'Finished reading': book.finishedAt ?? '', 'Original link': book.url,
      Cover: book.coverAssetId ? 'Uploaded cover' : `${book.design.style} · ${book.design.pattern} · ${book.design.color} / ${book.design.ink}`,
      ...Object.fromEntries(book.fields.map((field, index) => [`Your detail: ${field.label} (${index + 1})`, field.value])),
    }
  }
  const current = details(before), proposed = details(after)
  const changed = [...new Set([...Object.keys(current), ...Object.keys(proposed)])].filter((key) => current[key] !== proposed[key] && (current[key] || proposed[key]))
  const coverChanged = before ? before.coverAssetId !== after.coverAssetId : !!after.coverAssetId
  if (coverChanged && !changed.includes('Cover')) changed.push('Cover')
  const text = (value?: string) => value ? value.length > 2000 ? `${value.slice(0, 2000)}… (full text below)` : value : 'Not added'
  return <section className="assistant-book-comparison" aria-label="Book details comparison">
    <p>{before ? `${changed.length} ${changed.length === 1 ? 'detail' : 'details'} changed` : 'New entry for your bookshelf'}</p>
    <table><thead><tr><th scope="col">Detail</th><th scope="col">Current</th><th scope="col">Proposed</th></tr></thead><tbody>
      {changed.map((key) => <tr key={key}><th scope="row">{key}</th><td data-label="Current">{text(current[key])}</td><td data-label="Proposed">{text(proposed[key])}</td></tr>)}
      {coverChanged && <tr><th scope="row">Cover preview</th><td data-label="Current">{oldCover.url ? <img src={oldCover.url} alt="Current book cover" /> : oldCover.error || 'Designed cover'}</td><td data-label="Proposed">{newCover.url ? <img src={newCover.url} alt="Proposed book cover" /> : newCover.error || 'Designed cover'}</td></tr>}
    </tbody></table>
    <p>Long notes are shortened here. Full details, cover design, and retained references are available below.</p>
  </section>
}
