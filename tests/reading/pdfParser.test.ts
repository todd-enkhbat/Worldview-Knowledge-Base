import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('decodes the real two-page PDF fixture, preserving page count, page text and rendering geometry', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({ data: new Uint8Array(readFileSync('tests/fixtures/reading-pages.pdf')), useSystemFonts: true, disableFontFace: true })
  try {
    const pdf = await loading.promise
    expect(pdf.numPages).toBe(2)
    const first = await pdf.getPage(1), second = await pdf.getPage(2)
    expect(first.getViewport({ scale: 1 })).toMatchObject({ width: 612, height: 792 })
    expect(second.getViewport({ scale: 1.5 })).toMatchObject({ width: 918, height: 1188 })
    const text = (await first.getTextContent()).items.map((entry) => 'str' in entry ? entry.str : '').join(' ')
    const later = (await second.getTextContent()).items.map((entry) => 'str' in entry ? entry.str : '').join(' ')
    expect(text).toContain('The copper orchard keeps its evidence close.')
    expect(later).toContain('Connections turn saved articles into useful knowledge.')
    expect(later).not.toContain('The copper orchard')
  } finally { await loading.destroy() }
})
