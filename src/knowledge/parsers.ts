import type { Authorship, ParsedMessage, ParsedSource } from './types.ts'
import { normalizeVaultPath, parseVaultMetadata } from './vault.ts'
import { structuralSpans, type ChunkOptions } from './chunking.ts'
import { parsePortableKnowledge } from './portability.ts'
import { parseVaultDate } from '../data/obsidian.ts'
import { fnv1a32 } from '../domain/placement.ts'

type Obj = Record<string, unknown>
const object = (x: unknown): Obj => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {}
const string = (x: unknown) => typeof x === 'string' ? x : ''

export function sourceTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) { const ms = value < 10_000_000_000 ? value * 1000 : value; return Number.isFinite(new Date(ms).getTime()) ? ms : null }
  if (typeof value !== 'string' || !value.trim()) return null
  return parseVaultDate(value)?.epochMs ?? null
}

function role(value: unknown): Authorship {
  return value === 'user' || value === 'human' ? 'human' : value === 'assistant' ? 'assistant' : 'unknown'
}

function parts(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => typeof part === 'string' ? part : string(object(part).text)).filter(Boolean).join('\n')
}

function conversation(id: string, title: string, kind: ParsedSource['kind'], messages: ParsedMessage[], metadata: Obj): ParsedSource {
  let text = ''
  const located = messages.map((message) => {
    if (text) text += '\n\n'
    const start = text.length
    text += message.text
    return { ...message, start, end: text.length }
  })
  return { externalId: `${kind}:${id}`, title, kind, text, messages: located, authoredAt: messages.find((m) => m.authoredAt !== null)?.authoredAt ?? null, metadata }
}

function chatGpt(value: Obj): ParsedSource {
  const mapping = object(value.mapping)
  const messages: ParsedMessage[] = []
  // Preserve every branch. Stable input order disambiguates equal/unknown timestamps.
  for (const [id, raw] of Object.entries(mapping)) {
    const entry = object(raw)
    const message = object(entry.message)
    if (!Object.keys(message).length) continue
    const content = object(message.content)
    const text = parts(content.parts) || string(content.text)
    if (!text) continue
    messages.push({ id: string(message.id) || id, parentId: string(entry.parent) || undefined, text, role: role(object(message.author).role), authoredAt: sourceTime(message.create_time) })
  }
  messages.sort((a, b) => (a.authoredAt ?? Infinity) - (b.authoredAt ?? Infinity))
  const id = string(value.id) || string(value.conversation_id)
  if (!id) throw new Error('ChatGPT conversation has no stable id; the original is retained for repair.')
  return conversation(id, string(value.title) || 'ChatGPT conversation', 'chatgpt', messages, value)
}

function claude(value: Obj): ParsedSource {
  const messages = (value.chat_messages as unknown[]).map((raw): ParsedMessage => {
    const message = object(raw)
    return {
      id: string(message.uuid) || string(message.id) || undefined,
      parentId: string(message.parent_message_uuid) || string(message.parent) || undefined,
      text: string(message.text) || parts(message.content),
      role: role(message.sender ?? message.role),
      authoredAt: sourceTime(message.created_at ?? message.timestamp),
    }
  }).filter((m) => m.text)
  const id = string(value.uuid) || string(value.id)
  if (!id) throw new Error('Claude conversation has no stable id; the original is retained for repair.')
  return conversation(id, string(value.name) || string(value.title) || 'Claude conversation', 'claude', messages, value)
}

function codexRollout(text: string): ParsedSource {
  const rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try { return object(JSON.parse(line)) }
    catch {
      throw new Error(`Invalid Codex session JSON on line ${index + 1}. Export a complete copy and retry. The original is retained.`)
    }
  })
  const metadata = object(rows.find((row) => row.type === 'session_meta')?.payload)
  const id = string(metadata.id) || string(metadata.session_id)
  if (!id) throw new Error('This JSONL file has no Codex session identity. The original is retained.')
  const events: ParsedMessage[] = []
  const responseItems: ParsedMessage[] = []
  for (const [index, row] of rows.entries()) {
    const payload = object(row.payload)
    const authoredAt = sourceTime(row.timestamp)
    if (row.type === 'event_msg' && (payload.type === 'user_message' || payload.type === 'agent_message')) {
      if (typeof payload.message === 'string' && payload.message.trim()) {
        events.push({ id: `event-${index + 1}`, role: payload.type === 'user_message' ? 'human' : 'assistant', text: payload.message, authoredAt })
      }
    } else if (row.type === 'response_item' && payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
      const body = parts(payload.content).trim()
      if (body && !/^(?:<environment_context>|<user_instructions>|# AGENTS\.md instructions)/i.test(body)) {
        responseItems.push({ id: string(payload.id) || `response-${index + 1}`, role: role(payload.role), text: body, authoredAt })
      }
    }
  }
  const messages = [...events, ...responseItems.filter((item) => !events.some((event) => event.role === item.role))]
    .sort((a, b) => (a.authoredAt ?? Infinity) - (b.authoredAt ?? Infinity))
  if (!messages.length) throw new Error('The Codex session contains no readable human or assistant messages. The original is retained.')
  const title = messages.find((message) => message.role === 'human')?.text.split('\n')[0].slice(0, 100)
  return conversation(`codex:${id}`, title || 'Codex session', 'conversation', messages, { importer: 'codex-rollout', indexedRoles: ['human', 'assistant'] })
}

const isGeminiActivity = (value: Obj) => /^(?:gemini(?: apps)?|bard)$/i.test(string(value.header)) ||
  Array.isArray(value.products) && value.products.some((product) => /^(?:gemini(?: apps)?|bard)$/i.test(string(product)))

function activityText(html: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:br\b[^>]*|\/(?:p|div|li|pre|blockquote|h[1-6]))\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (match, raw: string) => {
      const key = raw.toLowerCase()
      if (key[0] !== '#') return entities[key] ?? match
      const code = key[1] === 'x' ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1))
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : match
    }).trim()
}

function geminiActivity(rows: unknown[]): ParsedSource[] {
  const sources = new Map<string, ParsedSource>()
  for (const raw of rows) {
    const item = object(raw)
    if (!isGeminiActivity(item)) continue
    const match = /^Prompted\s+([\s\S]+)$/i.exec(string(item.title))
    const authoredAt = sourceTime(item.time)
    if (!match || authoredAt === null) continue
    const prompt = match[1].trim()
    if (!prompt) continue
    const html = Array.isArray(item.safeHtmlItem) ? item.safeHtmlItem.map((value) => string(object(value).html)).join('\n') :
      string(item.safeHtmlItem) || string(object(item.safeHtmlItem).html)
    const response = activityText(html)
    const id = `gemini:${authoredAt}:${fnv1a32(prompt).toString(16)}`
    const messages: ParsedMessage[] = [{ id: 'prompt', role: 'human', text: prompt, authoredAt }]
    // Takeout dates the activity, so the reply's own authored time remains unknown.
    if (response) messages.push({ id: 'reply', parentId: 'prompt', role: 'assistant', text: response, authoredAt: null })
    if (!sources.has(id) || response) sources.set(id, conversation(id, `Gemini · ${prompt.split('\n')[0].slice(0, 100)}`, 'conversation', messages, { importer: 'gemini-activity' }))
  }
  if (!sources.size) throw new Error('Gemini activity has no dated “Prompted” entries in this export. The original is retained.')
  return [...sources.values()]
}

function document(text: string, path: string, kind: ParsedSource['kind'] = 'document'): ParsedSource {
  const base = path.split('/').at(-1) ?? path
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  const title = frontmatter && /^title:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter[1])?.[1]
  const date = frontmatter && /^(?:date|created|created_at):\s*["']?([^\r\n"']+)/m.exec(frontmatter[1])?.[1]
  return { externalId: `${kind}:${path.normalize('NFC')}`, title: title || /^#\s+(.+)$/m.exec(text)?.[1] || base.replace(/\.[^.]+$/, ''), kind, text, messages: [], authoredAt: sourceTime(date), metadata: { path, ...(/\.(?:md|markdown)$/i.test(path) ? parseVaultMetadata(text) : {}) } }
}

/** The complete original is stored before this parser runs, including unsupported fields. */
export function parseKnowledgeText(text: string, path: string, mime = ''): ParsedSource[] {
  if (/\.canvas$/i.test(path)) {
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new Error('Invalid Canvas JSON. Original retained; repair the file and retry.') }
    const canvas = object(value)
    if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges) || canvas.nodes.length > 5000 || canvas.edges.length > 20000) throw new Error('This Canvas exceeds the supported node/edge limits or has no valid graph. Original retained.')
    const ids = new Set<string>(), sections: string[] = [], diagnostics: string[] = []
    for (const raw of canvas.nodes) {
      const node = object(raw), id = string(node.id)
      if (!id || ids.has(id)) throw new Error('Canvas nodes need unique identifiers. Original retained.')
      ids.add(id)
      if (node.type === 'text') sections.push(string(node.text))
      else if (node.type === 'file') { const file = string(node.file); if (normalizeVaultPath(file)) sections.push(`File reference: ${file}${string(node.subpath)}`); else diagnostics.push(`Invalid file reference: ${file}`) }
      else if (node.type === 'link') sections.push(`Link reference: ${string(node.url)}`)
      else if (node.type === 'group') sections.push(string(node.label))
      else diagnostics.push(`Unsupported Canvas node type: ${string(node.type) || 'unknown'}`)
    }
    for (const raw of canvas.edges) { const edge = object(raw); if (!ids.has(string(edge.fromNode)) || !ids.has(string(edge.toNode))) throw new Error('Canvas contains an edge whose endpoint is missing. Original retained.'); if (typeof edge.label === 'string') sections.push(edge.label) }
    const parsed = document(text, path)
    parsed.metadata = { path, interchange: 'obsidian-canvas', canvas, readableText: sections.filter(Boolean).join('\n\n'), diagnostics, coordinates: 'independent-2d; never applied to world placement' }
    return [parsed]
  }
  if (/\.base$/i.test(path)) {
    const parsed = document(text, path)
    parsed.metadata = { path, interchange: 'obsidian-base', evaluation: 'none', formulasRetainedAsText: /^formulas\s*:/m.test(text), diagnostics: ['Bases is retained and searchable as text. Filters and formulas are not executed during import.'] }
    return [parsed]
  }
  if (/\.(?:jsonl|ndjson)$/i.test(path)) return [codexRollout(text)]
  if (/\.json$/i.test(path) || mime.includes('json')) {
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new Error('Invalid JSON. Original saved; fix the export and retry.') }
    const container = object(value)
    if (container.format === 'worldview-portable') return parsePortableKnowledge(value)
    const rows = Array.isArray(value) ? value : Array.isArray(container.conversations) ? container.conversations : [value]
    if (rows.some((v) => Object.keys(object(object(v).mapping)).length)) return rows.map((v) => chatGpt(object(v)))
    if (rows.some((v) => Array.isArray(object(v).chat_messages))) return rows.map((v) => claude(object(v)))
    if (rows.some((row) => isGeminiActivity(object(row)))) return geminiActivity(rows)
    // Generic JSON is indexed in full, never a first-items preview.
    return [document(text, path)]
  }
  if (/\.(?:md|markdown)$/i.test(path)) return [document(text, path, path.includes('/') ? 'obsidian' : 'document')]
  if (/\.(?:txt|text|csv|tsv|html?|log|xml|ya?ml)$/i.test(path) || mime.startsWith('text/') || !/\.[^/]+$/.test(path)) return [document(text, path)]
  throw new Error('Original saved. Text extraction for this format is not available yet; add a text or Markdown export to make it searchable.')
}

/** Bound passages within a message/document while retaining exact UTF-16 source offsets. */
export function splitPassages(source: ParsedSource, options: number | ChunkOptions = 1400): (ParsedMessage & { start: number; end: number; locator: string })[] {
  const opts = typeof options === 'number' ? { maxChars: options } : options
  const rawPages = source.metadata?.pages as { page: number; start: number; end: number }[] | undefined
  const pages = Array.isArray(rawPages) ? rawPages.filter((p) => Number.isInteger(p.page) && p.start >= 0 && p.end >= p.start && p.end <= source.text.length) : []
  const segments: (ParsedMessage & { start: number; end: number })[] = source.messages.length ? source.messages : pages.length ? pages.map((page) => ({ text: source.text.slice(page.start, page.end), start: page.start, end: page.end, role: 'unknown', authoredAt: source.authoredAt })) : [{ text: source.text, start: 0, end: source.text.length, role: 'unknown', authoredAt: source.authoredAt }]
  const out: (ParsedMessage & { start: number; end: number; locator: string })[] = []
  for (const [messageIndex, segment] of segments.entries()) {
    for (const { start: cursor, end } of structuralSpans(source.text, segment, opts)) {
      const text = source.text.slice(cursor, end)
      const page = pages.find((p) => p.start <= cursor && p.end > cursor)?.page
      const audio = Array.isArray(source.metadata?.audioChunks) ? (source.metadata.audioChunks as { start: number; end: number | null }[])[messageIndex] : undefined
      const time = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
      if (text.trim()) out.push({ ...segment, text, start: cursor, end, locator: audio ? `Audio ${time(audio.start)}${audio.end === null ? '' : `–${time(audio.end)}`}` : page !== undefined ? `Page ${page}` : source.messages.length ? `Message ${messageIndex + 1}${cursor !== segment.start ? ' (continued)' : ''}` : `Characters ${cursor + 1}–${end}` })
    }
  }
  return out
}
