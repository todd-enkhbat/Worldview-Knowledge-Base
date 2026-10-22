import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, createNode, initRepo } from '../../src/data/repo.ts'
import { keepAll, keepCard, loadChat, resetChat, send, skipCard, useChat } from '../../src/ai/chat/session.ts'
import { importVault } from '../../src/ai/chat/apply.ts'
import type { ChatStreamEvent } from '../../src/ai/chat/protocol.ts'

const T0 = Date.UTC(1990, 4, 17)

/** A scripted /api/chat: each call answers with the next assistant turn. */
function script(turns: unknown[][]) {
  const bodies: { messages: { role: string; content: unknown }[] }[] = []
  const f = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    const content = turns.shift() ?? [{ type: 'text', text: '(end)' }]
    const stop = content.some((b) => (b as { type: string }).type === 'tool_use') ? 'tool_use' : 'end_turn'
    const events: ChatStreamEvent[] = [{ t: 'done', content, stopReason: stop, model: 'claude-opus-5-5', usage: { input: 1, output: 1, cacheRead: 0 } }]
    return new Response(events.map((e) => JSON.stringify(e)).join('\n') + '\n', { status: 200 })
  })
  vi.stubGlobal('fetch', f)
  return { f, bodies }
}

const note = (key: string, title: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: 'idea',
  title,
  body: `About ${title}`,
  date: { iso: '2019-05', precision: 'month', certain: false },
  tags: ['physics'],
  links: [],
  source: {},
  ...extra,
})

beforeEach(async () => {
  useWorld.getState().hydrate(null, [])
  useApp.setState({ toasts: [], selectedId: null })
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0, start: 'empty' })
  resetChat()
  useChat.setState({ loaded: false })
  await loadChat()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await closeRepo()
})

const titles = () => [...useWorld.getState().nodes.values()].map((n) => n.title).sort()

describe('chat session', () => {
  it('answers search_world itself, waits on proposals, and writes nothing until kept (I5)', async () => {
    const existing = await createNode({ archetype: 'entity', title: 'Ludwig Boltzmann' })
    const { bodies } = script([
      [{ type: 'tool_use', id: 's1', name: 'search_world', input: { query: 'Boltzmann' } }],
      [
        { type: 'text', text: 'Here is what I heard.' },
        {
          type: 'tool_use',
          id: 'p1',
          name: 'propose_notes',
          input: { notes: [note('n1', 'Entropy is the arrow of time', { links: [{ to: existing.id, kind: 'influenced-by' }, { to: 'n2', kind: 'supports' }] }), note('n2', 'Second law')] },
        },
      ],
      [{ type: 'text', text: 'Noted. What next?' }],
    ])
    await send('I keep thinking about entropy and Boltzmann')
    // The search was answered without the user and the turn continued.
    const searchResult = bodies[1].messages.at(-1)!.content as { type: string; content: string }[]
    expect(searchResult[0].type).toBe('tool_result')
    expect(JSON.parse(searchResult[0].content)[0].title).toBe('Ludwig Boltzmann')
    expect(titles()).toEqual(['Ludwig Boltzmann'])
    expect(useChat.getState().cards.p1.map((c) => c.status)).toEqual(['open', 'open'])

    await keepCard('p1', 'n1')
    expect(titles()).toEqual(['Entropy is the arrow of time', 'Ludwig Boltzmann'])
    const kept = [...useWorld.getState().nodes.values()].find((n) => n.title.startsWith('Entropy'))!
    expect(kept.links.map((l) => l.targetId)).toEqual([existing.id])
    expect(kept.provenance).toMatchObject({ source: 'chat', model: 'claude-opus-5-5' })

    skipCard('p1', 'n2')
    // Every card decided: the results go back and Claude continues without new text.
    await vi.waitFor(() => expect(bodies.length).toBe(3))
    const result = (bodies[2].messages.at(-1)!.content as { type: string; content: string }[]).find((b) => b.type === 'tool_result')!
    expect(JSON.parse(result.content)).toMatchObject({ kept: [{ key: 'n1', id: kept.id }], skipped: ['n2'], undecided: [] })
    await vi.waitFor(() => expect(useChat.getState().busy).toBe(false))
  })

  it('Keep all resolves links between the kept proposals and is one undo', async () => {
    script([[{ type: 'tool_use', id: 'p1', name: 'propose_notes', input: { notes: [note('a', 'Alpha', { links: [{ to: 'b', kind: 'derives' }] }), note('b', 'Beta')] } }]])
    await send('two ideas')
    script([[{ type: 'text', text: 'ok' }]])
    await keepAll('p1')
    const alpha = [...useWorld.getState().nodes.values()].find((n) => n.title === 'Alpha')!
    const beta = [...useWorld.getState().nodes.values()].find((n) => n.title === 'Beta')!
    expect(alpha.links).toMatchObject([{ targetId: beta.id, kind: 'derives' }])
    await vi.waitFor(() => expect(useChat.getState().busy).toBe(false))
    useApp.getState().toasts.find((t) => t.message === 'Kept 2 notes')!.undo!()
    await vi.waitFor(() => expect(titles()).toEqual([]))
  })

  it('turns an invalid tool input into an error result and lets Claude retry', async () => {
    const { bodies } = script([[{ type: 'tool_use', id: 'x', name: 'propose_notes', input: { notes: [] } }], [{ type: 'text', text: 'sorry' }]])
    await send('hi')
    const r = (bodies[1].messages.at(-1)!.content as { is_error?: boolean }[])[0]
    expect(r.is_error).toBe(true)
  })

  it('says what is missing when the server has no key (I7)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    await send('hello')
    expect(useChat.getState().error).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('imports a vault without Claude, moving pre-T0 dates to reference dates', async () => {
    const r = await importVault([
      { path: 'Boltzmann.md', text: '---\nkind: entity\ndate: 1844-02-20\n---\n[[Entropy]]', lastModified: 0 },
      { path: 'Entropy.md', text: '---\ndate: 2001\n---\nbody', lastModified: 0 },
    ])
    expect(r.added).toBe(2)
    const b = [...useWorld.getState().nodes.values()].find((n) => n.title === 'Boltzmann')!
    expect(b.temporalOrigin).toBe(T0)
    expect(b.referenceDate).toMatchObject({ epochMs: Date.UTC(1844, 1, 20), precision: 'day' })
    expect(b.links).toHaveLength(1)
  })
})
