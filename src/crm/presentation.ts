import { validateCrmFilter } from './model.ts'
import type { CrmFilter } from './types.ts'

export const CRM_PRESENTATION_AREAS = ['people', 'companies', 'objects', 'tasks', 'calendar', 'review', 'outreach', 'connections', 'trash'] as const
export type CrmPresentationArea = typeof CRM_PRESENTATION_AREAS[number]
export interface CrmPresentation {
  area: CrmPresentationArea; groupId: string; layout: 'table' | 'gallery' | 'board' | 'network' | 'places';
  query: string; filter: CrmFilter | null; columns: string[];
  sort: { field: string; direction: 'asc' | 'desc' }[]; viewId: string;
}
const MAX_BYTES = 32 * 1024
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const boundedText = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit
function key(account: string, fingerprint: string) { return account && account.length <= 1000 && fingerprint && fingerprint.length <= 256 ? `worldview.people.presentation.v1:${JSON.stringify([account, fingerprint])}` : null }
function storageOrNull(storage?: Pick<Storage, 'getItem' | 'setItem'>) { try { return storage ?? globalThis.sessionStorage ?? null } catch { return null } }
/** Only presentation state may cross a remount. Never accept records, drafts or edit revisions. */
export function parseCrmPresentation(value: unknown): CrmPresentation | null {
  if (!record(value) || !CRM_PRESENTATION_AREAS.includes(value.area as CrmPresentationArea) || !['table', 'gallery', 'board', 'network', 'places'].includes(String(value.layout)) || !boundedText(value.groupId, 1000) || !boundedText(value.query, 2000) || !boundedText(value.viewId, 1000) || value.filter !== null && !validateCrmFilter(value.filter)) return null
  if (!Array.isArray(value.columns) || value.columns.length > 60 || !value.columns.every(column => boundedText(column, 1000) && column.length > 0) || new Set(value.columns).size !== value.columns.length) return null
  if (!Array.isArray(value.sort) || value.sort.length > 20 || !value.sort.every(sort => record(sort) && boundedText(sort.field, 1000) && sort.field.length > 0 && ['asc', 'desc'].includes(String(sort.direction)))) return null
  return structuredClone({ area: value.area as CrmPresentationArea, groupId: value.groupId, layout: value.layout as CrmPresentation['layout'], query: value.query, filter: value.filter as CrmFilter | null, columns: value.columns as string[], sort: value.sort.map(sort => ({ field: sort.field as string, direction: sort.direction as 'asc' | 'desc' })), viewId: value.viewId })
}
export function readCrmPresentation(account: string, fingerprint: string, storage?: Pick<Storage, 'getItem' | 'setItem'>): CrmPresentation | null {
  try { const name = key(account, fingerprint), store = storageOrNull(storage); if (!name || !store) return null; const raw = store.getItem(name); if (!raw || new TextEncoder().encode(raw).byteLength > MAX_BYTES) return null; const value: unknown = JSON.parse(raw); return record(value) && value.schemaVersion === 1 ? parseCrmPresentation(value.presentation) : null } catch { return null }
}
export function writeCrmPresentation(account: string, fingerprint: string, presentation: CrmPresentation, storage?: Pick<Storage, 'getItem' | 'setItem'>): void {
  try { const name = key(account, fingerprint), store = storageOrNull(storage), safe = parseCrmPresentation(presentation); if (!name || !store || !safe) return; const raw = JSON.stringify({ schemaVersion: 1, presentation: safe }); if (new TextEncoder().encode(raw).byteLength <= MAX_BYTES) store.setItem(name, raw) } catch { /* Session storage can be unavailable or full. Canonical data is unchanged. */ }
}
