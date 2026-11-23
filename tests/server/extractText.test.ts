import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { extractPdfText, locatePdfPages } from '../../server/extractText.ts'
import { startTestEngine } from '../helpers/engine.ts'

function hasPoppler(): boolean {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true } catch { return false }
}

/** A real minimal PDF, with byte-correct object offsets and an explicit page font. */
function pdfFixture(): Uint8Array<ArrayBuffer> {
  const stream = 'BT /F1 12 Tf 40 750 Td (Late-source evidence: the launch date is November 29.) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let text = '%PDF-1.4\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) { offsets.push(text.length); text += `${i + 1} 0 obj\n${object}\nendobj\n` }
  const xref = text.length
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(text)
}

describe('Local document extraction', () => {
  it('retains canonical text offsets across PDF pages', () => {
    const text = 'First page\fSecond page\f'
    const result = locatePdfPages(text)
    expect(result.pages.map((p) => result.text.slice(p.start, p.end))).toEqual(['First page', 'Second page'])
    expect(result.pages.map((p) => p.page)).toEqual([1, 2])
  })
  it('refuses non-PDF input before launching a parser', async () => {
    await expect(extractPdfText(new TextEncoder().encode('Not a PDF'))).rejects.toThrow(/signature/)
  })
  it.runIf(hasPoppler())('extracts a real PDF through the HTTP API with a usable page locator', async () => {
    const engine = await startTestEngine()
    const result = await fetch(`${engine.base}/extract-text`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-wv-client': 'test-extract' }, body: new Blob([pdfFixture()]) })
    expect(result.status).toBe(200)
    const extracted = await result.json() as { text: string; pages: { page: number; start: number; end: number }[] }
    expect(extracted.text).toContain('November 29')
    expect(extracted.pages[0].page).toBe(1)
    expect(extracted.text.slice(extracted.pages[0].start, extracted.pages[0].end)).toContain('Late-source evidence')
  })
})
