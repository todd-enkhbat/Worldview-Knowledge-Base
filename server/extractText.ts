import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
export const MAX_EXTRACT_BYTES = 64 * 1024 * 1024

export interface ExtractedText {
  text: string
  pages: { page: number; start: number; end: number }[]
}

export class ExtractionError extends Error {
  readonly status: number
  constructor(message: string, status = 422) {
    super(message)
    this.name = 'ExtractionError'
    this.status = status
  }
}

/** Preserve page boundaries in the canonical extracted text used by citation offsets. */
export function locatePdfPages(text: string): ExtractedText {
  const pages: ExtractedText['pages'] = []
  let start = 0
  for (const [i, part] of text.split('\f').entries()) {
    if (!part && start >= text.length) break
    pages.push({ page: i + 1, start, end: start + part.length })
    start += part.length + 1
  }
  return { text, pages }
}

async function recognizePdf(input: string): Promise<ExtractedText> {
  if (process.platform !== 'darwin') throw new ExtractionError('This PDF needs local OCR. Use the macOS app or provide a searchable copy. The original is retained.')
  const helper = process.env.WORLDVIEW_PDF_OCR_HELPER
  try {
    const args = ['--pdf', input]
    const { stdout } = await execute(helper ?? '/usr/bin/swift', helper ? args : [fileURLToPath(new URL('../electron/helper-ocr.swift', import.meta.url)), ...args], { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 })
    if (!stdout.replaceAll('\f', '').trim()) throw new ExtractionError('Local OCR did not find readable text. The original is retained.')
    return locatePdfPages(stdout)
  } catch (error) {
    if (error instanceof ExtractionError) throw error
    throw new ExtractionError('Local OCR could not read this PDF. Check that it is unlocked, has at most 100 pages and 50 scanned pages, and try again. The original is retained.')
  }
}

/** Local Poppler extraction; no document bytes or text go to an inference provider. */
export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedText> {
  if (bytes.length > MAX_EXTRACT_BYTES) throw new ExtractionError('This PDF exceeds the 64 MiB local extraction limit. Its original can still be kept.', 413)
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new ExtractionError('The file does not have a PDF signature.')
  const folder = await mkdtemp(join(tmpdir(), 'worldview-extract-'))
  const input = join(folder, 'source.pdf')
  const output = join(folder, 'source.txt')
  try {
    await writeFile(input, bytes)
    try {
      await execute('pdftotext', ['-layout', '-enc', 'UTF-8', input, output], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    } catch (error) {
      if ((error as { code?: string })?.code === 'ENOENT' && process.platform === 'darwin') return await recognizePdf(input)
      throw error
    }
    if ((await stat(output)).size > 32 * 1024 * 1024) throw new ExtractionError('Extracted PDF text exceeds the 32 MiB local indexing limit. The original is retained.', 413)
    const text = await readFile(output, 'utf8')
    if (!text.trim()) return await recognizePdf(input)
    return locatePdfPages(text)
  } catch (e) {
    if (e instanceof ExtractionError) throw e
    if ((e as { code?: string })?.code === 'ENOENT') throw new ExtractionError('Local PDF extraction needs Poppler (pdftotext) on the app server. The original is retained and can be retried.', 503)
    throw new ExtractionError('The PDF could not be extracted locally. It may be encrypted, malformed, or exceed the processing time limit. The original is retained.')
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}
