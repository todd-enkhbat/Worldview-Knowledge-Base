import { useState } from 'react'
import { ArrowClockwise, ArrowSquareOut, Camera, CheckCircle, WarningCircle } from '@phosphor-icons/react'
import { useCrmQuery } from './client.ts'
import { CrmDialog } from './CrmControls.tsx'
import './photoCoverage.css'

interface PhotoCoverageRow { personId: string; name: string; status: 'available' | 'missing' | 'damaged' | 'missing-original'; sources: string[]; reason: string }
interface PhotoCoverage { total: number; available: number; missing: number; damaged: number; missingOriginal: number; filteredTotal: number; rows: PhotoCoverageRow[]; nextOffset: number | null }
export function PhotoCoveragePanel({ onClose, onSelect, onShowMissing }: { onClose: () => void; onSelect: (id: string) => void; onShowMissing: () => void }) {
  const [offset, setOffset] = useState(0), [status, setStatus] = useState('needs-attention')
  const coverage = useCrmQuery<PhotoCoverage | null>(`photo-coverage?limit=100&offset=${offset}&status=${status}`, null), data = coverage.data
  return <CrmDialog title="Contact photo check" wide onClose={onClose}><section className="crm-photo-coverage">
    <div className="crm-photo-coverage-total"><Camera size={30} weight="duotone" /><div><strong>{data ? `${data.available.toLocaleString()} of ${data.total.toLocaleString()}` : coverage.error ? 'Photo check unavailable' : 'Checking originals…'}</strong><span>verified photos saved on this Mac</span></div><button className="crm-icon" aria-label="Refresh photo check" onClick={coverage.refresh}><ArrowClockwise size={18} /></button></div>
    {data && <><progress aria-label="Contact photo completeness" value={data.available} max={Math.max(1, data.total)} /><div className="crm-photo-coverage-stats"><span><CheckCircle size={14} />{data.available} verified</span><span><Camera size={14} />{data.missing} need attention</span>{!!(data.damaged + data.missingOriginal) && <span><WarningCircle size={14} />{data.damaged + data.missingOriginal} originals need repair</span>}</div></>}
    <p>Open a person’s saved profile in Dia and choose <strong>Other capture options → Save contact photo only</strong> in Worldview Reader. Photos are matched to existing contacts and kept locally. For Folk groups, use Reader’s dedicated photo import. A missing photo stays visible here until a real original is saved.</p>
    <div className="crm-photo-coverage-toolbar"><label>Show<select aria-label="Photo check status" value={status} onChange={event => { setStatus(event.target.value); setOffset(0) }}><option value="needs-attention">Needs attention</option><option value="available">Verified photos</option><option value="damaged">Damaged original</option><option value="missing-original">Missing original file</option></select></label><button className="crm-button" onClick={onShowMissing}>Show missing photos in Gallery</button></div>
    {coverage.loading && <p role="status">Checking local image originals…</p>}{coverage.error && <p className="crm-error" role="alert">{coverage.error}</p>}
    <div className="crm-photo-coverage-list">{data?.rows.map(row => <button key={row.personId} onClick={() => onSelect(row.personId)}><span><strong>{row.name}</strong><small>{row.reason}</small><em>{row.sources.join(' · ') || 'No saved profile source'}</em></span><ArrowSquareOut size={15} /></button>)}</div>
    {data && <footer><span>{data.filteredTotal.toLocaleString()} contacts in this check</span><button className="crm-button" disabled={!offset || coverage.loading} onClick={() => setOffset(value => Math.max(0, value - 100))}>Previous</button><button className="crm-button" disabled={data.nextOffset === null || coverage.loading} onClick={() => setOffset(data.nextOffset!)}>Next</button></footer>}
  </section></CrmDialog>
}
