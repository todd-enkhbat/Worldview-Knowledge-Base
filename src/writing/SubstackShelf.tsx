import { useEffect, useRef, useState } from 'react'
import { ArrowSquareOut, ArrowLeft, ArrowsClockwise } from '@phosphor-icons/react'
import { getStore, getWorldGeneration, isRepoReady, putWorldState, useRepoStatus } from '../data/repo.ts'
import { useAuth } from '../data/auth.ts'
import { SUBSTACK_KV, SUBSTACK_PROFILE, SUBSTACK_PUBLICATION, substackLink, type SubstackPost, type SubstackSnapshot } from './substack.ts'
import './substack.css'

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
async function request(path = '', signal?: AbortSignal) {
  const response = await fetch(`/api/connections/substack${path}`, { signal, headers: { 'x-wv-client': 'writing-substack' }, credentials: 'same-origin' }).catch(() => { throw new Error('Substack could not be reached. Try Refresh or open your profile on Substack.') })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || 'Substack could not be reached.')
  return value
}
export function SubstackShelf({ compact = false }: { compact?: boolean }) {
  const [snapshot, setSnapshot] = useState<SubstackSnapshot | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState('')
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<SubstackPost | null>(null), [body, setBody] = useState(''), [reading, setReading] = useState(false), [readError, setReadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const ready = useRepoStatus(s => s.ready), writer = useRepoStatus(s => s.writer)
  const account = useAuth(s => s.user?.id ?? 'local'), generation = getWorldGeneration()
  const heading = useRef<HTMLHeadingElement>(null), menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (!compact) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu.current?.open) { event.preventDefault(); menu.current.open = false; menu.current.querySelector('summary')?.focus() }
    }
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && menu.current?.open && !menu.current.contains(event.target)) menu.current.open = false }
    document.addEventListener('keydown', close); document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', outside) }
  }, [compact])
  useEffect(() => {
    if (!ready || !isRepoReady()) return
    const store = getStore(), activeGeneration = getWorldGeneration(), controller = new AbortController()
    const current = () => !controller.signal.aborted && isRepoReady() && getStore() === store && getWorldGeneration() === activeGeneration
    setBusy(true); setError(''); setSelected(null)
    async function load() {
      try {
        const saved = await store.getKv<SubstackSnapshot>(SUBSTACK_KV)
        if (current() && saved?.profile?.handle === 'thetallerpoppy' && Array.isArray(saved.posts)) setSnapshot(saved)
      } catch { /* A live read can still succeed if the local cache is unavailable. */ }
      try {
        const value: SubstackSnapshot = await request('', controller.signal)
        if (!current()) return
        setSnapshot(value)
        if (useRepoStatus.getState().writer) {
          try { await putWorldState(SUBSTACK_KV, value, { store, shouldWrite: current }) }
          catch { if (current()) setError('Loaded from Substack. The offline copy could not be saved; refresh to retry.') }
        }
      } catch (cause) { if (current()) setError(message(cause)) }
      finally { if (current()) setBusy(false) }
    }
    void load()
    return () => controller.abort()
  }, [ready, account, generation, refresh])
  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    setBody(''); setReadError(''); setReading(true); heading.current?.focus()
    void request(`?post=${encodeURIComponent(selected.slug)}`, controller.signal).then(value => {
      if (!controller.signal.aborted) setBody(value.text || 'This post has no public body. Open it on Substack to read more.')
    }).catch(cause => { if (!controller.signal.aborted) setReadError(message(cause)) }).finally(() => { if (!controller.signal.aborted) setReading(false) })
    return () => controller.abort()
  }, [selected])
  const profile = snapshot?.profile, photo = substackLink(profile?.photo, true)
  const posts = (snapshot?.posts ?? []).filter(post => `${post.title} ${post.subtitle} ${post.excerpt}`.toLowerCase().includes(query.toLowerCase()))
  const local = isRepoReady() && getStore().info.kind === 'sqlite', auth = useAuth(s => s.state)
  const identity = <><span className="substack-avatar">TE{photo && <img src={photo} alt="" width="36" height="36" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true }} />}</span><span><strong>{profile?.name ?? '@thetallerpoppy'}</strong><small>Substack <ArrowSquareOut size={11} /></small></span></>
  const contents = <>
    <header className="substack-shelf-header"><div><h3>Published on Substack</h3></div><a className="substack-identity" href={SUBSTACK_PROFILE} target="_blank" rel="noreferrer">{identity}</a></header>
    {profile?.bio && <p className="substack-bio">{profile.bio}</p>}
    <div className="substack-controls"><label><span className="knowledge-sr-only">Search your Substack posts</span><input type="search" placeholder="Find published writing…" value={query} onChange={event => setQuery(event.target.value)} /></label><button className="knowledge-button" type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)} aria-label="Refresh Substack"><ArrowsClockwise size={16} />{busy ? 'Checking…' : 'Refresh'}</button></div>
    {error && <p role="alert" className="knowledge-error">{error}{snapshot && ' Showing your last saved public profile and post list.'}</p>}
    {busy && !snapshot && <p role="status">Loading your public profile and writing…</p>}
    {!selected ? <div className="substack-posts">{posts.map(post => <button type="button" className="substack-post" key={post.id} onClick={() => setSelected(post)}><span>{post.date && <time dateTime={post.date}>{new Date(post.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>}<strong>{post.title}</strong><span>{post.subtitle || post.excerpt}</span></span><ArrowSquareOut size={17} /></button>)}{!busy && snapshot && !posts.length && <p>{query ? 'No matching posts. Try another search.' : 'No public posts yet. Your local drafts appear below.'}</p>}</div> : <article className="substack-reader"><button type="button" className="knowledge-button" onClick={() => setSelected(null)}><ArrowLeft size={14} />All posts</button><h4 ref={heading} tabIndex={-1}>{selected.title}</h4><p className="substack-subtitle">{selected.subtitle}</p>{reading && <p role="status">Opening your writing…</p>}{readError && <p className="knowledge-error" role="alert">{readError}</p>}{body.split(/\n+/).filter(Boolean).map((paragraph, index) => <p className="substack-reader-paragraph" key={index}>{paragraph}</p>)}<a href={substackLink(selected.url) || SUBSTACK_PROFILE} target="_blank" rel="noreferrer">Read original on Substack <ArrowSquareOut size={13} /></a></article>}
    <footer><a href={`${SUBSTACK_PUBLICATION}/archive`} target="_blank" rel="noreferrer">{snapshot?.hasMore ? 'See all posts on Substack' : 'Open Substack archive'} <ArrowSquareOut size={12} /></a>{snapshot && <small>Checked {new Date(snapshot.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</small>}</footer>
    <details className="substack-data-help"><summary>Where is my writing saved?</summary><p>{local ? auth === 'none' ? 'Your drafts and uploaded files are saved on this computer by the local Worldview service, in its workspace folder (world.sqlite and blobs/).' : 'Your drafts and uploaded files are saved on the Worldview server for this account.' : 'This workspace saves drafts in this browser’s storage. Keep the same browser and address to access them.'} Save to Library keeps a revision in Worldview.</p><p>This panel reads your public Substack profile and recent posts. A local profile and post-list copy is kept for offline browsing{writer ? ' and included in world exports' : ' when the workspace is writable'}. Reading a full post needs a connection. Private drafts, subscribers, and account access are not connected. Publishing still happens on Substack.</p><p>Export now creates a separate portable backup of Worldview. It does not upload your world to Substack. Keep a backup on another drive or backup service to protect against losing this computer.</p></details>
  </>
  return compact ? <details ref={menu} className="substack-profile-menu"><summary aria-label="Your Substack profile and published writing">{identity}</summary><section className="substack-shelf" aria-label="Your Substack">{contents}</section></details> : <section className="substack-shelf" aria-label="Your Substack">{contents}</section>
}
