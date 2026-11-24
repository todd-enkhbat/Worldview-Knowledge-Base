import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowCounterClockwise, ClockCounterClockwise, Plus, X } from '@phosphor-icons/react'
import { getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { useKnowledge } from '../knowledge/index.ts'
import { plainTextFromWriting, validateWritingDocument } from './model.ts'
import { readWritingHistory, WRITING_HISTORY_KV, type WritingRevision } from './history.ts'
import { restoreWritingPublishedVersion, restoreWritingRevision, saveWritingSnapshot, useWriting } from './store.ts'
import type { WritingDocument } from './types.ts'

export function WritingHistoryPanel({ document, flush, onRestored, onClose, onBusyChange }: { document: WritingDocument; flush: () => Promise<void>; onRestored: (document: WritingDocument) => void; onClose: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [entries, setEntries] = useState<WritingRevision[]>([]), [selected, setSelected] = useState(''), [name, setName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const alive = useRef(true), busyCallback = useRef(onBusyChange)
  busyCallback.current = onBusyChange
  useEffect(() => { alive.current = true; return () => { alive.current = false; busyCallback.current?.(false) } }, [])
  const versions = useKnowledge((state) => state.versions), writer = useRepoStatus((state) => state.writer)
  useEffect(() => {
    let alive = true
    const store = getStore(), generation = getWorldGeneration()
    const current = () => alive && getStore() === store && getWorldGeneration() === generation
    let sequence = 0
    const refresh = () => { const request = ++sequence; void readWritingHistory(store).then((history) => { if (current() && request === sequence) setEntries(history.entries.filter((entry) => entry.documentId === document.id)) }).catch((cause) => { if (current() && request === sequence) setError(cause instanceof Error ? cause.message : String(cause)) }) }
    refresh()
    const stop = subscribeRepo((change) => { if (change.type === 'kv' && change.keys.includes(WRITING_HISTORY_KV)) refresh() })
    return () => { alive = false; stop() }
  }, [document.id])
  const timeline = useMemo(() => {
    const publications: WritingRevision[] = []
    for (const version of versions) {
      if (version.sourceId !== document.sourceId || version.metadata?.writingDocumentId !== document.id) continue
      const metadata = version.metadata
      try {
        const saved = validateWritingDocument({ ...document, title: metadata.title, subtitle: metadata.subtitle ?? '', byline: metadata.byline ?? '', content: metadata.content, appearance: metadata.appearance, format: metadata.writingFormat ?? document.format, topicIds: metadata.topicIds ?? [] })
        publications.push({ id: `published:${version.id}`, documentId: document.id, createdAt: version.createdAt, label: 'Saved to Library', kind: 'named', document: saved })
      } catch { /* A non-writing legacy source is not an editable rich snapshot. */ }
    }
    return [...entries, ...publications].sort((a, b) => b.createdAt - a.createdAt)
  }, [entries, versions, document])
  const compared = timeline.find((entry) => entry.id === selected)
  const before = compared ? plainTextFromWriting(compared.document.content) : ''
  const now = plainTextFromWriting(document.content)
  async function action(task: (assertCurrent: () => void) => Promise<void>) {
    const store = getStore(), generation = getWorldGeneration()
    const assertCurrent = () => { if (!alive.current || !isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) throw new Error('The workspace changed. Reopen version history before continuing.') }
    setBusy(true); busyCallback.current?.(true); setError(''); setNotice('')
    try { assertCurrent(); await task(assertCurrent) } catch (cause) { if (getStore() === store && getWorldGeneration() === generation) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { busyCallback.current?.(false); if (alive.current && getStore() === store && getWorldGeneration() === generation) setBusy(false) }
  }
  return <aside className="writing-design writing-history" aria-label="Version history"><header><h3><ClockCounterClockwise size={17} />Version history</h3><button type="button" className="knowledge-icon-button" aria-label="Close version history" onClick={onClose}><X size={18} /></button></header><p>Keep a milestone. Compare an earlier draft. Restoring saves your current work first.</p>
    <form onSubmit={(event) => { event.preventDefault(); if (!name.trim()) return; void action(async (assertCurrent) => { await flush(); assertCurrent(); const saved = await saveWritingSnapshot(document.id, name); assertCurrent(); if (saved) setEntries((items) => items.some((item) => item.id === saved.id) ? items : [...items, saved]); setName(''); setNotice('Named snapshot saved.') }) }}><label htmlFor="writing-snapshot-name">Name a snapshot</label><div><input id="writing-snapshot-name" value={name} maxLength={160} onChange={(event) => setName(event.target.value)} placeholder="Before the final edit…" /><button type="submit" className="knowledge-icon-button" aria-label="Save named snapshot" disabled={!writer || busy || !name.trim()}><Plus size={17} /></button></div></form>
    {error && <p className="knowledge-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="writing-timeline">{timeline.map((entry) => <button key={entry.id} type="button" className={selected === entry.id ? 'is-selected' : ''} aria-pressed={selected === entry.id} onClick={() => setSelected(entry.id)}><strong>{entry.label}</strong><span>{new Date(entry.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span><small>{entry.document.title || 'Untitled writing'}</small></button>)}{!timeline.length && <p>Your first edit creates an automatic checkpoint. Name a snapshot whenever you reach a milestone.</p>}</div>
    {compared && <section className="writing-version-compare" aria-label="Compare writing versions"><h4>{compared.label}</h4><dl><div><dt>Title</dt><dd>{compared.document.title === document.title ? 'Unchanged' : `${compared.document.title} → ${document.title}`}</dd></div><div><dt>Text</dt><dd>{before === now ? 'Unchanged' : 'Different from your current draft'}</dd></div><div><dt>Design</dt><dd>{JSON.stringify(compared.document.appearance) === JSON.stringify(document.appearance) ? 'Unchanged' : 'Changed'}</dd></div></dl><details><summary>Read this version</summary><div className="writing-compare-columns"><div><strong>Then</strong><pre>{before.slice(0, 30000) || 'Empty page'}</pre></div><div><strong>Now</strong><pre>{now.slice(0, 30000) || 'Empty page'}</pre></div></div></details><button type="button" className="knowledge-button" disabled={!writer || busy} onClick={() => void action(async (assertCurrent) => { await flush(); assertCurrent(); const latest = useWriting.getState().docs.find((entry) => entry.id === document.id); if (!latest) throw new Error('Reopen the writing before restoring.'); const restored = compared.id.startsWith('published:') ? await restoreWritingPublishedVersion(document.id, compared.id.slice(10), latest.updatedAt) : await restoreWritingRevision(document.id, compared.id, latest.updatedAt); assertCurrent(); onRestored(restored); setNotice('Version restored. Your previous draft is kept in history.') })}><ArrowCounterClockwise size={15} />{busy ? 'Restoring…' : 'Restore this version'}</button></section>}
  </aside>
}
