import { useEffect, useRef, useState, type FormEvent } from 'react'
import { getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { initializeCollections, useCollections } from '../workspace/collections.ts'
import './telegramCapture.css'

interface Status { configured: boolean; enabled: boolean; phase: string; bot: { id: number; username?: string } | null; userIds: number[]; chatIds: number[]; projectId: string | null; ownMessages: boolean; autoTranscribe: boolean; acknowledge: boolean; language: string; transcriptionAvailable: boolean; lastPollAt: number | null; lastError: string | null; receipts: { id: string; title: string; status: string; createdAt: number; sourceId: string; voiceEntryId?: string; error?: string }[] }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const parseIds = (value: string) => { const values = value.split(/[\s,]+/).filter(Boolean).map(Number); if (values.some((id) => !Number.isSafeInteger(id) || id === 0)) throw new Error('Enter Telegram numeric IDs separated by commas.'); return [...new Set(values)] }
async function request(action = '', body?: unknown, method = body ? 'POST' : 'GET') {
  const response = await fetch(`/api/capture/telegram${action ? `/${action}` : ''}`, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-wv-client': 'workspace-telegram' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error ?? 'The Telegram connector is unavailable.')
  return value
}

export function TelegramCaptureControls() {
  const writer = useRepoStatus((s) => s.writer), collections = useCollections((s) => s.collections)
  const [status, setStatus] = useState<Status | null>(null), [token, setToken] = useState(''), [users, setUsers] = useState(''), [chats, setChats] = useState(''), [project, setProject] = useState(''), [language, setLanguage] = useState('')
  const [ownMessages, setOwnMessages] = useState(false), [automatic, setAutomatic] = useState(false), [acknowledge, setAcknowledge] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [candidates, setCandidates] = useState<{ userId: number; chatId: number; chatType: string }[]>([])
  const initialized = useRef(false), mounted = useRef(true)
  const scope = () => ({ store: isRepoReady() ? getStore() : null, generation: getWorldGeneration() })
  const current = (value: ReturnType<typeof scope>) => mounted.current && isRepoReady() && value.store === getStore() && value.generation === getWorldGeneration()
  function apply(value: Status, fields = false) {
    setStatus(value)
    if (fields || !initialized.current) { setUsers(value.userIds.join(', ')); setChats(value.chatIds.join(', ')); setProject(value.projectId ?? ''); setLanguage(value.language); setOwnMessages(value.ownMessages); setAutomatic(value.autoTranscribe); setAcknowledge(value.acknowledge); initialized.current = true }
  }
  useEffect(() => {
    mounted.current = true
    let active = true
    const load = () => { const store = isRepoReady() ? getStore() : null, generation = getWorldGeneration(); void request().then((value: Status) => { if (active && isRepoReady() && store === getStore() && generation === getWorldGeneration()) apply(value) }).catch((e) => { if (active && isRepoReady() && store === getStore() && generation === getWorldGeneration()) setError(message(e)) }) }
    void initializeCollections(); load()
    const timer = window.setInterval(load, 10_000)
    const stop = subscribeRepo((change) => { if (change.type === 'wipe' || change.type === 'import') { initialized.current = false; setToken(''); setStatus(null); setCandidates([]); setNotice(''); setError(''); load() } })
    return () => { active = false; mounted.current = false; clearInterval(timer); stop() }
  }, [])
  const fields = () => ({ ...(token.trim() ? { token: token.trim() } : {}), userIds: parseIds(users), chatIds: parseIds(chats), projectId: project || null, ownMessages, autoTranscribe: automatic, acknowledge, language })
  async function configure(enabled = status?.enabled ?? false) {
    const world = scope(); setBusy(true); setError(''); setNotice('')
    try { const result = await request('', { ...fields(), enabled }); if (current(world)) { apply(result, true); setToken(''); setNotice(enabled ? 'Telegram capture is running for the selected senders and chats.' : 'Telegram settings saved. Capture is paused.') } } catch (e) { if (current(world)) setError(message(e)) } finally { if (current(world)) setBusy(false) }
  }
  async function action(name: 'probe' | 'discover' | 'poll' | 'retry', receiptId?: string) {
    const world = scope(); setBusy(true); setError(''); setNotice('')
    try {
      const result = await request(name, { ...(name === 'probe' && token.trim() ? { token: token.trim() } : {}), ...(receiptId ? { receiptId } : {}) })
      if (!current(world)) return
      if (name === 'probe') setNotice(`Connected to @${result.bot.username}.${result.webhookConfigured ? ' This bot already has a webhook; use a dedicated bot before starting capture.' : ' Ready for a sender and chat allowlist.'}`)
      else if (name === 'discover') { setCandidates(result.candidates); setNotice(result.candidates.length ? 'Choose your own sender/chat pair below. Message content was not imported.' : 'Send /start to your bot in Telegram, then check again.') }
      else { apply(result); setNotice(name === 'retry' ? 'Retained capture retried.' : 'Checked Telegram for authorized captures.') }
    } catch (e) { if (current(world)) setError(message(e)) } finally { if (current(world)) setBusy(false) }
  }
  async function disconnect() { const world = scope(); setBusy(true); setError(''); try { const result = await request('', undefined, 'DELETE'); if (current(world)) { apply(result, true); setToken(''); setNotice('Telegram capture stopped. Its saved records and originals remain in your workspace.') } } catch (e) { if (current(world)) setError(message(e)) } finally { if (current(world)) setBusy(false) } }
  const submit = (event: FormEvent) => { event.preventDefault(); void configure() }
  return <section className="knowledge-capture-section telegram-capture" aria-labelledby="telegram-capture-title"><h2 id="telegram-capture-title">Telegram inbox</h2><p>Send text, forwarded messages, voice notes or files to your dedicated bot. Allowed senders and chats feed this workspace; originals stay available. New captures appear in Library without moving your 3D world.</p>
    <p className="telegram-status" role="status">{status ? `${status.bot?.username ? `@${status.bot.username} · ` : ''}${status.phase}${status.lastPollAt ? ` · last checked ${new Date(status.lastPollAt).toLocaleTimeString()}` : ''}` : 'Checking local Telegram service…'}</p>
    <form autoComplete="off" onSubmit={submit}><div className="telegram-fields"><label>Bot token<input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={status?.configured ? 'Configured on the local service; leave blank to keep it' : 'Set TELEGRAM_BOT_TOKEN locally, or enter a BotFather token'} /></label><label>Allowed sender IDs<input value={users} onChange={(e) => setUsers(e.target.value)} placeholder="Your numeric Telegram user ID" /></label><label>Allowed chat IDs<input value={chats} onChange={(e) => setChats(e.target.value)} placeholder="Private chat ID or an explicitly selected group" /></label><label>Save into investigation<select value={project} onChange={(e) => setProject(e.target.value)}><option value="">General inbox</option>{collections.filter((item) => !item.deletedAt).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>Speech language<input value={language} maxLength={32} onChange={(e) => setLanguage(e.target.value)} placeholder="Auto, or en, es…" /></label></div><div className="telegram-checks"><label><input type="checkbox" checked={ownMessages} onChange={(e) => setOwnMessages(e.target.checked)} />Attribute my original messages to me. Forwards remain third-party.</label><label><input type="checkbox" checked={automatic} disabled={!status?.transcriptionAvailable} onChange={(e) => setAutomatic(e.target.checked)} />Transcribe received voice and video locally, including while this window is closed.</label><label><input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />Reply with a short saved receipt in the allowed chat.</label></div><div className="knowledge-capture-controls"><button disabled={!writer || busy} type="submit">Save connection</button><button disabled={!writer || busy || !users.trim() || !chats.trim() || !(status?.configured || token.trim())} type="button" onClick={() => void configure(!status?.enabled)}>{status?.enabled ? 'Pause capture' : 'Start capture'}</button><button disabled={busy || !(status?.configured || token.trim())} type="button" onClick={() => void action('probe')}>Test bot connection</button><button disabled={busy || !status?.configured || status.enabled} type="button" onClick={() => void action('discover')}>Find my sender/chat IDs</button>{status?.enabled && <button type="button" disabled={busy} onClick={() => void action('poll')}>Check now</button>}{status?.configured && <button type="button" disabled={!writer || busy} onClick={() => void disconnect()}>Disconnect</button>}</div></form>
    <p className="knowledge-capture-muted">Create a dedicated bot with BotFather, send it /start, then select your sender and chat IDs. Capture starts only after you choose both allowlists. Telegram downloads are limited to 20 MiB. Speech inference runs locally and may download its model on first use.</p>
    {candidates.length > 0 && <ul className="telegram-pairs">{candidates.map((item) => <li key={`${item.userId}:${item.chatId}`}><span>Sender {item.userId} · {item.chatType} chat {item.chatId}</span><button className="knowledge-button" disabled={!writer || busy} onClick={() => { setUsers(String(item.userId)); setChats(String(item.chatId)); setNotice('Sender/chat selected. Save the connection and start capture when ready.') }}>Use this pair</button></li>)}</ul>}
    {notice && <p role="status">{notice}</p>}{(error || status?.lastError) && <p className="knowledge-error" role="alert">{error || status?.lastError}</p>}
    {!!status?.receipts.length && <ul className="knowledge-capture-list">{status.receipts.map((receipt) => <li key={receipt.id}><div><strong>{receipt.title}</strong><span>{receipt.status} · {new Date(receipt.createdAt).toLocaleString()}</span>{receipt.error && <p>{receipt.error}</p>}</div><div className="knowledge-capture-controls"><a className="knowledge-button" href={`#/library?source=${encodeURIComponent(receipt.sourceId)}`}>Read capture</a>{(receipt.status === 'partial' || receipt.status === 'failed') && <button disabled={!writer || busy || !status.enabled} onClick={() => void action('retry', receipt.id)}>Retry retained capture</button>}</div></li>)}</ul>}
  </section>
}
