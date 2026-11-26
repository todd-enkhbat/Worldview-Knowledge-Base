import { useRef, useState } from 'react'
import { crmCommand, crmGet, crmMessage, useCrmQuery, type CrmDetail } from './client.ts'
import type { ReconnectQueue as Queue } from './connectionTypes.ts'
import type { CrmPerson } from './types.ts'

export function ReconnectQueue({ writer, onSelectPerson }: { writer: boolean; onSelectPerson: (person: CrmPerson) => void }) {
  const [offset, setOffset] = useState(0), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const inFlight = useRef(false)
  const query = useCrmQuery<Queue | null>('connections/reconnect?offset=' + offset, null)
  const rows = query.data?.rows ?? []
  const choose = async (row: Queue['rows'][number], reminder: boolean) => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(row.id); setError('')
    try {
      if (reminder) {
        const due = new Date()
        due.setHours(17, 0, 0, 0)
        await crmCommand({ operation: 'create', collection: 'tasks', record: { title: 'Reconnect with ' + row.name, dueAt: due.getTime(), entityRefs: [{ type: 'person', id: row.id }] } })
        if (rows.length === 1 && offset > 0) setOffset(offset - 10)
      } else {
        const detail = await crmGet<CrmDetail>('people/' + encodeURIComponent(row.id))
        onSelectPerson(detail.record)
      }
    } catch (reason) { setError(crmMessage(reason)) }
    finally { setBusy(''); inFlight.current = false }
  }
  return <section className="crm-reconnect"><header><h3>People to reconnect with</h3><p>Last recorded interaction at least 30 days ago, with no open reminder.</p></header>
    {query.loading && !query.data ? <p>Checking recent activity…</p> : !rows.length && !query.error && <p>No contacts match on this page.</p>}
    {rows.map(row => <article key={row.id}><div><button type="button" className="crm-link-button" disabled={!!busy} onClick={() => void choose(row, false)}>{row.name}</button><small>{row.idleDays} days ago · {row.last.title} · {row.last.source}</small></div>
      <button type="button" className="crm-button" disabled={!writer || !!busy} onClick={() => void choose(row, true)}>Remind me today</button></article>)}
    {((query.data?.total ?? 0) > 10 || offset > 0) && <div className="crm-pagination"><button type="button" disabled={!offset || query.loading} onClick={() => setOffset(offset - 10)}>Previous contacts</button><button type="button" disabled={offset + 10 >= (query.data?.total ?? 0) || query.loading} onClick={() => setOffset(offset + 10)}>More contacts</button></div>}
    {!!query.data?.unavailableSources && <small>Some saved email sources are unavailable. The latest dates may be incomplete.</small>}
    {(error || query.error) && <p role="alert">{error || query.error}</p>}
  </section>
}
