import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp, useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, createNode, initRepo, softDelete, updateNode } from '../../src/data/repo.ts'
import { citationAllowed, readMemoryContextForModel, readPassageForModel, readRecord, recordDigest, searchPassagesForModel, searchWorld } from '../../src/ai/chat/apply.ts'
import { loadChat, resetChat, send, useChat } from '../../src/ai/chat/session.ts'
import { CHAT_SYSTEM, ReadRecordInput, type ChatStreamEvent } from '../../src/ai/chat/protocol.ts'
import { captureThought, importKnowledgeFiles, initializeKnowledge, searchKnowledge, setSourcePolicy, useKnowledge } from '../../src/knowledge/index.ts'
import { useWorkspace } from '../../src/workspace/state.ts'
import { evidenceLinks } from '../../src/hud/Chat.tsx'
import { createKnowledgePage, resetArtifacts } from '../../src/knowledge/artifacts/index.ts'

beforeEach(async () => {
  useWorld.getState().hydrate(null, [])
  useApp.setState({ toasts: [], selectedId: null })
  useWorkspace.setState({ sourceIds: [], role: 'all', sourceKind: 'all', authoredAfter: '', authoredBefore: '' })
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  await initializeKnowledge()
  resetChat()
  useChat.setState({ loaded: false })
  await loadChat()
  useChat.setState({ cloudAi: 'enabled' }) // These tests explicitly exercise an opted-in cloud session.
})

afterEach(async () => {
  resetArtifacts()
  vi.unstubAllGlobals()
  useWorkspace.setState({ sourceIds: [], role: 'all', sourceKind: 'all', authoredAfter: '', authoredBefore: '' })
  await closeRepo()
})

function scriptedTurns(turns: unknown[][]) {
  const bodies: { messages: { role: string; content: unknown }[] }[] = []
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    const content = turns.shift() ?? [{ type: 'text', text: 'Done.' }]
    const events: ChatStreamEvent[] = [{ t: 'done', content, stopReason: 'end_turn', model: 'test-model', usage: { input: 1, output: 1, cacheRead: 0 } }]
    return new Response(events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  })
  vi.stubGlobal('fetch', fetcher)
  return bodies
}

describe('readable AI evidence', () => {
  it('delivers the bounded shared packet to the model and registers only exact issued citations', async () => {
    await captureThought('The copper orchard decision is to choose the quiet studio.')
    await createKnowledgePage({ title: 'Approved profile', kind: 'profile', contentMd: 'I prefer compact explanations.' })
    const packet = await readMemoryContextForModel('copper orchard', 4096)
    expect(packet.bytes).toBe(new TextEncoder().encode(packet.rendered).byteLength)
    expect(packet.bytes).toBeLessThanOrEqual(4096)
    expect(packet.context.map((entry) => entry.title)).toContain('Approved profile')
    const hit = packet.evidence[0]
    const bodies = scriptedTurns([
      [{ type: 'tool_use', id: 'context', name: 'read_memory_context', input: { query: 'copper orchard', maxBytes: 4096 } }],
      [{ type: 'text', text: `You chose the quiet studio. [Original](${hit.citationUrl})` }],
    ])
    await send('What did I choose for copper orchard?')
    const delivered = bodies[1].messages.at(-1)!.content as { content: string }[]
    const rendered = JSON.parse(delivered[0].content)
    expect(rendered.evidence).toEqual([expect.objectContaining({ id: hit.id, text: hit.text, versionId: hit.versionId })])
    expect(rendered.context).toEqual([expect.objectContaining({ title: 'Approved profile' })])
    expect(useChat.getState().citations[hit.citationUrl]).toMatchObject({ passageId: hit.id, versionId: hit.versionId })
    await setSourcePolicy(hit.sourceId, { aiAllowed: false })
    expect((await readMemoryContextForModel('copper orchard')).evidence).toEqual([])
    expect(evidenceLinks(`[Original](${hit.citationUrl})`, useChat.getState().citations)).toEqual([])
  })
  it('finds and reads evidence late in a record, with bounded continuation and a stale-reference check', async () => {
    const body = `${'ordinary introduction '.repeat(180)}The exact deployment decision was violet-otter.\n${'more context '.repeat(300)}`
    const record = await createNode({ title: 'Deployment journal', archetype: 'document', contentMd: body })
    const hits = await searchWorld('violet-otter')
    expect(hits.map((hit) => hit.id)).toContain(record.id)
    const hit = hits.find((item) => item.id === record.id)!
    expect(hit.start).toBeGreaterThan(2000)
    expect(hit.excerpt).toContain('violet-otter')
    expect(hit.excerpt).toBe(body.slice(hit.start, hit.end))
    const read = await readRecord({ id: record.id, offset: hit.start, limit: 220, digest: hit.digest })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.text).toBe(body.slice(hit.start, hit.start + 220))
    expect(read.nextOffset).toBe(hit.start + 220)
    expect(read.citationUrl).toContain(hit.digest)
    await updateNode(record.id, { contentMd: 'A corrected decision.' })
    expect(await readRecord({ id: record.id, digest: hit.digest })).toMatchObject({ ok: false, error: 'record_changed' })
  })

  it('never reveals deleted records or generates unbounded record reads', async () => {
    const record = await createNode({ title: 'Deleted rare decision', archetype: 'idea', contentMd: 'rare-falcon' })
    const digest = await recordDigest(record)
    await softDelete(record.id)
    expect(await searchWorld('rare-falcon')).toEqual([])
    expect(await readRecord({ id: record.id, digest })).toMatchObject({ ok: false, error: 'not_available' })
    expect(ReadRecordInput.safeParse({ id: record.id, limit: 1000000 }).success).toBe(false)
    expect(ReadRecordInput.safeParse({ id: record.id, offset: -1 }).success).toBe(false)
  })

  it('enforces AI exclusions independently from permitted local source search and verifies source scope again when reading', async () => {
    const first = await captureThought('Confidential aurora planning decision.')
    const second = await captureThought('Public aurora research note.')
    const source = useKnowledge.getState().sources.find((s) => s.nodeId === first.id)!
    const secondSource = useKnowledge.getState().sources.find((s) => s.nodeId === second.id)!
    const local = await searchKnowledge('aurora')
    const firstPassage = local.find((p) => p.sourceId === source.id)!
    expect((await readPassageForModel(firstPassage.id)).ok).toBe(true)
    await setSourcePolicy(source.id, { aiAllowed: false })
    expect((await searchKnowledge('aurora')).some((p) => p.sourceId === source.id)).toBe(true)
    expect((await searchPassagesForModel('aurora')).every((p) => p.sourceId !== source.id)).toBe(true)
    expect((await searchWorld('aurora')).every((p) => p.id !== first.id)).toBe(true)
    expect((await readRecord({ id: first.id })).ok).toBe(false)
    expect((await readPassageForModel(firstPassage.id)).ok).toBe(false)
    useWorkspace.setState({ sourceIds: [source.id] })
    expect(await searchPassagesForModel('aurora')).toEqual([])
    expect((await readRecord({ id: second.id })).ok).toBe(false)
    expect(citationAllowed({ sourceId: secondSource.id, title: secondSource.title, citationUrl: '' })).toBe(false)
  })

  it('answers passage tools automatically, preserves speaker attribution and issues only verifiable source links', async () => {
    const archive = [{ uuid: 'thread-evidence', name: 'Housing choice', chat_messages: [
      { uuid: 'human-turn', sender: 'human', text: 'I chose a quiet studio for the next year.', created_at: '2026-10-10T10:00:00Z' },
      { uuid: 'assistant-turn', sender: 'assistant', text: 'You could instead rent a penthouse.', created_at: '2026-10-10T10:01:00Z' },
    ] }]
    await importKnowledgeFiles([new File([JSON.stringify(archive)], 'claude-conversations.json', { type: 'application/json' })])
    const hit = (await searchPassagesForModel('quiet studio')).find((p) => p.role === 'human')!
    expect(hit).toBeDefined()
    const answer = `The recorded choice was a quiet studio. [Housing choice](${hit.citationUrl})`
    const bodies = scriptedTurns([
      [{ type: 'tool_use', id: 'find', name: 'search_passages', input: { query: 'quiet studio' } }],
      [{ type: 'tool_use', id: 'read', name: 'read_passage', input: { id: hit.id } }],
      [{ type: 'text', text: answer }],
    ])
    await send('What did I decide about housing?')
    expect(bodies).toHaveLength(3)
    const result = bodies[2].messages.at(-1)!.content as { content: string }[]
    expect(JSON.parse(result[0].content)).toMatchObject({ ok: true, role: 'human', text: expect.stringContaining('quiet studio') })
    expect(useChat.getState().pending).toEqual([])
    expect(evidenceLinks(answer, useChat.getState().citations)).toMatchObject([{ passageId: hit.id }])
    expect(evidenceLinks('[Made up](#/library?passage=does-not-exist)', useChat.getState().citations)).toEqual([])
    expect(evidenceLinks('[Script](javascript:alert(1))', useChat.getState().citations)).toEqual([])
    expect(CHAT_SYSTEM).toContain("An assistant's suggestion")
  })

  it('keeps the local transcript while withholding old evidence from later requests after a permission change', async () => {
    const record = await captureThought('Secret osprey project budget: seventy seven.')
    const source = useKnowledge.getState().sources.find((s) => s.nodeId === record.id)!
    scriptedTurns([
      [{ type: 'tool_use', id: 'read-secret', name: 'read_record', input: { id: record.id } }],
      [{ type: 'text', text: 'Your osprey budget was seventy seven.' }],
    ])
    await send('Read the project budget.')
    const length = useChat.getState().history.length
    expect(JSON.stringify(useChat.getState().history)).toContain('seventy seven')
    await setSourcePolicy(source.id, { aiAllowed: false })
    const bodies = scriptedTurns([[{ type: 'text', text: 'I can help with permitted sources.' }]])
    await send('What can you help with now?')
    expect(useChat.getState().history.length).toBeGreaterThan(length)
    expect(JSON.stringify(useChat.getState().history)).toContain('seventy seven')
    expect(JSON.stringify(bodies[0])).not.toContain('seventy seven')
    expect(JSON.stringify(bodies[0])).not.toContain('Read the project budget')
  })

  it('keeps authored-time and speaker filters in force for searches and follow-up reads', async () => {
    const archive = [{ uuid: 'dated-thread', name: 'Quasar choices', chat_messages: [
      { uuid: 'h1', sender: 'human', text: 'Quasar choice: a studio.', created_at: '2026-10-10T10:00:00Z' },
      { uuid: 'a1', sender: 'assistant', text: 'Quasar suggestion: a penthouse.', created_at: '2026-10-10T10:01:00Z' },
      { uuid: 'h2', sender: 'human', text: 'Quasar update: a workshop.', created_at: '2026-10-11T10:00:00Z' },
    ] }]
    await importKnowledgeFiles([new File([JSON.stringify(archive)], 'dated.json', { type: 'application/json' })])
    const all = await searchPassagesForModel('Quasar')
    const assistant = all.find((p) => p.role === 'assistant')!
    const later = all.find((p) => p.text.includes('workshop'))!
    useWorkspace.setState({ role: 'human', sourceKind: 'claude', authoredAfter: '2026-10-10', authoredBefore: '2026-10-10' })
    const filtered = await searchPassagesForModel('Quasar')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]).toMatchObject({ role: 'human', text: expect.stringContaining('studio') })
    expect((await readPassageForModel(assistant.id)).ok).toBe(false)
    expect((await readPassageForModel(later.id)).ok).toBe(false)
    expect((await readRecord({ id: filtered[0].nodeId! })).ok).toBe(false)
    expect((await readPassageForModel(filtered[0].id)).ok).toBe(true)
  })

  it('bounds long provider conversations while preserving and immediately reloading the local transcript', async () => {
    scriptedTurns([[{ type: 'text', text: 'Ready.' }]])
    await send('Initialize the investigation.')
    const history = Array.from({ length: 410 }, (_, i) => ({ role: i % 2 === 0 ? 'user' as const : 'assistant' as const, content: `Earlier visible turn ${i}` }))
    useChat.setState({ history, modelHistoryStart: 0 })
    const bodies = scriptedTurns([[{ type: 'text', text: 'The new investigation continues.' }]])
    await send('Continue with this new question.')
    expect(bodies[0].messages.length).toBeLessThan(360)
    expect(bodies[0].messages[0].role).toBe('user')
    expect(useChat.getState().history.length).toBe(412)
    useChat.setState({ history: [], loaded: false })
    await loadChat()
    expect(useChat.getState().history.length).toBe(412)
    expect(JSON.stringify(useChat.getState().history)).toContain('Earlier visible turn 0')
  })
})
