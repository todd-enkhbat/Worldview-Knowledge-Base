import type { ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createAi } from '../../server/ai.ts'
import { createChat, sanitizeAnthropicMessages } from '../../server/chat.ts'

const clients = () => {
  const openAiRetrieve = vi.fn(async () => ({ id: 'gpt-6.2-sol' })), anthropicRetrieve = vi.fn(async () => ({ id: 'claude-opus-5-5' }))
  const openAiCreate = vi.fn(), openAiStream = vi.fn(), anthropicStream = vi.fn(), anthropicCreate = vi.fn()
  return { openAiRetrieve, anthropicRetrieve, openAiCreate, openAiStream, anthropicStream, anthropicCreate, openai: { models: { retrieve: openAiRetrieve }, responses: { create: openAiCreate, stream: openAiStream } } as never, anthropic: { models: { retrieve: anthropicRetrieve }, beta: { messages: { stream: anthropicStream } }, messages: { create: anthropicCreate } } as never }
}
describe('server-side AI selection and diagnostics', () => {
  it('requires explicit opt-in even when provider keys are retained', async () => {
    const fake = clients(), env = { OPENAI_API_KEY: 'test-openai-key', ANTHROPIC_API_KEY: 'test-anthropic-key' }
    const automatic = createAi({ env, openAiClient: fake.openai, anthropicClient: fake.anthropic })
    expect(automatic.status()).toEqual({ provider: null, model: null, configured: false })
    expect(automatic.chat).toBeUndefined(); expect(automatic.refine).toBeUndefined()
    expect(await automatic.probe()).toMatchObject({ ok: false, reason: 'unavailable', message: expect.stringContaining('Cloud AI is off') })
    expect(fake.openAiRetrieve).not.toHaveBeenCalled(); expect(fake.anthropicRetrieve).not.toHaveBeenCalled()
    expect(fake.openAiCreate).not.toHaveBeenCalled(); expect(fake.openAiStream).not.toHaveBeenCalled()
    expect(fake.anthropicCreate).not.toHaveBeenCalled(); expect(fake.anthropicStream).not.toHaveBeenCalled()
    const openai = createAi({ env: { ...env, AI_PROVIDER: 'openai' }, openAiClient: fake.openai })
    expect(openai.status()).toEqual({ provider: 'openai', model: 'gpt-6.2-sol', configured: true })
    expect(openai.chat).toBeTypeOf('function'); expect(openai.refine).toBeTypeOf('function')
    const explicit = createAi({ env: { ...env, AI_PROVIDER: 'anthropic' }, openAiClient: fake.openai, anthropicClient: fake.anthropic })
    expect(explicit.status()).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', configured: true })
    expect(createAi({ env: { ...env, AI_PROVIDER: 'none' } }).status()).toEqual({ provider: null, model: null, configured: false })
  })
  it('does not silently spend another provider key when explicit OpenAI has no credential', async () => {
    const runtime = createAi({ env: { AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'other-provider-key' } })
    expect(runtime.status()).toEqual({ provider: 'openai', model: 'gpt-6.2-sol', configured: false })
    expect(runtime.chat).toBeUndefined(); expect(runtime.refine).toBeUndefined()
    expect(await runtime.probe()).toMatchObject({ ok: false, reason: 'unavailable', message: expect.stringContaining('OpenAI') })
    expect(createAi({ env: {} }).configured).toBe(false)
  })
  it('checks model access without generation and never returns credentials or raw model metadata', async () => {
    const fake = clients(), runtime = createAi({ env: { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-secret', OPENAI_CHAT_MODEL: 'gpt-6.2-sol' }, openAiClient: fake.openai })
    const result = await runtime.probe()
    expect(result).toMatchObject({ provider: 'openai', model: 'gpt-6.2-sol', configured: true, ok: true, message: expect.stringContaining('does not verify available credit') })
    expect(fake.openAiRetrieve).toHaveBeenCalledExactlyOnceWith('gpt-6.2-sol', { timeout: 15000 })
    expect(fake.openAiCreate).not.toHaveBeenCalled(); expect(fake.openAiStream).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('sk-secret')
  })
  it('sanitizes OpenAI auth/credit failures and unknown Anthropic diagnostics', async () => {
    const fake = clients(); fake.openAiRetrieve.mockRejectedValueOnce({ status: 429, code: 'insufficient_quota', message: 'sk-private-key https://private.provider/token=secret' })
    const openai = await createAi({ env: { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test' }, openAiClient: fake.openai }).probe()
    expect(openai).toMatchObject({ ok: false, reason: 'unavailable', message: expect.stringContaining('credit') }); expect(JSON.stringify(openai)).not.toMatch(/sk-private|private\.provider|token=/)
    fake.anthropicRetrieve.mockRejectedValueOnce(new Error('sk-ant-secret https://private.provider/token=secret'))
    const anthropic = await createAi({ env: { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test' }, anthropicClient: fake.anthropic }).probe()
    expect(anthropic).toMatchObject({ ok: false, reason: 'error' }); expect(JSON.stringify(anthropic)).not.toMatch(/sk-ant|private\.provider|token=/)
  })
  it('preserves explicit safe model names and rejects malformed identifiers without echoing secrets', () => {
    const fake = clients()
    expect(createAi({ env: { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test', OPENAI_CHAT_MODEL: 'gpt-6.2-astra' }, openAiClient: fake.openai }).model).toBe('gpt-6.2-astra')
    expect(() => createAi({ env: { AI_PROVIDER: 'not-a-provider' } })).toThrow('AI_PROVIDER must be')
    expect(() => createAi({ env: { AI_PROVIDER: 'openai', OPENAI_CHAT_MODEL: 'sk-do-not-echo-me' } })).toThrow('identifier is invalid')
  })
})

describe('Anthropic provider-switch replay', () => {
  it('removes opaque envelopes, retains usable text/tool blocks and drops empty assistant messages', () => {
    const envelope = { type: 'worldview_provider_state', provider: 'openai', output: [{ type: 'reasoning', encrypted_content: 'cipher' }] }
    expect(sanitizeAnthropicMessages([{ role: 'user', content: 'hello' }, { role: 'assistant', content: [envelope, { type: 'text', text: 'Useful answer' }, { type: 'tool_use', id: 'call', name: 'read_record', input: { id: 'x' } }] }, { role: 'assistant', content: [envelope] }])).toEqual([{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'Useful answer' }, { type: 'tool_use', id: 'call', name: 'read_record', input: { id: 'x' } }] }])
  })
  it('does not transmit the local OpenAI replay state to Anthropic SDK calls', async () => {
    let params: Record<string, unknown> = {}
    const client = { beta: { messages: { stream: (value: Record<string, unknown>) => { params = value; return { abort() {}, async *[Symbol.asyncIterator]() {}, finalMessage: async () => ({ content: [{ type: 'text', text: 'Done' }], model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) } } } } } as never
    const res = { writableEnded: false, destroyed: false, writeHead() {}, write() {}, on() {}, end() {} } as unknown as ServerResponse
    await createChat({ client })({ messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'worldview_provider_state', provider: 'openai', output: [{ type: 'reasoning', encrypted_content: 'cipher-must-not-transmit' }] }, { type: 'text', text: 'Previous answer' }] }, { role: 'user', content: 'Continue' }] }, res)
    expect(JSON.stringify(params.messages)).not.toContain('worldview_provider_state'); expect(JSON.stringify(params.messages)).not.toContain('cipher-must-not-transmit'); expect(JSON.stringify(params.messages)).toContain('Previous answer')
  })
})
