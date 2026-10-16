import Anthropic from '@anthropic-ai/sdk'
import { REFINE_JSON_SCHEMA, REFINE_SYSTEM, RefineInput, RefineOutput, type RefineResult } from '../src/ai/refineSchema.ts'

// Omnibox step 2 (PLAN roadmap): Claude Haiku 5.5 rewrites the provisional record. One
// messages.create with a json_schema output format, effort low and thinking disabled; the
// reply is parsed and checked with zod by hand, and a refusal, truncation or bad reply comes
// back as { ok: false } so the browser keeps its provisional record. The key stays here.

export const REFINE_MODEL = 'claude-haiku-5-5'

export interface RefinerOptions {
  apiKey?: string
  client?: Pick<Anthropic, 'messages'>
}

export function createRefiner(opts: RefinerOptions = {}): (body: unknown) => Promise<RefineResult> {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: 30_000, maxRetries: 1 })
  return async (body) => {
    const input = RefineInput.safeParse(body)
    if (!input.success) return { ok: false, reason: 'invalid', message: `bad request: ${input.error.issues[0]?.message ?? 'invalid'}` }
    const { text, today, t0, candidates } = input.data
    const prompt = [
      `today: ${today}`,
      `t0: ${t0}`,
      `candidates (link targets):`,
      candidates.length ? candidates.map((c) => `- ${c.id} [${c.archetype}] ${c.title}`).join('\n') : '- (none)',
      '',
      '<typed>',
      text,
      '</typed>',
    ].join('\n')

    let response: Anthropic.Message
    try {
      response = await client.messages.create({
        model: REFINE_MODEL,
        max_tokens: 2048,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: REFINE_JSON_SCHEMA } },
        system: REFINE_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      })
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return { ok: false, reason: 'unavailable', message: 'The Anthropic API key was rejected.' }
      if (e instanceof Anthropic.RateLimitError) return { ok: false, reason: 'error', message: 'Rate limited; try again shortly.' }
      if (e instanceof Anthropic.APIError) return { ok: false, reason: 'error', message: `API error ${e.status ?? ''}: ${e.message}` }
      return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) }
    }

    if (response.stop_reason === 'refusal') return { ok: false, reason: 'refusal', message: response.stop_details?.explanation ?? undefined }
    if (response.stop_reason === 'max_tokens') return { ok: false, reason: 'truncated' }
    const textBlock = response.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') return { ok: false, reason: 'invalid', message: 'no text in the reply' }
    let raw: unknown
    try {
      raw = JSON.parse(textBlock.text)
    } catch {
      return { ok: false, reason: 'invalid', message: 'the reply was not JSON' }
    }
    const parsed = RefineOutput.safeParse(raw)
    if (!parsed.success) return { ok: false, reason: 'invalid', message: parsed.error.issues[0]?.message }
    const ids = new Set(candidates.map((c) => c.id))
    const output = { ...parsed.data, links: parsed.data.links.filter((l) => ids.has(l.targetId)) }
    return { ok: true, output, model: response.model }
  }
}
