import { parseMarkdown, type MdBlock, type MdInline } from '../hud/markdown.ts'
import type { KnowledgeSource, SourceVersion } from '../knowledge/types.ts'
import { extractVaultLinks, parseVaultMetadata, resolveVaultLink, type VaultCandidate } from '../knowledge/vault.ts'
import { safeWritingLink, validateWritingContent, writingFromPlainText } from './model.ts'
import type { WritingDocument, WritingMark, WritingNode } from './types.ts'

type Corpus = { sources: readonly KnowledgeSource[]; versions: readonly SourceVersion[] }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
const text = (words: string, marks: WritingMark[]): WritingNode => ({ type:'text', text:words, ...(marks.length ? {marks} : {}) })
const paragraph = (content: WritingNode[]): WritingNode => ({type:'paragraph', ...(content.length ? {content} : {})})
function isMarkdown(source: KnowledgeSource, version: SourceVersion) {
  return source.kind === 'obsidian' || /\.(md|markdown)$/i.test(String(version.metadata?.path ?? version.originalName))
}

function referenceResolver(source: KnowledgeSource, version: SourceVersion, corpus?: Corpus) {
  const stored = new Map<string,string>()
  const refs = version.metadata?.resolvedReferences
  if (Array.isArray(refs)) for (const ref of refs) {
    if (record(ref) && record(ref.resolution) && ref.resolution.status === 'resolved' && typeof ref.resolution.id === 'string' && typeof ref.target === 'string') {
      stored.set(ref.target,ref.resolution.id)
    }
  }
  let candidates: VaultCandidate[] | undefined
  return (address: string) => {
    const target = address.split(/[#^]/,1)[0]
    if (!target && address.startsWith('#')) return source.id
    if (stored.has(target)) return stored.get(target)
    if (!corpus) return undefined
    if (!candidates) {
      const active = new Map(corpus.sources.filter(s => !s.deleted && !s.excluded).map(s => [s.currentVersionId,s]))
      candidates = corpus.versions.flatMap(v => {
        const candidate = active.get(v.id)
        if (!candidate || v.metadata?.vaultId !== version.metadata?.vaultId || v.metadata?.watchedFolderId !== version.metadata?.watchedFolderId) return []
        const aliases = record(v.metadata?.properties) ? v.metadata.properties.aliases : []
        return [{id:candidate.id, path:String(v.metadata?.path ?? v.originalName), aliases:[candidate.title,...(Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === 'string') : typeof aliases === 'string' ? [aliases] : [])]}]
      })
    }
    const result = resolveVaultLink(String(version.metadata?.path ?? version.originalName),target,candidates)
    return result.status === 'resolved' ? result.id : undefined
  }
}

function parseBody(raw: string, resolve: (target: string) => string | undefined): WritingNode[] {
  function inlines(nodes: MdInline[], marks: WritingMark[] = []): WritingNode[] {
    return nodes.flatMap((n): WritingNode[] => {
      if (n.type === 'text') return n.text ? [text(n.text,marks)] : []
      if (n.type === 'br') return [{type:'hardBreak'}]
      if (n.type === 'code') return [text(n.text,[{type:'code'}])]
      if (n.type === 'wiki' || n.type === 'relative') {
        const reference = n.type === 'wiki' ? extractVaultLinks(n.raw)[0] : undefined
        const address = n.type === 'relative' ? n.url : n.raw.replace(/^!?\[\[/,'').split('|')[0].replace(/\]\]$/,'')
        let decoded = address
        try { decoded = decodeURIComponent(address) } catch { /* An unescaped percent is valid in a vault filename. */ }
        const id = resolve(decoded)
        if (!id || address.length > 1000 || /[\r\n\0]/.test(address)) return [text(n.raw,marks)]
        const next = [...marks,{type:'writingSourceLink',attrs:{sourceId:id,target:address,embed:!!reference?.embed}}]
        return n.type === 'relative' ? inlines(n.children,next) : [text(reference?.alias || address,next)]
      }
      if (n.type === 'link') return inlines(n.children,safeWritingLink(n.href) ? [...marks,{type:'link',attrs:{href:n.href}}] : marks)
      const type = n.type === 'strong' ? 'bold' : n.type === 'em' ? 'italic' : n.type
      return inlines(n.children,marks.some(m => m.type === type) ? marks : [...marks,{type}])
    })
  }
  function blocks(items: MdBlock[]): WritingNode[] {
    return items.map((b): WritingNode => {
      switch (b.type) {
        case 'paragraph': return paragraph(inlines(b.children))
        case 'heading': return {type:'heading',attrs:{level:b.level},content:inlines(b.children)}
        case 'hr': return {type:'horizontalRule'}
        case 'code': return {type:'codeBlock', ...(b.lang ? {attrs:{language:b.lang.slice(0,80)}} : {}), ...(b.text ? {content:[text(b.text,[])]} : {})}
        case 'blockquote': return {type:'blockquote',content:b.children.length ? blocks(b.children) : [paragraph([])]}
        case 'list': return {type:b.ordered ? 'orderedList' : 'bulletList', ...(b.ordered ? {attrs:{start:Math.max(1,b.start)}} : {}), content:b.items.map(item => {
          const children = blocks(item)
          if (children[0]?.type !== 'paragraph') children.unshift(paragraph([]))
          return {type:'listItem',content:children}
        })}
        case 'table': return {type:'table',content:b.rows.map((cells,i) => ({type:'tableRow',content:cells.map(cell => ({type:i===0 ? 'tableHeader' : 'tableCell',content:[paragraph(inlines(cell))]}))}))}
      }
    })
  }
  const {rawFrontmatter,bodyStart} = parseVaultMetadata(raw)
  const body = blocks(parseMarkdown(raw.slice(bodyStart),{obsidian:true}))
  if (rawFrontmatter) body.unshift({type:'codeBlock',attrs:{language:'yaml'},content:[text(rawFrontmatter.trimEnd(),[])]})
  return body
}

/** A legacy source editor represented every paragraph as unmarked text and hard breaks.
 * Only replace intact original runs; edited paragraphs and user-created rich nodes survive. */
function rawLegacyParagraph(node: WritingNode): string | undefined {
  if (node.type !== 'paragraph' || Object.values(node.attrs ?? {}).some(v => v != null)) return undefined
  let result = ''
  for (const child of node.content ?? []) {
    if (child.marks?.length) return undefined
    if (child.type === 'text') result += child.text ?? ''
    else if (child.type === 'hardBreak') result += '\n'
    else return undefined
  }
  return result
}

export function sourceWritingContent(source: KnowledgeSource, version: SourceVersion, saved?: WritingNode, corpus?: Corpus): WritingNode {
  if (!isMarkdown(source,version)) return saved ?? writingFromPlainText(version.text)
  const resolve = referenceResolver(source,version,corpus)
  if (!saved) {
    const content = parseBody(version.text,resolve)
    return validateWritingContent({type:'doc', content:content.length ? content : [paragraph([])]})
  }
  const original = version.text.split('\n\n')
  const positions = new Map<string,number[]>()
  original.forEach((p,i) => {const list = positions.get(p) ?? []; list.push(i); positions.set(p,list)})
  const nodes = saved.content ?? [], raw = nodes.map(rawLegacyParagraph), result: WritingNode[] = []
  let nextOriginal = 0, changed = false
  for (let i=0; i<nodes.length;) {
    const words = raw[i]
    const start = words ? positions.get(words)?.find(pos => pos >= nextOriginal) : undefined
    if (start === undefined) {result.push(nodes[i++]); continue}
    let count = 1
    while (i+count < nodes.length && start+count < original.length && raw[i+count] === original[start+count]) count++
    const previous = nodes.slice(i,i+count)
    const formatted = parseBody(original.slice(start,start+count).join('\n\n'),resolve)
    if (formatted.length && JSON.stringify(previous) !== JSON.stringify(formatted)) {result.push(...formatted); changed = true}
    else result.push(...previous)
    i += count
    nextOriginal = start + count
  }
  return changed ? validateWritingContent({...saved,content:result}) : saved
}

export function sourceWritingDocument(doc: WritingDocument, sources: readonly KnowledgeSource[], versions: readonly SourceVersion[]): WritingDocument {
  if (!doc.basedOnSourceId || !doc.baseVersionId) return doc
  const source = sources.find(s => s.id === doc.basedOnSourceId)
  const version = versions.find(v => v.id === doc.baseVersionId && v.sourceId === source?.id)
  if (!source || !version) return doc
  const content = sourceWritingContent(source,version,doc.content,{sources,versions})
  return content === doc.content ? doc : {...doc,content}
}
