import { useEffect, useState } from 'react'
type Account = { id: string; label: string; service: string }
type Item = { id: string; title: string; date: string }
export type ImportedApplication = {
  source: string
  text: string
  title: string
  date: string
  confirmation: boolean
}
async function request(action: string, body?: unknown) {
  const r = await fetch('/api/study-google/' + action, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-wv-client': 'applications', 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const data = await r.json()
  if (!r.ok) throw Error(data.error)
  return data
}
export function Discovery({ choose }: { choose: (data: ImportedApplication) => void }) {
  const [docLink,setDocLink]=useState(''),[email,setEmail]=useState(''),[auth,setAuth]=useState('')
  const [accounts, setAccounts] = useState<Account[]>([]),
    [id, setId] = useState(''),
    [terms, setTerms] = useState(''),
    [folder, setFolder] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [items, setItems] = useState<Item[]>([]),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    const load = () =>
      request('accounts')
        .then((a: Account[]) => {
          setAccounts(a)
          setId((old) => (a.some((v) => v.id === old) ? old : (a[0]?.id ?? '')))
        })
        .catch((e) => setStatus(e.message))
    void load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])
  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setStatus('')
    try {
      await fn()
    } catch (e) {
      setStatus((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <details>
      <summary>Find earlier applications in Google Drive or Gmail</summary>
      <fieldset disabled={busy}>
        <legend>Google sources</legend>
        <label>Document or tab link<input type="url" value={docLink} onChange={e=>setDocLink(e.target.value)} placeholder="Paste a Google Docs link"/></label>
        <label>Account to check (optional)<input type="email" value={email} onChange={e=>setEmail(e.target.value)}/></label>
        <button type="button" disabled={!docLink.trim()} onClick={()=>void run(async()=>choose(await request('document',{url:docLink,email,account:id})))}>Preview this document</button>
        {auth&&<a href={auth} target="_blank" rel="noopener noreferrer">Continue to Google</a>}
        {['drive', 'gmail'].map((service) => (
          <button
            type="button"
            key={service}
            onClick={() =>
              void run(async () => {
                const data = await request('connect', { service })
                setAuth(data.url);window.open(data.url, '_blank', 'noopener,noreferrer')
              })
            }
          >
            Connect {service === 'drive' ? 'Drive' : 'Gmail'}
          </button>
        ))}
        {accounts.length > 0 && (
          <>
            <label>
              Account
              <select
                value={id}
                onChange={(e) => {
                  setId(e.target.value)
                  setItems([])
                }}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} · {a.service}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Search terms
              <input value={terms} onChange={(e) => setTerms(e.target.value)} />
            </label>
            <label>
              {accounts.find((a) => a.id === id)?.service === 'gmail' ? 'Label' : 'Folder ID'}
              <input value={folder} onChange={(e) => setFolder(e.target.value)} />
            </label>
            <label>
              From
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              Through
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  const result = await request('search', { account: id, terms, folder, from, to })
                  setItems(result)
                  setStatus(result.length ? 'Choose an item to preview.' : 'No matches in this scope.')
                })
              }
            >
              Find candidates
            </button>
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() =>
                  void run(async () => choose(await request('preview', { account: id, id: item.id })))
                }
              >
                {item.title} · {item.date.slice(0, 10)}
              </button>
            ))}
          </>
        )}
      </fieldset>
      <p role="status">{busy ? 'Contacting Google…' : status}</p>
    </details>
  )
}
