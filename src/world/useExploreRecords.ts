import { useEffect, useMemo, useState } from 'react'
import { useWorld } from '../app/store.ts'
import { initializeBookshelf, useBookshelf } from '../bookshelf/store.ts'
import { useRepoStatus } from '../data/repo.ts'
import { initializeArtifacts, useArtifacts } from '../knowledge/artifacts/index.ts'
import { initializeKnowledge, useKnowledge } from '../knowledge/index.ts'
import { initializeCollections, useCollections } from '../workspace/collections.ts'
import { initializeWriting, useWriting } from '../writing/store.ts'
import { exploreRecords } from './exploreRecords.ts'

export function useExploreRecords() {
  const ready = useRepoStatus(state => state.ready)
  const nodes = useWorld(state => state.nodes)
  const sources = useKnowledge(state => state.sources)
  const versions = useKnowledge(state => state.versions)
  const books = useBookshelf(state => state.books)
  const writings = useWriting(state => state.docs)
  const investigations = useCollections(state => state.collections)
  const pages = useArtifacts(state => state.pages)
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!ready) return
    let current = true
    setLoad('loading')
    const commands = [initializeKnowledge(), initializeBookshelf(), initializeWriting(), initializeCollections(), initializeArtifacts()]
    void Promise.allSettled(commands).then(results => {
      if (current) setLoad(results.some(result => result.status === 'rejected') ? 'error' : 'ready')
    })
    return () => { current = false }
  }, [ready, attempt])

  const records = useMemo(() => exploreRecords({ nodes, sources, versions, books, writings, investigations, pages }), [nodes, sources, versions, books, writings, investigations, pages])
  return { records, load: ready ? load : 'loading', retry: () => setAttempt(value => value + 1) } as const
}
