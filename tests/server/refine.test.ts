import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { createRefiner, REFINE_MODEL } from '../../server/refine.ts'
import type { RefineInput, RefineOutput } from '../../src/ai/refineSchema.ts'
import { startTestEngine } from '../helpers/engine.ts'

const input: RefineInput = {
  text: 'Read Shannon 1948 on information #entropy',
  today: '2026-10-16',
  t0: '1990-05-17',
  candidates: [{ id: 'n-boltz', title: 'Ludwig Boltzmann', archetype: 'entity' }],
}

const good: RefineOutput = {
  archetype: 'document',
  title: 'A Mathematical Theory of Communication',
  contentMd: 'Shannon defines information entropy.',
  tags: ['information-theory', 'entropy'],
  date: { iso: '2026-10-16', precision: 'day' },
  referenceDate: { iso: '1948', precision: 'year', label: 'Published' },
  entityKind: null,
  demonQuery: null,
  mass: 2.5,
  temperature: 0.2,
  links: [
    { targetId: 'n-boltz', kind: 'derives', label: null },
    { targetId: 'invented-id', kind: 'relates', label: null },
  ],
}

type Create = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Partial<Anthropic.Message>>

function stub(create: Create) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = []
  const client = {
    messages: {
      create: async (p: Anthropic.MessageCreateParamsNonStreaming) => {
        calls.push(p)
        return create(p)
      },
    },
  } as unknown as Pick<Anthropic, 'messages'>
  return { client, calls }
}

const reply = (text: string, stop: Anthropic.StopReason = 'end_turn'): Partial<Anthropic.Message> => ({
  model: REFINE_MODEL,
  stop_reason: stop,
  stop_details: null,
  content: [{ type: 'text', text, citations: null }] as Anthropic.ContentBlock[],
})

describe('omnibox refinement (server)', () => {
  it('asks Haiku 5.5 for structured JSON at low effort with thinking off, and drops invented link targets', async () => {
    const s = stub(async () => reply(JSON.stringify(good)))
    const r = await createRefiner({ client: s.client })(input)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.output.title).toBe(good.title)
    expect(r.output.links.map((l) => l.targetId)).toEqual(['n-boltz'])
    const p = s.calls[0]
    expect(p.model).toBe('claude-haiku-5-5')
    expect(p.thinking).toEqual({ type: 'disabled' })
    expect(p.output_config?.effort).toBe('low')
    expect(p.output_config?.format?.type).toBe('json_schema')
    expect(JSON.stringify(p.messages)).toContain('n-boltz')
  })

  it('falls back on refusal, truncation, non-JSON and schema-invalid replies', async () => {
    const refusal = await createRefiner({ client: stub(async () => ({ ...reply(''), stop_reason: 'refusal' })).client })(input)
    expect(refusal).toMatchObject({ ok: false, reason: 'refusal' })
    const cut = await createRefiner({ client: stub(async () => reply('{"archetype":', 'max_tokens')).client })(input)
    expect(cut).toMatchObject({ ok: false, reason: 'truncated' })
    const prose = await createRefiner({ client: stub(async () => reply('Sure! Here is the record.')).client })(input)
    expect(prose).toMatchObject({ ok: false, reason: 'invalid' })
    const bad = await createRefiner({ client: stub(async () => reply(JSON.stringify({ ...good, archetype: 'planet' }))).client })(input)
    expect(bad).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('validates the request before spending a call', async () => {
    const s = stub(async () => reply(JSON.stringify(good)))
    const r = await createRefiner({ client: s.client })({ ...input, text: '' })
    expect(r).toMatchObject({ ok: false, reason: 'invalid' })
    expect(s.calls).toHaveLength(0)
  })

  it('is reachable at POST /api/refine, and answers 503 when no key is configured', async () => {
    const withKey = await startTestEngine({ refine: createRefiner({ client: stub(async () => reply(JSON.stringify(good))).client }) })
    const res = await fetch(`${withKey.base}/refine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    const noKey = await startTestEngine()
    const res2 = await fetch(`${noKey.base}/refine`, { method: 'POST', body: '{}' })
    expect(res2.status).toBe(503)
  })
})
