import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, createNode, initRepo } from '../../src/data/repo.ts'
import { _rememberOriginalForTests, keepAll, keepCard, loadChat, resetChat, send, skipCard, useChat } from '../../src/ai/chat/session.ts'
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

  it('keeps the original file and live embeds with the note (the portrait case)', async () => {
    _rememberOriginalForTests(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'portrait.jpg', { type: 'image/jpeg' }))
    script([
      [
        {
          type: 'tool_use',
          id: 'p1',
          name: 'propose_notes',
          input: {
            notes: [
              note('n1', 'My studio portrait', {
                kind: 'memory',
                attach: ['portrait.jpg', 'gone.mov'],
                embeds: [
                  { kind: 'youtube', url: 'https://youtu.be/abc123', title: 'Talk' },
                  { kind: 'place', place: { name: 'Pupin Hall', address: '550 W 120th St, New York', lat: 40.81, lng: -73.96 } },
                ],
              }),
            ],
          },
        },
      ],
      [{ type: 'text', text: 'kept' }],
    ])
    await send('here is my portrait')
    await keepCard('p1', 'n1')
    const rec = [...useWorld.getState().nodes.values()].find((n) => n.title === 'My studio portrait')!
    expect(rec.attachments).toMatchObject([{ name: 'portrait.jpg', kind: 'image', mime: 'image/jpeg' }])
    expect(rec.embeds?.map((e) => e.kind)).toEqual(['youtube', 'place'])
    expect(useChat.getState().cards.p1[0].error).toMatch(/gone\.mov/)
    await vi.waitFor(() => expect(useChat.getState().busy).toBe(false))
  })

  it('adds a file and a place to an existing note when the card says addTo', async () => {
    const memory = await createNode({ archetype: 'memory', title: 'My studio portrait' })
    _rememberOriginalForTests(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'portrait.png', { type: 'image/png' }))
    script([
      [
        {
          type: 'tool_use',
          id: 'p1',
          name: 'propose_notes',
          input: { notes: [note('n1', 'The photo itself', { addTo: memory.id, attach: ['portrait.png'], embeds: [{ kind: 'place', place: { name: 'The studio' } }] })] },
        },
      ],
      [{ type: 'text', text: 'done' }],
    ])
    await send('attach this to my portrait memory')
    await keepCard('p1', 'n1')
    const rec = useWorld.getState().nodes.get(memory.id)!
    expect(useWorld.getState().nodes.size).toBe(1)
    expect(rec.attachments.map((a) => a.name)).toEqual(['portrait.png'])
    expect(rec.embeds?.[0]).toMatchObject({ kind: 'place', place: { name: 'The studio' } })
    expect(useChat.getState().cards.p1[0]).toMatchObject({ status: 'kept', id: memory.id })
    await vi.waitFor(() => expect(useChat.getState().busy).toBe(false))
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
    const file = (path: string, text: string) => ({ path, file: new File([text], path.split('/').pop()!) })
    const r = await importVault([
      file('Boltzmann.md', '---\nkind: entity\ndate: 1844-02-20\n---\n[[Entropy]] ![[portrait.png]]'),
      file('Entropy.md', '---\ndate: 2001\n---\nbody'),
      file('assets/portrait.png', 'png bytes'),
    ])
    expect(r.added).toBe(2)
    const b = [...useWorld.getState().nodes.values()].find((n) => n.title === 'Boltzmann')!
    expect(b.temporalOrigin).toBe(T0)
    expect(b.referenceDate).toMatchObject({ epochMs: Date.UTC(1844, 1, 20), precision: 'day' })
    expect(b.links).toHaveLength(1)
    // ![[portrait.png]] attaches the vault's file as the note's original.
    expect(r.attached).toBe(1)
    expect(useWorld.getState().nodes.get(b.id)!.attachments.map((a) => a.name)).toEqual(['portrait.png'])
  })
})
