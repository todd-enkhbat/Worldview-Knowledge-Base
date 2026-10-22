import { describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import { createChat } from '../../server/chat.ts'
import { fetchReadable, htmlToText } from '../../server/fetchUrl.ts'
import { CHAT_TOOLS, ProposeNotesInput, type ChatStreamEvent } from '../../src/ai/chat/protocol.ts'

function fakeRes() {
  const chunks: string[] = []
  const res = {
    writableEnded: false,
    destroyed: false,
    writeHead: () => res,
    write: (c: string) => (chunks.push(c), true),
    end: () => void (res.writableEnded = true),
    on: () => res,
  }
  const events = () => chunks.join('').trim().split('\n').map((l) => JSON.parse(l) as ChatStreamEvent)
  return { res: res as unknown as ServerResponse, events }
}

function fakeClient(events: unknown[], final: Record<string, unknown>, seen: { params?: Record<string, unknown> }) {
  return {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          seen.params = params
          return {
            abort() {},
            async *[Symbol.asyncIterator]() {
              yield* events
            },
            finalMessage: async () => ({ model: 'claude-opus-5-5', stop_details: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 }, ...final }),
          }
        },
      },
    },
  } as never
}

describe('chat relay', () => {
  it('streams text, tool starts and the finished turn, with fallbacks on', async () => {
    const seen: { params?: Record<string, unknown> } = {}
    const content = [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't1', name: 'ask_user', input: { question: 'q', options: ['a', 'b'] } }]
    const chat = createChat({
      client: fakeClient(
        [
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
          { type: 'content_block_start', content_block: { type: 'tool_use', name: 'ask_user' } },
        ],
        { content, stop_reason: 'tool_use' },
        seen,
      ),
    })
    const { res, events } = fakeRes()
    await chat({ messages: [{ role: 'user', content: 'hello' }] }, res)
    expect(events().map((e) => e.t)).toEqual(['text', 'tool', 'done'])
    const done = events().at(-1) as Extract<ChatStreamEvent, { t: 'done' }>
    expect(done.content).toEqual(content)
    expect(seen.params?.fallbacks).toBe('default')
    expect(seen.params?.model).toBe('claude-opus-5-5')
  })

  it('reports a refusal and a bad request', async () => {
    const chat = createChat({ client: fakeClient([], { content: [], stop_reason: 'refusal' }, {}) })
    const a = fakeRes()
    await chat({ messages: [{ role: 'user', content: 'x' }] }, a.res)
    expect(a.events()[0]).toMatchObject({ t: 'error', reason: 'refusal' })
    const b = fakeRes()
    await chat({ messages: [] }, b.res)
    expect(b.events()[0]).toMatchObject({ t: 'error', reason: 'error' })
  })

  it('declares eager-streamed tools whose schemas match the validators', () => {
    expect(CHAT_TOOLS.map((t) => t.name)).toEqual(['search_world', 'propose_notes', 'ask_user'])
    expect(CHAT_TOOLS.every((t) => t.eager_input_streaming && t.input_schema.type === 'object')).toBe(true)
    const ok = ProposeNotesInput.safeParse({
      notes: [{ key: 'n1', kind: 'idea', title: 'T', body: '', date: { iso: '2019-05', precision: 'month', certain: false }, tags: [], links: [], source: {} }],
    })
    expect(ok.success).toBe(true)
  })
})

describe('URL reading', () => {
  it('reduces HTML to readable text with headings and lists', () => {
    const html = '<html><head><title>T</title><script>x()</script></head><body><nav>menu</nav><article><h2>Entropy</h2><p>It &amp; time.</p><ul><li>one</li></ul></article></body></html>'
    expect(htmlToText(html)).toBe('## Entropy\nIt & time.\n\n- one')
  })

  it('rejects non-http links and reads a page title', async () => {
    await expect(fetchReadable('file:///etc/passwd')).rejects.toThrow(/http/)
    const page = await fetchReadable('https://example.com/a', (async () =>
      new Response('<title>Hello &amp; bye</title><p>Body</p>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch)
    expect(page.title).toBe('Hello & bye')
    expect(page.text).toContain('Body')
  })
})
