import { useEffect, useRef, useState } from 'react'
import { Buildings, CheckCircle } from '@phosphor-icons/react'
import { getStore, getWorldGeneration, isRepoReady, useRepoStatus } from '../data/repo.ts'
import { CrmDialog } from './CrmControls.tsx'
import { crmGet, crmMessage, notifyCrmChanged } from './client.ts'

interface Progress {
  state: 'idle' | 'running' | 'complete'
  runId: string | null
  total: number
  processed: number
  updated: number
  completeRecords: number
  partial: number
  failed: number
}

export function CompanyPopulation({ disabled, onClose, onShowMissing }: { disabled: boolean; onClose: () => void; onShowMissing: () => void }) {
  const [pass, setPass] = useState<Progress | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  const request = useRef(''), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const data = await crmGet<Progress>('organization-enrichment', { signal: controller.signal })
        if (controller.signal.aborted) return
        setPass(data); setError('')
        if (data.state === 'running') timer = setTimeout(refresh, 2000)
        if (data.state === 'complete') notifyCrmChanged()
      } catch (cause) { if (!controller.signal.aborted) setError(crmMessage(cause)) }
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [attempt])
  async function start() {
    if (busy || disabled || !useRepoStatus.getState().writer || !isRepoReady()) return
    const store = getStore(), generation = getWorldGeneration()
    request.current ||= crypto.randomUUID()
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/crm/organization-enrichment', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-wv-client': 'people-workspace' },
        body: JSON.stringify({ requestId: request.current }),
      })
      const data = await response.json()
      if (!alive.current || !isRepoReady() || store !== getStore() || generation !== getWorldGeneration()) return
      if (!response.ok) throw new Error(data.error || 'The company lookup could not start.')
      request.current = ''; setPass(data); setAttempt(value => value + 1)
    } catch (cause) { if (alive.current) setError(crmMessage(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  const started = pass && pass.state !== 'idle'
  return <CrmDialog title="Fill company details" onClose={onClose}>
    <p className="crm-muted">Worldview checks your entire Companies list for missing websites, descriptions, and logos. It looks at saved sources, official websites, and public organization listings. Results are saved on your Mac.</p>
    {started && <section className="crm-company-progress" aria-label="Company lookup progress">
      <strong>{pass.state === 'complete' ? <CheckCircle size={17} /> : <Buildings size={17} />}{pass.state === 'complete' ? 'Scan complete' : 'Checking organizations'}</strong>
      <progress aria-label="Companies checked" value={pass.processed} max={Math.max(1, pass.total)} />
      <span role="status">{pass.processed.toLocaleString()} of {pass.total.toLocaleString()} checked · {pass.updated.toLocaleString()} updated</span>
      {pass.state === 'complete' && <small>{pass.completeRecords} with a website, description, and logo · {pass.partial} still missing details{pass.failed ? ' · ' + pass.failed + ' had a source lookup fail' : ''}</small>}
      {pass.partial > 0 && <button type="button" className="crm-link-button" onClick={onShowMissing}>View companies missing details</button>}
    </section>}
    {error && <p role="alert" className="crm-error">{error} <button className="crm-link-button" onClick={() => setAttempt(value => value + 1)}>Refresh status</button></p>}
    <footer className="crm-dialog-actions"><button className="crm-button" onClick={onClose}>Close</button>
      {pass?.state !== 'running' && <button className="crm-button is-primary" disabled={!pass || disabled || busy} onClick={() => void start()}>{busy ? 'Starting…' : pass?.state === 'complete' ? 'Check again' : 'Check all companies'}</button>}
    </footer>
  </CrmDialog>
}
