import { useEffect, useState } from 'react'
import { getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { readBookshelfOriginal } from './media.ts'
export function useBookshelfCover(id: string | null) {
  const ready = useRepoStatus((state) => state.ready), [epoch, setEpoch] = useState(0), [error, setError] = useState('')
  const [result, setResult] = useState<{ id: string; url: string; store: ReturnType<typeof getStore>; generation: number } | null>(null)
  useEffect(() => subscribeRepo((change) => { if (change.type === 'wipe' || change.type === 'import') setEpoch((value) => value + 1) }), [])
  useEffect(() => {
    let alive = true, url: string | null = null; setResult(null); setError('')
    if (!id || !ready || !isRepoReady()) return
    const store = getStore(), generation = getWorldGeneration()
    void readBookshelfOriginal(id, { store, generation }).then(({ blob }) => { if (!alive || !isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return; url = URL.createObjectURL(blob); setResult({ id, url, store, generation }) }).catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [id, ready, epoch])
  return { url: result && result.id === id && isRepoReady() && result.store === getStore() && result.generation === getWorldGeneration() ? result.url : null, error }
}
