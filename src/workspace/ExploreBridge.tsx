import { useEffect, useRef, useState } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import { useRepoStatus } from '../data/repo.ts'
import { eligibleEvidence } from '../knowledge/evidencePolicy.ts'
import { initializeKnowledge, useKnowledge } from '../knowledge/index.ts'
import { flyTo, getOrbitControls } from '../world/camera/flyTo.ts'
import { getPoseTable } from '../world/poses.ts'
import { ensurePlayhead, seekPlayhead } from '../world/time/clock.ts'
import { historyStepForRecord } from './history.ts'
import { passageHref, searchReturnHref } from './routes.ts'
import { useWorkspace } from './state.ts'
import './exploreContext.css'

/** Wait for the new canvas's controls/poses before focusing a record from the reader. */
export default function ExploreBridge({ hash }: { hash: string }) {
  const ready = useWorld((s) => s.loaded && s.settings?.firstRunComplete === true)
  const repoReady = useRepoStatus((state) => state.ready)
  const nodes = useWorld((s) => s.nodes)
  const corpus = useKnowledge()
  const returnHash = useWorkspace((state) => state.returnHash)
  const context = useWorkspace((state) => state.exploreContext)
  const id = new URLSearchParams(hash.split('?')[1] ?? '').get('record')
  const node = id ? nodes.get(id) : null
  const [loadError, setLoadError] = useState(false)
  const handled = useRef<string | null>(null)
  useEffect(() => {
    if (!repoReady || !id) return
    let active = true
    void initializeKnowledge().catch(() => { if (active) setLoadError(true) })
    return () => { active = false }
  }, [repoReady, id])
  useEffect(() => {
    if (!ready || !id || !node || handled.current === id) return
    const settings = useWorld.getState().settings!
    const app = useApp.getState()
    // This is a new canvas reached from a record link; an old walk/flight/interior rig
    // must not prevent its orbit controls from mounting. In-canvas handoffs keep their guards.
    if (app.mode !== 'orbit' && !app.setMode('orbit')) useApp.setState({ mode: 'orbit', prevMode: 'orbit' })
    app.focus(null)
    let frame = 0
    let attempts = 0
    const focus = () => {
      if (getOrbitControls() && getPoseTable().index.has(id)) {
        // Initialize the shared clock first: its first canvas frame must not undo a seek
        // requested from the reader. Births use the shared integer mapping, without ceil.
        const now = Date.now()
        const current = ensurePlayhead(settings, now)
        const target = historyStepForRecord(current, node.temporalOrigin, settings, now)
        if (target !== current) { useApp.getState().setClock({ playing: false }); seekPlayhead(target) }
      }
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      if (getOrbitControls() && getPoseTable().index.has(id) && flyTo(id, reduceMotion ? { distance: 32, transition: false } : { distance: 32 })) {
        useApp.getState().select(id)
        handled.current = id
      } else if (++attempts < 300) frame = requestAnimationFrame(focus)
    }
    frame = requestAnimationFrame(focus)
    return () => cancelAnimationFrame(frame)
  }, [ready, id, node])

  if (!ready || !id) return null
  const scope = context?.recordId === id ? context : null
  const scopedSources = scope?.sourceIds ?? []
  const filters = { includeHistory: true, sourceIds: scopedSources.length ? scopedSources : undefined }
  const eligible = (passageId: string) => {
    const passage = corpus.passages.find((candidate) => candidate.id === passageId)
    return passage && eligibleEvidence(corpus, passage, filters) ? passage : null
  }
  const selectedPassage = scope?.passageId ? eligible(scope.passageId) : null
  const availableSources = corpus.sources.filter((source) => scopedSources.includes(source.id) && !source.deleted && !source.excluded)
  const relationships = corpus.proposals.flatMap((proposal) => {
    if (proposal.status === 'rejected' || !proposal.evidencePassageIds.length) return []
    const otherId = proposal.sourceNodeId === id ? proposal.targetNodeId : proposal.targetNodeId === id ? proposal.sourceNodeId : null
    const other = otherId && nodes.get(otherId)
    if (!other) return []
    const passages = proposal.evidencePassageIds.map(eligible)
    if (passages.some((passage) => !passage)) return []
    return [{ ...proposal, other, passages }]
  })
  return <details className="world-research-context" data-label-avoid>
    <summary>Research context</summary>
    <div className="world-research-content">
      <strong>{node?.title ?? 'Record unavailable'}</strong>
      {node && <p>Explore opens around this record. Evidence-backed relationships are listed below.</p>}
      {scopedSources.length > 0 && <p>{availableSources.length} of {scopedSources.length} selected sources available</p>}
      {selectedPassage && <a href={passageHref(selectedPassage.id, !!searchReturnHref(returnHash))}>Read the selected passage</a>}
      {node && (loadError || corpus.error ? <p role="status">Relationship evidence could not be loaded.</p> : !corpus.loaded ? <p role="status">Loading relationship evidence…</p> : relationships.length ? <ul>
        {relationships.map((relationship) => <li key={relationship.id}>
          <h3>{relationship.other.title}</h3>
          <p>{relationship.status === 'accepted' ? 'Accepted connection · ' : 'Suggested connection · '}{relationship.explanation}</p>
          <div>{relationship.passages.map((passage) => passage && <a key={passage.id} href={passageHref(passage.id, !!searchReturnHref(returnHash))}>{passage.title}</a>)}</div>
        </li>)}
      </ul> : <p>There are no eligible relationships with cited evidence for this record.</p>)}
      <a href={returnHash}>Return to your record</a>
      {searchReturnHref(returnHash) && <a href="#/search">Return to search</a>}
    </div>
  </details>
}
