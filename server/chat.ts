import type { ServerResponse } from 'node:http'
import Anthropic from '@anthropic-ai/sdk'
import { CHAT_SYSTEM, CHAT_TOOLS, ChatRequest, type ChatStreamEvent } from '../src/ai/chat/protocol.ts'

// The chat intake relay (milestone 1). Holds the key, the system prompt and the tool list;
// streams one turn back as newline-delimited ChatStreamEvent JSON. The browser owns the
// conversation (append-only, so thinking blocks stay valid) and answers every tool call.
// Refusals fall back server-side to the model Anthropic recommends for the category.

export const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-opus-5-5'

export interface ChatOptions {
  apiKey?: string
  client?: Pick<Anthropic, 'beta'>
  model?: string
}

export type ChatHandler = (body: unknown, res: ServerResponse) => Promise<void>

export function createChat(opts: ChatOptions = {}): ChatHandler {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 2 })
  const model = opts.model ?? CHAT_MODEL

  return async (body, res) => {
    const input = ChatRequest.safeParse(body)
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
    const emit = (e: ChatStreamEvent) => res.write(`${JSON.stringify(e)}\n`)
    if (!input.success) {
      emit({ t: 'error', reason: 'error', message: `bad request: ${input.error.issues[0]?.message ?? 'invalid'}` })
      return void res.end()
    }

    try {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        // Auto-cache the growing conversation (files and pages are resent every turn).
        cache_control: { type: 'ephemeral' },
        system: CHAT_SYSTEM,
        tools: CHAT_TOOLS as unknown as Anthropic.Beta.BetaToolUnion[],
        messages: input.data.messages as Anthropic.Beta.BetaMessageParam[],
      })
      res.on('close', () => stream.abort())
      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') emit({ t: 'tool', name: event.content_block.name })
        else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') emit({ t: 'text', d: event.delta.text })
      }
      const message = await stream.finalMessage()
      if (message.stop_reason === 'refusal') {
        emit({ t: 'error', reason: 'refusal', message: message.stop_details?.explanation ?? 'Claude declined to continue this conversation.' })
      }
      emit({
        t: 'done',
        content: message.content,
        stopReason: message.stop_reason,
        model: message.model,
        usage: {
          input: message.usage.input_tokens,
          output: message.usage.output_tokens,
          cacheRead: message.usage.cache_read_input_tokens ?? 0,
          cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
        },
      })
    } catch (e) {
      if (res.writableEnded || res.destroyed) return
      if (e instanceof Anthropic.AuthenticationError) emit({ t: 'error', reason: 'unavailable', message: 'The Anthropic API key was rejected.' })
      else if (e instanceof Anthropic.RateLimitError) emit({ t: 'error', reason: 'rate', message: 'Rate limited; try again in a moment.' })
      else if (e instanceof Anthropic.APIError) {
        const inner = (e.error as { error?: { message?: unknown } } | undefined)?.error?.message
        emit({ t: 'error', reason: 'error', message: typeof inner === 'string' ? inner : `API error ${e.status ?? ''}: ${e.message}` })
      } else emit({ t: 'error', reason: 'error', message: e instanceof Error ? e.message : String(e) })
    }
    res.end()
  }
}
