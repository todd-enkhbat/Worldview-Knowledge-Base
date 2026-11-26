import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { BookOpen } from '@phosphor-icons/react'
import { editionCover, type CatalogEdition, type EditionResult } from './catalog.ts'
import { courseCopy, identifies, type BookSubject, type Evidence } from './recommendations.ts'
import { readingLists } from './readingLists.ts'
import { removeAttribution, safeBookUrl, saveAttribution, useBookshelf } from './store.ts'
import type { BookAttribution } from './types.ts'

export function ReadingEvidence({ hits, disabled, actionLabel, choose, edit, find }: {
  hits: Evidence[]; disabled: boolean; actionLabel: (edition: CatalogEdition) => string; choose: (row: EditionResult) => Promise<void>
  edit: (subject: BookSubject) => void; find: (query: string) => void
}) {
  const groups = new Map<string, Evidence[]>()
  for (const hit of hits) {
    const key = hit.title.replace(/^the /i, '').toLowerCase() + '|' + hit.author
    groups.set(key, [...groups.get(key) ?? [], hit])
  }
  return <div className="reading-evidence">{Array.from(groups, ([key, rows]) => {
    const versions = rows.filter(r => courseCopy(r))
    const count = (isbn: string) => new Set(versions.filter(r => r.isbn === isbn).map(r => r.by)).size
    const [lead] = versions.sort((a, b) => count(b.isbn) - count(a.isbn))
    const main = lead ?? rows[0], copy = courseCopy(main), cover = copy && editionCover(copy.edition)
    const sources = rows.filter(r => r !== main)
    const label = main.relation === 'Favorite' ? 'Favorite of' : main.relation + ' by'
    return <section key={key} className="reading-evidence-item" aria-label={'Reading evidence for ' + main.title}>
      <div className="reading-evidence-head">
        {copy && <span className="course-cover" aria-hidden="true"><BookOpen size={21} />
          {cover && <img key={cover} src={cover} alt="" onError={e => { e.currentTarget.hidden = true }} />}
        </span>}
        <div><h3>{main.title}</h3><p>{main.author}</p>
          {main.version && <strong>{main.version}{copy && ' · ' + copy.edition.year}</strong>}
        </div>
      </div>
      <p>{label} <strong>{main.by}</strong></p>
      <p>{main.url ? <a href={main.url} target="_blank" rel="noopener noreferrer">{main.context}</a> : main.context}</p>
      <div className="reading-evidence-actions">
        {copy ? <button type="button" disabled={disabled} onClick={() => void choose(copy)}>{actionLabel(copy.edition)}</button> :
          <button type="button" onClick={() => find(main.isbn || [main.title, main.author].join(' '))}>Find catalog editions</button>}
        <button type="button" disabled={disabled} onClick={() => edit({ title: main.title, author: main.author, isbn: main.isbn, editionId: copy?.edition.id ?? main.editionId ?? '' })}>Add recommender</button>
      </div>
      {sources.length > 0 && <details><summary>{sources.length} more {sources.length === 1 ? 'source' : 'sources'}</summary>
        {sources.map((r, index) => <p key={index}><strong>{r.by}</strong> · {r.relation}{r.version ? ' · ' + r.version : ' · Work as a whole'}<br />
          {r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.context}</a> : r.context}
          {r.isbn && r.isbn !== main.isbn && courseCopy(r) && <button type="button" disabled={disabled} onClick={() => void choose(courseCopy(r)!)}>{actionLabel(courseCopy(r)!.edition)}</button>}
        </p>)}
      </details>}
    </section>
  })}</div>
}

export function RecommenderDialog({ subject, onClose }: { subject: BookSubject; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), suggestions = useId()
  const personal = useBookshelf(s => s.attributions)
  const existing = personal?.filter(r => identifies(r, subject)) ?? []
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<BookAttribution['kind']>('Person')
  const [scope, setScope] = useState<BookAttribution['scope']>('work'), [relation, setRelation] = useState<BookAttribution['relation']>('Recommended')
  const [message, setMessage] = useState('')
  useEffect(() => { dialog.current?.showModal(); input.current?.focus() }, [])
  function pick(value: string) {
    setName(value)
    const known = personal?.find(r => r.name.toLowerCase() === value.toLowerCase())
    if (known) setKind(known.kind)
    else if (value.toLowerCase() === 'a16z' || value.startsWith('Columbia College') || value.startsWith('Columbia Department')) setKind('Institution')
    else setKind('Person')
  }
  async function persist(event: FormEvent) {
    event.preventDefault()
    if (busy || !name.trim()) return
    if (!safeBookUrl(url.trim())) { setMessage('Use a source link starting with https:// or http://.'); return }
    setBusy(true)
    try {
      await saveAttribution({ ...subject, isbn: scope === 'edition' ? subject.isbn : '', editionId: scope === 'edition' ? subject.editionId : '', name: name.trim(), url: url.trim(), kind, scope, relation })
      onClose()
    } catch (err) { setMessage(err instanceof Error ? err.message : 'Could not save the recommender.') }
    finally { setBusy(false) }
  }
  async function remove(id: string) {
    setBusy(true)
    try { await removeAttribution(id); setMessage('Recommender removed.') }
    catch (err) { setMessage(err instanceof Error ? err.message : 'Could not remove the recommender.') }
    finally { setBusy(false) }
  }
  return <dialog ref={dialog} className="recommender-dialog" aria-label="Add recommender" onClose={onClose}>
    <header><h3>Add recommender</h3><button type="button" aria-label="Close recommender" onClick={onClose}>×</button></header>
    <p>{subject.title}{subject.author && ' · ' + subject.author}</p>
    <form onSubmit={persist}>
      <label>Who recommended it?<input ref={input} list={suggestions} value={name} onChange={e => pick(e.target.value)} maxLength={300} required /></label>
      <datalist id={suggestions}>{[...new Set([...readingLists.map(l => l.by), ...personal?.map(r => r.name) ?? []])].map(s => <option key={s} value={s}/>)}</datalist>
      <div className="recommender-presets">{['a16z', 'Marc Andreessen', 'Francis Pedraza'].map(s => <button key={s} type="button" onClick={() => pick(s)}>{s}</button>)}</div>
      <div className="recommender-fields"><label>Source type<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option>Person</option><option>Institution</option></select></label>
      <label>Relationship<select value={relation} onChange={e => setRelation(e.target.value as typeof relation)}><option>Recommended</option><option>Assigned</option></select></label>
      {(subject.isbn || subject.editionId) && <label>Applies to<select value={scope} onChange={e => setScope(e.target.value as typeof scope)}><option value="work">Whole work</option><option value="edition">This edition</option></select></label>}</div>
      <label>Source link (optional)<input type="url" maxLength={4000} value={url} onChange={e => setUrl(e.target.value)} placeholder="Syllabus, interview or reading list" /></label>
      <button className="recommender-save" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save recommender'}</button>
    </form>
    {existing.length > 0 && <div className="existing-attributions"><h4>Your attributions</h4>{existing.map(r => <p key={r.id}>{r.name} · {r.relation} · {r.scope === 'edition' ? 'This edition' : 'Whole work'} <button disabled={busy} type="button" onClick={() => void remove(r.id)} aria-label={'Remove ' + r.name}>Remove</button></p>)}</div>}
    {message && <p role="status">{message}</p>}
  </dialog>
}
