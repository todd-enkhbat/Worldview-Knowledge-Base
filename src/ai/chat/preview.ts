import { strFromU8, unzipSync } from 'fflate'

// Readable previews of files Claude cannot take directly (milestone 1, "anything in the
// world"). The original is always kept byte for byte; the preview is what Claude reads to
// understand it: the shape of a dataset, the people in a contact card, the events in a
// calendar, the text of a Word document, the contents of a zip. Pure functions over bytes or
// text, so they are testable without a browser.

const MAX_PREVIEW = 40_000

const clip = (s: string, n = MAX_PREVIEW) => (s.length > n ? `${s.slice(0, n)}\n… (${(s.length - n).toLocaleString('en')} more characters)` : s)

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

// ─── tables ──────────────────────────────────────────────────────────────────────────

/** Split one delimited line, honouring double quotes. */
function splitRow(line: string, delim: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') q = false
      else cur += c
    } else if (c === '"') q = true
    else if (c === delim) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

function columnType(values: string[]): string {
  const v = values.filter((x) => x.trim() !== '')
  if (!v.length) return 'empty'
  if (v.every((x) => /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(x.trim()))) return 'number'
  if (v.every((x) => !Number.isNaN(Date.parse(x)) && /\d{4}|\d{1,2}[/.-]\d{1,2}/.test(x))) return 'date'
  if (v.every((x) => /^(true|false|yes|no|0|1)$/i.test(x.trim()))) return 'boolean'
  return 'text'
}

/** Header, column types, row count and the first rows of a CSV/TSV. */
export function tablePreview(text: string, delim = text.split('\n', 1)[0].includes('\t') ? '\t' : ','): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (!lines.length) return 'An empty table.'
  const header = splitRow(lines[0], delim)
  const rows = lines.slice(1).map((l) => splitRow(l, delim))
  const sample = rows.slice(0, 200)
  const cols = header.map((h, i) => `${h || `column ${i + 1}`} (${columnType(sample.map((r) => r[i] ?? ''))})`)
  const head = rows.slice(0, 25).map((r) => r.join(' | '))
  return clip(`${rows.length.toLocaleString('en')} rows × ${header.length} columns: ${cols.join(', ')}\n\nFirst rows:\n${header.join(' | ')}\n${head.join('\n')}`)
}

/** Shape of a JSON document: arrays by length and first items, objects by keys. */
export function jsonPreview(text: string): string {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return clip(text)
  }
  if (Array.isArray(v)) {
    const keys = v.length && v[0] && typeof v[0] === 'object' ? `; items have keys: ${Object.keys(v[0] as object).join(', ')}` : ''
    return clip(`A JSON array of ${v.length.toLocaleString('en')} items${keys}.\n\nFirst items:\n${JSON.stringify(v.slice(0, 5), null, 2)}`)
  }
  if (v && typeof v === 'object') {
    // A Jupyter notebook: show the cells, not the JSON.
    const nb = v as { cells?: { cell_type: string; source: string | string[] }[] }
    if (Array.isArray(nb.cells)) {
      return clip(nb.cells.map((c, i) => `[${c.cell_type} ${i + 1}]\n${Array.isArray(c.source) ? c.source.join('') : c.source}`).join('\n\n'))
    }
    return clip(`A JSON object with keys: ${Object.keys(v).join(', ')}\n\n${JSON.stringify(v, null, 2)}`)
  }
  return clip(text)
}

// ─── contacts and calendars ──────────────────────────────────────────────────────────

/** Unfold RFC 5545/6350 continuation lines. */
const unfold = (text: string) => text.replace(/\r?\n[ \t]/g, '')

function props(block: string): { name: string; params: string; value: string }[] {
  return block
    .split(/\r?\n/)
    .map((l) => /^([A-Za-z0-9-]+)((?:;[^:]*)?):(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1].toUpperCase(), params: m[2], value: m[3].replace(/\\n/g, '\n').replace(/\\([,;\\])/g, '$1') }))
}

/** Each contact in a vCard file as one readable line. */
export function vcardPreview(text: string): string {
  const cards = unfold(text).split(/BEGIN:VCARD/i).slice(1)
  const people = cards.map((c) => {
    const p = props(c)
    const get = (n: string) => p.filter((x) => x.name === n).map((x) => x.value.replace(/;+/g, ' ').trim()).filter(Boolean)
    const parts = [
      get('FN')[0] ?? get('N')[0] ?? 'Unnamed',
      ...get('ORG').map((o) => `org: ${o}`),
      ...get('TITLE').map((t) => `title: ${t}`),
      ...get('EMAIL').map((e) => `email: ${e}`),
      ...get('TEL').map((t) => `tel: ${t}`),
      ...get('ADR').map((a) => `address: ${a}`),
      ...get('BDAY').map((b) => `born: ${b}`),
      ...get('URL').map((u) => `url: ${u}`),
      ...get('NOTE').map((n) => `note: ${n}`),
    ]
    return `- ${parts.join(' · ')}`
  })
  return clip(`${people.length} contact${people.length === 1 ? '' : 's'}:\n${people.join('\n')}`)
}

/** Each event in an iCalendar file as one readable line. */
export function icsPreview(text: string): string {
  const events = unfold(text).split(/BEGIN:VEVENT/i).slice(1)
  const lines = events.map((e) => {
    const p = props(e.split(/END:VEVENT/i)[0])
    const get = (n: string) => p.find((x) => x.name === n)?.value
    return `- ${get('DTSTART') ?? '?'} ${get('SUMMARY') ?? 'Untitled'}${get('LOCATION') ? ` @ ${get('LOCATION')}` : ''}${get('DESCRIPTION') ? ` — ${get('DESCRIPTION')!.slice(0, 200)}` : ''}`
  })
  return clip(`${lines.length} event${lines.length === 1 ? '' : 's'}:\n${lines.join('\n')}`)
}

// ─── archives and office documents ───────────────────────────────────────────────────

const TEXTY = /\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|html?|org|rst|tex|py|js|ts|tsx|jsx|rs|go|java|c|h|cpp|swift|kt|rb|sh|sql|ipynb)$/i

/** Text runs of Office XML, with paragraph breaks. */
function xmlText(xml: string, para: RegExp): string {
  return xml
    .replace(para, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The text of a .docx, the slides of a .pptx, the sheets and strings of a .xlsx. */
export function officePreview(bytes: Uint8Array, ext: string): string | null {
  const want = (n: string) =>
    (ext === 'docx' && n === 'word/document.xml') ||
    (ext === 'pptx' && /^ppt\/slides\/slide\d+\.xml$/.test(n)) ||
    (ext === 'xlsx' && (n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml'))
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, { filter: (f) => want(f.name) })
  } catch {
    return null
  }
  if (ext === 'docx' && files['word/document.xml']) return clip(xmlText(strFromU8(files['word/document.xml']), /<\/w:p>/g))
  if (ext === 'pptx') {
    const slides = Object.keys(files).sort((a, b) => +a.replace(/\D/g, '') - +b.replace(/\D/g, ''))
    return clip(slides.map((s, i) => `[slide ${i + 1}]\n${xmlText(strFromU8(files[s]), /<\/a:p>/g)}`).join('\n\n'))
  }
  if (ext === 'xlsx') {
    const sheets = [...strFromU8(files['xl/workbook.xml'] ?? new Uint8Array()).matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => m[1])
    const strings = [...strFromU8(files['xl/sharedStrings.xml'] ?? new Uint8Array()).matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1])
    return clip(`Sheets: ${sheets.join(', ') || '?'}\n\nText in the workbook (first ${Math.min(strings.length, 300)} cells):\n${strings.slice(0, 300).join(' | ')}`)
  }
  return null
}

/** What is inside a zip, with the text of its small text files. */
export function zipPreview(bytes: Uint8Array): string {
  const listing: string[] = []
  let budget = 30_000
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!f.name.endsWith('/') && !f.name.startsWith('__MACOSX/')) listing.push(`${f.name} (${formatBytes(f.originalSize)})`)
        const take = TEXTY.test(f.name) && f.originalSize <= 20_000 && budget >= f.originalSize
        if (take) budget -= f.originalSize
        return take
      },
    })
  } catch (e) {
    return `A zip archive that could not be opened (${e instanceof Error ? e.message : String(e)}).`
  }
  const texts = Object.entries(files).map(([name, data]) => `<entry name=${JSON.stringify(name)}>\n${strFromU8(data)}\n</entry>`)
  return clip(`A zip archive with ${listing.length} files:\n${listing.slice(0, 400).join('\n')}${listing.length > 400 ? '\n…' : ''}${texts.length ? `\n\nSmall text files inside:\n${texts.join('\n')}` : ''}`)
}

// ─── dispatch ────────────────────────────────────────────────────────────────────────

export const extOf = (name: string) => /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''

/**
 * A text preview for a file Claude cannot read natively, from its bytes. Returns null for
 * formats with no reader here (video, audio, databases, unknown binaries): the caller then
 * describes the file by name, type and size and Claude asks the user about it.
 */
export function previewBytes(name: string, mime: string, bytes: Uint8Array): string | null {
  const ext = extOf(name)
  const text = () => new TextDecoder().decode(bytes)
  if (ext === 'csv' || ext === 'tsv' || mime === 'text/csv') return tablePreview(text(), ext === 'tsv' ? '\t' : undefined)
  if (ext === 'json' || ext === 'geojson' || ext === 'ipynb' || mime === 'application/json') return jsonPreview(text())
  if (ext === 'vcf' || mime === 'text/vcard') return vcardPreview(text())
  if (ext === 'ics' || mime === 'text/calendar') return icsPreview(text())
  if (ext === 'docx' || ext === 'pptx' || ext === 'xlsx') return officePreview(bytes, ext)
  if (ext === 'zip' || mime === 'application/zip') return zipPreview(bytes)
  return null
}
