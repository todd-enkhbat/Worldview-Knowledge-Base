import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blobSink, bytesSink, exportArchive, type BackupTarget } from '../../src/data/archive.ts'
import { exportDirectoryBundle, type BundleReader, type BundleWriter } from '../../src/data/directoryBundle.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, getStore, handleRemoteChange, importWorld, importWorldDirectory, initRepo, wipeWorld } from '../../src/data/repo.ts'
import { answerAsk, chatSessionToken, loadChat, resetChat, send, stage, useChat } from '../../src/ai/chat/session.ts'
import { resetKnowledge } from '../../src/knowledge/index.ts'

beforeEach(async () => {
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  resetChat()
  await loadChat()
  useChat.setState({ cloudAi: 'enabled' }) // These tests explicitly exercise an opted-in cloud session.
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetKnowledge()
  await closeRepo()
})

const restoredTranscript = () => ({ history: [{ role: 'user', content: 'The restored conversation must survive.' }], cards: { restored: [{ key: 'r1', status: 'open', note: { title: 'Restored pending card' } }] }, asks: {}, laterKept: [], contextDay: null, model: null })
async function sourceWithTranscript() {
  const store = createMemoryStore()
  const settings = await getStore().getSettings()
  await store.putSettings(settings!)
  await store.putKv('chat.v1', restoredTranscript())
  return store
}
function backupMemory(onWrite?: () => Promise<void>): BackupTarget {
  const blobs = new Map<string, Blob>()
  return {
    async write(name, fill) { const sink = blobSink(); await fill(sink); blobs.set(name, sink.blob()); await onWrite?.() },
    async prune() {},
    async read(name) { return blobs.get(name) },
  }
}
function directory() {
  const files = new Map<string, Uint8Array<ArrayBuffer>>()
  const writer: BundleWriter = { async exists(path) { return files.has(path) }, async write(path, bytes) { files.set(path, bytes.slice()) }, async remove(path) { files.delete(path) } }
  const reader: BundleReader = { async read(path) { const bytes = files.get(path); if (!bytes) throw new Error('Missing file'); return new Blob([bytes]) } }
  return { writer, reader }
}
function assistantReply(text: string): Response {
  return new Response(`${JSON.stringify({ t: 'done', content: [{ type: 'text', text }], stopReason: 'end_turn', model: 'test-model', usage: { input: 1, output: 1, cacheRead: 0 } })}\n`, { status: 200 })
}

describe('chat lifecycle across restore and replacement', () => {
  it('never executes tools from a refused response and excludes unanswered refused calls from the next request', async () => {
    const bodies: { messages: unknown[] }[] = []
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return bodies.length === 1 ? new Response(JSON.stringify({ t: 'done', content: [
        { type: 'worldview_provider_state', provider: 'openai', output: [{ type: 'function_call', call_id: 'refused-call', name: 'read_memory_context', arguments: '{"query":"secret"}' }] },
        { type: 'tool_use', id: 'refused-call', name: 'read_memory_context', input: { query: 'secret' } },
      ], stopReason: 'refusal', model: 'test-model', usage: { input: 1, output: 1, cacheRead: 0 } }) + '\n') : assistantReply('A fresh permitted conversation.')
    })
    vi.stubGlobal('fetch', fetcher)
    await send('First request.')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(useChat.getState().pending).toEqual([])
    expect(JSON.stringify(useChat.getState().history)).toContain('refused-call')
    await send('Start a fresh topic.')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(bodies[1])).not.toContain('refused-call')
  })

  it('reloads restored history/cards and prevents a stale save queued during replacement from overwriting them', async () => {
    useChat.setState({ history: [{ role: 'user', content: 'Previous world conversation.' }], asks: { old: { input: { question: 'A previous question?', options: ['Yes', 'No'] } } } })
    const incoming = await sourceWithTranscript()
    const sink = bytesSink()
    await exportArchive(incoming, sink)
    let backupStarted!: () => void
    let releaseBackup!: () => void
    const started = new Promise<void>((resolve) => { backupStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseBackup = resolve })
    const restoring = importWorld(new Blob([sink.bytes().slice()]), { backup: backupMemory(async () => { backupStarted(); await blocked }) })
    await started
    answerAsk('old', 'This queued old answer must not overwrite the backup transcript.')
    releaseBackup()
    await restoring
    await loadChat()
    expect(useChat.getState().history).toEqual(restoredTranscript().history)
    expect(useChat.getState().cards).toEqual(restoredTranscript().cards)
    expect((await getStore().getKv<{ history: unknown; asks: unknown }>('chat.v1'))?.history).toEqual(restoredTranscript().history)
    expect((await getStore().getKv<{ asks: unknown }>('chat.v1'))?.asks).toEqual({})
  })

  it('aborts a request and ignores its late response after a folder restore without restoring stale files or transcript', async () => {
    let resolveReply!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal
      return new Promise<Response>((resolve) => { resolveReply = resolve })
    }))
    const oldFile = new File(['An original from the old conversation.'], 'old-conversation.txt', { type: 'text/plain' })
    stage([{ name: oldFile.name, kind: 'text', bytes: oldFile.size, blocks: [{ type: 'text', text: 'An old staged file.' }], file: oldFile }])
    const token = chatSessionToken()
    const sending = send('A request from the previous world.')
    await vi.waitFor(() => expect(signal).toBeDefined())
    const source = await sourceWithTranscript()
    const incoming = directory()
    await exportDirectoryBundle(source, incoming.writer, { chunkBytes: 256 })
    const previous = directory()
    await importWorldDirectory(incoming.reader, { replace: true, backup: async () => { await exportDirectoryBundle(getStore(), previous.writer); return { name: 'before-restore', reader: previous.reader } } })
    expect(signal?.aborted).toBe(true)
    expect(chatSessionToken()).toBeGreaterThan(token)
    resolveReply(assistantReply('A stale answer that must never be appended.'))
    await sending
    await loadChat()
    expect(useChat.getState().history).toEqual(restoredTranscript().history)
    expect(useChat.getState().staged).toEqual([])
    expect(useChat.getState().busy).toBe(false)
    expect((await getStore().getKv<{ history: unknown }>('chat.v1'))?.history).toEqual(restoredTranscript().history)
  })

  it('loads remote transcript changes while keeping local files staged and never writes a reset over remote data', async () => {
    const file = new File(['Keep my unsubmitted original.'], 'my-draft.txt', { type: 'text/plain' })
    stage([{ name: file.name, kind: 'text', bytes: file.size, blocks: [], file }])
    const remote = restoredTranscript()
    await getStore().putKv('chat.v1', remote)
    await handleRemoteChange({ type: 'kv', keys: ['chat.v1'] })
    await loadChat()
    expect(useChat.getState().history).toEqual(remote.history)
    expect(useChat.getState().staged[0].file).toBe(file)
    expect(await getStore().getKv('chat.v1')).toEqual(remote)
  })

  it('blocks late work from an account whose repository has closed', async () => {
    let resolveReply!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async () => new Promise<Response>((resolve) => { resolveReply = resolve })))
    const sending = send('The old account request.')
    await vi.waitFor(() => expect(resolveReply).toBeDefined())
    await closeRepo()
    await initRepo({ store: createMemoryStore() })
    await completeFirstRun({ T0: Date.UTC(2000, 0, 1), start: 'empty' })
    await getStore().putKv('chat.v1', restoredTranscript())
    await loadChat()
    resolveReply(assistantReply('The old account answer.'))
    await sending
    expect(useChat.getState().history).toEqual(restoredTranscript().history)
    expect((await getStore().getKv<{ history: unknown }>('chat.v1'))?.history).toEqual(restoredTranscript().history)
  })

  it('clears the mounted conversation and staging after a wipe without saving an empty reset transcript', async () => {
    await getStore().putKv('chat.v1', restoredTranscript())
    await handleRemoteChange({ type: 'kv', keys: ['chat.v1'] })
    await loadChat()
    const file = new File(['An old staged original.'], 'before-wipe.txt')
    stage([{ name: file.name, kind: 'text', bytes: file.size, blocks: [], file }])
    await wipeWorld({ confirm: true })
    await loadChat()
    expect(useChat.getState().history).toEqual([])
    expect(useChat.getState().staged).toEqual([])
    expect(await getStore().getKv('chat.v1')).toBeUndefined()
  })
})
