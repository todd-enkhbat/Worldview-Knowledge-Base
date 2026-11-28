import { create } from 'zustand'
import { initialWorkspaceContext, QUICK_CAPTURE_DRAFT_LIMIT, validateWorkspaceContext, type WorkspaceContext, type WorkspaceSection } from './context.ts'

export { QUICK_CAPTURE_DRAFT_LIMIT, validateWorkspaceContext, WORKSPACE_SECTIONS, type WorkspaceContext, type WorkspaceSection } from './context.ts'

const KEY = 'worldview.workspace.v1'
let activeScope = 'local'
export const getWorkspaceScope = () => activeScope
export function workspaceScopeForAccount(userId: string | null | undefined, search: string, development: boolean): string {
  const qa = development ? new URLSearchParams(search).get('qa') : null
  return qa ? `qa:${qa}` : userId ?? 'local'
}

function readContext(scope = activeScope): WorkspaceContext {
  try { return validateWorkspaceContext(JSON.parse(localStorage.getItem(`${KEY}:${scope}`) ?? 'null')) } catch { return initialWorkspaceContext() }
}

export function hasDeviceWorkspaceContext(scope = activeScope): boolean {
  try { const value: unknown = JSON.parse(localStorage.getItem(`${KEY}:${scope}`) ?? 'null'); return value !== null && typeof value === 'object' } catch { return false }
}

export const useWorkspace = create<WorkspaceContext>()(initialWorkspaceContext)

useWorkspace.subscribe((context) => {
  try { localStorage.setItem(`${KEY}:${activeScope}`, JSON.stringify(context)) } catch { /* The record store remains authoritative when device preferences cannot be saved. */ }
})

/** Account-scoped resume state must never expose a previous user's research context. */
export function restoreWorkspaceContext(scope = 'local'): void {
  activeScope = scope
  useWorkspace.setState(readContext(scope), true)
}

export function setWorkspaceQuery(query: string): void { useWorkspace.setState({ query }) }
export function setWorkspaceSources(sourceIds: readonly string[]): void { useWorkspace.setState({ sourceIds: [...new Set(sourceIds)] }) }
export function setQuickCaptureDraft(update: string | ((previous: string) => string)): void {
  useWorkspace.setState((state) => ({ quickCaptureDraft: (typeof update === 'function' ? update(state.quickCaptureDraft) : update).slice(0, QUICK_CAPTURE_DRAFT_LIMIT) }))
}

export function selectWorkspaceRecord(id: string | null, passageId: string | null = null): void {
  useWorkspace.setState({ selectedRecordId: id, selectedPassageId: passageId, selectedSourceId: null })
}

export function openWorkspaceRecord(id: string, passageId?: string): void {
  selectWorkspaceRecord(id, passageId ?? null)
  location.hash = passageId ? `#/library?passage=${encodeURIComponent(passageId)}` : `#/library?record=${encodeURIComponent(id)}`
}

export function rememberReaderPosition(id: string, top: number): void {
  if (!Number.isFinite(top) || top < 0) return
  useWorkspace.setState((s) => ({ readerPositions: Object.fromEntries([...Object.entries(s.readerPositions).filter(([k]) => k !== id), [id, top]].slice(-80)) }))
}

export function exploreWorkspaceRecord(id: string, context: { sourceIds?: readonly string[]; passageId?: string | null } = {}): void {
  useWorkspace.setState({
    selectedRecordId: id,
    returnHash: location.hash.startsWith('#/explore') ? useWorkspace.getState().returnHash : location.hash || '#/library',
    exploreContext: { recordId: id, sourceIds: [...new Set(context.sourceIds)].slice(0, 1000), passageId: context.passageId ?? null },
  })
  location.hash = `#/explore?record=${encodeURIComponent(id)}`
}

export function returnToWorkspace(): void { location.hash = useWorkspace.getState().returnHash || '#/today' }

export function rememberWorkspaceSection(section: WorkspaceSection): void {
  if (useWorkspace.getState().lastSection === section) return
  useWorkspace.setState({ lastSection: section })
}

/** A new visit resumes the last readable section; direct links keep their exact destination. */
export function workspaceHomeHash(): string {
  const context = readContext()
  const section = context.lastSection
  if (section === 'library' && context.selectedPassageId) return `#/library?passage=${encodeURIComponent(context.selectedPassageId)}`
  if (section === 'library' && context.selectedRecordId) return `#/library?record=${encodeURIComponent(context.selectedRecordId)}`
  if (section === 'library' && context.selectedSourceId) return `#/library?source=${encodeURIComponent(context.selectedSourceId)}`
  return `#/${section}`
}
