import { useEffect, useState, type FormEvent } from 'react'
import { BookmarkSimple, Plus, X } from '@phosphor-icons/react'
import { useApp } from '../app/store.ts'
import { useRepoStatus } from '../data/repo.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { ProductDialog } from '../hud/ProductDialog.tsx'
import { useWorkspace } from './state.ts'
import { addInvestigationQuestion, archiveInvestigation, initializeCollections, openInvestigation, removeInvestigationQuestion, renameInvestigation, saveInvestigation, updateInvestigationContext, useCollections, type SavedInvestigation } from './collections.ts'

const describe = (error: unknown) => error instanceof Error ? error.message : String(error)

export function SaveInvestigation() {
  const writer = useRepoStatus((s) => s.writer)
  const query = useWorkspace((s) => s.query)
  const sourceIds = useWorkspace((s) => s.sourceIds)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { const item = await saveInvestigation(title); setSaved(item.title); setOpen(false); setTitle('') } catch (e) { setError(describe(e)) } finally { setBusy(false) }
  }
  return <><button className="knowledge-button" disabled={!writer} onClick={() => { setTitle(query.slice(0, 100)); setError(''); setOpen(true) }}><BookmarkSimple size={17} />Save investigation</button>{saved && <span className="knowledge-investigation-saved" role="status">Saved “{saved}” in Projects.</span>}{open && <ProductDialog title="Save an investigation" description="Keep this question and source selection so you can pick up the same thread later." onClose={() => !busy && setOpen(false)}><form className="knowledge-investigation-form" onSubmit={(e) => void submit(e)}><label htmlFor="investigation-name">Name<input id="investigation-name" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. Storage architecture" autoFocus /></label><p>{query ? `Question: ${query}` : 'No current search question. You can add open questions later.'}</p><p>{sourceIds.length ? `${sourceIds.length} selected sources` : 'All permitted sources'} · source type, authorship and date filters are saved.</p>{error && <p role="alert" className="knowledge-error">{error}</p>}<button className="knowledge-button is-primary" disabled={!title.trim() || busy} type="submit">{busy ? 'Saving…' : 'Save investigation'}</button></form></ProductDialog>}</>
}

export function Investigations() {
  const collections = useCollections((s) => s.collections)
  const error = useCollections((s) => s.error)
  const [initialError, setInitialError] = useState('')
  useEffect(() => { void initializeCollections().catch((e) => setInitialError(describe(e))) }, [])
  const live = collections.filter((item) => !item.deletedAt)
  const archived = collections.filter((item) => item.deletedAt)
  return <section className="knowledge-investigations"><div className="knowledge-section-title"><div><h2>Projects & saved investigations</h2><p>Keep a named source scope, decisions to revisit, and open questions.</p></div><SaveInvestigation /></div>{error || initialError ? <p className="knowledge-error" role="alert">{error || initialError}</p> : null}{live.length ? <div className="knowledge-investigation-list">{live.sort((a, b) => b.updatedAt - a.updatedAt).map((item) => <Investigation key={item.id} item={item} />)}</div> : <p className="knowledge-list-empty">Save your current investigation here or from Search. Each project starts with material and questions you choose.</p>}{archived.length > 0 && <details className="knowledge-investigation-archive"><summary>Archived investigations ({archived.length})</summary>{archived.map((item) => <Investigation key={item.id} item={item} />)}</details>}</section>
}

function Investigation({ item }: { item: SavedInvestigation }) {
  const writer = useRepoStatus((s) => s.writer)
  const sources = useKnowledge((s) => s.sources)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(item.title)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selected = item.sourceIds.length ? sources.filter((s) => item.sourceIds.includes(s.id)) : sources
  const available = selected.filter((s) => !s.deleted && !s.excluded)
  async function action(work: () => Promise<void>) { setBusy(true); setError(''); try { await work() } catch (e) { setError(describe(e)) } finally { setBusy(false) } }
  const open = (question?: string) => { try { openInvestigation(item.id, question) } catch (e) { setError(describe(e)) } }
  const archive = () => void action(async () => { await archiveInvestigation(item.id); useApp.getState().pushToast({ message: `Archived ${item.title}`, undo: () => archiveInvestigation(item.id, false) }) })
  return <article className="knowledge-investigation"><div className="knowledge-section-title">{renaming ? <form className="knowledge-investigation-rename" onSubmit={(e) => { e.preventDefault(); void action(async () => { await renameInvestigation(item.id, title); setRenaming(false) }) }}><label className="knowledge-sr-only" htmlFor={`rename-${item.id}`}>Investigation name</label><input id={`rename-${item.id}`} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus /><button className="knowledge-button" type="submit" disabled={busy || !title.trim()}>Save name</button><button className="knowledge-text-button" type="button" onClick={() => setRenaming(false)}>Cancel</button></form> : <h3>{item.title}</h3>}<span>{available.length} available sources{item.sourceIds.length ? ` / ${item.sourceIds.length} selected` : ' · all sources'}</span></div>{item.query && <p className="knowledge-investigation-query">{item.query}</p>}<p className="knowledge-investigation-filters">{item.role === 'all' ? 'All authors' : item.role} · {item.sourceKind === 'all' ? 'All source types' : item.sourceKind}{item.authoredAfter || item.authoredBefore ? ` · ${item.authoredAfter || 'Any date'} – ${item.authoredBefore || 'Present'} (UTC)` : ''}</p><details className="knowledge-investigation-scope"><summary>Inspect saved source scope</summary>{item.sourceIds.length ? <ul>{item.sourceIds.map((id) => { const source = sources.find((s) => s.id === id); return <li key={id} data-source-id={id}>{source?.title ?? 'Source no longer available'}{source?.excluded ? ' · excluded' : source?.deleted ? ' · deleted' : ''}</li> })}</ul> : <p>All sources permitted by their current access policies. AI exclusions are checked again when you ask a question.</p>}</details>{!item.deletedAt && <><div className="knowledge-inline-actions"><button className="knowledge-button is-primary" onClick={() => open()}>Open investigation</button><button className="knowledge-text-button" disabled={!writer || busy} onClick={() => void action(() => updateInvestigationContext(item.id))}>Update from current scope</button><button className="knowledge-text-button" disabled={!writer || busy} onClick={() => { setTitle(item.title); setRenaming(true) }}>Rename</button><button className="knowledge-text-button" disabled={!writer || busy} onClick={archive}>Archive</button></div><div className="knowledge-open-questions"><h4>Open questions</h4>{item.questions.length ? <ul>{item.questions.map((text) => <li key={text}><button className="knowledge-text-button" onClick={() => open(text)}>{text}</button><button aria-label={`Remove question: ${text}`} className="knowledge-question-remove" disabled={!writer || busy} onClick={() => void action(() => removeInvestigationQuestion(item.id, text))}><X size={15} /></button></li>)}</ul> : <p>No open questions saved.</p>}<form onSubmit={(e) => { e.preventDefault(); void action(async () => { await addInvestigationQuestion(item.id, question); setQuestion('') }) }}><label className="knowledge-sr-only" htmlFor={`question-${item.id}`}>Add an open question to {item.title}</label><input id={`question-${item.id}`} value={question} maxLength={1000} onChange={(e) => setQuestion(e.target.value)} placeholder="Something you want to work out…" /><button className="knowledge-button" disabled={!writer || busy || !question.trim()} type="submit"><Plus size={15} />Add question</button></form></div></>}{item.deletedAt && <button className="knowledge-button" disabled={!writer || busy} onClick={() => void action(() => archiveInvestigation(item.id, false))}>Restore investigation</button>}{error && <p className="knowledge-error" role="alert">{error}</p>}</article>
}
