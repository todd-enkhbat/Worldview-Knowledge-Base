import { WORKSPACE_SECTIONS, type WorkspaceSection } from './state.ts'

export type AppRoute = WorkspaceSection | 'world' | 'lab' | 'perf' | 's1' | 'sandbox'

export function parseAppRoute(hash: string, development = false): AppRoute {
  const path = (hash.replace(/^#/, '').split('?')[0] || '/').replace(/\/$/, '')
  if (development && path.startsWith('/sandbox/')) return 'sandbox'
  if (path === '/lab/perf') return 'perf'
  if (path === '/lab/s1') return 's1'
  if (path === '/lab') return 'lab'
  if (path === '/explore' || path === '/world') return 'world'
  if (path === '/ask') return 'search'
  if (path === '/archive') return 'library'
  if (path === '/writing') return 'write'
  const section = path.replace(/^\//, '') as WorkspaceSection
  return WORKSPACE_SECTIONS.includes(section) ? section : 'today'
}

export function libraryDestination(hash: string): { recordId: string | null; passageId: string | null; sourceId: string | null; digest: string | null } {
  const params = new URLSearchParams(hash.split('?')[1] ?? '')
  return { recordId: params.get('record'), passageId: params.get('passage'), sourceId: params.get('source'), digest: params.get('digest') }
}
