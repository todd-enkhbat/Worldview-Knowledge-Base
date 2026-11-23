import { create } from 'zustand'
import { compareAndSwapWorldState, getStore, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import type { WorldStore } from '../data/WorldStore.ts'
import { useWorkspace, validateWorkspaceContext, type WorkspaceContext } from './state.ts'

export const COLLECTIONS_KV = 'collections.v1'
type InvestigationFilters = Pick<WorkspaceContext, 'query' | 'sourceIds' | 'role' | 'sourceKind' | 'authoredAfter' | 'authoredBefore'>
export interface SavedInvestigation extends InvestigationFilters {
  id: string
  title: string
  questions: string[]
  updatedAt: number
  deletedAt?: number | null
}
export interface CollectionsSnapshot { schemaVersion: 1; revision: number; collections: SavedInvestigation[] }
const empty = (): CollectionsSnapshot => ({ schemaVersion: 1, revision: 0, collections: [] })
export const useCollections = create<CollectionsSnapshot & { loaded: boolean; busy: boolean; error: string | null }>()(() => ({ ...empty(), loaded: false, busy: false, error: null }))
let boundStore: WorldStore | null = null
const cleanup: (() => void)[] = []
let queue: Promise<unknown> = Promise.resolve()

function fields(context: InvestigationFilters): InvestigationFilters {
  return { query: context.query, sourceIds: [...context.sourceIds], role: context.role, sourceKind: context.sourceKind, authoredAfter: context.authoredAfter, authoredBefore: context.authoredBefore }
}

function decode(value: unknown): CollectionsSnapshot {
  if (value === undefined) return empty()
  if (!value || typeof value !== 'object') throw new Error('Saved investigations could not be read. Your existing data was not changed.')
  const snapshot = value as CollectionsSnapshot
  if (snapshot.schemaVersion !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.collections)) throw new Error('Saved investigations use an unsupported format. Your existing data was not changed.')
  const ids = new Set<string>()
  for (const item of snapshot.collections) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.title !== 'string' || !item.title.trim() || typeof item.query !== 'string' || !Array.isArray(item.sourceIds) || item.sourceIds.some((id) => typeof id !== 'string') || !Array.isArray(item.questions) || item.questions.some((q) => typeof q !== 'string') || !Number.isFinite(item.updatedAt)) throw new Error('A saved investigation is incomplete. Your existing data was not changed.')
    ids.add(item.id)
    const clean = validateWorkspaceContext(item)
    if (clean.role !== item.role || clean.sourceKind !== item.sourceKind || clean.authoredAfter !== item.authoredAfter || clean.authoredBefore !== item.authoredBefore) throw new Error('A saved investigation has unsupported filters. Your existing data was not changed.')
  }
  return structuredClone(snapshot)
}

function matches(store: WorldStore) { return isRepoReady() && getStore() === store && boundStore === store }

export async function refreshCollections(): Promise<void> {
  if (!isRepoReady()) return
  const store = getStore()
  const snapshot = decode(await store.getKv(COLLECTIONS_KV))
  if (matches(store) && snapshot.revision >= useCollections.getState().revision) useCollections.setState({ ...snapshot, loaded: true, error: null })
}

/** Metadata refresh never applies a saved investigation over the user's active context. */
export async function initializeCollections(): Promise<void> {
  if (!isRepoReady()) return
  const store = getStore()
  if (boundStore !== store) {
    for (const stop of cleanup.splice(0)) stop()
    boundStore = store
    useCollections.setState({ ...empty(), loaded: false, busy: false, error: null })
    cleanup.push(subscribeRepo((change) => {
      if (change.type === 'wipe' || change.type === 'import') useCollections.setState({ ...empty(), loaded: false, error: null })
      if (change.type === 'wipe' || change.type === 'import' || change.type === 'kv' && change.keys.includes(COLLECTIONS_KV)) void refreshCollections().catch((e) => useCollections.setState({ error: e instanceof Error ? e.message : String(e) }))
    }))
    cleanup.push(useRepoStatus.subscribe((status) => {
      if (!status.ready && boundStore === store) {
        boundStore = null
        for (const stop of cleanup.splice(0)) stop()
        useCollections.setState({ ...empty(), loaded: false, busy: false, error: null })
      }
    }))
  }
  await refreshCollections()
}

function mutate<T>(change: (snapshot: CollectionsSnapshot) => T): Promise<T> {
  if (!isRepoReady()) return Promise.reject(new Error('Open your workspace before saving an investigation.'))
  const requestedStore = getStore()
  const task = queue.catch(() => {}).then(async () => {
    if (!isRepoReady() || getStore() !== requestedStore) throw new Error('The active workspace changed. Open this investigation again before saving.')
    if (!useRepoStatus.getState().writer) throw new Error('This workspace is read only. Close the other editing tab before saving.')
    useCollections.setState({ busy: true, error: null })
    try {
      await initializeCollections()
      const snapshot = decode(await requestedStore.getKv(COLLECTIONS_KV))
      if (!matches(requestedStore)) throw new Error('The active workspace changed before the investigation could be saved.')
      const expected = snapshot.revision
      const result = change(snapshot)
      snapshot.revision++
      await compareAndSwapWorldState(COLLECTIONS_KV, snapshot, expected)
      if (matches(requestedStore)) useCollections.setState({ ...snapshot, loaded: true, error: null })
      return structuredClone(result)
    } catch (error) {
      if (matches(requestedStore)) {
        await refreshCollections().catch(() => {})
        useCollections.setState({ error: error instanceof Error ? error.message : String(error) })
      }
      throw error
    } finally { if (matches(requestedStore)) useCollections.setState({ busy: false }) }
  })
  queue = task
  return task
}

const titleOf = (title: string) => { const clean = title.trim(); if (!clean || clean.length > 120) throw new Error('Give this investigation a name of 1 to 120 characters.'); return clean }
const find = (snapshot: CollectionsSnapshot, id: string) => { const result = snapshot.collections.find((item) => item.id === id); if (!result) throw new Error('This investigation is no longer available. Refresh the list.'); return result }

export function saveInvestigation(title: string): Promise<SavedInvestigation> {
  const clean = titleOf(title)
  const context = fields(useWorkspace.getState())
  return mutate((snapshot) => { const item: SavedInvestigation = { id: crypto.randomUUID(), title: clean, ...context, questions: [], updatedAt: Date.now(), deletedAt: null }; snapshot.collections.push(item); return item })
}
export function renameInvestigation(id: string, title: string): Promise<void> {
  const clean = titleOf(title)
  return mutate((snapshot) => { const item = find(snapshot, id); item.title = clean; item.updatedAt = Date.now() })
}
export function updateInvestigationContext(id: string): Promise<void> {
  const context = fields(useWorkspace.getState())
  return mutate((snapshot) => { Object.assign(find(snapshot, id), context, { updatedAt: Date.now() }) })
}
export function archiveInvestigation(id: string, archived = true): Promise<void> {
  return mutate((snapshot) => { const item = find(snapshot, id); item.deletedAt = archived ? Date.now() : null; item.updatedAt = Date.now() })
}
export function addInvestigationQuestion(id: string, question: string): Promise<void> {
  const text = question.trim()
  if (!text || text.length > 1000) return Promise.reject(new Error('Write a question of 1 to 1,000 characters.'))
  return mutate((snapshot) => { const item = find(snapshot, id); if (!item.questions.includes(text)) item.questions.push(text); item.updatedAt = Date.now() })
}
export function removeInvestigationQuestion(id: string, question: string): Promise<void> {
  return mutate((snapshot) => { const item = find(snapshot, id); item.questions = item.questions.filter((q) => q !== question); item.updatedAt = Date.now() })
}
export function openInvestigation(id: string, question?: string): void {
  const item = useCollections.getState().collections.find((entry) => entry.id === id && !entry.deletedAt)
  if (!item) throw new Error('This investigation is no longer available.')
  useWorkspace.setState({ ...fields(item), ...(question ? { query: question } : {}), selectedRecordId: null, selectedSourceId: null, selectedPassageId: null, lastSection: 'search' })
  location.hash = '#/search'
}
