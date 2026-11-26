import { useCallback, useEffect, useRef, useState } from 'react'
import { crmConnectionRequest } from '../crm/CrmConnections.tsx'
import type { CrmConnectionsStatus, CrmGoogleAccount } from '../crm/connectionTypes.ts'
import { subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { CALENDAR_PLACES_KEY, readCalendarPlaces, refreshCalendarPlaces, setCalendarSource, type CalendarPlaces } from './calendar.ts'

export function useMapCalendars() {
  const writer = useRepoStatus(s=>s.writer), [cache, setCache] = useState<CalendarPlaces>({ revision:0, accounts:[] })
  const [accounts,setAccounts] = useState<CrmGoogleAccount[]>([]), [error,setError] = useState(''), [busy,setBusy] = useState(false)
  const running = useRef(false), controller = useRef<AbortController | null>(null)
  const sync = useCallback(async (force: boolean) => {
    const signal = controller.current?.signal
    if (!signal || signal.aborted || running.current) return
    running.current = true; setBusy(true); setError('')
    try {
      const current = await readCalendarPlaces()
      if (signal.aborted) return
      setCache(current)
      const status = await crmConnectionRequest<CrmConnectionsStatus>('', undefined, signal)
      if (signal.aborted) return
      const connected = status.accounts.filter(a => a.connected && a.capabilities.includes('calendar')); setAccounts(connected)
      const failed: string[] = []
      for (const account of current.accounts) {
        if (!writer || !connected.some(a=>a.id===account.id) || (!force && Date.now()-account.syncedAt < 3600000)) continue
        try { await refreshCalendarPlaces(account.id, signal) }
        catch (e) { if (signal.aborted) return; failed.push(account.label + ' · ' + (e instanceof Error ? e.message : String(e))) }
      }
      if (!signal.aborted) setError(failed.join(' · '))
    } catch (e) { if (!signal.aborted) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (!signal.aborted) { running.current = false; setBusy(false) } }
  }, [writer])
  useEffect(() => {
    let c = new AbortController(); controller.current = c; running.current = false
    const reload = () => { const signal=c.signal; void readCalendarPlaces().then(v=>{ if (!signal.aborted) setCache(prev => v.revision >= prev.revision ? v : prev) }).catch(e=>{ if(!signal.aborted) setError(String(e)) }) }
    const stop = subscribeRepo(change=>{
      if (change.type==='wipe' || change.type==='import') {
        c.abort(); c=new AbortController(); controller.current=c; running.current=false
        setCache({revision:0,accounts:[]}); setAccounts([]); void sync(false)
      } else if (change.type==='kv' && change.keys.includes(CALENDAR_PLACES_KEY)) reload()
    })
    const update = () => { void sync(false) }
    update(); const timer = window.setInterval(update, 3600000); window.addEventListener('online',update)
    return () => { c.abort(); stop(); clearInterval(timer); window.removeEventListener('online',update) }
  }, [sync])
  async function toggle(account: Pick<CrmGoogleAccount,'id'|'label'|'email'>, enabled: boolean) {
    const signal = controller.current?.signal
    if (!signal || signal.aborted || busy) return
    try { await setCalendarSource(account,enabled); if (!signal.aborted) await sync(false) }
    catch (e) { if (!signal.aborted) setError(String(e)) }
  }
  return { cache, accounts, busy, error, sync, toggle }
}
