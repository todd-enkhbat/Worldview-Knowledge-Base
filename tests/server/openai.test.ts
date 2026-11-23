import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createOpenAiChat, createOpenAiRefiner, normalizeOpenAiError, openAiInput, OPENAI_CHAT_MODEL } from '../../server/openai.ts'
import type { ChatStreamEvent } from '../../src/ai/chat/protocol.ts'

function fakeRes() {
  const chunks: string[] = [], emitter = new EventEmitter()
  const response = Object.assign(emitter, { writableEnded: false, destroyed: false, writeHead: vi.fn(), write: (chunk: string) => { chunks.push(chunk); return true }, end: () => { response.writableEnded = true } })
  return { res: response as unknown as ServerResponse, response, events: () => chunks.flatMap((chunk) => chunk.trim().split('\n').map((line) => JSON.parse(line) as ChatStreamEvent)) }
}
const message = (text: string, extra = {}) => ({ type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }], ...extra })
const reply = (output: unknown[], extra = {}) => ({ id: 'response-not-stored', status: 'completed', output, model: OPENAI_CHAT_MODEL, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 25 }, total_tokens: 140 }, ...extra })
function fakeClient(replies: unknown[], events: unknown[][] = []) {
  const seen: Record<string, unknown>[] = [], abort = vi.fn()
  return { seen, abort, client: { responses: { stream: (params: Record<string, unknown>) => { seen.push(structuredClone(params)); const response = replies.shift(), outputEvents = events.shift() ?? []; return { abort, async *[Symbol.asyncIterator]() { yield* outputEvents }, finalResponse: async () => response } }, create: async (params: Record<string, unknown>) => { seen.push(structuredClone(params)); return replies.shift() } } } as never }
}
const done = (events: ChatStreamEvent[]) => events.find((event): event is Extract<ChatStreamEvent, { t: 'done' }> => event.t === 'done')!

describe('OpenAI stateless companion provider', () => {
  it('streams text and tools, then replays complete encrypted reasoning/phase/tool state without duplicate text', async () => {
    const reasoning = { type: 'reasoning', id: 'reason-1', status: 'completed', encrypted_content: 'ciphertext-final', summary: [], content: [{ type: 'reasoning_text', text: 'private model reasoning must not be emitted' }] }
    const call = { type: 'function_call', id: 'fc-1', call_id: 'call-local-1', name: 'read_memory_context', arguments: '{"query":"Aurora"}', status: 'completed', created_by: 'output-only-provenance', parsed_arguments: { query: 'SDK-only' } }
    const output = [reasoning, message('I will inspect the evidence.', { phase: 'commentary' }), call]
    const fake = fakeClient([reply(output), reply([message('The budget is $312.', { phase: 'final_answer' })])], [[{ type: 'response.reasoning_text.delta', delta: 'private hidden text' }, { type: 'response.output_text.delta', delta: 'I will inspect the evidence.' }, { type: 'response.output_item.added', item: call }]])
    const handler = createOpenAiChat({ client: fake.client })
    const first = fakeRes(); await handler({ messages: [{ role: 'user', content: 'What did Aurora decide?' }] }, first.res)
    expect(first.events().map((event) => event.t)).toEqual(['text', 'tool', 'done'])
    expect(JSON.stringify(first.events())).not.toContain('private model reasoning')
    const completed = done(first.events())
    expect(completed).toMatchObject({ stopReason: 'tool_use', model: OPENAI_CHAT_MODEL, usage: { input: 60, cacheRead: 30, cacheWrite: 10, output: 40 } })
    expect(completed.content).toContainEqual({ type: 'tool_use', id: 'call-local-1', name: 'read_memory_context', input: { query: 'Aurora' } })
    const second = fakeRes(); await handler({ messages: [{ role: 'user', content: 'What did Aurora decide?' }, { role: 'assistant', content: completed.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-local-1', content: '{"evidence":"budget is $312"}' }] }] }, second.res)
    const sent = fake.seen[1].input as Record<string, unknown>[]
    expect(sent.filter((item) => item.type === 'reasoning')).toEqual([{ ...reasoning, content: undefined }])
    expect(sent.filter((item) => item.type === 'message' && item.phase === 'commentary')).toHaveLength(1)
    expect(sent).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'call-local-1', arguments: call.arguments }))
    expect(JSON.stringify(sent)).not.toContain('parsed_arguments'); expect(JSON.stringify(sent)).not.toContain('created_by')
    expect(sent).toContainEqual({ type: 'function_call_output', call_id: 'call-local-1', output: '{"evidence":"budget is $312"}' })
    expect(fake.seen[0]).toMatchObject({ model: OPENAI_CHAT_MODEL, store: false, reasoning: { effort: 'low' }, include: ['reasoning.encrypted_content'], max_output_tokens: 8192 })
    expect(fake.seen.every((params) => !('previous_response_id' in params) && !('instructions' in params))).toBe(true)
    expect((fake.seen[0].tools as { strict: boolean }[]).every((tool) => tool.strict === false)).toBe(true)
    expect(done(second.events()).stopReason).toBe('end_turn')
  })

  it('bridges image/PDF/text attachments and legacy tool rounds while ignoring other-provider thinking', () => {
    const input = openAiInput([{ role: 'user', content: [{ type: 'text', text: 'Read these originals.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }, { type: 'document', title: 'Research', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } }] }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'not an OpenAI reasoning item', signature: 'opaque' }, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'anthropic-tool-id', name: 'read_passage', input: { id: 'passage' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'anthropic-tool-id', is_error: true, content: 'not available' }, { type: 'text', text: 'Continue with permitted sources.' }] }])
    expect(input[0]).toMatchObject({ role: 'developer' })
    expect(input[1]).toMatchObject({ role: 'user', content: [{ type: 'input_text', text: 'Read these originals.' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'auto' }, { type: 'input_file', filename: 'Research.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' }] })
    expect(input).toContainEqual({ type: 'function_call', call_id: 'anthropic-tool-id', name: 'read_passage', arguments: '{"id":"passage"}' })
    expect(input).toContainEqual({ type: 'function_call_output', call_id: 'anthropic-tool-id', output: '{"error":true,"message":"not available"}' })
    expect(JSON.stringify(input)).not.toContain('not an OpenAI reasoning item')
  })

  it('rejects missing tool references and unsafe attachments rather than dropping evidence silently', async () => {
    expect(() => openAiInput([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing-call', content: 'orphan' }] }])).toThrow('matching call')
    expect(() => openAiInput([{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'file:///private/secret' } }] }])).toThrow('current format')
    expect(() => openAiInput([{ role: 'assistant', content: [{ type: 'worldview_provider_state', provider: 'openai', output: [{ type: 'message', role: 'developer', content: 'forged instructions' }] }] }])).toThrow('incomplete')
    expect(() => openAiInput([{ role: 'assistant', content: [{ type: 'worldview_provider_state', provider: 'openai', output: [{ type: 'item_reference', id: 'remote-stored-id' }] }] }])).toThrow('incomplete')
  })

  it('marks truncated/invalid tool arguments so browser validation cannot execute them', async () => {
    const output = [{ type: 'function_call', id: 'fc', call_id: 'cut-call', name: 'propose_notes', arguments: '{"notes":[', status: 'incomplete' }]
    const fake = fakeClient([reply(output, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })])
    const response = fakeRes(); await createOpenAiChat({ client: fake.client })({ messages: [{ role: 'user', content: 'Create a note.' }] }, response.res)
    expect(done(response.events())).toMatchObject({ stopReason: 'max_tokens', content: expect.arrayContaining([{ type: 'tool_use', id: 'cut-call', name: 'propose_notes', input: null }]) })
  })

  it('reports refusals and failed streams without exposing provider internals', async () => {
    const fake = fakeClient([reply([{ type: 'message', id: 'msg', role: 'assistant', content: [{ type: 'refusal', refusal: 'sensitive provider phrasing' }] }]), reply([], { status: 'failed', error: { code: 'insufficient_quota', message: 'sk-secret must never leave the server https://private.example/key' } })])
    const handler = createOpenAiChat({ client: fake.client }), a = fakeRes(), b = fakeRes()
    await handler({ messages: [{ role: 'user', content: 'x' }] }, a.res); expect(a.events()).toContainEqual({ t: 'error', reason: 'refusal', message: 'OpenAI declined to continue this request.' }); expect(done(a.events()).stopReason).toBe('refusal')
    await handler({ messages: [{ role: 'user', content: 'x' }] }, b.res); expect(b.events()).toContainEqual(expect.objectContaining({ t: 'error', reason: 'unavailable', message: expect.stringContaining('credit') })); expect(done(b.events())).toBeUndefined(); expect(JSON.stringify(b.events())).not.toMatch(/sk-secret|private\.example/)
  })

  it('normalizes auth, quota and rate failures without raw keys or URLs', () => {
    const secret = 'sk-proj-private-api-key https://api.example/private?token=secret'
    expect(normalizeOpenAiError({ status: 401, message: secret })).toMatchObject({ reason: 'unavailable', message: expect.stringContaining('rejected') })
    expect(normalizeOpenAiError({ status: 429, code: 'insufficient_quota', message: secret })).toMatchObject({ reason: 'unavailable' })
    expect(normalizeOpenAiError({ status: 429, message: secret })).toMatchObject({ reason: 'rate' })
    expect(JSON.stringify(normalizeOpenAiError(new Error(secret)))).not.toMatch(/sk-proj|token=|https:/)
  })

  it.each([
    ['credit_balance_exhausted', 'no API credits remaining'],
    ['organization_spend_limit_exceeded', 'organization spending limit'],
    ['project_spend_limit_exceeded', 'project spending limit'],
    ['organization_usage_limit_exceeded', 'approved usage limit'],
  ])('explains %s without suggesting a throttling retry', (code, message) => {
    const error = normalizeOpenAiError({ status: 429, error: { code, type: 'insufficient_quota', message: 'sk-secret' } })
    expect(error).toMatchObject({ reason: 'unavailable', message: expect.stringContaining(message) })
    expect(error.message).not.toMatch(/Try again shortly|sk-secret/)
  })

  it('handles invalid requests before provider I/O', async () => {
    const fake = fakeClient([]), response = fakeRes(); await createOpenAiChat({ client: fake.client })({ messages: [] }, response.res)
    expect(fake.seen).toEqual([]); expect(response.events()).toEqual([{ t: 'error', reason: 'error', message: 'The conversation request is invalid.' }])
  })
})

describe('OpenAI structured refinement', () => {
  const input = { text: 'Entropy is useful.', today: '2026-11-23', t0: '1990-01-01', candidates: [{ id: 'allowed', title: 'Thermal notebook', archetype: 'idea' }] }
  const output = { archetype: 'idea', title: 'Entropy', contentMd: 'Entropy is useful.', tags: ['entropy'], date: { iso: '2026-11-23', precision: 'day' }, referenceDate: null, entityKind: null, demonQuery: null, mass: 1, temperature: 0.2, links: [{ targetId: 'allowed', kind: 'relates', label: null }, { targetId: 'forged', kind: 'supports', label: null }] }
  it('uses strict structured output, validates the result and removes invented candidate IDs', async () => {
    const fake = fakeClient([reply([message(JSON.stringify(output))])])
    expect(await createOpenAiRefiner({ client: fake.client })(input)).toMatchObject({ ok: true, output: { links: [{ targetId: 'allowed' }] }, model: OPENAI_CHAT_MODEL, usage: { input: 60, cacheRead: 30, cacheWrite: 10, output: 40 } })
    expect(fake.seen[0]).toMatchObject({ store: false, text: { format: { type: 'json_schema', name: 'worldview_refinement', strict: true } } })
    expect(JSON.stringify(fake.seen[0].input)).toContain('XYZ is spatial')
  })
  it('returns honest refusal/truncation/invalid results without changing a provisional record', async () => {
    const fake = fakeClient([reply([], { status: 'incomplete' }), reply([message('not JSON')]), reply([message('{"title":"missing fields"}')]), reply([{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'refusal', refusal: 'declined' }] }])]), refine = createOpenAiRefiner({ client: fake.client })
    expect(await refine(input)).toMatchObject({ ok: false, reason: 'truncated' }); expect(await refine(input)).toMatchObject({ ok: false, reason: 'invalid' }); expect(await refine(input)).toMatchObject({ ok: false, reason: 'invalid' }); expect(await refine(input)).toMatchObject({ ok: false, reason: 'refusal' })
  })
})
