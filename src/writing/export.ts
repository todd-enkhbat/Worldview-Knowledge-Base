import { strToU8, zipSync } from 'fflate'
import { getStore, getWorldGeneration, isRepoReady } from '../data/repo.ts'
import { validateWritingDocument } from './model.ts'
import { parseWritingEmbed, readWritingMedia } from './media.ts'
import type { WritingDocument, WritingMark, WritingNode } from './types.ts'

export const MAX_WRITING_EXPORT_MEDIA_BYTES = 64 * 1024 * 1024
export const MAX_WRITING_EXPORT_BYTES = 128 * 1024 * 1024
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/webm': 'webm' }
const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
const markdown = (value: unknown) => String(value ?? '').replace(/\\/g, '\\\\').replace(/([`*_[\]{}()#+.!|>~-])/g, '\\$1').replace(/&/g, '&amp;').replace(/</g, '&lt;')
const link = (value: string) => new URL(value).href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E')
function base64(bytes: Uint8Array): string { const chunks: string[] = []; for (let offset = 0; offset < bytes.length; offset += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))); return btoa(chunks.join('')) }
function references(doc: WritingDocument): Set<string> {
  const result = new Set<string>()
  function visit(node: WritingNode) { if (node.type === 'writingMedia') result.add(String(node.attrs!.assetId)); for (const child of node.content ?? []) visit(child) }
  visit(doc.content); if (doc.appearance.backgroundAssetId) result.add(doc.appearance.backgroundAssetId)
  return result
}
interface ExportAsset { id: string; bytes: Uint8Array; mime: string; kind: 'image' | 'audio' | 'video'; path: string; dataUrl: string }
function styles(mark: WritingMark): string {
  const attrs = mark.attrs ?? {}, result: string[] = []
  if (mark.type === 'textStyle') for (const [key, css] of Object.entries({ color: 'color', backgroundColor: 'background-color', fontFamily: 'font-family', fontSize: 'font-size' })) if (typeof attrs[key] === 'string') result.push(`${css}:${attrs[key]}`)
  if (mark.type === 'highlight' && typeof attrs.color === 'string') result.push(`background-color:${attrs.color}`)
  return result.join(';')
}
function htmlMark(text: string, mark: WritingMark): string {
  const tags: Record<string, string> = { bold: 'strong', italic: 'em', underline: 'u', strike: 's', code: 'code', highlight: 'mark' }
  if (mark.type === 'link') return `<a href="${html(new URL(String(mark.attrs!.href)).href)}" rel="noreferrer noopener">${text}</a>`
  const tag = tags[mark.type] ?? 'span', style = styles(mark)
  return `<${tag}${style ? ` style="${html(style)}"` : ''}>${text}</${tag}>`
}
function htmlNode(node: WritingNode, assets: Map<string, ExportAsset>): string {
  const children = () => (node.content ?? []).map((child) => htmlNode(child, assets)).join('')
  const align = node.attrs?.textAlign ? ` style="text-align:${html(node.attrs.textAlign)}"` : ''
  switch (node.type) {
    case 'doc': return children()
    case 'text': return (node.marks ?? []).reduce(htmlMark, html(node.text))
    case 'paragraph': return `<p${align}>${children() || '<br>'}</p>`
    case 'heading': { const level = Number(node.attrs?.level ?? 2); return `<h${level}${align}>${children()}</h${level}>` }
    case 'hardBreak': return '<br>'
    case 'horizontalRule': return '<hr>'
    case 'blockquote': return `<blockquote>${children()}</blockquote>`
    case 'bulletList': return `<ul>${children()}</ul>`
    case 'orderedList': return `<ol start="${Number(node.attrs?.start ?? 1)}" type="${html(node.attrs?.type ?? '1')}">${children()}</ol>`
    case 'listItem': return `<li>${children()}</li>`
    case 'codeBlock': return `<pre><code>${html((node.content ?? []).map((child) => child.type === 'hardBreak' ? '\n' : child.text ?? '').join(''))}</code></pre>`
    case 'table': return `<div class="table-scroll"><table><tbody>${children()}</tbody></table></div>`
    case 'tableRow': return `<tr>${children()}</tr>`
    case 'tableCell': case 'tableHeader': { const tag = node.type === 'tableHeader' ? 'th' : 'td'; return `<${tag} colspan="${Number(node.attrs?.colspan ?? 1)}" rowspan="${Number(node.attrs?.rowspan ?? 1)}"${Array.isArray(node.attrs?.colwidth) && node.attrs.colwidth.some((width) => Number(width) > 0) ? ` style="min-width:${node.attrs.colwidth.reduce((total: number, width: unknown) => total + Number(width), 0)}px"` : ''}>${children()}</${tag}>` }
    case 'writingCitation': { const a = node.attrs!, provenance = `${a.sourceId} · version ${a.versionId}${a.page ? ` · page ${a.page}` : ` · characters ${Number(a.start) + 1}–${a.end}`}`; return `<blockquote class="writing-citation" data-source-id="${html(a.sourceId)}" data-source-version="${html(a.versionId)}"><p>${html(a.quote)}</p><cite>${a.url ? `<a href="${html(a.url)}" rel="noreferrer noopener">${html(a.sourceTitle)}</a>` : html(a.sourceTitle)}<small>${html(provenance)}</small></cite></blockquote>` }
    case 'writingTopicLink': return `<span class="writing-topic-link" data-topic-id="${html(node.attrs!.topicId)}">[[${html(node.attrs!.label)}]]</span>`
    case 'writingFootnote': return `<sup class="writing-footnote-ref"><a href="#fn-${encodeURIComponent(String(node.attrs!.id))}" title="${html(node.attrs!.text)}" aria-label="Footnote: ${html(node.attrs!.text)}">※</a></sup>`
    case 'writingEmbed': { const embed = parseWritingEmbed(String(node.attrs!.url)); if (!embed) throw new Error('An external video URL is unsafe. Export was not created.'); return `<p class="external-video"><a href="${html(embed.url)}" rel="noreferrer noopener">Open ${embed.provider === 'youtube' ? 'YouTube' : 'Vimeo'} video</a> <small>External video loads only when opened.</small></p>` }
    case 'writingMedia': {
      const attrs = node.attrs!, asset = assets.get(String(attrs.assetId))
      if (!asset || asset.kind !== attrs.kind || asset.mime !== attrs.mime) throw new Error('A media block does not match its retained original. Export was not created.')
      const media = asset.kind === 'image' ? `<img src="${asset.dataUrl}" alt="${html(attrs.alt)}" loading="lazy">` : `<${asset.kind} src="${asset.dataUrl}" controls${asset.kind === 'video' ? ' playsinline' : ''} preload="metadata" aria-label="${html(attrs.name)}"></${asset.kind}>`
      return `<figure class="media media--${html(attrs.width ?? 'normal')}"${attrs.displayWidth ? ` style="width:${Number(attrs.displayWidth)}%"` : ''}>${media}${attrs.caption ? `<figcaption>${html(attrs.caption)}</figcaption>` : ''}</figure>`
    }
  }
  throw new Error('This writing block cannot be exported safely.')
}
function mdMark(text: string, mark: WritingMark): string {
  if (mark.type === 'bold') return `**${text}**`
  if (mark.type === 'italic') return `*${text}*`
  if (mark.type === 'strike') return `~~${text}~~`
  if (mark.type === 'underline') return `<u>${text}</u>`
  if (mark.type === 'highlight') return `<mark>${text}</mark>`
  if (mark.type === 'link') return `[${text}](${link(String(mark.attrs!.href))})`
  return text
}
function mdNode(node: WritingNode, assets: Map<string, ExportAsset>): string {
  const children = (separator = '') => (node.content ?? []).map((child) => mdNode(child, assets)).join(separator)
  switch (node.type) {
    case 'doc': return children('\n\n')
    case 'text': {
      if (node.marks?.some((mark) => mark.type === 'code')) { const raw = node.text ?? '', longest = Math.max(0, ...(raw.match(/`+/g) ?? []).map((run) => run.length)), fence = '`'.repeat(longest + 1); return `${fence} ${raw} ${fence}` }
      return (node.marks ?? []).reduce(mdMark, markdown(node.text))
    }
    case 'paragraph': return children()
    case 'heading': return `${'#'.repeat(Number(node.attrs?.level ?? 2))} ${children()}`
    case 'hardBreak': return '  \n'
    case 'horizontalRule': return '---'
    case 'blockquote': return children('\n\n').split('\n').map((line) => `> ${line}`).join('\n')
    case 'bulletList': case 'orderedList': return (node.content ?? []).map((child, index) => { const prefix = node.type === 'orderedList' ? `${Number(node.attrs?.start ?? 1) + index}. ` : '- '; return mdNode(child, assets).split('\n').map((line, lineIndex) => lineIndex ? `${' '.repeat(prefix.length)}${line}` : `${prefix}${line}`).join('\n') }).join('\n')
    case 'listItem': return children('\n\n')
    case 'codeBlock': { const raw = (node.content ?? []).map((child) => child.type === 'hardBreak' ? '\n' : child.text ?? '').join(''), length = Math.max(2, ...(raw.match(/`+/g) ?? []).map((run) => run.length)) + 1, fence = '`'.repeat(length), language = String(node.attrs?.language ?? '').replace(/[^A-Za-z0-9_+-]/g, ''); return `${fence}${language}\n${raw}\n${fence}` }
    case 'table': if (node.content?.some((row) => row.content?.some((cell) => Number(cell.attrs?.colspan ?? 1) > 1 || Number(cell.attrs?.rowspan ?? 1) > 1))) return htmlNode(node, assets); return (node.content ?? []).map((row, index) => `| ${(row.content ?? []).map((cell) => mdNode(cell, assets).replace(/\n/g, '<br>')).join(' | ')} |${index === 0 ? `\n| ${(row.content ?? []).map(() => '---').join(' | ')} |` : ''}`).join('\n')
    case 'tableRow': return children(' | ')
    case 'tableCell': case 'tableHeader': return children('<br>')
    case 'writingCitation': { const a = node.attrs!, title = a.url ? `[${markdown(a.sourceTitle)}](${link(String(a.url))})` : markdown(a.sourceTitle), locator = a.page ? `page ${a.page}` : `characters ${Number(a.start) + 1}–${a.end}`; return `${String(a.quote).split('\n').map((line) => `> ${markdown(line)}`).join('\n')}\n>\n> — ${title} (${locator}; source ${markdown(a.sourceId)}, version ${markdown(a.versionId)})` }
    case 'writingTopicLink': return `[[${String(node.attrs!.label).replace(/[[\]\n]/g, '')}]]`
    case 'writingFootnote': return `[^fn-${encodeURIComponent(String(node.attrs!.id))}]`
    case 'writingEmbed': { const embed = parseWritingEmbed(String(node.attrs!.url)); if (!embed) throw new Error('An external video URL is unsafe.'); return `[${embed.provider === 'youtube' ? 'YouTube' : 'Vimeo'} video](${embed.url})` }
    case 'writingMedia': { const attrs = node.attrs!, asset = assets.get(String(attrs.assetId)); if (!asset || asset.kind !== attrs.kind || asset.mime !== attrs.mime) throw new Error('A media block does not match its retained original.'); return `${asset.kind === 'image' ? '!' : ''}[${markdown(asset.kind === 'image' ? attrs.alt || attrs.name : `${asset.kind}: ${attrs.name}`)}](${asset.path})${attrs.caption ? `\n\n${markdown(attrs.caption)}` : ''}` }
  }
  throw new Error('This writing block cannot be exported safely.')
}
function footnotes(doc: WritingDocument): { id: string; text: string }[] {
  const values = new Map<string, string>()
  const visit = (node: WritingNode) => { if (node.type === 'writingFootnote') values.set(String(node.attrs!.id), String(node.attrs!.text)); for (const child of node.content ?? []) visit(child) }
  visit(doc.content); return [...values].map(([id, text]) => ({ id, text }))
}
function htmlDocument(doc: WritingDocument, assets: Map<string, ExportAsset>): string {
  const a = doc.appearance, font = { serif: 'Georgia, "Times New Roman", serif', sans: 'system-ui, -apple-system, "Segoe UI", sans-serif', mono: 'ui-monospace, "Courier New", monospace' }[a.fontFamily]
  let background = `background-color:${a.backgroundColor}`
  if (a.background === 'gradient') background += `;background-image:linear-gradient(140deg,${a.backgroundColor} 0%,color-mix(in srgb,${a.waveColor} 35%,${a.backgroundColor}) 100%)`
  if (a.background === 'waves') background += `;background-image:repeating-radial-gradient(ellipse at 100% -20%,transparent 0,transparent 35px,color-mix(in srgb,${a.waveColor} ${a.waveIntensity}%,transparent) 36px,transparent 38px)`
  if (a.background === 'dots') background += `;background-image:radial-gradient(color-mix(in srgb,${a.waveColor} ${a.waveIntensity}%,transparent) 1px,transparent 1px);background-size:22px 22px`
  if (a.background === 'image' && a.backgroundAssetId) { const image = assets.get(a.backgroundAssetId); if (!image || image.kind !== 'image') throw new Error('The writing background original is missing or is not an image.'); background += `;background-image:url('${image.dataUrl}');background-size:cover;background-position:center` }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; frame-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${html(doc.title || 'Untitled writing')}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:40px 20px;${background};color:${a.textColor};font:${a.fontSize}px/${a.lineHeight} ${font}}article{max-width:${a.pageWidth}px;margin:auto;padding:clamp(24px,5vw,64px);background:${a.pageStyle === 'paper' ? a.pageColor : 'transparent'};border-radius:8px;${a.pageStyle === 'paper' ? 'box-shadow:0 12px 50px #00000015' : ''}}h1,h2,h3,h4,h5,h6{line-height:1.25;overflow-wrap:anywhere}h1{font-size:2.15em;margin:0 0 .3em}.subtitle{font-size:1.15em}.byline{font-size:.8em;opacity:.75}.document-content{margin-top:2em;overflow-wrap:anywhere}a{color:${a.accentColor}}blockquote{border-left:3px solid ${a.accentColor};margin:1.5em 0;padding-left:1.2em}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:1em;background:#00000008}code{font-family:ui-monospace,monospace}hr{border:0;border-top:1px solid ${a.accentColor};opacity:.4;margin:2em 0}.media{margin:1.5em auto}.media--normal{width:72%}.media--wide{width:90%}.media--full{width:100%}.media img,.media video{display:block;width:100%;max-width:100%;height:auto}.media audio{width:100%}figcaption{margin-top:.5em;text-align:center;font-size:.75em;white-space:pre-wrap}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #8886;padding:.5em;vertical-align:top}th{background:#8881}.writing-citation>p,.writing-footnotes li{white-space:pre-wrap}cite small{display:block;font:11px/1.6 system-ui;opacity:.7}.writing-topic-link{color:inherit;border-bottom:1px dotted currentColor}.writing-footnotes{font-size:.8em}.external-video{font-size:.85em}.external-video small{display:block;opacity:.7}@media(max-width:600px){.media--normal,.media--wide{width:100%}}@media print{body{padding:0}article{padding:0;box-shadow:none;max-width:none}*{print-color-adjust:exact}}</style></head><body><article><header><h1>${html(doc.title || 'Untitled writing')}</h1>${doc.subtitle ? `<p class="subtitle">${html(doc.subtitle)}</p>` : ''}${doc.byline ? `<p class="byline">${html(doc.byline)}</p>` : ''}</header><main class="document-content">${htmlNode(doc.content, assets)}${footnotes(doc).length ? `<section class="writing-footnotes" aria-label="Footnotes"><hr><h2>Notes</h2><ol>${footnotes(doc).map((note) => `<li id="fn-${encodeURIComponent(note.id)}">${html(note.text)}</li>`).join('')}</ol></section>` : ''}</main></article></body></html>`
}

/** Complete artifact or actionable failure: no partial export with dangling originals. */
export async function exportWritingDocument(value: WritingDocument, format: 'html' | 'markdown' | 'bundle'): Promise<{ blob: Blob; name: string }> {
  if (!['html', 'markdown', 'bundle'].includes(format)) throw new Error('Choose HTML, Markdown or a complete writing bundle.')
  const doc = validateWritingDocument(value), store = getStore(), generation = getWorldGeneration()
  const check = () => { if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) throw new Error('The workspace changed before this writing export finished.') }
  check()
  const ids = [...references(doc)], metadata = await Promise.all(ids.map((id) => store.getAssetMeta(id)))
  check()
  if (metadata.some((meta) => !meta)) throw new Error('A retained writing original is missing. Restore its verified backup before exporting.')
  const originalBytes = metadata.reduce((total, meta) => total + meta!.bytes, 0)
  if (originalBytes > MAX_WRITING_EXPORT_MEDIA_BYTES) throw new Error('Portable writing exports support up to 64 MiB of media. Use a verified world backup for larger originals.')
  // Count every HTML embedding, not just distinct assets: repeated base64 references can amplify a small draft.
  if (format !== 'markdown') {
    const sizes = new Map(ids.map((id, index) => [id, Math.ceil(metadata[index]!.bytes / 3) * 4 + 96]))
    let estimated = new TextEncoder().encode(JSON.stringify(doc)).byteLength * 8 + 16384
    const count = (node: WritingNode) => { if (node.type === 'writingMedia') estimated += sizes.get(String(node.attrs!.assetId)) ?? 0; for (const child of node.content ?? []) count(child) }
    count(doc.content)
    if (doc.appearance.background === 'image' && doc.appearance.backgroundAssetId) estimated += sizes.get(doc.appearance.backgroundAssetId) ?? 0
    if (estimated + (format === 'bundle' ? originalBytes : 0) > MAX_WRITING_EXPORT_BYTES) throw new Error('This self-contained writing export would exceed 128 MiB. Reduce repeated media or use a verified world backup.')
  }
  const assets = new Map<string, ExportAsset>()
  for (const id of ids) { const media = await readWritingMedia(id, { store, generation }); check(); assets.set(id, { id, bytes: media.bytes, mime: media.mime, kind: media.kind, path: `assets/${id}.${extensions[media.mime]}`, dataUrl: format === 'markdown' ? '' : `data:${media.mime};base64,${base64(media.bytes)}` }) }
  const name = (doc.title || 'Untitled writing').normalize('NFKC').replace(/[^\p{L}\p{N}._ -]/gu, '').replace(/^\.+/, '').trim().slice(0, 100) || 'Writing'
  const rendered = format === 'markdown' ? '' : htmlDocument(doc, assets), md = `# ${markdown(doc.title || 'Untitled writing')}\n\n${doc.subtitle ? `${markdown(doc.subtitle)}\n\n` : ''}${doc.byline ? `${markdown(doc.byline)}\n\n` : ''}${mdNode(doc.content, assets)}${footnotes(doc).length ? `\n\n${footnotes(doc).map((note) => `[^fn-${encodeURIComponent(note.id)}]: ${markdown(note.text).replace(/\n/g, '\n    ')}`).join('\n')}` : ''}\n`
  check()
  if (format === 'html') return { blob: new Blob([rendered], { type: 'text/html;charset=utf-8' }), name: `${name}.html` }
  if (format === 'markdown' && !assets.size) return { blob: new Blob([md], { type: 'text/markdown;charset=utf-8' }), name: `${name}.md` }
  const manifest = { format: 'worldview-writing-export.v1', schemaVersion: 1, document: doc, assets: [...assets.values()].map((asset) => ({ assetId: asset.id, path: asset.path, mime: asset.mime, bytes: asset.bytes.byteLength, sha256: asset.id.slice('writing-'.length) })) }
  const files: Record<string, Uint8Array> = { 'document.md': strToU8(md), 'writing.json': strToU8(JSON.stringify(manifest, null, 2)), 'README.txt': strToU8('Local writing export. document.md uses the retained files in assets/. writing.json preserves the validated rich document and appearance. Full bundles include self-contained document.html. External video blocks stay explicit links. No cloud service is required.\n') }
  if (format === 'bundle') files['document.html'] = strToU8(rendered)
  for (const asset of assets.values()) files[asset.path] = asset.bytes
  if (Object.values(files).reduce((total, bytes) => total + bytes.byteLength, 0) > MAX_WRITING_EXPORT_BYTES) throw new Error('This portable writing export exceeds 128 MiB. Use a verified world backup for larger originals.')
  const archive = zipSync(files, { level: 6 }); check()
  return { blob: new Blob([archive.slice()], { type: 'application/zip' }), name: `${name}${format === 'markdown' ? '-markdown' : '-writing'}.zip` }
}
