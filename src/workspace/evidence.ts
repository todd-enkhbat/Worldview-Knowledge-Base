import type { KnowledgePassage, SourceVersion } from '../knowledge/types.ts'

/** Page metadata also repairs the display of citations indexed before page locators were added. */
export function passageLocator(passage: Pick<KnowledgePassage, 'locator' | 'start' | 'end'>, version?: Pick<SourceVersion, 'metadata'>): string {
  const raw = version?.metadata?.pages
  if (Array.isArray(raw)) {
    const pages = raw.filter((value): value is { page: number; start: number; end: number } => value !== null && typeof value === 'object' && Number.isInteger(value.page) && Number.isFinite(value.start) && Number.isFinite(value.end) && value.start <= passage.end - 1 && value.end > passage.start)
    if (pages.length) return pages[0].page === pages.at(-1)!.page ? `Page ${pages[0].page}` : `Pages ${pages[0].page}–${pages.at(-1)!.page}`
  }
  return passage.locator || `Characters ${passage.start + 1}–${passage.end}`
}
