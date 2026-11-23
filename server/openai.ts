import type { ServerResponse } from 'node:http'
import OpenAI from 'openai'
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems'
import type { Response, ResponseInput, ResponseInputItem, ResponseInputContent, ResponseOutputItem, ResponseUsage } from 'openai/resources/responses/responses'
import { CHAT_SYSTEM, CHAT_TOOLS, ChatRequest, type ChatStreamEvent } from '../src/ai/chat/protocol.ts'
import { REFINE_JSON_SCHEMA, REFINE_SYSTEM, RefineInput, RefineOutput, type RefineResult } from '../src/ai/refineSchema.ts'
import type { ChatHandler } from './chat.ts'

export const OPENAI_CHAT_MODEL = 'gpt-6.2-sol'
export interface OpenAiOptions { apiKey?: string; model?: string; client?: Pick<OpenAI, 'responses'>; maxOutputTokens?: number }
type ErrorNotice = Extract<ChatStreamEvent, { t: 'error' }>
type Block = Record<string, unknown>
const object = (value: unknown): value is Block => !!value && typeof value === 'object' && !Array.isArray(value)
class OpenAiInputError extends Error {}

/** Category-only notices never echo a credential, request URL or raw provider payload. */
export function normalizeOpenAiError(error: unknown): Omit<ErrorNotice, 't'> {
  if (error instanceof OpenAiInputError) return { reason: 'error', message: error.message.slice(0, 300) }
  const details = object(error) ? error : {}, status = details.status
  const inner = object(details.error) ? details.error : {}
  const code = typeof details.code === 'string' ? details.code : inner.code
  if (status === 401 || code === 'invalid_api_key') return { reason: 'unavailable', message: 'The OpenAI API key was rejected. Update the server-side key.' }
  if (code === 'credit_balance_exhausted') return { reason: 'unavailable', message: 'This OpenAI organization has no API credits remaining. Check the linked organization and its credit grants in API billing.' }
  if (code === 'organization_spend_limit_exceeded' || code === 'project_spend_limit_exceeded') return { reason: 'unavailable', message: `The OpenAI ${code.startsWith('project') ? 'project' : 'organization'} spending limit was reached. Check its limits in the API dashboard.` }
  if (code === 'organization_usage_limit_exceeded') return { reason: 'unavailable', message: 'The OpenAI organization reached its approved usage limit. Check organization limits in the API dashboard.' }
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached' || code === 'billing_not_active') return { reason: 'unavailable', message: 'OpenAI API credit or billing is unavailable. Check this project’s API balance and spending limit.' }
  if (status === 429 || code === 'rate_limit_exceeded') return { reason: 'rate', message: 'OpenAI is rate limited. Try again shortly.' }
  if (status === 403) return { reason: 'unavailable', message: 'This OpenAI project does not permit the requested model or operation.' }
  if (status === 404 || code === 'model_not_found') return { reason: 'unavailable', message: 'The configured OpenAI model is not available to this project.' }
  if (code === 'context_length_exceeded' || status === 413) return { reason: 'error', message: 'This request exceeds OpenAI input limits. Narrow the source selection or start a new conversation.' }
  if (error instanceof OpenAI.APIConnectionTimeoutError) return { reason: 'error', message: 'OpenAI took too long to respond. Try again.' }
  if (error instanceof OpenAI.APIConnectionError) return { reason: 'unavailable', message: 'The OpenAI service could not be reached. Check the connection and retry.' }
  return { reason: 'error', message: typeof status === 'number' && status >= 500 ? 'OpenAI is temporarily unavailable. Try again shortly.' : 'OpenAI could not complete this request. Your saved record is unchanged.' }
}

function clientFor(opts: OpenAiOptions): Pick<OpenAI, 'responses'> | null {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY
  return opts.client ?? (apiKey ? new OpenAI({ apiKey, maxRetries: 0, timeout: 120000 }) : null)
}
const boundedTokens = (value: number | undefined) => Number.isSafeInteger(value) ? Math.max(256, Math.min(64000, value!)) : 8192
const validUrl = (value: unknown): value is string => { try { return typeof value === 'string' && ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false } }
const base64 = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && /^[a-zA-Z\d+/]*={0,2}$/.test(value)

function media(block: Block): ResponseInputContent | null {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'input_text', text: block.text }
  if (block.type !== 'image' && block.type !== 'document') return null
  const source = object(block.source) ? block.source : {}
  if (block.type === 'image') {
    if (source.type === 'base64' && base64(source.data) && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(String(source.media_type))) return { type: 'input_image', image_url: `data:${source.media_type};base64,${source.data}`, detail: 'auto' }
    if (source.type === 'url' && validUrl(source.url)) return { type: 'input_image', image_url: source.url, detail: 'auto' }
    throw new OpenAiInputError('This image cannot be sent to OpenAI in its current format. Its original is retained.')
  }
  if (source.type === 'base64' && source.media_type === 'application/pdf' && base64(source.data)) return { type: 'input_file', filename: typeof block.title === 'string' ? `${block.title.replace(/[\r\n\0]/g, '').slice(0, 180)}.pdf` : 'document.pdf', file_data: `data:application/pdf;base64,${source.data}` }
  if (source.type === 'url' && validUrl(source.url)) return { type: 'input_file', file_url: source.url }
  if (source.type === 'text' && typeof source.data === 'string') return { type: 'input_text', text: `${typeof block.title === 'string' ? `${block.title}\n` : ''}${source.data}` }
  throw new OpenAiInputError('This document cannot be sent to OpenAI in its current format. Its original is retained.')
}

const outputTypes = new Set(['message', 'reasoning', 'function_call', 'function_call_output', 'file_search_call', 'web_search_call', 'computer_call', 'computer_call_output', 'program', 'program_output', 'tool_search_call', 'tool_search_output', 'additional_tools', 'compaction', 'image_generation_call', 'code_interpreter_call', 'local_shell_call', 'local_shell_call_output', 'shell_call', 'shell_call_output', 'apply_patch_call', 'apply_patch_call_output', 'mcp_call', 'mcp_list_tools', 'mcp_approval_request', 'mcp_approval_response', 'custom_tool_call', 'custom_tool_call_output'])
function replayOutput(raw: unknown): ResponseInputItem[] {
  if (!Array.isArray(raw) || raw.length > 2000 || raw.some((item) => !object(item) || !outputTypes.has(String(item.type)) || item.type === 'message' && (item.role !== 'assistant' || !Array.isArray(item.content)))) throw new OpenAiInputError('Saved OpenAI context is incomplete. Start a new conversation to continue safely.')
  try { return toResponseInputItems(raw as ResponseOutputItem[]) } catch { throw new OpenAiInputError('Saved OpenAI context uses an unsupported format. Start a new conversation.') }
}

/** Translate append-only local history; opaque SDK output is replayed exactly once. */
export function openAiInput(messages: { role: 'user' | 'assistant'; content: unknown }[]): ResponseInput {
  const input: ResponseInput = [{ role: 'developer', content: [{ type: 'input_text', text: CHAT_SYSTEM }] }]
  const calls = new Set<string>(), results = new Set<string>()
  for (const message of messages) {
    if (typeof message.content === 'string') { if (message.content) input.push({ role: message.role, content: message.content }); continue }
    if (!Array.isArray(message.content)) throw new OpenAiInputError('The conversation contains an unreadable message.')
    const blocks = message.content.filter(object)
    const state = message.role === 'assistant' ? blocks.find((block) => block.type === 'worldview_provider_state' && block.provider === 'openai') : null
    if (state) {
      const replay = replayOutput(state.output)
      for (const item of replay) if (item.type === 'function_call') { if (!item.call_id || !item.name) throw new OpenAiInputError('Saved tool context is incomplete. Start a new conversation.'); calls.add(item.call_id) }
      input.push(...replay)
      continue
    }
    let content: ResponseInputContent[] = []
    const flush = () => { if (content.length) { input.push({ role: message.role, content }); content = [] } }
    for (const block of blocks) {
      if (block.type === 'tool_use' && message.role === 'assistant') {
        flush()
        if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) throw new OpenAiInputError('A saved tool call is incomplete. Start a new conversation.')
        calls.add(block.id)
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) })
      } else if (block.type === 'tool_result' && message.role === 'user') {
        flush()
        if (typeof block.tool_use_id !== 'string' || !calls.has(block.tool_use_id) || results.has(block.tool_use_id)) throw new OpenAiInputError('A tool result has no matching call in this conversation. Start a new conversation.')
        results.add(block.tool_use_id)
        const parts = Array.isArray(block.content) ? block.content.filter(object).flatMap((part) => media(part) ?? []) : null
        const text = typeof block.content === 'string' ? block.content : ''
        input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: parts?.length ? [...(block.is_error ? [{ type: 'input_text' as const, text: 'The tool returned an error.' }] : []), ...parts] : block.is_error ? JSON.stringify({ error: true, message: text }) : text })
      } else { const part = media(block); if (part) content.push(part) }
    }
    flush()
  }
  return input
}

function usageOf(usage: ResponseUsage | null | undefined) {
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0
  const written = usage?.input_tokens_details?.cache_write_tokens ?? 0
  return { input: Math.max(0, (usage?.input_tokens ?? 0) - cached - written), output: usage?.output_tokens ?? 0, cacheRead: cached, cacheWrite: written }
}
function visibleOutput(response: Response): unknown[] {
  const replayable = response.output.map((item) => { if (item.type !== 'reasoning') return item; const { content: _rawReasoning, ...encrypted } = item; return encrypted })
  const content: unknown[] = [{ type: 'worldview_provider_state', provider: 'openai', output: replayable }]
  for (const item of response.output) {
    if (item.type === 'message') for (const part of item.content) { if (part.type === 'output_text') content.push({ type: 'text', text: part.text }) }
    else if (item.type === 'function_call') { let parsed: unknown = null; try { parsed = JSON.parse(item.arguments) } catch { /* browser validation rejects incomplete arguments */ }; content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: parsed }) }
  }
  return content
}
const refusalOf = (response: Response) => response.output.some((item) => item.type === 'message' && item.content.some((part) => part.type === 'refusal'))

export function createOpenAiChat(opts: OpenAiOptions = {}): ChatHandler {
  const client = clientFor(opts), model = opts.model ?? OPENAI_CHAT_MODEL
  return async (body, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
    const emit = (event: ChatStreamEvent) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`) }
    const request = ChatRequest.safeParse(body)
    if (!request.success) { emit({ t: 'error', reason: 'error', message: 'The conversation request is invalid.' }); res.end(); return }
    if (!client) { emit({ t: 'error', reason: 'unavailable', message: 'An OpenAI API key is not configured on the server.' }); res.end(); return }
    try {
      const stream = client.responses.stream({ model, input: openAiInput(request.data.messages), store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'low' }, max_output_tokens: boundedTokens(opts.maxOutputTokens), tools: CHAT_TOOLS.map((tool) => ({ type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false })) })
      const abort = () => stream.abort()
      res.on('close', abort)
      try {
        for await (const event of stream) {
          if (event.type === 'response.output_text.delta') emit({ t: 'text', d: event.delta })
          else if (event.type === 'response.output_item.added' && event.item.type === 'function_call') emit({ t: 'tool', name: event.item.name })
        }
        const response = await stream.finalResponse()
        if (!['completed', 'incomplete'].includes(response.status ?? '') || response.error) { emit({ t: 'error', ...normalizeOpenAiError(response.error) }); return }
        const refusal = refusalOf(response) || response.incomplete_details?.reason === 'content_filter'
        if (refusal) emit({ t: 'error', reason: 'refusal', message: 'OpenAI declined to continue this request.' })
        const truncated = response.status === 'incomplete' && !refusal
        const hasTools = response.output.some((item) => item.type === 'function_call')
        emit({ t: 'done', content: visibleOutput(response), stopReason: truncated ? 'max_tokens' : refusal ? 'refusal' : hasTools ? 'tool_use' : 'end_turn', model: response.model, usage: usageOf(response.usage) })
      } finally { res.off?.('close', abort) }
    } catch (error) { if (!res.destroyed && !res.writableEnded) emit({ t: 'error', ...normalizeOpenAiError(error) }) }
    finally { if (!res.destroyed && !res.writableEnded) res.end() }
  }
}

export function createOpenAiRefiner(opts: OpenAiOptions = {}): (body: unknown) => Promise<RefineResult> {
  const client = clientFor(opts), model = opts.model ?? OPENAI_CHAT_MODEL
  return async (body) => {
    const input = RefineInput.safeParse(body)
    if (!input.success) return { ok: false, reason: 'invalid', message: 'The refinement request is invalid.' }
    if (!client) return { ok: false, reason: 'unavailable', message: 'An OpenAI API key is not configured on the server.' }
    const { text, today, t0, candidates } = input.data
    const prompt = [`today: ${today}`, `t0: ${t0}`, 'candidates (only permitted link targets):', candidates.length ? candidates.map((candidate) => `- ${candidate.id} [${candidate.archetype}] ${candidate.title}`).join('\n') : '- (none)', '', '<typed>', text, '</typed>'].join('\n')
    try {
      const response = await client.responses.create({ model, store: false, reasoning: { effort: 'low' }, max_output_tokens: boundedTokens(opts.maxOutputTokens), input: [{ role: 'developer', content: REFINE_SYSTEM.replace('a 3D world where height is time.', 'a 3D world where XYZ is spatial and the timeline represents history.') }, { role: 'user', content: prompt }], text: { format: { type: 'json_schema', name: 'worldview_refinement', schema: REFINE_JSON_SCHEMA, strict: true } } })
      if (response.status === 'failed' || response.error) { const error = normalizeOpenAiError(response.error); return { ok: false, reason: error.reason === 'rate' ? 'error' : error.reason, message: error.message } }
      if (refusalOf(response) || response.incomplete_details?.reason === 'content_filter') return { ok: false, reason: 'refusal', message: 'OpenAI declined to refine this record.' }
      if (response.status === 'incomplete') return { ok: false, reason: 'truncated' }
      const text = response.output.filter((item) => item.type === 'message').flatMap((item) => item.content.flatMap((part) => part.type === 'output_text' ? [part.text] : [])).join('')
      let raw: unknown; try { raw = JSON.parse(text) } catch { return { ok: false, reason: 'invalid', message: 'OpenAI returned no valid refinement JSON.' } }
      const parsed = RefineOutput.safeParse(raw)
      if (!parsed.success) return { ok: false, reason: 'invalid', message: 'The refinement did not match the record format.' }
      const ids = new Set(candidates.map((candidate) => candidate.id))
      return { ok: true, output: { ...parsed.data, links: parsed.data.links.filter((link) => ids.has(link.targetId)) }, model: response.model, usage: usageOf(response.usage) }
    } catch (failure) { const error = normalizeOpenAiError(failure); return { ok: false, reason: error.reason === 'rate' ? 'error' : error.reason, message: error.message } }
  }
}
