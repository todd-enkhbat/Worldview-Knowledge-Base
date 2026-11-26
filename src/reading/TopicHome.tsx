import { writingPassages } from '../writing/concepts.ts'
import { ConceptNotebookAction } from './ConceptNotebookAction.tsx'
import { TopicPassages } from './TopicPassages.tsx'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowUpRight, BookOpen, FileText, Hash, Highlighter, MagnifyingGlass, Plus, TreeStructure } from '@phosphor-icons/react'
import { useKnowledge } from '../knowledge/index.ts'
import { initializeArtifacts, useArtifacts } from '../knowledge/artifacts/index.ts'
import { useRepoStatus } from '../data/repo.ts'
import { initializeCollections, openInvestigation, useCollections } from '../workspace/collections.ts'
import { usePersonalLibrary } from './personalLibrary.ts'
import { plainTextFromWriting } from '../writing/model.ts'
import { assignTopics, createTopic, useReading } from './store.ts'
import { normalizeTopicName, resolveTopics, topicHref, topicMatches } from './topics.ts'
import './topics.css'

type View = 'overview' | 'sources' | 'highlights' | 'writing' | 'pages' | 'projects'
const failureText = (error: unknown) => error instanceof Error ? error.message : String(error)
const sourceHref = (id: string) => `#/library?source=${encodeURIComponent(id)}`
const writingHref = (id: string) => `#/write?doc=${encodeURIComponent(id)}`

/** One topic is a view over retained evidence, drafts, and explicitly scoped projects. */
export default function TopicHome({ hash }: { hash: string }) {
  const { sources, writings } = usePersonalLibrary(), versions = useKnowledge(s => s.versions), reading = useReading()
  const collections = useCollections(), artifacts = useArtifacts(), writer = useRepoStatus((state) => state.writer)
  const [query, setQuery] = useState(''), [name, setName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [sourceQuery, setSourceQuery] = useState('')
  const [sectionLimit, setSectionLimit] = useState(100)
  const params = new URLSearchParams(hash.split('?')[1] ?? ''), selectedId = params.get('topic'), requested = params.get('tab')
  const view: View = ['sources', 'highlights', 'writing', 'pages', 'projects'].includes(requested ?? '') ? requested as View : 'overview'
  useEffect(() => setSectionLimit(100), [selectedId, view])
  const topics = useMemo(() => resolveTopics(sources, reading.topics, reading.items), [sources, reading.topics, reading.items])
  const topic = topics.find((entry) => entry.id === selectedId || entry.aliases.includes(selectedId ?? ''))
  useEffect(() => { void Promise.all([initializeCollections(), initializeArtifacts()]).catch((cause) => setError(failureText(cause))) }, [])
  const included = useMemo(() => new Map(sources.filter((source) => !source.deleted && !source.excluded).map((source) => [source.id, source])), [sources])
  const related = topic ? topic.sourceIds.map((id) => included.get(id)).filter((source) => !!source) : []
  const relatedIds = new Set(related.map((source) => source.id))
  const highlights = reading.highlights.filter((entry) => relatedIds.has(entry.sourceId))
  const pdfHighlights = (reading.pdfHighlights ?? []).filter((entry) => relatedIds.has(entry.sourceId))
  const notes = reading.notes.filter((entry) => relatedIds.has(entry.sourceId))
  const drafts = topic ? writings.filter((doc) => !doc.archivedAt && (topicMatches(topic, doc.topicIds) || writingPassages(doc.content).some(passage => topicMatches(topic, [passage.topicId])) || topicMatches(topic, reading.items.find((item) => item.sourceId === `writing:${doc.id}`)?.topicIds) || !!doc.sourceId && relatedIds.has(doc.sourceId))) : []
  const pages = topic ? artifacts.pages.filter((page) => !page.archivedAt && (page.sourceIds.some((id) => relatedIds.has(id)) || normalizeTopicName(page.title) === normalizeTopicName(topic.name))) : []
  const projects = topic ? collections.collections.filter((project) => !project.deletedAt && (project.sourceIds.some((id) => relatedIds.has(id)) || normalizeTopicName(project.title) === normalizeTopicName(topic.name))) : []
  const currentVersions = new Map(versions.map((version) => [version.id, version]))
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { const entry = await createTopic(name); setName(''); location.hash = topicHref(entry.id) }
    catch (cause) { setError(failureText(cause)) } finally { setBusy(false) }
  }
  async function assign(sourceId: string, checked: boolean) {
    if (!topic) return
    setBusy(true); setError('')
    try {
      const saved = topic.readingTopicIds[0] ? { id: topic.readingTopicIds[0] } : await createTopic(topic.name)
      const assigned = useReading.getState().items.find((item) => item.sourceId === sourceId)?.topicIds ?? []
      await assignTopics(sourceId, checked ? [...new Set([...assigned, saved.id])] : assigned.filter((id) => !topic.readingTopicIds.includes(id)))
    } catch (cause) { setError(failureText(cause)) } finally { setBusy(false) }
  }
  const shownTopics = topics.filter((entry) => [entry.name, ...(entry.terms ?? [])].some(label => normalizeTopicName(label).includes(normalizeTopicName(query))))
  const tabs = [{ id: 'overview', title: 'Overview', count: null }, { id: 'sources', title: 'Sources', count: related.length }, { id: 'highlights', title: 'Highlights & notes', count: highlights.length + pdfHighlights.length + notes.length }, { id: 'writing', title: 'Writing', count: drafts.length }, { id: 'pages', title: 'Knowledge pages', count: pages.length }, { id: 'projects', title: 'Projects', count: projects.length }] as const
  const emptyTabs = tabs.filter(tab => tab.count === 0 && tab.id !== 'sources' && tab.id !== view)
  const visibleTabs = tabs.filter(tab => !emptyTabs.includes(tab))
  const tabLink = (tab: typeof tabs[number]) => <a key={tab.id} aria-current={view === tab.id ? 'page' : undefined} href={`${topicHref(topic!.id)}${tab.id === 'overview' ? '' : `&tab=${tab.id}`}`}>{tab.title}{!!tab.count && <span>{tab.count}</span>}</a>
  return <section className={'topic-home' + (topic ? ' has-concept' : '')} aria-label="Topics">
    <header className="topic-home-heading"><div><span className="reading-overline">{topic ? 'Concept' : 'Topics'}</span><h2>{topic ? topic.name : 'Your topics'}</h2><p>{topic ? 'Notes, quotations, and sources that use this concept.' : 'One home for the sources, highlights, and writing that belong together.'}</p></div><a className="knowledge-button" href="#/topics?view=projects">Saved investigations <ArrowUpRight size={14} /></a></header>
    {(error || reading.error) && <p role="alert" className="knowledge-error">{error || reading.error}</p>}
    <div className="topic-home-layout"><aside className="topic-index" aria-label="Topic index"><label className="topic-search"><MagnifyingGlass size={16} /><span className="knowledge-sr-only">Find a topic</span><input type="search" value={query} autoComplete="off" onChange={(event) => setQuery(event.target.value)} placeholder="Find a topic…" /></label><nav aria-label="Your topics">{shownTopics.slice(0, 100).map((entry) => <a key={entry.id} aria-current={topic?.id === entry.id ? 'page' : undefined} href={topicHref(entry.id)}><Hash size={16} /><span>{entry.name}</span>{entry.sourceIds.length > 0 && <small aria-label={entry.sourceIds.length + ' sources'}>{entry.sourceIds.length}</small>}</a>)}</nav>{shownTopics.length > 100 && <p>Showing 100 topics. Refine your search to find another.</p>}<form className="topic-create" onSubmit={(event) => void create(event)}><label className="knowledge-sr-only" htmlFor="topic-create-name">New topic name</label><input id="topic-create-name" value={name} maxLength={160} onChange={(event) => setName(event.target.value)} autoComplete="off" placeholder="A new idea to explore…" /><button className="knowledge-icon-button" type="submit" aria-label="Create topic" disabled={!writer || busy || !name.trim()}><Plus size={17} /></button></form></aside>
    <div className="topic-content">{selectedId && !topic ? <div className="topic-empty"><Hash size={28} /><h3>This topic is unavailable</h3><p>Choose a topic from your workspace, or create one.</p><a href="#/topics">All topics</a></div> : !topic ? <div className="topic-welcome"><Hash size={38} weight="thin" /><h3>Ideas become easier to find when they have a home.</h3><p>Select a topic to bring together its sources, your margin notes, and the pieces you’re writing. Source tags and assigned topics with the same name appear together.</p><div className="topic-overview-counts"><span><strong>{topics.length}</strong> topics</span><span><strong>{included.size}</strong> sources</span><span><strong>{reading.highlights.length + (reading.pdfHighlights?.length ?? 0)}</strong> highlights</span></div><a href="#/library" className="knowledge-button"><BookOpen size={16} />Browse your library</a></div> : <>
      <div className="topic-actions"><a href="#/topics"><ArrowLeft size={14} />All topics</a><div className="concept-actions"><ConceptNotebookAction topic={topic} disabled={!writer} /><a className="knowledge-button" href={`#/graph?topic=${encodeURIComponent(topic.id)}`}><TreeStructure size={16} />Explore connections</a></div></div>
      <div className="concept-navigation"><nav className="topic-tabs" aria-label="Topic sections">{visibleTabs.map(tabLink)}</nav>
        {!!emptyTabs.length && <details key={view} className="topic-other-sections"><summary>More sections</summary><nav aria-label="Other topic sections">{emptyTabs.map(tabLink)}</nav></details>}
      </div>
      {view === 'overview' && <TopicPassages key={topic.id} topic={topic} topics={topics} writable={writer} />}
      {(view === 'overview' && related.length > 0 || view === 'sources') && <section className="topic-section"><header><h3>Sources <span>{related.length}</span></h3><a href={`${topicHref(topic.id)}&tab=sources`}>See all <ArrowUpRight size={12} /></a></header>{related.length ? related.slice(0, view === 'overview' ? 6 : sectionLimit).map((source) => <a className="topic-row" key={source.id} href={sourceHref(source.id)}><FileText size={19} /><span><strong>{source.title}</strong><small>{currentVersions.get(source.currentVersionId)?.text.slice(0, 160)}</small></span><ArrowUpRight size={14} /></a>) : <p className="topic-empty-copy">Add a source below, or assign this topic while reading.</p>}
      {view === 'sources' && <details className="topic-assign" open={!related.length || undefined}><summary>Add or remove sources</summary><label>Find sources<input value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} autoComplete="off" placeholder="Search by title…" /></label><div>{[...included.values()].filter((source) => normalizeTopicName(source.title).includes(normalizeTopicName(sourceQuery))).slice(0, 80).map((source) => { const assigned = reading.items.find((item) => item.sourceId === source.id)?.topicIds ?? []; const chosen = topicMatches(topic, assigned), tagged = source.tags.some((tag) => normalizeTopicName(tag) === normalizeTopicName(topic.name)); return <label key={source.id}><input type="checkbox" checked={chosen || tagged} disabled={!writer || busy || tagged} onChange={(event) => void assign(source.id, event.target.checked)} /><span>{source.title}{tagged && <small>From source tag · original metadata retained</small>}</span></label> })}</div></details>}</section>}
      {(view === 'overview' && highlights.length + pdfHighlights.length + notes.length > 0 || view === 'highlights') && <section className="topic-section"><header><h3>What stood out <span>{highlights.length + pdfHighlights.length + notes.length}</span></h3><a href={`${topicHref(topic.id)}&tab=highlights`}>See all <ArrowUpRight size={12} /></a></header>{[...highlights, ...pdfHighlights].slice(0, view === 'overview' ? 4 : sectionLimit).map((entry) => <a className="topic-highlight" key={entry.id} aria-label={`Open highlighted passage from ${included.get(entry.sourceId)?.title ?? 'source'}${'page' in entry ? `, page ${entry.page}` : ''}`} href={`${sourceHref(entry.sourceId)}&version=${encodeURIComponent(entry.versionId)}${'page' in entry ? `&page=${entry.page}` : ''}`}><Highlighter size={17} aria-hidden="true" /><div><blockquote>{entry.quote}</blockquote>{entry.note && <p className="topic-highlight-comment"><span>Your comment</span>{entry.note}</p>}<small>{included.get(entry.sourceId)?.title}{'page' in entry ? ` · page ${entry.page}` : ''}</small></div></a>)}{notes.slice(0, view === 'overview' ? 2 : sectionLimit).map((note) => <a className="topic-note" key={note.id} href={sourceHref(note.sourceId)}><p>{note.text}</p><small>Your note · {included.get(note.sourceId)?.title}</small></a>)}{!highlights.length && !pdfHighlights.length && !notes.length && <p className="topic-empty-copy">Highlights and your own remarks will collect here.</p>}</section>}
      {(view === 'writing') && <section className="topic-section"><header><h3>On your writing desk <span>{drafts.length}</span></h3><a href="#/write">Writing studio <ArrowUpRight size={12} /></a></header>{drafts.slice(0, sectionLimit).map((doc) => <a className="topic-row" key={doc.id} href={writingHref(doc.id)}><FileText size={19} /><span><strong>{doc.title || 'Untitled writing'}</strong><small>{doc.subtitle || plainTextFromWriting(doc.content).slice(0, 160)}</small></span><small>{doc.sourceId ? 'In Library' : 'Draft'}</small></a>)}{!drafts.length && <p className="topic-empty-copy">Assign this topic from the writing studio’s Research panel to keep your drafts here.</p>}</section>}
      {(view === 'overview' && pages.length > 0 || view === 'pages') && <section className="topic-section"><header><h3>Knowledge pages <span>{pages.length}</span></h3><a href="#/knowledge">All pages <ArrowUpRight size={12} /></a></header>{pages.slice(0, view === 'overview' ? 4 : sectionLimit).map((page) => <a className="topic-row" key={page.id} href={`#/knowledge?page=${encodeURIComponent(page.id)}`}><BookOpen size={18} /><span><strong>{page.title}</strong><small>{page.kind} · {page.sourceIds.some((id) => relatedIds.has(id)) ? 'Shares retained sources' : 'Matches this topic name'}</small></span></a>)}{!pages.length && <p className="topic-empty-copy">Pages with the same topic name or explicitly shared sources appear here. Their evidence and review decisions remain separate.</p>}</section>}
      {(view === 'overview' && projects.length > 0 || view === 'projects') && <section className="topic-section"><header><h3>Related investigations <span>{projects.length}</span></h3><a href="#/topics?view=projects">Manage investigations <ArrowUpRight size={12} /></a></header>{projects.slice(0, view === 'overview' ? 4 : sectionLimit).map((project) => <button className="topic-row" key={project.id} onClick={() => openInvestigation(project.id)}><MagnifyingGlass size={18} /><span><strong>{project.title}</strong><small>{project.sourceIds.some((id) => relatedIds.has(id)) ? 'Explicitly scoped to related sources' : 'Matches this topic name'}</small></span><ArrowUpRight size={14} /></button>)}{!projects.length && <p className="topic-empty-copy">Investigations you scope to these sources—or name after this topic—appear here.</p>}</section>}
      {view !== 'overview' && ({ sources: related.length, highlights: Math.max(highlights.length + pdfHighlights.length, notes.length), writing: drafts.length, pages: pages.length, projects: projects.length }[view] > sectionLimit) && <button type="button" className="knowledge-button" onClick={() => setSectionLimit((limit) => limit + 100)}>Show 100 more</button>}
    </>}</div></div>
  </section>
}
