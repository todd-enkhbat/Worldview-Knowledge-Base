import { useEffect, useRef, useState } from 'react'
import { getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { canonicalJson, hashText } from '../data/hash.ts'
import type { CrmBase, CrmCollection, CrmCollectionMap, CrmCommand, CrmCommandResult, CrmCompany, CrmField, CrmFieldValue, CrmGroup, CrmHistory, CrmInteraction, CrmMembership, CrmNote, CrmPerson, CrmRelationship, CrmTask } from './types.ts'

export interface CrmListResult<T = CrmBase> { revision: number; collection: CrmCollection; rows: T[]; total: number; nextOffset: number | null }
export interface CrmDetail<T = CrmPerson> { revision: number; collection: CrmCollection; record: T; canonicalId?: string; related: { companies: CrmCompany[]; memberships: CrmMembership[]; groups: CrmGroup[]; fields: CrmField[]; fieldValues: CrmFieldValue[]; notes: CrmNote[]; interactions: CrmInteraction[]; tasks: CrmTask[]; relationships: CrmRelationship[]; history: CrmHistory[] } }
export interface CrmStatus { available: boolean; workspaceFingerprint?: string; revision: number; counts: Record<CrmCollection, { active: number; total: number }>; pendingCandidates: number; pendingProposals: number; dueTasks: number; cloudEnrichment: false; sendingEnabled: false }
export const crmMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const CHANGED = 'worldview:crm-changed'
export function notifyCrmChanged() { window.dispatchEvent(new Event(CHANGED)) }
function workspaceScope() { return isRepoReady() ? { store: getStore(), generation: getWorldGeneration() } : null }
function assertScope(scope: ReturnType<typeof workspaceScope>) { if (!scope || !isRepoReady() || scope.store !== getStore() || scope.generation !== getWorldGeneration()) throw new Error('The workspace changed. Reopen People before continuing.') }
export async function crmGet<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
  const scope = workspaceScope(); assertScope(scope)
  const response = await fetch(path.startsWith('/api/') ? path : `/api/crm/${path.replace(/^\//, '')}`, { credentials: 'same-origin', signal: options.signal, headers: { 'x-wv-client': 'people-workspace' } })
  const value = await response.json() as T & { error?: string }; assertScope(scope)
  if (!response.ok) throw new Error(value.error ?? 'People could not load. Your saved records are unchanged.')
  return value
}
interface RetryEntry { requestId: string; pending?: Promise<CrmCommandResult> }
const retries = new Map<string, RetryEntry>()
let retryScope: ReturnType<typeof workspaceScope> = null
const resetRetries = () => { retries.clear(); retryScope = null }
const unsubscribeRetries = subscribeRepo(change => { if (change.type === 'import' || change.type === 'wipe') resetRetries() })
import.meta.hot?.dispose(() => { unsubscribeRetries(); resetRetries() })
export async function crmCommand(input: Omit<CrmCommand, 'requestId'> & { requestId?: string }): Promise<CrmCommandResult> {
  const scope = workspaceScope(); assertScope(scope)
  if (!useRepoStatus.getState().writer) throw new Error('This window is read only. Edit People in the writing window.')
  if (!retryScope || retryScope.store !== scope!.store || retryScope.generation !== scope!.generation) { resetRetries(); retryScope = scope }
  const key = input.requestId === undefined ? await hashText(canonicalJson(input)) : null
  assertScope(scope)
  if (!useRepoStatus.getState().writer) throw new Error('This window is read only. Edit People in the writing window.')
  let entry = key ? retries.get(key) : undefined
  if (entry?.pending) return entry.pending
  if (!entry) { if (key && retries.size >= 128) throw new Error('Several edits have uncertain results. Review the saved records before starting more edits.'); entry = { requestId: input.requestId ?? crypto.randomUUID() }; if (key) retries.set(key, entry) }
  const selected = entry
  const forget = () => { if (key && retries.get(key) === selected) retries.delete(key) }
  const pending = (async () => {
    let definiteRejection = false
    try {
      const response = await fetch('/api/crm/command', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-wv-client': 'people-workspace' }, body: JSON.stringify({ ...input, requestId: selected.requestId }) })
      definiteRejection = !response.ok && response.status < 500 && response.status !== 408
      const value = await response.json() as CrmCommandResult & { error?: string }; assertScope(scope)
      if (!response.ok) throw new Error(value.error ?? 'This edit could not be saved. Your input is still here.')
      if (!value || value.ok !== true || typeof value.revision !== 'number') throw new Error('The save receipt was incomplete. Retry this same edit to check its saved result.')
      forget(); notifyCrmChanged(); return value
    } catch (cause) { if (definiteRejection) forget(); throw cause }
    finally { selected.pending = undefined }
  })()
  selected.pending = pending
  return pending
}
export function useCrmQuery<T>(path: string | null, initial: T) {
  const scope = workspaceScope()
  const [state, setState] = useState({ path, scope, data: initial, loading: !!path, error: '' }), [epoch, setEpoch] = useState(0)
  const serial = useRef(0), initialRef = useRef(initial); initialRef.current = initial
  useEffect(() => { const changed = () => setEpoch((value) => value + 1); window.addEventListener(CHANGED, changed); const unsubscribe = subscribeRepo((change) => { if (change.type === 'kv' && change.keys.includes('crm.v1') || change.type === 'import' || change.type === 'wipe') changed() }); return () => { window.removeEventListener(CHANGED, changed); unsubscribe() } }, [])
  useEffect(() => {
    if (!path) return
    const id = ++serial.current, controller = new AbortController(), queryScope = workspaceScope()
    setState((old) => ({ path, scope: queryScope, data: old.path === path && old.scope?.store === queryScope?.store && old.scope?.generation === queryScope?.generation ? old.data : initialRef.current, loading: true, error: '' }))
    void crmGet<T>(path, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted && serial.current === id) setState({ path, scope: queryScope, data, loading: false, error: '' }) }).catch((cause) => { if (!controller.signal.aborted && serial.current === id) setState({ path, scope: queryScope, data: initialRef.current, loading: false, error: crmMessage(cause) }) })
    return () => { controller.abort() }
  }, [path, epoch])
  const valid = state.path === path && state.scope?.store === scope?.store && state.scope?.generation === scope?.generation
  return { data: valid ? state.data : initial, loading: valid ? state.loading : !!path, error: valid ? state.error : '', refresh: () => setEpoch((value) => value + 1) }
}
export const emptyCrmPage = <T,>(collection: CrmCollection): CrmListResult<T> => ({ revision: 0, collection, rows: [], total: 0, nextOffset: null })
export function useCrmList<K extends CrmCollection>(collection: K, params: Record<string, string | number | undefined> = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))
  return useCrmQuery<CrmListResult<CrmCollectionMap[K]>>(`${collection}?${query}`, emptyCrmPage<CrmCollectionMap[K]>(collection))
}
/** Paged metadata only; originals and raw provider payloads stay on the server. */
export async function crmAll<K extends CrmCollection>(collection: K, signal?: AbortSignal, params: Record<string, string> = {}): Promise<CrmCollectionMap[K][]> {
  const rows: CrmCollectionMap[K][] = []; let offset: number | null = 0
  do { const query = new URLSearchParams({ ...params, limit: '500', offset: String(offset) }), page: CrmListResult<CrmCollectionMap[K]> = await crmGet(`${collection}?${query}`, { signal }); rows.push(...page.rows); offset = page.nextOffset } while (offset !== null)
  return rows
}
export const personName = (person: Pick<CrmPerson, 'fullName' | 'firstName' | 'lastName' | 'emails'>) => person.fullName || [person.firstName, person.lastName].filter(Boolean).join(' ') || person.emails[0] || 'Unnamed contact'
export function downloadCrm(name: string, value: unknown, mime = 'application/json') { const url = URL.createObjectURL(new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type: mime })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
