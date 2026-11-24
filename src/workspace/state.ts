import { create } from 'zustand'
import type { RetrievalEngine } from '../knowledge/types.ts'

export const WORKSPACE_SECTIONS = ['today', 'write', 'search', 'library', 'bookshelf', 'graph', 'topics', 'knowledge', 'review', 'sources'] as const
export type WorkspaceSection = typeof WORKSPACE_SECTIONS[number]

export interface WorkspaceContext {
  retrievalEngine: RetrievalEngine
  query: string
  sourceIds: string[]
  selectedRecordId: string | null
  selectedPassageId: string | null
  selectedSourceId: string | null
  returnHash: string
  lastSection: WorkspaceSection
  readerPositions: Record<string, number>
  draft: string
  /** Unsaved quick-capture text, separate from the Today composer and saved records. */
  quickCaptureDraft: string
  role: 'all' | 'human' | 'assistant' | 'third-party' | 'unknown'
  sourceKind: string
  authoredAfter: string
  authoredBefore: string
}

const KEY = 'worldview.workspace.v1'
export const QUICK_CAPTURE_DRAFT_LIMIT = 128 * 1024
const initial = (): WorkspaceContext => ({ retrievalEngine: 'local', query: '', sourceIds: [], selectedRecordId: null, selectedPassageId: null, selectedSourceId: null, returnHash: '#/today', lastSection: 'today', readerPositions: {}, draft: '', quickCaptureDraft: '', role: 'all', sourceKind: 'all', authoredAfter: '', authoredBefore: '' })
let activeScope = 'local'
export const getWorkspaceScope = () => activeScope
export function workspaceScopeForAccount(userId: string | null | undefined, search: string, development: boolean): string {
  const qa = development ? new URLSearchParams(search).get('qa') : null
  return qa ? `qa:${qa}` : userId ?? 'local'
}

export function validateWorkspaceContext(value: unknown): WorkspaceContext {
  const base = initial()
    if (!value || typeof value !== 'object') return base
    const v = value as Partial<WorkspaceContext>
    return {
      ...base,
      retrievalEngine: ['local', 'qmd-lexical', 'qmd-hybrid'].includes(String(v.retrievalEngine)) ? v.retrievalEngine! : 'local',
      query: typeof v.query === 'string' ? v.query.slice(0, 2000) : '',
      sourceIds: Array.isArray(v.sourceIds) ? v.sourceIds.filter((x): x is string => typeof x === 'string').slice(0, 1000) : [],
      selectedRecordId: typeof v.selectedRecordId === 'string' ? v.selectedRecordId : null,
      selectedPassageId: typeof v.selectedPassageId === 'string' ? v.selectedPassageId : null,
      selectedSourceId: typeof v.selectedSourceId === 'string' ? v.selectedSourceId : null,
      returnHash: typeof v.returnHash === 'string' && /^#\/(today|write|search|library|bookshelf|graph|topics|knowledge|review|sources)(?:[?]|$)/.test(v.returnHash) ? v.returnHash : base.returnHash,
      lastSection: WORKSPACE_SECTIONS.includes(v.lastSection as WorkspaceSection) ? v.lastSection as WorkspaceSection : 'today',
      readerPositions: v.readerPositions && typeof v.readerPositions === 'object' ? Object.fromEntries(Object.entries(v.readerPositions).filter(([, n]) => typeof n === 'number' && Number.isFinite(n) && n >= 0).slice(-80)) : {},
      draft: typeof v.draft === 'string' ? v.draft : '',
      quickCaptureDraft: typeof v.quickCaptureDraft === 'string' ? v.quickCaptureDraft.slice(0, QUICK_CAPTURE_DRAFT_LIMIT) : '',
      role: ['all', 'human', 'assistant', 'third-party', 'unknown'].includes(v.role ?? '') ? v.role! : 'all',
      sourceKind: ['all', 'thought', 'document', 'chatgpt', 'claude', 'obsidian', 'legacy', 'conversation'].includes(v.sourceKind ?? '') ? v.sourceKind! : 'all',
      authoredAfter: typeof v.authoredAfter === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.authoredAfter) ? v.authoredAfter : '',
      authoredBefore: typeof v.authoredBefore === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.authoredBefore) ? v.authoredBefore : '',
    }
}

function readContext(scope = activeScope): WorkspaceContext {
  try { return validateWorkspaceContext(JSON.parse(localStorage.getItem(`${KEY}:${scope}`) ?? 'null')) } catch { return initial() }
}

export function hasDeviceWorkspaceContext(scope = activeScope): boolean {
  try { const value: unknown = JSON.parse(localStorage.getItem(`${KEY}:${scope}`) ?? 'null'); return value !== null && typeof value === 'object' } catch { return false }
}

export const useWorkspace = create<WorkspaceContext>()(() => initial())

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

export function exploreWorkspaceRecord(id: string): void {
  useWorkspace.setState({ selectedRecordId: id, returnHash: location.hash.startsWith('#/explore') ? useWorkspace.getState().returnHash : location.hash || '#/library' })
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
