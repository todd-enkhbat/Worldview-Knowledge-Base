import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { BookOpen, Check, FileText, MagnifyingGlass, PencilSimple } from '@phosphor-icons/react'
import { useBookshelfCover } from '../bookshelf/useCover.ts'
import type { ShelfBook } from '../bookshelf/types.ts'
import { usePersonalLibrary } from '../reading/personalLibrary.ts'
import { versionAuthor, type Corpus, type QuoteSource } from './model.ts'

type Category = 'Books' | 'Articles' | 'Library'
interface Choice { key: string; category: Category; title: string; detail: string; isbn?: string; time: number; book?: ShelfBook; sourceId?: string }
export const editionLabel = (book: ShelfBook) => book.catalog?.editionLabel || [book.year, book.isbn].filter(Boolean).join(' · ') || ''

function SavedCover({ id, fallback }: { id: string; fallback: ReactNode }) {
  const { url } = useBookshelfCover(id)
  return url ? <img src={url} alt="" /> : fallback
}
function SourceButton({ choice, selected, choose }: { choice: Choice; selected: boolean; choose: () => void }) {
  const Icon = choice.category === 'Books' ? BookOpen : FileText
  return <button type="button" className="quote-source-choice" aria-pressed={selected} onClick={choose} title={[choice.title, choice.detail].filter(Boolean).join(' · ')}>
    <span className="quote-choice-icon" aria-hidden="true" style={choice.book ? { background: choice.book.design.color, color: choice.book.design.ink } : undefined}>
      {choice.book?.coverAssetId ? <SavedCover id={choice.book.coverAssetId} fallback={<Icon size={16} />} /> : <Icon size={16} />}
    </span>
    <span className="quote-choice-text"><strong>{choice.title}</strong>{choice.detail && <small>{choice.detail}</small>}</span>
    {selected && <Check size={15} weight="bold" aria-hidden="true" />}
  </button>
}

export function QuoteSourcePicker({ books, corpus, reference, onChoose, onManual, onCategory, onPendingArticle }: {
  books: ShelfBook[]; corpus: Corpus; reference: QuoteSource; onChoose: (book?: ShelfBook, sourceId?: string) => void
  onManual: (article: boolean) => void; onCategory: (article: boolean) => void; onPendingArticle: () => void
}) {
  const [category, setCategory] = useState<Category | null>(null)
  const [query, setQuery] = useState(''), [limit, setLimit] = useState(6)
  const { sources } = usePersonalLibrary(corpus.sources)
  const choices = useMemo<Choice[]>(() => {
    const editions: Choice[] = books.filter(book => !book.archivedAt || book.id === reference.bookId).map(book => ({
      key: 'book:' + book.id, category: book.kind === 'article' ? 'Articles' : 'Books', title: book.title, book,
      detail: [book.authors.join(', '), editionLabel(book) || book.catalog?.editionId].filter(Boolean).join(' · '),
      isbn: book.isbn, time: book.updatedAt,
    }))
    const versions = new Map(corpus.versions.map(v => [v.id, v]))
    const retained: Choice[] = sources.map(source => {
      const version = versions.get(source.currentVersionId)
      return {
        key: 'source:' + source.id, sourceId: source.id, category: version?.metadata?.format === 'article' ? 'Articles' : 'Library',
        title: source.title, detail: versionAuthor(version) || String(version?.metadata?.host || version?.originalName || ''),
        time: source.updatedAt,
      }
    })
    // An article saved on the shelf already has an edition-specific choice. A directly linked
    // Reader source may still represent another retained version, so keep that selection visible.
    const attachedArticles = new Set(books.filter(book => book.kind === 'article' && !book.archivedAt && book.sourceId).map(book => 'source:' + book.sourceId))
    return editions.concat(retained.filter(option => option.category !== 'Articles' || !attachedArticles.has(option.key)
      || !reference.bookId && option.key === 'source:' + reference.sourceId)).sort((a, b) => b.time - a.time || a.title.localeCompare(b.title))
  }, [books, corpus.versions, sources, reference.bookId, reference.sourceId])
  const selectedKey = reference.bookId ? 'book:' + reference.bookId : reference.sourceId ? 'source:' + reference.sourceId : ''
  const selected = choices.find(c => c.key === selectedKey)
  const active = category || selected?.category || (reference.kind === 'article' ? 'Articles' : choices.some(c => c.category === 'Books') ? 'Books' : choices.some(c => c.category === 'Articles') ? 'Articles' : 'Library')
  const group = choices.filter(c => c.category === active)
  const needle = query.trim().toLocaleLowerCase()
  const matches = group.filter(c => [c.title, c.detail, c.isbn].some(field => field?.toLocaleLowerCase().includes(needle)))
  const visible = matches.slice(0, limit)
  if (selected && !needle && selected.category === active && !visible.includes(selected)) visible.unshift(selected)
  function browse(value: Category) { setCategory(value); setLimit(6); setQuery(''); onCategory(value === 'Articles') }

  return <section className="quote-source-picker" aria-label="Choose a source">
    <div className="quote-picker-tools">
      <div className="quote-source-categories" role="group" aria-label="Source type">
        {(['Books', 'Articles', 'Library'] as const).map(value =>
          <button type="button" key={value} aria-pressed={active === value} onClick={() => browse(value)}>{value}</button>,
        )}
      </div>
      <button type="button" className="quote-manual" onClick={() => onManual(active === 'Articles')}><PencilSimple size={13} />Enter manually</button>
    </div>
    {(group.length > 6 || query) && <label className="quote-source-search"><MagnifyingGlass size={15} aria-hidden="true" /><input type="search" aria-label={'Find in ' + active} placeholder={'Find in ' + active.toLowerCase()} value={query} onChange={event => { setQuery(event.target.value); setLimit(6) }} /></label>}
    {active === 'Articles' && <button type="button" className="quote-pending-article" aria-pressed={reference.kind === 'article' && !reference.title && !reference.url && !selectedKey} onClick={onPendingArticle}>
      <FileText size={15} aria-hidden="true" />Article · add reference later
    </button>}
    {visible.length > 0 ? <div className="quote-source-list" role="group" aria-label={'Choose from ' + active.toLowerCase()}>
      {visible.map(choice => <SourceButton key={choice.key} choice={choice} selected={selectedKey === choice.key} choose={() => onChoose(choice.book, choice.sourceId)} />)}
    </div> : <p className="quote-source-empty">{needle ? 'No matching sources.' : active === 'Books' ? 'No saved books yet.' : active === 'Articles' ? 'No saved articles yet.' : 'No other retained sources.'}</p>}
    {matches.length > visible.length && <button type="button" className="quote-more" onClick={() => setLimit(n => n + 12)}>Show more {active === 'Library' ? 'sources' : active.toLowerCase()} ({matches.length - visible.length})</button>}
  </section>
}
