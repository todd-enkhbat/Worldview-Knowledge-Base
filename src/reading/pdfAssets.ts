// PDF.js resources ship with the application. There is no CDN or remote font request.
const resources = import.meta.glob<string>('/node_modules/pdfjs-dist/{cmaps/*.bcmap,standard_fonts/*.{pfb,ttf},wasm/*.wasm}', { eager: true, query: '?url', import: 'default' })
export class LocalPdfDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const folder = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }[kind]
    if (!folder || !/^[\w.-]+$/.test(filename)) throw new Error('This PDF requested an unsupported rendering resource.')
    const resource = resources[`/node_modules/pdfjs-dist/${folder}/${filename}`]
    if (!resource) throw new Error('A bundled PDF rendering resource is unavailable.')
    const response = await fetch(resource, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('A bundled PDF rendering resource could not be opened.')
    return new Uint8Array(await response.arrayBuffer())
  }
}
