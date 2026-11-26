import type { RetrievalEngine } from '../knowledge/types.ts'

export const WORKSPACE_SECTIONS = ['today', 'write', 'search', 'library', 'bookshelf', 'quotes', 'people', 'maps', 'graph', 'topics', 'knowledge', 'review', 'sources','vocabulary','applications'] as const
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

export const QUICK_CAPTURE_DRAFT_LIMIT = 128 * 1024
export function initialWorkspaceContext(): WorkspaceContext {
  return {
    retrievalEngine: 'local',
    query: '',
    sourceIds: [],
    selectedRecordId: null,
    selectedPassageId: null,
    selectedSourceId: null,
    returnHash: '#/today',
    lastSection: 'today',
    readerPositions: {},
    draft: '',
    quickCaptureDraft: '',
    role: 'all',
    sourceKind: 'all',
    authoredAfter: '',
    authoredBefore: '',
  }
}

export function validateWorkspaceContext(value: unknown): WorkspaceContext {
  const base = initialWorkspaceContext()
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
    returnHash: typeof v.returnHash === 'string' && /^#\/(today|write|search|library|bookshelf|quotes|people|maps|graph|topics|knowledge|review|sources)(?:[?]|$)/.test(v.returnHash) ? v.returnHash : base.returnHash,
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
