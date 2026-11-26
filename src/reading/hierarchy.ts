import type { ReadingFolder } from './types.ts'

export const FOLDER_KINDS = ['folder', 'section', 'concept', 'note'] as const
export type FolderKind = typeof FOLDER_KINDS[number]
export const FOLDER_ICONS = ['folder', 'books', 'book', 'graduation', 'brain', 'lightbulb', 'palette', 'heart', 'globe', 'users', 'code', 'calendar', 'star', 'note', 'leaf', 'compass'] as const
export type FolderIconName = typeof FOLDER_ICONS[number]
export function suggestedFolderIcon(name: string): FolderIconName {
  if (/books|reading|literature/i.test(name)) return 'books'
  if (/academ|course|school/i.test(name)) return 'graduation'
  if (/philosoph|concept|idea/i.test(name)) return 'brain'
  if (/art|humanit/i.test(name)) return 'palette'
  if (/relationship|love|ekni/i.test(name)) return 'heart'
  if (/meeting|network|people/i.test(name)) return 'users'
  if (/tech|code/i.test(name)) return 'code'
  if (/world|civiliz|vault/i.test(name)) return 'globe'
  return 'folder'
}
export function folderTrail(folders: readonly ReadingFolder[], id: string | null): ReadingFolder[] {
  const byId = new Map(folders.filter(folder => !folder.deletedAt).map(folder => [folder.id, folder]))
  const result: ReadingFolder[] = [], seen = new Set<string>()
  while (id && !seen.has(id)) { seen.add(id); const folder = byId.get(id); if (!folder) break; result.unshift(folder); id = folder.parentId }
  return result
}
export const folderHref = (id: string | null) => `#/library${id ? `?folder=${encodeURIComponent(id)}` : ''}`
export function canMoveFolder(folders: readonly ReadingFolder[], id: string, parentId: string | null): boolean {
  if (!parentId) return true
  const trail = folderTrail(folders, parentId)
  return trail.length > 0 && !trail.some(folder => folder.id === id)
}
