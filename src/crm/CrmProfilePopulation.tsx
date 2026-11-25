import { useEffect, useRef, useState } from 'react'
import { ArrowClockwise, Camera, CheckCircle, GlobeSimple, Images, SpinnerGap } from '@phosphor-icons/react'
import { CrmDialog } from './CrmControls.tsx'
import { crmMessage } from './client.ts'
import { profileMediaPost } from './profileMediaClient.ts'
import './crmVisuals.css'

interface PopulationRow { personId: string; name?: string; status: 'updated' | 'unavailable' | 'skipped' | 'error'; downloaded?: boolean; addedLinks?: number; message?: string; notices?: string[]; error?: string }
interface PopulationResult { total: number; offset: number; nextOffset: number | null; results: PopulationRow[]; downloaded: number; updated: number; addedLinks?: number; cloudAiUsed: false }
export function CrmProfilePopulation({ groupId, groupName, disabled, onClose, onChanged }: { groupId?: string; groupName?: string; disabled: boolean; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [rows, setRows] = useState<PopulationRow[]>([]), [progress, setProgress] = useState<{ offset: number; total: number; next: number | null } | null>(null)
  const [photos, setPhotos] = useState(0), [links, setLinks] = useState(0), alive = useRef(true), flight = useRef(false), pending = useRef<{ offset: number; requestId: string } | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function populate() {
    if (disabled || flight.current) return
    const offset = progress?.next ?? 0
    const request = pending.current?.offset === offset ? pending.current : { offset, requestId: crypto.randomUUID() }
    pending.current = request; flight.current = true; setBusy(true); setError('')
    try {
      const result = await profileMediaPost<PopulationResult>('populate', { requestId: request.requestId, offset, limit: 5, discover: true, eligibleOnly: true, ...(groupId ? { groupId } : {}) })
      const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
      if (!result || !Array.isArray(result.results) || !count(result.total) || result.offset !== offset || !count(result.downloaded) || result.downloaded > result.results.length || result.addedLinks !== undefined && !count(result.addedLinks) || !(result.nextOffset === null || count(result.nextOffset) && result.nextOffset > offset && result.nextOffset <= result.total) || result.cloudAiUsed !== false) throw new Error('The profile receipt was incomplete. Retry to check the saved results.')
      pending.current = null
      if (alive.current) { setRows(previous => [...previous, ...result.results]); setPhotos(previous => previous + result.downloaded); setLinks(previous => previous + (result.addedLinks ?? result.results.reduce((sum, row) => sum + (row.addedLinks ?? 0), 0))); setProgress({ offset: result.nextOffset ?? result.total, total: result.total, next: result.nextOffset }); onChanged() }
    } catch (cause) { if (alive.current) setError(crmMessage(cause)) }
    finally { flight.current = false; if (alive.current) setBusy(false) }
  }
  const finished = progress?.next === null
  return <CrmDialog title="Bring your people into focus" wide onClose={onClose}><div className="crm-profile-population">
    <div className="crm-population-art"><Camera size={32} weight="duotone" /><div><strong>{groupName || 'Your people'}, with a fuller picture</strong><small>Real photos. Source-backed links. Originals kept on your Mac.</small></div><Images size={23} weight="duotone" /></div>
    <p>Check existing websites, imported photo references and captured profiles in batches of five. Missing photos and verified social links are filled from those sources. Your existing photo is kept. LinkedIn and other restricted profiles may need an explicit Reader capture or an upload.</p>
    <div className="crm-population-stats"><span><strong>{photos}</strong> photos saved</span><span><strong>{links}</strong> profile links added</span><span><GlobeSimple size={12} /> No cloud AI</span></div>
    {progress && <><progress className="crm-population-progress" aria-label="Profile population progress" value={progress.offset} max={Math.max(1, progress.total)} /><small>{progress.offset} of {progress.total} eligible profiles checked{finished ? ' · Finished' : ''}</small></>}
    {!!rows.length && <div className="crm-population-results" aria-label="Profile population results">{rows.map((row, index) => <div key={`${row.personId}:${index}`}><CheckCircle size={14} weight={row.status === 'updated' ? 'fill' : 'regular'} /><strong>{row.name || 'Contact'}</strong><span title={row.error || row.notices?.join(' ') || row.message}>{row.downloaded ? 'Photo saved' : row.addedLinks ? `${row.addedLinks} links added` : row.status === 'unavailable' ? 'Needs a capture or upload' : row.status === 'error' ? 'Could not retrieve' : 'Already up to date'}</span></div>)}</div>}
    {error && <p className="crm-error" role="alert">{error}</p>}
    {finished && <p role="status">This pass is complete. Unavailable photos stay empty until you capture or upload the right picture.</p>}
    <footer className="crm-dialog-actions"><button className="crm-button" onClick={onClose}>{busy ? 'Close · current batch will finish' : 'Done'}</button><button className="crm-button is-primary" disabled={disabled || busy || finished} onClick={() => void populate()}>{busy ? <SpinnerGap className="crm-person-spin" size={15} /> : <ArrowClockwise size={15} />}{busy ? 'Checking profiles…' : error ? 'Retry this batch' : progress ? 'Check next five' : 'Populate missing profiles'}</button></footer>
  </div></CrmDialog>
}
