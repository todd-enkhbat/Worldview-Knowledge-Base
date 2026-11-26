import { unzipSync, strFromU8 } from 'fflate'

export async function readApplicationFile(file: File): Promise<string> {
  if (file.size > 16 * 1024 * 1024) throw Error('Choose a file smaller than 16 MB.')
  if (/\.pdf$/i.test(file.name)) {
    const response = await fetch('/api/extract-text', {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-wv-client': 'applications' },
      body: file
    })
    const result = await response.json()
    if (!response.ok) throw Error(result.error || 'Cannot extract the PDF text.')
    return result.text
  }
  if (/\.docx$/i.test(file.name)) {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (entry) => entry.name === 'word/document.xml' && entry.originalSize < 6000000
    })
    if (!files['word/document.xml']) throw Error('This file has no readable Word document.')
    const xml = new DOMParser().parseFromString(strFromU8(files['word/document.xml']), 'application/xml')
    return Array.from(xml.getElementsByTagNameNS('*', 'p'), (p) =>
      Array.from(p.getElementsByTagNameNS('*', 't'), (t) => t.textContent).join('')
    ).join('\n')
  }
  if (file.size > 2000000) throw Error('Choose a text document smaller than 2 MB.')
  const text = await file.text()
  if (!/\.html?$/i.test(file.name)) return text
  const doc = new DOMParser().parseFromString(text, 'text/html')
  doc.querySelectorAll('script,style,template,input,select,textarea').forEach((node) => node.remove())
  doc.querySelectorAll('p,div,li,h1,h2,h3,br').forEach((node) => node.append('\n'))
  return doc.body.textContent ?? ''
}
