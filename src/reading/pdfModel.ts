import type { SourceVersion } from '../knowledge/types.ts'
import type { WorldStore } from '../data/WorldStore.ts'

export interface PdfRect { x: number; y: number; width: number; height: number }
export interface PdfSelection { page: number; quote: string; prefix: string; suffix: string; rects: PdfRect[] }
const MAX_PDF_BYTES = 64 * 1024 * 1024
export function isPdfVersion(version: SourceVersion): boolean { return /\.pdf$/i.test(version.originalName) || version.metadata?.mime === 'application/pdf' || version.metadata?.format === 'pdf' }
export async function readPdfOriginal(version: SourceVersion, store: WorldStore): Promise<Uint8Array> {
  if (version.originalPurged) throw new Error('This original was intentionally removed. Its extracted text and saved annotations remain available.')
  const [blob, meta] = await Promise.all([store.getBlob(version.originalBlobId), store.getAssetMeta(version.originalBlobId)])
  if (!blob || !meta) throw new Error('The original PDF is unavailable. Restore its original from a verified backup, or use Extracted text.')
  if (blob.size > MAX_PDF_BYTES) throw new Error('This PDF exceeds the 64 MiB page-reader limit. Its original remains retained; use Extracted text or download the original.')
  if (blob.size !== meta.bytes) throw new Error('The PDF original does not match its retained size. Restore a verified backup before opening it.')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('The retained original is not a PDF. Use Extracted text to read this source.')
  const match = /^knowledge-([a-f\d]{64})$/.exec(version.originalBlobId)
  if (match) { const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (part) => part.toString(16).padStart(2, '0')).join(''); if (digest !== match[1]) throw new Error('The original PDF failed its content check. Restore a verified backup before opening it.') }
  return bytes
}
const rounded = (value: number) => Math.round(value * 1_000_000) / 1_000_000
/** Page-relative rectangles survive zoom, viewport changes, and PDF re-open. */
export function pdfSelection(element: HTMLElement, page: number, selection: Selection | null): PdfSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0), text = element.querySelector('.textLayer')
  if (!text || !text.contains(range.startContainer) || !text.contains(range.endContainer)) return null
  const quote = range.toString()
  if (!quote.trim() || quote.length > 20_000) return null
  const bounds = element.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return null
  const rects: PdfRect[] = []
  for (const rect of range.getClientRects()) {
    const left = Math.max(bounds.left, rect.left), top = Math.max(bounds.top, rect.top), right = Math.min(bounds.right, rect.right), bottom = Math.min(bounds.bottom, rect.bottom)
    if (right - left < .5 || bottom - top < .5) continue
    const next = { x: rounded((left - bounds.left) / bounds.width), y: rounded((top - bounds.top) / bounds.height), width: rounded((right - left) / bounds.width), height: rounded((bottom - top) / bounds.height) }
    if (!rects.some((entry) => Math.abs(entry.x - next.x) < .001 && Math.abs(entry.y - next.y) < .001 && Math.abs(entry.width - next.width) < .001 && Math.abs(entry.height - next.height) < .001)) rects.push(next)
    if (rects.length > 200) return null
  }
  if (!rects.length) return null
  const before = document.createRange(); before.selectNodeContents(text); before.setEnd(range.startContainer, range.startOffset)
  const after = document.createRange(); after.selectNodeContents(text); after.setStart(range.endContainer, range.endOffset)
  return { page, quote, prefix: before.toString().slice(-48), suffix: after.toString().slice(0, 48), rects }
}
