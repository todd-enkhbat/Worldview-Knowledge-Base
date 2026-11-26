import { BOOK_PUBLISHERS, verifiedPublisherEditions } from './publishers.ts'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  editionCover,
  rankedEditions,
  type EditionResult,
  type CatalogEdition,
  type CatalogWork
} from './catalog.ts'

import { readingLists } from './readingLists.ts'
import { ReadingEvidence, RecommenderDialog } from './Recommenders.tsx'
import { findEvidence, normalized, publishedEvidence, subjectOf, type BookSubject } from './recommendations.ts'
import { stageOf } from './ReadingStage.tsx'
import type { ShelfStatus } from './types.ts'
import { matchesEdition, useBookshelf } from './store.ts'
import { reviewedEdition, translationGuide } from './translationGuide.ts'

const syllabusIsbns = new Set(publishedEvidence.filter(r => r.relation === 'Assigned').map(r => r.isbn).filter(Boolean))

function Cover({ edition }: { edition: CatalogEdition }) {
  const url = editionCover(edition),
    [failed, setFailed] = useState(false)
  return url && !failed ? (
    <img loading="lazy" src={url} alt={'Cover of ' + edition.title} onError={() => setFailed(true)} />
  ) : (
    <span className="edition-paper">
      {edition.title}
      <small>{edition.publisher}</small>
    </span>
  )
}
function TranslationPick({ match, actionLabel, disabled, choose }: {
  match: NonNullable<ReturnType<typeof translationGuide>>
  actionLabel: (edition: CatalogEdition) => string
  disabled: boolean
  choose: (result: EditionResult) => Promise<void>
}) {
  const [first] = match.ranked
  const copy = reviewedEdition(match.guide, first)
  return (
    <section className="translation-guide" aria-label="Translation recommendation">
      <div className="translation-lead">
        <span className="edition-image" aria-hidden="true"><Cover edition={copy.edition} /></span>
        <div>
          <h3>{match.tied ? 'Equally supported translations' : 'Recommended translation'}</h3>
          <strong>{first.translator}</strong>
          <p>{match.guide.title} · {first.publisher} · {first.year}</p>
        </div>
      </div>
      <p>{first.reason}</p>
      <div className="translation-actions">
        <button type="button" disabled={disabled} onClick={() => void choose(copy)}>
          {actionLabel(copy.edition)}
        </button>
        <details open={match.tied || undefined}>
          <summary>Why this translation? ({first.assessments.length} {first.assessments.length === 1 ? 'source' : 'sources'})</summary>
          <p>Ranked by distinct reviewers in this guide. A joint review counts once.</p>
          {match.ranked.map((translation, index) => <div className="translation-sources" key={translation.isbn}>
            {match.ranked.length > 1 && <h4>{translation.translator}</h4>}
            {translation.assessments.map(source => <p key={source.by}>
              <a href={source.url} target="_blank" rel="noopener noreferrer">{source.by}</a>
              {' · '}{source.publication}<br />{source.judgment}
            </p>)}
            {index > 0 && <button type="button" disabled={disabled} onClick={() => void choose(reviewedEdition(match.guide, translation))}>
              {actionLabel(reviewedEdition(match.guide, translation).edition)} · {translation.translator.split(' ').at(-1)}
            </button>}
          </div>)}
        </details>
      </div>
    </section>
  )
}

export function CatalogPicker({
  initialQuery,
  disabled,
  adding,
  stage,
  onChoose
}: {
  initialQuery: string
  disabled: boolean
  adding: boolean
  stage: ShelfStatus
  onChoose: (work: CatalogWork, edition: CatalogEdition) => Promise<void>
}) {
  const [publisher, setPublisher] = useState('')
  const [limit,setLimit]=useState(24)
  const [query, setQuery] = useState(initialQuery),
    [submitted, setSubmitted] = useState(''),
    [rows, setRows] = useState<EditionResult[]>([])
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState(''),
    [more, setMore] = useState<Record<string, number>>({})
  const request = useRef<AbortController | null>(null),
    input = useRef<HTMLInputElement>(null),
    saveLock = useRef(false)
  useEffect(() => {
    input.current?.focus()
    return () => request.current?.abort()
  }, [])
  const resultsAnchor = useRef<HTMLDivElement>(null)
  async function search(event?: FormEvent, newQuery?: string, selectedPublisher = publisher) {
    event?.preventDefault()
    const fresh = !!event || newQuery !== undefined
    const phrase = newQuery ?? (event ? query.trim() : submitted),
      offsets = fresh ? { openlibrary: 0, google: 0 } : more
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    if (fresh) {
      if (newQuery !== undefined) setQuery(newQuery)
      setLimit(24);setSubmitted(phrase)
      setRows(verifiedPublisherEditions(phrase, selectedPublisher))
      setMore({})
    }
    setMessage('')
    if (fresh && findEvidence(phrase, personal).some(hit => normalized(hit.by) === normalized(phrase))) {
      setPending(false)
      return
    }
    setPending(true)
    const failures: string[] = []
    await Promise.all(
      Object.entries(offsets).map(async ([provider, offset]) => {
        try {
          const response = await fetch(
            '/api/book-catalog/visual?' + new URLSearchParams({ provider, q: phrase, offset: String(offset), ...(selectedPublisher ? { publisher: selectedPublisher } : {}) }),
            { signal: controller.signal }
          )
          if (!response.ok) throw new Error()
          const { results, nextOffset } = (await response.json()) as {
            results: EditionResult[]
            nextOffset: number | null
          }
          if (controller.signal.aborted) return
          setRows((previous) => rankedEditions([...previous, ...results], phrase))
          setMore((previous) => {
            const next = { ...previous }
            if (nextOffset != null) next[provider] = nextOffset
            else delete next[provider]
            return next
          })
        } catch {
          if (!controller.signal.aborted) failures.push(provider === 'google' ? 'Google Books' : 'Open Library')
        }
      })
    )
    if (!controller.signal.aborted) {
      setMessage(failures.length ? failures.join(' and ') + ' unavailable.' : '')
      setPending(false)
    }
  }
  async function choose({ work, edition }: EditionResult) {
    if (saveLock.current || disabled) return
    saveLock.current = true
    try {
      await onChoose(work, edition)
    } finally {
      saveLock.current = false
    }
  }
  const books = useBookshelf(s => s.books)
  function actionLabel(edition: CatalogEdition) {
    if (!adding) return 'Choose edition'
    const saved = books.find(book => !book.archivedAt && matchesEdition(book, 'book', edition.id, edition.isbn))
    return saved ? 'Open saved copy · ' + stageOf(saved.status).label : stageOf(stage).action
  }
  const personal = useBookshelf(s => s.attributions)
  const recommenders = useMemo(() => [...new Set([...readingLists.map(list => list.by), ...(personal ?? []).map(r => r.name)])].sort((a, b) => a.localeCompare(b)), [personal])
  const evidence = useMemo(() => findEvidence(submitted, personal), [submitted, personal])
  const [subject, editSubject] = useState<BookSubject | null>(null)
  const guide = translationGuide(submitted)
  const otherTranslations = guide && <TranslationPick key={submitted} match={guide} actionLabel={actionLabel} disabled={disabled} choose={choose} />
  const [inspected, inspect] = useState<EditionResult | null>(null),
    preview = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (inspected) preview.current?.showModal?.()
  }, [inspected])
  return (
    <section className="book-catalog-picker edition-picker" aria-label="Book catalog">
      <div className="edition-discovery">
      <form onSubmit={search}>
        <label htmlFor="book-catalog-query">Find your edition</label>
        <div>
          <input
            id="book-catalog-query"
            ref={input}
            type="search"
            placeholder="Title, author, publisher, ISBN or recommender"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={240}
          />
          <button disabled={disabled || query.trim().length < 2}>Search</button>
        </div>
      </form>
      <label className="reading-list-selector"><span>Publisher / series</span><select aria-label="Publisher or series" value={publisher} onChange={event => { const value = event.target.value; setPublisher(value); if (query.trim().length >= 2) void search(undefined, query.trim(), value) }}><option value="">All publishers</option>{BOOK_PUBLISHERS.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      <label className="reading-list-selector"><span>Browse reading lists</span>
        <select aria-label="Browse reading lists" value={recommenders.find(name => normalized(name) === normalized(submitted)) ?? ''}
          onChange={event => { if (event.target.value) void search(undefined, event.target.value) }}>
          <option value="" disabled>Choose a person or institution</option>
          {recommenders.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      </div>
      {evidence.length > 0 && <ReadingEvidence hits={evidence} disabled={disabled} actionLabel={actionLabel} choose={choose} edit={editSubject} find={async q => {
        await search(undefined, q)
        resultsAnchor.current?.focus()
        resultsAnchor.current?.scrollIntoView({ block: 'nearest' })
      }} />}
      {evidence.length > 0 && otherTranslations ? <details className="other-translations" key={submitted}><summary>Compare scholarly reviews</summary>{otherTranslations}</details> : otherTranslations}
      <div className="edition-status" role="status">
        {saveLock.current && disabled ? 'Saving your edition…' : pending
          ? 'Finding editions…'
          : submitted && !rows.length
            ? evidence.some(hit => normalized(hit.by) === normalized(submitted)) ? '' : guide || evidence.length ? 'No additional catalog editions found.' : 'No matching editions. Try the ISBN or identify your copy below.'
            : ''}{message && ' ' + message}
      </div>
      {submitted && !evidence.length && <a className="course-source-lookup" href={'https://www.google.com/search?' + new URLSearchParams({ q: 'site:columbia.edu syllabus ' + submitted })} target="_blank" rel="noopener noreferrer">Look for a Columbia syllabus ↗</a>}
      <div ref={resultsAnchor} tabIndex={-1} aria-label="Catalog editions" className="edition-grid">
        {rows.slice(0,limit).map(({ work, edition }) => (
          <article key={edition.id}>
            <button
              type="button"
              disabled={disabled}
              className="edition-choice"
              aria-label={
                actionLabel(edition) + ' · ' +
                [edition.title, edition.publisher, edition.translator, edition.date].filter(Boolean).join(', ')
              }
              onClick={() => void choose({ work, edition })}
            >
              <span className="edition-image">
                <Cover edition={edition} />
              </span>
              <strong>{edition.title}</strong>
              <span>
                {[edition.publisher, edition.date].filter(Boolean).join(' · ') ||
                  work.authors.map((a) => a.name).join(', ')}
              </span>
              {syllabusIsbns.has(subjectOf({ work, edition }).isbn) && <small>Matches a syllabus translation</small>}
              {edition.translator && <span>Translated by {edition.translator}</span>}
              <small>{[edition.editionLabel, edition.language, edition.isbn].filter(Boolean).join(' · ')}</small>
              {edition.representative && <small>Representative cover</small>}
              <span className="edition-save-label">{actionLabel(edition)}</span>
            </button>
            {edition.sourceUrl && <a className="edition-inspect" href={edition.sourceUrl} target="_blank" rel="noreferrer">Publisher-verified edition ↗</a>}
            <button type="button" className="edition-inspect" onClick={() => inspect({ work, edition })}>
              Inspect cover
            </button>
            <button type="button" className="edition-inspect" disabled={disabled} onClick={() => editSubject(subjectOf({ work, edition }))}>Add recommender</button>
          </article>
        ))}
      </div>
      {subject && <RecommenderDialog subject={subject} onClose={() => editSubject(null)} />}
      {inspected && (
        <dialog ref={preview} className="edition-preview" onClose={() => inspect(null)}>
          <button type="button" autoFocus onClick={() => preview.current?.close()}>
            Back to editions
          </button>
          <Cover edition={inspected.edition} />
          <h3>{inspected.edition.title}</h3>
          <p>
            {[
              inspected.edition.translator,
              inspected.edition.publisher,
              inspected.edition.date,
              inspected.edition.editionLabel,
              inspected.edition.isbn
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </dialog>
      )}
      {rows.length>limit&&<button type="button" onClick={()=>setLimit(limit+24)}>Show more matching editions</button>}
      {!pending && rows.length<=limit && Object.keys(more).length > 0 && (
        <button type="button" onClick={() => void search()}>
          More editions
        </button>
      )}
    </section>
  )
}
