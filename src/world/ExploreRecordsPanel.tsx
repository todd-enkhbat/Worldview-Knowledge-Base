import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowUpRight, Crosshair, MagnifyingGlass, X } from '@phosphor-icons/react'
import { useApp, useWorld } from '../app/store.ts'
import { birthStep } from '../domain/time.ts'
import { openInvestigation } from '../workspace/collections.ts'
import { EXPLORE_KINDS, type ExploreKind, type ExploreRecord } from './exploreRecords.ts'

const CHUNK = 24
const recordDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
const normalized = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim()
const kinds = Object.entries(EXPLORE_KINDS) as [ExploreKind, (typeof EXPLORE_KINDS)[ExploreKind]][]

export function ExploreRecordsPanel({ records, load, selected, onSelect, onCenter, onClose, onRetry, focusOnOpen }: {
  records: readonly ExploreRecord[]
  load: 'loading' | 'ready' | 'error'
  selected?: ExploreRecord
  onSelect: (record: ExploreRecord) => void
  onCenter: (record: ExploreRecord) => void
  onClose: () => void
  onRetry: () => void
  focusOnOpen: boolean
}) {
  const [kind, setKind] = useState<ExploreKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [atDate, setAtDate] = useState(false)
  const [page, setPage] = useState(0)
  const [error, setError] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  const results = useRef<HTMLDivElement>(null)
  const step = useApp(state => atDate ? state.clock.step : 0)
  const settings = useWorld(state => state.settings)
  const matching = useMemo(() => {
    const words = normalized(query).split(/\s+/).filter(Boolean)
    return records.filter(record => {
      if (kind !== 'all' && record.kind !== kind) return false
      if (atDate && settings && birthStep(record.date, settings.T0, settings.stepsPerYear) > step) return false
      const searchText = words.length ? normalized(record.title + ' ' + record.detail) : ''
      return words.every(word => searchText.includes(word))
    })
  }, [records, query, kind, atDate, settings, step])
  const lastPage = Math.max(0, Math.ceil(matching.length / CHUNK) - 1)
  const currentPage = Math.min(page, lastPage)
  const start = currentPage * CHUNK

  function goToPage(next: number) {
    setPage(next)
    results.current?.scrollTo({ top: 0 })
  }

  useEffect(() => { if (focusOnOpen) search.current?.focus() }, [focusOnOpen])

  return <aside className="world-records" id="world-records" aria-labelledby="world-records-title" data-label-avoid
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    }}>
    <header className="world-records-header"><div><h2 id="world-records-title">Workspace records</h2><p>{records.length.toLocaleString()} {records.length === 1 ? 'record' : 'records'} in this workspace</p></div><button type="button" className="world-records-close" aria-label="Close workspace records" onClick={onClose}><X size={18} /></button></header>
    <div className="world-records-filters">
      <label className="world-records-search"><MagnifyingGlass size={16} aria-hidden="true" /><input ref={search} name="record-search" type="search" aria-label="Find a workspace record" value={query} placeholder="Find a workspace record…" onChange={event => { setQuery(event.target.value); goToPage(0) }} /></label>
      <div><select aria-label="Record type" value={kind} onChange={event => { setKind(event.target.value as ExploreKind | 'all'); goToPage(0) }}>
        <option value="all">All types</option>{kinds.map(([value, group]) => <option key={value} value={value}>{group.label}</option>)}
      </select><label className="world-records-date"><input type="checkbox" checked={atDate} onChange={event => { setAtDate(event.target.checked); goToPage(0) }} />At timeline date</label></div>
    </div>
    {selected && <div className="world-record-focus" key={selected.key} style={{ '--record-color': EXPLORE_KINDS[selected.kind].color } as CSSProperties}>
      <span>{EXPLORE_KINDS[selected.kind].singular} · {recordDate.format(selected.date)}</span>
      <strong>{selected.title}</strong>
      {selected.detail && <small>{selected.detail}</small>}
      {selected.dateRange && <small>{selected.dateRange}</small>}
      <div>
        <button type="button" onClick={() => onCenter(selected)}><Crosshair size={16} aria-hidden="true" /> Show on map</button>
        {selected.href ? <a href={selected.href}>Open record <ArrowUpRight size={14} aria-hidden="true" /></a>
          : selected.investigationId ? <button type="button" onClick={() => {
            try { openInvestigation(selected.investigationId!) } catch { setError(true) }
          }}>Resume investigation <ArrowUpRight size={14} aria-hidden="true" /></button>
            : <button type="button" onClick={() => { if (selected.nodeId) { onClose(); useApp.getState().select(selected.nodeId) } }}>Open saved query <ArrowUpRight size={14} aria-hidden="true" /></button>}
      </div>
    </div>}
    {error && <p className="world-records-status" role="alert">The investigation is unavailable. Refresh the records and try again.</p>}
    {load !== 'ready' && <p className="world-records-status" role="status">{load === 'loading' ? 'Loading workspace records…' : <>Some records couldn’t load. <button type="button" onClick={() => { setError(false); onRetry() }}>Retry</button></>}</p>}
    <div className="world-records-results" ref={results}>
      {matching.length ? <ul aria-label="Matching workspace records">
        {matching.slice(start, start + CHUNK).map(record => <li key={record.key}><button type="button" aria-current={selected?.key === record.key ? 'true' : undefined} onClick={() => { setError(false); onSelect(record) }}>
          <i style={{ backgroundColor: EXPLORE_KINDS[record.kind].color }} aria-hidden="true" />
          <span><strong>{record.title}</strong><small>{EXPLORE_KINDS[record.kind].singular} · {recordDate.format(record.date)}</small></span><Crosshair size={16} aria-hidden="true" />
        </button></li>)}
      </ul> : load === 'ready' && <p className="world-records-status">{records.length ? 'No records match these filters.' : 'Saved thoughts, files, and other records will appear here.'}</p>}
      {lastPage > 0 && <div className="world-records-pagination">
        <button type="button" disabled={currentPage === 0} onClick={() => goToPage(currentPage - 1)}>Previous</button>
        <span>{currentPage + 1} of {lastPage + 1}</span>
        <button type="button" disabled={currentPage === lastPage} onClick={() => goToPage(currentPage + 1)}>Next</button>
      </div>}
    </div>
  </aside>
}
