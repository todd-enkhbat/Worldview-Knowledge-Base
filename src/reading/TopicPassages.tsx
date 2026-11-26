import { ArrowUpRight, BookOpen, LinkSimple, Quotes } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { useBookshelf } from '../bookshelf/store.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { useQuoteLibrary } from '../quotes/store.ts'
import { conceptReferences, type ConceptReference } from './conceptReferences.ts'
import { usePersonalLibrary } from './personalLibrary.ts'
import { updateTopic, useReading } from './store.ts'
import type { CanonicalTopic } from './topics.ts'

type Filter = 'all' | 'note' | 'quote'
const when = (value: number) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
function ReferenceRow({ reference }: { reference: ConceptReference }) {
  const [first, ...rest] = reference.excerpts
  const quoted = reference.kind === 'quote' || first.relation === 'Quoted in this note'
  const Icon = reference.kind === 'quote' ? Quotes : BookOpen
  return <article className="concept-reference">
    <a href={first.href} className="concept-reference-main">
      <Icon size={19} aria-hidden="true" />
      <div><div className="concept-reference-heading"><strong>{reference.title}</strong><ArrowUpRight size={14} aria-hidden="true" /></div>
        <small>{reference.detail}</small>
        {quoted ? <blockquote>{first.text}</blockquote> : first.text.trim() !== reference.title.trim() && <p>{first.text}</p>}
        <footer><span>{first.relation}</span><time dateTime={new Date(reference.at).toISOString()}>{when(reference.at)}</time></footer>
      </div>
    </a>
    {!!rest.length && <details className="concept-extra"><summary>{rest.length} more {rest.length === 1 ? 'passage' : 'passages'}</summary>
      {rest.map((passage, i) => <a key={i} href={passage.href}><small>{passage.relation}</small><span>{passage.text}</span><ArrowUpRight size={13} aria-hidden="true" /></a>)}
    </details>}
  </article>
}

export function TopicPassages({ topic, topics, writable }: { topic: CanonicalTopic; topics: CanonicalTopic[]; writable: boolean }) {
  const { writings, sources, nodes } = usePersonalLibrary(), versions = useKnowledge(s => s.versions), books = useBookshelf(s => s.books)
  const quotes = useQuoteLibrary(), reading = useReading()
  const [alias, setAlias] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false)
  const [filter, setFilter] = useState<Filter>('all'), [limit, setLimit] = useState(10)
  const { items, notes, highlights, pdfHighlights } = reading
  const references = useMemo(() => conceptReferences(topic, topics, { docs: writings, sources, nodes, versions, books, quotes: quotes.library.quotes, reading: { items, notes, highlights, pdfHighlights } }),
    [topic, topics, writings, sources, nodes, versions, books, quotes.library.quotes, items, notes, highlights, pdfHighlights])
  const noteCount = references.filter(ref => ref.kind === 'note').length
  const options = [{ id: 'all', label: 'All', count: references.length }, { id: 'note', label: 'Notes', count: noteCount }, { id: 'quote', label: 'Quotes', count: references.length - noteCount }] as const
  const visible = filter === 'all' ? references : references.filter(ref => ref.kind === filter)
  async function addAlias() {
    if (saving || !writable || !topic.readingTopicIds[0]) return
    setSaving(true); setError('')
    try { await updateTopic(topic.readingTopicIds[0], { name: topic.name, aliases: [...(topic.terms ?? []), alias.trim()] }); setAlias('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }
  return <section className="topic-passage-list" aria-label="Concept backlinks">
    <header className="concept-list-header"><h3><LinkSimple size={18} />Backlinks</h3>
      {!!references.length && <div className="concept-reference-filters" role="group" aria-label="Filter backlinks">
        {options.map(option => <button type="button" key={option.id} aria-pressed={filter === option.id} onClick={() => { setFilter(option.id); setLimit(10) }}>{option.label} <span>{option.count}</span></button>)}
      </div>}
    </header>
    {quotes.error && <p className="knowledge-error" role="alert">Saved quotations could not be loaded. {quotes.error}</p>}
    {visible.slice(0, limit).map(ref => <ReferenceRow reference={ref} key={ref.id} />)}
    {!visible.length && <p className="topic-empty-copy">{!quotes.loaded && !quotes.error ? 'Opening references…' : filter === 'quote' ? 'No saved quotations mention this concept yet.' : filter === 'note' ? 'No notes mention this concept yet.' : 'Use this name in a note or save a quotation containing it. Its passage and source will appear here.'}</p>}
    {visible.length > limit && <button className="knowledge-button" onClick={() => setLimit(v => v + 20)}>Show more backlinks</button>}
    {(!!topic.terms?.length || writable && !!topic.readingTopicIds.length) && <details className="concept-aliases"><summary>Concept aliases{topic.terms?.length ? ' · ' + topic.terms.join(', ') : ''}</summary>
      {writable && !!topic.readingTopicIds.length && <form onSubmit={e => { e.preventDefault(); void addAlias() }}><label>Another name<input value={alias} maxLength={160} placeholder="Alternate spelling or name" onChange={e => setAlias(e.target.value)} /></label><button className="knowledge-button" disabled={!alias.trim() || saving}>Add alias</button></form>}
      {error && <p role="alert">{error}</p>}
    </details>}
  </section>
}
