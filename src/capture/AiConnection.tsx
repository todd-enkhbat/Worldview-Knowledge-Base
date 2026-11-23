import { useEffect, useState } from 'react'
import { getStore, getWorldGeneration, isRepoReady } from '../data/repo.ts'
import { setCloudAiStatus } from '../ai/chat/session.ts'

interface AiStatus { provider: 'openai' | 'anthropic' | null; model: string | null; configured: boolean; ok?: boolean; message?: string; reason?: string }

/** Checks credentials and model access without submitting any record text or generating tokens. */
export function AiConnection() {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController(), store = isRepoReady() ? getStore() : null, generation = getWorldGeneration()
    void fetch('/api/ai/status', { headers: { 'x-wv-client': 'worldview-ai-status' }, signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('AI connection status is unavailable. Restart the local service after changing its configuration.')
      const value = await response.json() as AiStatus
      if (!controller.signal.aborted && isRepoReady() && getStore() === store && getWorldGeneration() === generation) { setStatus(value); setCloudAiStatus(value) }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) { setCloudAiStatus({ provider: null, configured: false }); setError(cause instanceof Error ? cause.message : 'AI connection status is unavailable.') } })
    return () => controller.abort()
  }, [])
  async function probe() {
    if (!isRepoReady() || !status?.configured || !status.provider || busy) return
    const store = getStore(), generation = getWorldGeneration()
    const current = () => isRepoReady() && getStore() === store && getWorldGeneration() === generation
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/ai/status', { method: 'POST', headers: { 'x-wv-client': 'worldview-ai-probe' } })
      if (!response.ok) throw new Error('The connection check could not reach the authorized local service.')
      const value = await response.json() as AiStatus
      if (current()) { setStatus(value); setCloudAiStatus(value) }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'The connection check failed.') }
    finally { if (current()) setBusy(false) }
  }
  const enabled = !!status?.provider && status.configured
  return <section className="knowledge-section" aria-labelledby="cloud-ai-heading">
    <h2 id="cloud-ai-heading">Cloud AI</h2>
    <p className="knowledge-search-caption">{enabled ? `${status.provider === 'openai' ? 'OpenAI' : 'Anthropic'} · ${status.model}` : status?.provider ? 'Cloud AI was selected, but its server credential is missing.' : 'Cloud AI is off.'}</p>
    <p className="knowledge-secondary">{enabled ? 'Sending a message shares its contents and approved source context with this provider.' : 'Capture thoughts, keep originals and search your sources locally. A cloud connection is optional.'}</p>
    {enabled ? <>
      <button className="knowledge-button" disabled={busy} onClick={() => void probe()}>{busy ? 'Checking…' : 'Check key and model access'}</button>
      <p className="knowledge-secondary">This check sends no source text and generates no tokens. Generation also requires available API credit.</p>
    </> : null}
    <details className="knowledge-connection-help"><summary>{enabled ? 'Manage this connection' : 'Enable cloud AI later'}</summary>
      <p className="knowledge-secondary">In the local service’s private <code>.env.local</code>, choose <code>AI_PROVIDER=openai</code> or <code>AI_PROVIDER=anthropic</code> and configure that provider’s API key. Restart the service after changing it. Keep credentials out of browser configuration.</p>
      <p className="knowledge-secondary">To turn cloud AI off, set <code>AI_PROVIDER=none</code> and restart. Stored keys alone never enable a provider.</p>
    </details>
    {status?.message && <p role="status" className={status.ok ? 'knowledge-saved' : 'knowledge-error'}>{status.message}</p>}
    {error && <p className="knowledge-error" role="alert">{error}</p>}
  </section>
}
