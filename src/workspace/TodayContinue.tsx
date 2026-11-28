import { useEffect, useState } from 'react'
import { bookHref } from '../bookshelf/model.ts'
import { useBookshelf } from '../bookshelf/store.ts'
import { useRepoStatus } from '../data/repo.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { usePersonalLibrary } from '../reading/personalLibrary.ts'
import { useReading } from '../reading/store.ts'
import { initializeCollections, openInvestigation, useCollections } from './collections.ts'
import './todayContinue.css'

export function TodayContinue() {
  const ready = useRepoStatus(state => state.ready)
  const investigations = useCollections(state => state.collections)
  const loaded = useCollections(state => state.loaded)
  const loadError = useCollections(state => state.error)
  const { sources, writings } = usePersonalLibrary()
  const reading = useReading(state => state.items)
  const books = useBookshelf(state => state.books)
  const imports = useKnowledge(state => state.imports)
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    setError('')
    if (ready) void initializeCollections().catch(cause => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { current = false }
  }, [ready])

  const recent = investigations.filter(item => !item.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt)
  const investigation = recent[0]
  const questionProject = recent.find(item => item.questions.some(question => question.trim()))
  const question = questionProject?.questions.find(question => question.trim())
  const draft = writings.filter(item => !item.publishedUpdatedAt || item.updatedAt > item.publishedUpdatedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const retained = new Map(sources.map(source => [source.id, source]))
  const readingItem = reading.filter(item => item.status === 'reading' && retained.has(item.sourceId))
    .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0]
  const source = readingItem && retained.get(readingItem.sourceId)
  const readingBook = books.filter(book => book.status === 'reading' && !book.archivedAt && (!book.sourceId || retained.has(book.sourceId)))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const failedImports = imports.filter(receipt => receipt.status === 'failed' || receipt.status === 'partial' && receipt.failed > 0).length
  const progress = readingItem?.progress ? ` · ${Math.round(readingItem.progress * 100)}% read` : ''
  const hasItems = investigation || draft || source || readingBook

  function resume(id: string, query?: string) {
    try { openInvestigation(id, query) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  return <section className="today-continue" aria-labelledby="today-continue-title">
    <header className="knowledge-section-title">
      <h2 id="today-continue-title">Continue</h2>
      <a className="knowledge-button" href="#/todos">Open To-do</a>
    </header>
    {(error || loadError) && <p role="status" className="knowledge-error">{error || loadError}</p>}
    {failedImports > 0 && <a className="today-capture-issue" href="#/sources?activity=imports">{failedImports} {failedImports === 1 ? 'import needs' : 'imports need'} attention <span>Review imports</span></a>}
    {hasItems ? <ul className="today-resume-list">
      {investigation && <li><button type="button" onClick={() => resume(investigation.id)}><span>Investigation</span><strong>{investigation.title}</strong></button></li>}
      {questionProject && question && <li><button type="button" onClick={() => resume(questionProject.id, question)}><span>Open question</span><strong>{question}</strong></button></li>}
      {draft && <li><a href={`#/write?doc=${encodeURIComponent(draft.id)}`}><span>Draft</span><strong>{draft.title.trim() || 'Untitled document'}</strong></a></li>}
      {source ? <li><a href={`#/library?source=${encodeURIComponent(source.id)}`}><span>Reading{progress}</span><strong>{source.title}</strong></a></li>
        : readingBook && <li><a href={bookHref(readingBook.id)}><span>Reading</span><strong>{readingBook.title}</strong></a></li>}
    </ul> : <p className="today-continue-empty">{ready && !loaded && !error && !loadError ? 'Finding your recent work…' : 'Saved investigations, drafts, and books in progress will appear here.'}</p>}
  </section>
}
