import { useEffect, useState } from 'react'
import { crmGet, personName, type CrmListResult } from './client.ts'
import type { CrmCompany, CrmPerson } from './types.ts'

export function ExistingRecordSuggestions({ name, email, kind, disabled, onChoose }: { name: string; email: string; kind: 'person' | 'company'; disabled: boolean; onChoose: (record: CrmPerson | CrmCompany) => void }) {
  const query = (email || name).trim(), collection = kind === 'company' ? 'companies' : 'people'
  const [result, setResult] = useState<{ query: string; rows: (CrmPerson | CrmCompany)[] }>({ query: '', rows: [] })
  useEffect(() => {
    if (query.length < 3) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void crmGet<CrmListResult<CrmCompany | CrmPerson>>(collection + '?limit=5&q=' + encodeURIComponent(query), { signal: controller.signal })
        .then(page => { if (!controller.signal.aborted) setResult({ query, rows: page.rows }) })
        .catch(() => { if (!controller.signal.aborted) setResult({ query, rows: [] }) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, collection])
  if (result.query !== query || !result.rows.length) return null
  return <div><strong>Already in your CRM</strong>{result.rows.map(row => <button type="button" className="crm-company-contact" key={row.id} disabled={disabled} onClick={() => onChoose(row)}>
    {kind === 'person' ? personName(row as CrmPerson) : String(row.name)}<small>{String(row.jobTitle || row.domain || row.emails[0] || '')}</small>
  </button>)}</div>
}
