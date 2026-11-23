import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createChat, type ChatHandler } from './chat.ts'
import { createRefiner } from './refine.ts'
import { createOpenAiChat, createOpenAiRefiner, normalizeOpenAiError, OPENAI_CHAT_MODEL } from './openai.ts'
import type { RefineResult } from '../src/ai/refineSchema.ts'

export type AiProvider = 'openai' | 'anthropic' | null
export interface AiStatus { provider: AiProvider; model: string | null; configured: boolean }
export interface AiProbe extends AiStatus { ok: boolean; checkedAt: string; reason?: 'unavailable' | 'rate' | 'error'; message?: string }
export interface AiRuntime {
  provider: AiProvider; model: string | null; configured: boolean
  chat?: ChatHandler
  refine?: (body: unknown) => Promise<RefineResult>
  status(): AiStatus
  probe(): Promise<AiProbe>
}
export interface AiOptions {
  env?: NodeJS.ProcessEnv
  openAiClient?: Pick<OpenAI, 'responses' | 'models'>
  anthropicClient?: Pick<Anthropic, 'beta' | 'messages' | 'models'>
}
const modelName = (value: string): string => {
  if (!/^[a-zA-Z\d][a-zA-Z\d._:-]{0,160}$/.test(value) || /^sk-/i.test(value)) throw new Error('The configured AI model identifier is invalid.')
  return value
}
/** Cloud AI requires an explicit choice; retaining a key never opts a world into it. */
export function createAi(opts: AiOptions = {}): AiRuntime {
  const env = opts.env ?? process.env, chosen = env.AI_PROVIDER?.trim().toLowerCase()
  if (chosen && !['openai', 'anthropic', 'none'].includes(chosen)) throw new Error('AI_PROVIDER must be openai, anthropic or none.')
  const provider: AiProvider = chosen === 'openai' || chosen === 'anthropic' ? chosen : null
  const apiKey = provider === 'openai' ? env.OPENAI_API_KEY?.trim() : provider === 'anthropic' ? env.ANTHROPIC_API_KEY?.trim() : undefined
  const model = provider === 'openai' ? modelName(env.OPENAI_CHAT_MODEL?.trim() || OPENAI_CHAT_MODEL) : provider === 'anthropic' ? modelName(env.ANTHROPIC_CHAT_MODEL?.trim() || env.CHAT_MODEL?.trim() || 'claude-opus-5-5') : null
  const configured = !!apiKey
  const openai = provider === 'openai' && configured ? opts.openAiClient ?? new OpenAI({ apiKey, maxRetries: 0, timeout: 120000 }) : null
  const anthropic = provider === 'anthropic' && configured ? opts.anthropicClient ?? new Anthropic({ apiKey, maxRetries: 1, timeout: 120000 }) : null
  const status = (): AiStatus => ({ provider, model, configured })
  const chat = openai ? createOpenAiChat({ client: openai, model: model! }) : anthropic ? createChat({ client: anthropic, model: model! }) : undefined
  const refine = openai ? createOpenAiRefiner({ client: openai, model: modelName(env.OPENAI_REFINE_MODEL?.trim() || model!) }) : anthropic ? createRefiner({ client: anthropic, model: modelName(env.ANTHROPIC_REFINE_MODEL?.trim() || 'claude-haiku-5-5') }) : undefined
  return { ...status(), chat, refine, status,
    async probe(): Promise<AiProbe> {
      const checkedAt = new Date().toISOString()
      if (!configured || !model) return { ...status(), ok: false, checkedAt, reason: 'unavailable', message: provider ? `A server-side ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key is not configured.` : 'Cloud AI is off. Local capture and search are available. Enable a provider explicitly in the local service configuration when you are ready.' }
      try {
        if (openai) await openai.models.retrieve(model, { timeout: 15000 })
        else await anthropic!.models.retrieve(model, {}, { timeout: 15000 })
        return { ...status(), ok: true, checkedAt, message: 'The API credential and model are accessible. No generation was requested; this does not verify available credit.' }
      } catch (failure) {
        if (provider === 'openai') { const notice = normalizeOpenAiError(failure); return { ...status(), ok: false, checkedAt, reason: notice.reason === 'refusal' ? 'error' : notice.reason, message: notice.message } }
        const raw = failure && typeof failure === 'object' ? failure as { status?: unknown; error?: { error?: { type?: unknown } } } : {}
        const statusCode = raw.status
        return { ...status(), ok: false, checkedAt, reason: statusCode === 429 ? 'rate' : statusCode === 401 || statusCode === 403 || statusCode === 404 ? 'unavailable' : 'error', message: statusCode === 401 ? 'The Anthropic API key was rejected. Update the server-side key.' : statusCode === 429 ? 'Anthropic is rate limited. Try again shortly.' : statusCode === 403 || statusCode === 404 ? 'The configured Anthropic model is unavailable to this project.' : 'Anthropic could not be checked. Verify the server connection and API configuration.' }
      }
    },
  }
}
