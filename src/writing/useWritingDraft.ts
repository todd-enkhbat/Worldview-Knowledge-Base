import { useCallback, useEffect, useRef, useState } from 'react'
import { getStore, getWorldGeneration, isRepoReady } from '../data/repo.ts'
import { updateWritingDocument } from './store.ts'
import { writingPublicationValue } from './model.ts'
import type { WritingDocument, WritingDocumentPatch } from './types.ts'

const value = (document: WritingDocument) => JSON.stringify(writingPublicationValue(document))
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** A pending save may advance its baseline, but can never erase a more recent edit. */
export function useWritingDraft(document: WritingDocument) {
  const [draft, setDraft] = useState(document), [status, setStatus] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved'), [error, setError] = useState('')
  const local = useRef(document), baseline = useRef(document), epoch = useRef(0), savedEpoch = useRef(0)
  const pending = useRef<Promise<void> | null>(null), failed = useRef(false), mounted = useRef(true)
  const lastError = useRef('')
  const scope = useRef({ store: getStore(), generation: getWorldGeneration() })
  const current = useCallback(() => isRepoReady() && getStore() === scope.current.store && getWorldGeneration() === scope.current.generation, [])
  const flush = useCallback(async (): Promise<void> => {
    if (!current()) throw new Error('The workspace changed. Reopen this document before saving.')
    if (pending.current) { await pending.current; if (epoch.current !== savedEpoch.current) return flush(); return }
    if (epoch.current === savedEpoch.current) return
    const submitted = local.current, version = epoch.current, expectedUpdatedAt = baseline.current.updatedAt
    if (mounted.current) { setStatus('saving'); setError('') }
    const action = updateWritingDocument(submitted.id, writingPublicationValue(submitted), { expectedUpdatedAt }).then((saved) => {
      if (!current()) return
      baseline.current = saved; savedEpoch.current = version; failed.current = false; lastError.current = ''
      if (epoch.current === version) { local.current = saved; if (mounted.current) { setDraft(saved); setStatus('saved') } }
      else if (mounted.current) setStatus('dirty')
    }).catch((cause: unknown) => {
      failed.current = true
      lastError.current = message(cause)
      if (mounted.current && current()) { setStatus('error'); setError(message(cause)) }
      throw cause
    }).finally(() => { pending.current = null })
    pending.current = action
    await action
  }, [current])
  const update = useCallback((patch: WritingDocumentPatch) => {
    const previous = local.current
    const next: WritingDocument = { ...previous, ...patch, appearance: { ...previous.appearance, ...patch.appearance } }
    if (value(previous) === value(next)) return
    local.current = next; epoch.current++
    setDraft(next); setStatus(failed.current ? 'error' : 'dirty')
  }, [])
  useEffect(() => {
    if (document.updatedAt === baseline.current.updatedAt) {
      const publication = (value: WritingDocument) => JSON.stringify([value.sourceId, value.publishedFingerprint, value.publishedUpdatedAt, value.lastPublishedAt])
      if (publication(document) !== publication(baseline.current)) {
        baseline.current = document
        local.current = { ...document, ...writingPublicationValue(local.current) }
        setDraft(local.current)
      }
      return
    }
    if (epoch.current === savedEpoch.current || value(document) === value(local.current)) {
      baseline.current = document; local.current = document; savedEpoch.current = epoch.current; failed.current = false; lastError.current = ''
      setDraft(document); setStatus('saved'); setError('')
    } else if (value(document) === value(baseline.current)) {
      // Publication metadata can change without replacing the editable wording.
      baseline.current = document
      local.current = { ...document, ...writingPublicationValue(local.current) }
      setDraft(local.current)
    } else { failed.current = true; lastError.current = 'A newer saved version is available. Your edits are still here; save a copy or reload the saved version.'; setStatus('error'); setError(lastError.current) }
  }, [document])
  useEffect(() => {
    if (status !== 'dirty' || failed.current) return
    const timer = setTimeout(() => { void flush().catch(() => {}) }, 650)
    return () => clearTimeout(timer)
  }, [draft, status, flush])
  useEffect(() => {
    mounted.current = true
    setDraft(local.current)
    setStatus(failed.current ? 'error' : pending.current ? 'saving' : epoch.current !== savedEpoch.current ? 'dirty' : 'saved')
    setError(lastError.current)
    const visibility = () => { if (globalThis.document.visibilityState === 'hidden') void flush().catch(() => {}) }
    const unload = (event: BeforeUnloadEvent) => { if (epoch.current !== savedEpoch.current || pending.current) { void flush().catch(() => {}); event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', unload)
    globalThis.document.addEventListener('visibilitychange', visibility)
    return () => { mounted.current = false; window.removeEventListener('beforeunload', unload); globalThis.document.removeEventListener('visibilitychange', visibility); void flush().catch(() => {}) }
  }, [flush])
  function reload(saved: WritingDocument) { local.current = saved; baseline.current = saved; epoch.current++; savedEpoch.current = epoch.current; failed.current = false; lastError.current = ''; setDraft(saved); setStatus('saved'); setError('') }
  return { draft, update, flush, status, error, reload }
}
