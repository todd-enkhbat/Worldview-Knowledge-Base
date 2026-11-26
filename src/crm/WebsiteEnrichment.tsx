import { useEffect, useRef, useState } from 'react'
import { crmMessage } from './client.ts'
import { profileCapturePost } from './ProfileCaptureClient.ts'
import type { CrmCompany, CrmPerson } from './types.ts'

interface Suggestion { name: string; description: string; url: string; sourceUrl: string }
interface Receipt { status: 'saved' | 'review'; message?: string; draftId: string; sourceNotice?: string; record?: CrmCompany | CrmPerson }
export function WebsiteEnrichment({ type, name, initialUrl = '', targetId, groupId, disabled, onSaved }: { type: 'person' | 'company'; name: string; initialUrl?: string; targetId?: string; groupId?: string; disabled: boolean; onSaved?: (record: CrmCompany | CrmPerson) => void }) {
  const [url, setUrl] = useState(initialUrl), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [draft, setDraft] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [chosen, setChosen] = useState<Suggestion | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const last = useRef({ key: '', id: '' })
  async function discover() {
    setBusy(true); setMessage(''); setDraft(''); setSuggestions([]); setChosen(null)
    try {
      const result = await profileCapturePost<{ suggestions: Suggestion[] }>('discover', { entityType: type, name })
      if (!mounted.current) return
      setSuggestions(result.suggestions)
      if (!result.suggestions.length) setMessage('No official website found. You can paste a known profile URL.')
    } catch (error) { setMessage(crmMessage(error)) } finally { setBusy(false) }
  }
  async function enrich() {
    setBusy(true); setMessage(''); setDraft('')
    const website = /^https?:\/\//i.test(url.trim()) ? url.trim() : 'https://' + url.trim()
    const key = JSON.stringify([website, targetId, groupId, type, name, chosen?.sourceUrl])
    if (last.current.key !== key) last.current = { key, id: crypto.randomUUID() }
    try {
      const result = await profileCapturePost<Receipt>('enrich-url', { requestId: last.current.id, url: website, type, targetId, groupId, name, wikidataSourceUrl: chosen?.url === website ? chosen.sourceUrl : undefined })
      if (!mounted.current) return
      if (result.status === 'saved' && result.record) {
        setMessage(result.sourceNotice || 'Profile saved.'); onSaved?.(result.record)
      } else { setDraft(result.draftId); setMessage(result.message || 'Review the captured profile.') }
      last.current.key = ''
    } catch (error) { setMessage(crmMessage(error)) } finally { setBusy(false) }
  }
  return <section className="crm-website-enrichment"><label>Public profile URL<input value={url} disabled={busy || disabled} placeholder="https://…" onChange={e => { setUrl(e.target.value); setChosen(null) }} /></label>
    <div><button type="button" className="crm-button" disabled={busy || disabled || !url.trim()} onClick={() => void enrich()}>{busy ? 'Checking…' : targetId ? 'Enrich from website' : groupId ? 'Capture and add to group' : 'Capture profile'}</button>
    {name.trim() && <button type="button" className="crm-link-button" disabled={busy || disabled} onClick={() => void discover()}>Find website on Wikidata</button>}</div>
    {suggestions.map(item => <div className="crm-website-option" key={item.sourceUrl + item.url}><a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.name}</a><small>{item.description}</small><button className="crm-link-button" type="button" disabled={busy || disabled} onClick={() => { setUrl(item.url); setChosen(item) }}>{item.url}</button></div>)}
    {message && <p role="status">{message} {draft && <a href={'#/people?capture=' + encodeURIComponent(draft)}>Review capture</a>}</p>}
  </section>
}
