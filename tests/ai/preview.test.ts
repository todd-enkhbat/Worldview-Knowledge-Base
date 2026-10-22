import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { icsPreview, jsonPreview, previewBytes, tablePreview, vcardPreview, zipPreview } from '../../src/ai/chat/preview.ts'

describe('file previews for Claude', () => {
  it('summarises a CSV: size, column types and first rows', () => {
    const p = tablePreview('name,born,score\n"Boltzmann, L.",1844-02-20,9.5\nGibbs,1839-02-11,9\n')
    expect(p).toContain('2 rows × 3 columns: name (text), born (date), score (number)')
    expect(p).toContain('Boltzmann, L. | 1844-02-20 | 9.5')
  })

  it('describes JSON arrays, objects and notebooks', () => {
    expect(jsonPreview('[{"a":1,"b":2},{"a":3}]')).toContain('A JSON array of 2 items; items have keys: a, b')
    expect(jsonPreview('{"cells":[{"cell_type":"code","source":["x = 1"]}]}')).toBe('[code 1]\nx = 1')
  })

  it('reads contacts and calendar events', () => {
    const vcf = 'BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nORG:Analytical Engines\nEMAIL:ada@example.com\nNOTE:Poetical\n science\nEND:VCARD\n'
    expect(vcardPreview(vcf)).toBe('1 contact:\n- Ada Lovelace · org: Analytical Engines · email: ada@example.com · note: Poeticalscience')
    const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20190501T090000Z\nSUMMARY:Defence\nLOCATION:Pupin Hall\nEND:VEVENT\nEND:VCALENDAR'
    expect(icsPreview(ics)).toBe('1 event:\n- 20190501T090000Z Defence @ Pupin Hall')
  })

  it('lists a zip and inlines its small text files; reads a docx', () => {
    const zip = zipSync({ 'notes/a.md': strToU8('# A'), 'img.png': new Uint8Array(10) })
    const p = zipPreview(zip)
    expect(p).toContain('A zip archive with 2 files')
    expect(p).toContain('<entry name="notes/a.md">\n# A')
    const docx = zipSync({ 'word/document.xml': strToU8('<w:document><w:p><w:t>Hello</w:t></w:p><w:p><w:t>World &amp; time</w:t></w:p></w:document>') })
    expect(previewBytes('thesis.docx', '', docx)).toBe('Hello\nWorld & time')
    expect(previewBytes('clip.mp4', 'video/mp4', new Uint8Array(4))).toBeNull()
  })
})
