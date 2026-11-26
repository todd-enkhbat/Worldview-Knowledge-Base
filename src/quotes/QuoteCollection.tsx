import { useEffect, useState } from 'react'
import { Quotes, Plus } from '@phosphor-icons/react'
import { QuoteCapture } from './QuoteCapture.tsx'
import { quoteScope, saveQuote, useQuoteLibrary } from './store.ts'
import { originHref, retainedHref, verificationLabel, verifiedAnchor, type QuoteRecord, type QuoteSource } from './model.ts'
import './quotes.css'

const when = (time: number) => new Date(time).toLocaleString()
const originLabel = { book: 'Bookshelf', writing: 'Writing', article: 'Library', collection: 'Quotes' }
const draftRole = { human: 'Your draft selection', ai: 'AI-generated draft selection', mixed: 'Mixed-authorship draft selection', unknown: 'Draft authorship unrecorded' }
const passageRole = { human: 'Human-authored source passage', assistant: 'AI-authored source passage', mixed: 'Mixed-authorship source passage', 'third-party': 'Third-party source passage', unknown: '' }
const attributionLabel = { 'source-metadata': 'Author from retained source metadata', 'bookshelf-metadata': 'Author from saved edition', 'user-supplied': 'Author supplied with reference', unknown: 'Author not recorded' }
const latest = (quote: QuoteRecord) => quote.history[quote.history.length - 1]
const referenceTitle = (source: QuoteSource) => source.referenceStatus === 'pending' ? 'Article · reference pending' : source.title
const referenceText = (source: QuoteSource) => [...new Set([referenceTitle(source), source.author, source.edition, source.isbn, source.catalogEditionId, source.locator, source.url].filter(Boolean))].join(' · ')
const selectedQuoteId = () => new URLSearchParams(window.location.hash.split('?')[1]).get('quote')
const quoteHref = (id: string) => '#/quotes?quote=' + encodeURIComponent(id)

export function BookQuotes({ bookId }: { bookId: string }) {
  const { library, error } = useQuoteLibrary()
  const quotes = library.quotes.filter(q => latest(q).source.bookId === bookId)
  if (error) return <p role="alert">{error}</p>
  if (!quotes.length) return null
  return <section className="book-linked-quotes" aria-label="Saved quotes from this edition">
    <h3>Quotes from this edition</h3>
    <ul>{quotes.map(q => <li key={q.id}>
      <a href={quoteHref(q.id)}>{q.text}</a>
      <small>{[latest(q).source.locator, when(q.createdAt)].filter(Boolean).join(' · ')}</small>
    </li>)}</ul>
  </section>
}

export default function QuoteCollection() {
  const { library, loaded, error: loadError, writer } = useQuoteLibrary()
  const [query, setQuery] = useState(''), [edit, setEdit] = useState<QuoteRecord | 'new' | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [requestedId, setRequestedId] = useState(selectedQuoteId)
  useEffect(() => {
    function navigate() { setRequestedId(selectedQuoteId()); setQuery('') }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])
  useEffect(() => {
    if (!loaded || !requestedId) return
    const target = document.getElementById('quote-' + requestedId)
    target?.focus({ preventScroll: true }); target?.scrollIntoView?.({ block: 'center' })
  }, [loaded, requestedId])
  const filtered = library.quotes.filter(q =>
    [q.text, referenceText(latest(q).source), q.origin.title].some(x => x.toLowerCase().includes(query.trim().toLowerCase())),
  )

  async function check(q: QuoteRecord) {
    const last = latest(q)
    setError(''); setBusy(q.id)
    try {
      await saveQuote(quoteScope(), q.id, 'rechecked', {
        text: q.text, origin: q.origin, source: last.source, anchor: verifiedAnchor(last.verification),
      }, q.history.length)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy('') }
  }

  return <section className="quote-collection" aria-label="Quote collection">
    <header><div><Quotes size={23} /><h1>Quotes</h1></div>
      <button type="button" className="knowledge-button is-primary" disabled={!writer} onClick={() => setEdit('new')}><Plus size={15} /> Add quote</button>
    </header>
    <label className="quote-find">Search quotes<input type="search" placeholder="Words, title, or author" value={query} onChange={e => setQuery(e.target.value)} /></label>
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
    {!loaded && !loadError ? <p role="status">Opening quotes…</p> : !filtered.length && <p>{query ? 'No matching quotations.' : 'Save a passage from Writing, Bookshelf, or a Library source, or add a quote here.'}</p>}
    {filtered.map(q => {
      const last = latest(q), s = last.source, v = last.verification, sourceLink = retainedHref(s), originLink = originHref(q.origin)
      return <article key={q.id} id={'quote-' + q.id} tabIndex={-1} className="quote-card">
        <blockquote>{q.text}</blockquote>
        <p>{s.referenceStatus === 'pending' ? <strong>{referenceTitle(s)}</strong> : <><strong>{s.author || 'Author not recorded'}</strong> · <cite>{s.title}</cite></>}{s.edition && ' · ' + s.edition}{s.locator && ' · ' + s.locator}</p>
        <p className="quote-status">{verificationLabel[v.status]}{v.status === 'exact' && ` · Characters ${v.start! + 1}–${v.end}`}{v.sourceAuthorship && passageRole[v.sourceAuthorship] && ' · ' + passageRole[v.sourceAuthorship]}</p>
        <p className="quote-datestamp">Saved {when(q.createdAt)} · Checked {when(v.checkedAt)}{q.origin.kind === 'writing' && ' · ' + draftRole[q.origin.authorship || 'unknown']}</p>
        <div className="quote-actions">
          {sourceLink && <a href={sourceLink}>Open retained version</a>}
          {s.url && <a href={s.url} target="_blank" rel="noopener noreferrer">Open article</a>}
          {s.bookId && <a href={'#/bookshelf?book=' + encodeURIComponent(s.bookId)}>Open saved edition</a>}
          {originLink && !(q.origin.kind === 'book' && q.origin.id === s.bookId) && <a href={originLink}>Open in {originLabel[q.origin.kind]}</a>}
          <button type="button" disabled={!writer || !!busy} onClick={() => setEdit(q)}>Edit reference</button>
          {s.sourceId && <button type="button" disabled={!writer || !!busy} onClick={() => void check(q)}>{busy === q.id ? 'Checking…' : 'Check text again'}</button>}
        </div>
        <details><summary>Reference history ({q.history.length})</summary><ol>{q.history.map((rev, index) =>
          <li key={index}><time dateTime={new Date(rev.at).toISOString()}>{when(rev.at)}</time> · {({ captured: 'Captured', amended: 'Reference edited', rechecked: 'Text rechecked' })[rev.action]}
            <p>{referenceText(rev.source)}</p><p>{verificationLabel[rev.verification.status]} · {attributionLabel[rev.attribution]}</p>
            {rev.source.versionId && <a href={retainedHref(rev.source)}>Open this version</a>}
          </li>,
        )}</ol></details>
      </article>
    })}
    {edit === 'new' && <QuoteCapture selection="" origin={{ kind: 'collection', id: 'quotes', title: 'Quotes' }} onClose={() => setEdit(null)} />}
    {edit && edit !== 'new' && <QuoteCapture selection={edit.text} origin={edit.origin} initialSource={latest(edit).source} anchor={verifiedAnchor(latest(edit).verification)} existing={edit} onClose={() => setEdit(null)} />}
  </section>
}
