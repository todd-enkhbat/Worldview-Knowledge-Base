import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, initRepo } from '../../src/data/repo.ts'
import { startSemantic, stopSemantic, useSemantic } from '../../src/ai/semanticIndex.ts'

describe('semantic index guard', () => {
  beforeEach(async () => {
    useWorld.getState().hydrate(null, [])
    await initRepo({ store: createMemoryStore() })
    await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'demo' })
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    stopSemantic()
    await closeRepo()
  })

  it('never indexes a throwaway in-memory world (no vector-store traffic at all)', async () => {
    const f = vi.fn(async () => new Response('[]'))
    vi.stubGlobal('fetch', f)
    await startSemantic()
    expect(f).not.toHaveBeenCalled()
    expect(useSemantic.getState().phase).not.toBe('indexing')
  })

  it('stopSemantic leaves the browser preference alone', () => {
    const kv = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => kv.get(k) ?? null,
      setItem: (k: string, v: string) => void kv.set(k, v),
      removeItem: (k: string) => void kv.delete(k),
    })
    localStorage.setItem('hyperspace.semantic', 'on')
    stopSemantic()
    expect(localStorage.getItem('hyperspace.semantic')).toBe('on')
    expect(useSemantic.getState().phase).toBe('off')
  })
})
