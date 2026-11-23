import { useEffect, useState } from 'react'
import { getStore, getWorldGeneration, isRepoReady } from '../data/repo.ts'
import { readWorldSnapshot } from '../data/worldSnapshot.ts'
import { useWorld } from '../app/store.ts'
import { initializeCollections, useCollections, type SavedInvestigation } from '../workspace/collections.ts'
import { buildPortableKnowledge, investigationBase, investigationCanvas } from '../knowledge/portability.ts'
import { zipVault } from '../data/obsidian.ts'
import { downloadKnowledgeFile } from './SourcesVoiceInbox.tsx'
import type { KnowledgeSnapshot } from '../knowledge/types.ts'
import './knowledgeCapture.css'

export function PortabilityControls() {
  const investigations = useCollections((state) => state.collections)
  const [selected, setSelected] = useState('all'), [format, setFormat] = useState('zip')
  const [history, setHistory] = useState(false), [aiOnly, setAiOnly] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { void initializeCollections() }, [])
  async function save() {
    setBusy(true); setError('')
    try {
      const store = getStore(), generation = getWorldGeneration()
      const world = await readWorldSnapshot(store, ['knowledge.v1', 'collections.v1'])
      if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) throw new Error('The active workspace changed before export completed.')
      const snapshot = world.kv['knowledge.v1'] as KnowledgeSnapshot | undefined
      if (!snapshot) throw new Error('Capture or import a source before exporting knowledge.')
      const collection = (world.kv['collections.v1'] as { collections?: SavedInvestigation[] } | undefined)?.collections?.find((item) => item.id === selected && !item.deletedAt)
      if (selected !== 'all' && !collection) throw new Error('This saved investigation is no longer available.')
      const options = { ...(collection?.sourceIds.length ? { sourceIds: collection.sourceIds } : {}), includeHistory: history, aiOnly, records: [...useWorld.getState().nodes.values()] }
      const files = buildPortableKnowledge(snapshot, collection ? [collection] : [], options)
      const sourceIds = new Set(snapshot.sources.filter((source) => !source.deleted && !source.excluded && (!aiOnly || source.aiAllowed) && (!options.sourceIds || options.sourceIds.includes(source.id))).map((source) => source.id))
      const sources = snapshot.sources.filter((source) => sourceIds.has(source.id))
      const investigation: SavedInvestigation = collection ?? { id: 'all-record', title: 'Worldview record', query: '', questions: [], sourceIds: [...sourceIds], role: 'all', sourceKind: 'all', authoredAfter: '', authoredBefore: '', updatedAt: Date.now() }
      if (format === 'zip') downloadKnowledgeFile(new Blob([zipVault(files).slice()], { type: 'application/zip' }), 'Worldview-portable.zip')
      else if (format === 'json') downloadKnowledgeFile(new Blob([files.get('worldview-sources.json')!], { type: 'application/json' }), 'worldview-sources.json')
      else if (format === 'canvas') downloadKnowledgeFile(new Blob([investigationCanvas(investigation, sources, options.records)], { type: 'application/json' }), 'Worldview-investigation.canvas')
      else downloadKnowledgeFile(new Blob([investigationBase(investigation)], { type: 'text/yaml' }), 'Worldview-investigation.base')
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  return <section className="knowledge-capture-section" aria-labelledby="portable-knowledge-title"><h2 id="portable-knowledge-title">Portable knowledge</h2><p>Export readable Markdown, an editable Canvas investigation and a conservative Bases view. Exact retained text and source/version/passage identities travel in the JSON manifest. Binary originals and complete recovery state remain in verified backups.</p><div className="knowledge-capture-controls"><label>Source scope <select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="all">All included sources</option>{investigations.filter((item) => !item.deletedAt).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>Format <select value={format} onChange={(event) => setFormat(event.target.value)}><option value="zip">Markdown + Canvas + Bases ZIP</option><option value="json">Reimportable source JSON</option><option value="canvas">Canvas map</option><option value="base">Bases view</option></select></label><label><input type="checkbox" checked={history} onChange={(event) => setHistory(event.target.checked)} /> Retain source history</label><label><input type="checkbox" checked={aiOnly} onChange={(event) => setAiOnly(event.target.checked)} /> Only sources allowed for AI</label><button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Preparing export…' : 'Download knowledge'}</button></div><p className="knowledge-capture-muted">Canvas XY is independent of your 3D world. Reimport worldview-sources.json through Import files. ZIP text exports are limited to 64 MiB; use folder backups for larger records.</p>{error && <p role="alert">{error}</p>}</section>
}
