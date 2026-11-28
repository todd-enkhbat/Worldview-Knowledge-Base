import { useEffect, useState } from 'react'
import { getStore, getWorldGeneration, isRepoReady, useRepoStatus } from '../data/repo.ts'
import { importKnowledgeFiles } from '../knowledge/index.ts'

type Share = { text: string; files: File[] }

function shareMessage<T>(id: string, action: 'preview' | 'dismiss'): Promise<T | null> {
  const controller = navigator.serviceWorker?.controller
  if (!controller) return Promise.resolve(null)
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    const finish = (value: T | null) => {
      clearTimeout(timeout)
      port1.close()
      resolve(value)
    }
    const timeout = setTimeout(() => finish(null), 3000)
    port1.onmessage = (event: MessageEvent<T | null>) => finish(event.data)
    controller.postMessage({ id, action }, [port2])
  })
}

export function SharedCapture({ id }: { id: string }) {
  const writer = useRepoStatus((state) => state.writer)
  const [share, setShare] = useState<Share | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState<'complete' | 'review' | null>(null)

  useEffect(() => {
    let active = true
    void shareMessage<Share>(id, 'preview').then((data) => {
      if (!active) return
      setShare(data)
      setLoading(false)
    })
    return () => { active = false }
  }, [id])

  function close() {
    if (location.hash === `#/today?share=${id}`) location.replace('#/today')
  }

  async function save() {
    if (!share || !writer || pending || !isRepoReady()) return
    const store = getStore(), generation = getWorldGeneration()
    const isCurrent = () => isRepoReady() && getStore() === store && getWorldGeneration() === generation
    setPending(true)
    setError('')
    try {
      const files = [...share.files]
      if (share.text) files.unshift(new File([share.text], `Shared note ${id.slice(0, 8)}.txt`, { type: 'text/plain' }))
      const saved = await importKnowledgeFiles(files)
      await shareMessage(id, 'dismiss')
      if (isCurrent()) setReceipt(saved.status === 'complete' ? 'complete' : 'review')
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const hasContent = share && (share.text || share.files.length > 0)
  return <section className="knowledge-section" aria-labelledby="today-share-title">
    <div className="knowledge-section-title"><h2 id="today-share-title">Shared with Worldview</h2></div>
    {id === 'too-large' ? <p role="status">This share exceeds 24 MiB. Import it directly from Library.</p> :
      receipt ? <p role="status">{receipt === 'complete' ? 'Saved to this workspace.' : 'Some items need attention.'} <a href="#/sources?activity=imports">View import receipt</a></p> :
        loading ? <p role="status">Opening the shared items…</p> :
          hasContent ? <>
            {share.text && <p className="today-shared-text">{share.text}</p>}
            {share.files.length > 0 && <ul>{share.files.map((file, index) => <li key={index}>{file.name}</li>)}</ul>}
            {error && <p className="knowledge-error" role="alert">{error}</p>}
            <div className="knowledge-inline-actions">
              <button type="button" className="knowledge-button is-primary" disabled={!writer || pending} onClick={() => void save()}>{pending ? 'Importing…' : 'Save to this workspace'}</button>
              <button type="button" className="knowledge-text-button" disabled={pending} onClick={() => { void shareMessage(id, 'dismiss'); close() }}>Discard share</button>
            </div>
          </> : <p role="status">This share is unavailable. Share it again from the originating app.</p>}
    {(!loading && !hasContent || receipt || id === 'too-large') && <button type="button" className="knowledge-text-button" onClick={close}>Close</button>}
  </section>
}
