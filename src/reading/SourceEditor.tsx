import { useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { KnowledgeSource, SourceVersion } from '../knowledge/types.ts'
import { getStore, getWorldGeneration, useRepoStatus } from '../data/repo.ts'
import { newWritingDraft, plainTextFromWriting, useWriting } from '../writing/store.ts'
import { sourceWritingContent, sourceWritingDocument } from '../writing/sourceMarkdown.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { useWritingDraft } from '../writing/useWritingDraft.ts'
import RichEditor from '../writing/RichEditor.tsx'
import type { WritingDocument } from '../writing/types.ts'
import { createTopic, useReading } from './store.ts'
import { resolveTopics } from './topics.ts'
import { insertWritingMedia } from '../writing/media.ts'
import { QuoteCapture } from '../quotes/QuoteCapture.tsx'
import { linkSavedQuote, type QuoteSelection } from '../writing/quoteLink.ts'
import './sourceEditor.css'

/** The imported source stays available; its working document is created on the first edit. */
export default function SourceEditor({ source, version }: { source: KnowledgeSource; version: SourceVersion }) {
  const loaded = useWriting(state => state.loaded)
  const saved = useWriting(state => state.docs.find(doc => !doc.archivedAt && (doc.sourceId === source.id || doc.basedOnSourceId === source.id)))
  const archivedCopies = useWriting(state => state.docs.filter(doc => doc.archivedAt && doc.basedOnSourceId === source.id).length)
  const sources = useKnowledge(state => state.sources), versions = useKnowledge(state => state.versions)
  const working = useMemo(() => saved && sourceWritingDocument(saved, sources, versions), [saved, sources, versions])
  const initial = useMemo(() => newWritingDraft({
    title: source.title,
    content: sourceWritingContent(source, version, undefined, { sources, versions }),
    basedOnSourceId: source.id,
  }, `source-draft:${source.id}${archivedCopies ? `:${archivedCopies}` : ''}`), [source, version, archivedCopies, sources, versions])
  if (!loaded) return <p role="status">Opening document…</p>
  return <Document key={saved?.id ?? initial.id} document={working ?? initial} createOnEdit={!saved} source={source} version={version} />
}
function Document({ document, createOnEdit, source, version }: {
  document: WritingDocument; createOnEdit: boolean; source: KnowledgeSource; version: SourceVersion
}) {
  const editor = useRef<Editor | null>(null), scope = useRef({ store: getStore(), generation: getWorldGeneration() })
  const [quote, setQuote] = useState<QuoteSelection | null>(null), [notice, setNotice] = useState('')
  const sources = useKnowledge(state => state.sources), topics = useReading(state => state.topics), items = useReading(state => state.items)
  const terms = useMemo(() => resolveTopics(sources, topics, items).map(topic => ({ id: topic.id, label: topic.name, aliases: topic.terms })), [sources, topics, items])
  const writer = useRepoStatus(state => state.writer)
  const { draft, update, status, error, flush } = useWritingDraft(document, createOnEdit)
  function exportUnsaved() {
    const url = URL.createObjectURL(new Blob([draft.title + '\n\n' + plainTextFromWriting(draft.content)], { type: 'text/plain;charset=utf-8' }))
    const link = globalThis.document.createElement('a'); link.href = url; link.download = 'unsaved-document.txt'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section className="source-editor" aria-label="Editable document">
    <div className="source-editor-heading"><div className="source-editor-status"><span role="status">{!writer ? 'Read only' : status === 'dirty' ? 'Unsaved changes' : status === 'saving' ? 'Saving…' : status === 'error' ? 'Not saved' : 'Saved locally'}</span></div>
    {error && <div role="alert" className="knowledge-error">{error} <button className="knowledge-button" onClick={() => void flush().catch(() => {})}>Retry save</button> <button className="knowledge-button" onClick={exportUnsaved}>Download my changes</button></div>}
    <label className="knowledge-sr-only" htmlFor="source-document-title">Document title</label>
    <textarea id="source-document-title" className="source-editor-title" rows={1} aria-label="Document title" value={draft.title} readOnly={!writer} maxLength={300} onChange={event => update({ title: event.target.value })} /></div>
    {quote && <QuoteCapture selection={quote.text} origin={{ kind: 'article', id: source.id, title: source.title, authorship: 'unknown' }}
      initialSource={{ sourceId: source.id, versionId: version.id, title: source.title }}
      onSaved={(id, text) => setNotice(editor.current && linkSavedQuote(editor.current, quote, id, text) ? 'Quote saved and linked to this passage.' : 'Quote saved to your collection.')} onClose={() => setQuote(null)} />}
    {notice && <p role="status">{notice}</p>}
    <RichEditor onReady={value => { editor.current = value }} onUpload={(files, target) => insertWritingMedia(files, target, scope.current)}
      topics={terms} conceptActions={{ terms, resolve: createTopic, onQuote: setQuote }} ariaLabel="Document content" documentId={draft.id} variant="source" content={draft.content} editable={writer} onChange={content => update({ content })} />
  </section>
}
