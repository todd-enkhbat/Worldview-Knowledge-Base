import { useEffect, useRef, useState } from 'react'
import type { ShelfBook } from '../bookshelf/types.ts'
import { isRepoReady } from '../data/repo.ts'
import { CaretRight, Quotes } from '@phosphor-icons/react'
import { QuoteSourcePicker, editionLabel } from './QuoteSourcePicker.tsx'
import { ReadingDialog } from '../reading/ReadingDialog.tsx'
import { quoteScope, saveQuote, useQuoteLibrary } from './store.ts'
import { verificationLabel, verifyQuote, versionAuthor, type Anchor, type QuoteOrigin, type QuoteRecord, type QuoteSource } from './model.ts'
import './quotes.css'

export interface QuoteCaptureProps {
  selection: string
  origin: QuoteOrigin
  initialSource?: Partial<QuoteSource>
  anchor?: Anchor
  existing?: QuoteRecord
  onSaved?: (quoteId: string, exactText: string) => void
  onClose: () => void
}
const blankSource: QuoteSource = { title: '', author: '', edition: '', locator: '' }
function bookReference(book: ShelfBook): QuoteSource {
  return {
    ...blankSource, kind: book.kind, title: book.title, author: book.authors.join(', ').slice(0, 500), edition: editionLabel(book).slice(0, 1200),
    bookId: book.id, catalogEditionId: book.catalog?.editionId, isbn: book.isbn || undefined, sourceId: book.sourceId, versionId: book.sourceVersionId,
  }
}

export function QuoteCapture({ selection, origin, initialSource, anchor, existing, onSaved, onClose }: QuoteCaptureProps) {
  const { corpus, books, loaded, writer, error: loadError } = useQuoteLibrary(true)
  const [scope] = useState(() => isRepoReady() ? quoteScope() : null)
  const [id] = useState(() => existing?.id || crypto.randomUUID())
  const [text, setText] = useState(selection)
  const [ref, setRef] = useState<QuoteSource>(() => ({
    ...initialSource,
    title: initialSource?.title || '', author: initialSource?.author || '',
    edition: initialSource?.edition || '', locator: initialSource?.locator || '',
  }))
  const [manual, setManual] = useState(!!existing && !initialSource?.bookId && !initialSource?.sourceId)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const alive = useRef(true), submitting = useRef(false), initialized = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const sources = corpus.sources.filter(s => !s.deleted && !s.excluded)
  const source = sources.find(s => s.id === ref.sourceId)
  const savedBook = books.find(b => b.id === ref.bookId)
  const versions = source ? corpus.versions.filter(v => v.sourceId === source.id).sort((a, b) => b.createdAt - a.createdAt) : []
  useEffect(() => {
    if (!loaded || initialized.current || existing) return
    initialized.current = true
    const bookId = initialSource?.bookId || (origin.kind === 'book' ? origin.id : undefined)
    const matchingEditions = !bookId && initialSource?.sourceId && initialSource.versionId
      ? books.filter(b => !b.archivedAt && b.sourceId === initialSource.sourceId && b.sourceVersionId === initialSource.versionId) : []
    const linkedBook = books.find(b => b.id === bookId) || (matchingEditions.length === 1 ? matchingEditions[0] : undefined)
    const sourceId = initialSource?.sourceId || linkedBook?.sourceId
    const linkedSource = corpus.sources.find(s => s.id === sourceId && !s.deleted && !s.excluded)
    const versionId = initialSource?.versionId || linkedBook?.sourceVersionId || linkedSource?.currentVersionId
    const version = linkedSource && corpus.versions.find(v => v.id === versionId && v.sourceId === linkedSource.id)
    if (linkedBook || linkedSource) setRef(old => ({
      ...(linkedBook ? bookReference(linkedBook) : old), sourceId, versionId,
      kind: linkedBook?.kind || old.kind || (version?.metadata?.format === 'article' ? 'article' : 'library'),
      title: old.title || linkedBook?.title || linkedSource?.title || '', locator: old.locator,
      edition: old.edition || (linkedBook ? editionLabel(linkedBook) : ''),
      author: old.author || linkedBook?.authors.join(', ').slice(0, 500) || versionAuthor(version),
    }))
  }, [books, loaded, corpus, existing, initialSource, origin.kind, origin.id])

  const selectSource = (book?: ShelfBook, retainedId?: string) => {
    const sourceId = book?.sourceId || retainedId
    if (book ? ref.bookId === book.id : !ref.bookId && ref.sourceId === sourceId) return
    const chosen = sources.find(s => s.id === sourceId)
    const versionId = book?.sourceVersionId || chosen?.currentVersionId
    const version = chosen && corpus.versions.find(v => v.id === versionId && v.sourceId === chosen.id)
    const reference: QuoteSource = book ? bookReference(book) : { ...blankSource, kind: version?.metadata?.format === 'article' ? 'article' : 'library', title: chosen?.title || '', author: versionAuthor(version) }
    setManual(false)
    setRef({ ...reference, sourceId, versionId })
  }
  const position = initialSource?.sourceId === ref.sourceId && initialSource?.versionId === ref.versionId && text === selection ? anchor : undefined
  const selected = !!(ref.bookId || ref.sourceId)
  const pendingArticle = ref.kind === 'article' && !selected && !ref.title.trim() && !ref.url?.trim()
  const hasReference = !!(ref.title.trim() || ref.url?.trim() || pendingArticle)
  const check = text.trim() && loaded && hasReference ? verifyQuote(text, ref, corpus, 0, position) : null
  function choosePendingArticle() { setManual(false); setRef({ ...blankSource, kind: 'article', referenceStatus: 'pending' }) }
  const change = (field: 'title' | 'author' | 'edition' | 'locator' | 'url', value: string) => setRef(old => ({ ...old, [field]: value }))
  const manualTitle = useRef<HTMLInputElement>(null)
  useEffect(() => { if (manual && !existing) manualTitle.current?.focus() }, [manual, existing])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (submitting.current || !scope) return
    submitting.current = true; setBusy(true); setError('')
    try {
      const url = ref.url?.trim() || (/^https?:\/\//i.test(ref.title.trim()) ? ref.title.trim() : undefined)
      const citation: QuoteSource = {
        ...ref, title: ref.title.trim() || url || '', url, kind: ref.kind || (url ? 'article' : undefined),
        referenceStatus: pendingArticle ? 'pending' : 'identified',
      }
      await saveQuote(scope, id, existing ? 'amended' : 'captured', { text, origin, source: citation, anchor: position }, existing?.history.length)
      if (alive.current) {
        onSaved?.(id, text)
        onClose()
      }
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      submitting.current = false
      if (alive.current) setBusy(false)
    }
  }

  return <ReadingDialog title={existing ? 'Edit quote reference' : 'Save a quotation'} onClose={() => { if (!busy) onClose() }}>
    <form className="quote-form" onSubmit={event => void submit(event)}>
      <div className="quote-capture-body">
        <div className="quote-passage">
          <Quotes size={20} aria-hidden="true" />
          <label><span className="knowledge-sr-only">Quoted words</span>
            <textarea required maxLength={20000} rows={2} value={text} readOnly={!!selection} placeholder="Enter the exact words…" onChange={e => setText(e.target.value)} />
          </label>
          {origin.kind === 'writing' && <small>From {origin.title}{origin.authorship === 'ai' ? ' · AI-generated draft text' : origin.authorship === 'human' ? ' · Your draft text' : origin.authorship === 'mixed' ? ' · Mixed draft authorship' : ''}</small>}
        </div>
        <QuoteSourcePicker books={books} corpus={corpus} reference={ref} onChoose={selectSource} onPendingArticle={choosePendingArticle}
          onCategory={article => {
            if (article && ref.kind !== 'article') choosePendingArticle()
            else if (!article && pendingArticle) { setManual(false); setRef({ ...blankSource }) }
          }} onManual={article => {
          if (!manual) { setRef({ ...blankSource, kind: article ? 'article' : undefined }); setManual(true) }
          else manualTitle.current?.focus()
        }} />
        {manual && <label className="quote-manual-title">Source title or article URL<input ref={manualTitle} required={!pendingArticle && !ref.url} maxLength={1000} value={ref.title} onChange={e => change('title', e.target.value)} /></label>}
        {(manual || selected) && <>
          <label className="quote-locator">Page, chapter, or location <span>(optional)</span><input maxLength={500} value={ref.locator} placeholder="e.g. p. 24" onChange={e => change('locator', e.target.value)} /></label>
          <details className="quote-citation-details" open={existing ? true : undefined}>
            <summary><CaretRight size={13} aria-hidden="true" />Reference details</summary>
            <div className="quote-reference-fields">
              <label>Source author<input maxLength={500} value={ref.author} placeholder="Unknown" onChange={e => change('author', e.target.value)} /></label>
              <label>Edition or ISBN<input maxLength={1200} value={ref.edition} readOnly={!!ref.catalogEditionId} onChange={e => change('edition', e.target.value)} /></label>
              {manual && <label>Article URL<input type="url" maxLength={2000} value={ref.url || ''} onChange={e => change('url', e.target.value)} /></label>}
              {ref.sourceId && <label>Source version<select value={ref.versionId || ''} disabled={!!savedBook?.sourceVersionId} onChange={e => {
                const version = versions.find(v => v.id === e.target.value)
                setRef(old => ({ ...old, versionId: version?.id, author: savedBook ? old.author : versionAuthor(version) || old.author }))
              }}>
                <option value="">No retained version selected</option>
                {ref.versionId && !versions.some(v => v.id === ref.versionId) && <option value={ref.versionId}>Previously linked version unavailable</option>}
                {versions.map(v => <option key={v.id} value={v.id}>{v.originalName || 'Retained text'} · {new Date(v.createdAt).toLocaleString()}{v.id === source?.currentVersionId ? ' · Current' : ''}</option>)}
              </select></label>}
            </div>
          </details>
        </>}
      </div>
      <footer className="quote-capture-footer">
        <div className="quote-capture-status" role={error || loadError ? 'alert' : 'status'}>
          {error || loadError ? error || loadError : <>
            <strong>{ref.title || ref.url || (pendingArticle ? 'Article · reference pending' : loaded ? 'Choose a source' : 'Opening sources…')}</strong>
            {check && <span>{verificationLabel[check.status]}{check.status === 'exact' && ` · Characters ${check.start! + 1}–${check.end}`}{check.status === 'multiple' && ' · Select the occurrence in Reader.'}</span>}
          </>}
        </div>
        <button type="submit" className="knowledge-button is-primary" disabled={!scope || !loaded || !writer || busy || !text.trim() || !hasReference}>{busy ? 'Saving…' : existing ? 'Save reference' : 'Save quote'}</button>
      </footer>
    </form>
  </ReadingDialog>
}
