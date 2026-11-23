import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { openIdbStore } from '../../src/data/idbStore.ts'
import { closeRepo, completeFirstRun, createNode, initRepo, wipeWorld } from '../../src/data/repo.ts'
import { startSemantic, stopSemantic, useSemantic } from '../../src/ai/semanticIndex.ts'
import { localVectorStore } from '../../src/ai/vectorStore.ts'
import { EMBED_DIM } from '../../src/ai/embedText.ts'
import type { EmbedReply } from '../../src/ai/embed.worker.ts'

afterEach(async () => { stopSemantic(); await closeRepo(); vi.unstubAllGlobals() })

async function preparedWorker() {
  await initRepo({ store: await openIdbStore({ name: `semantic-cancellation-${crypto.randomUUID()}`, opfsRoot: null }) })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  const node = await createNode({ archetype: 'idea', title: 'Retained budget evidence' })
  let notifyStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => { notifyStarted = resolve })
  const workers: DeferredWorker[] = []
  class DeferredWorker {
    onmessage: ((event: { data: EmbedReply }) => void) | null = null
    onerror: ((event: { message: string }) => void) | null = null
    terminated = false
    calls = 0
    held: { id: number; texts: string[] } | null = null
    constructor() { workers.push(this) }
    postMessage(request: { id: number; texts: string[] }) {
      this.calls++
      if (this.calls === 1 || workers.length > 1) queueMicrotask(() => this.finish(request))
      else { this.held = request; notifyStarted() }
    }
    finish(request = this.held!) {
      this.onmessage?.({ data: { type: 'ready', config: 'wasm/q8' } })
      this.onmessage?.({ data: { type: 'result', id: request.id, vectors: request.texts.map(() => new Float32Array(EMBED_DIM)) } })
    }
    terminate() { this.terminated = true }
  }
  vi.stubGlobal('Worker', DeferredWorker)
  return { node, started, workers }
}

it('never persists late node embeddings after a world wipe', async () => {
  const fixture = await preparedWorker()
  const indexing = startSemantic()
  await fixture.started
  await wipeWorld({ confirm: true })
  fixture.workers[0].finish()
  await indexing
  expect((await localVectorStore().meta()).some((meta) => meta.id === fixture.node.id)).toBe(false)
})

it('settles a stopped worker and can restart indexing without changing the saved world', async () => {
  const fixture = await preparedWorker()
  const indexing = startSemantic()
  await fixture.started
  stopSemantic()
  await indexing
  expect(fixture.workers[0].terminated).toBe(true)
  expect(useSemantic.getState().phase).toBe('off')
  await startSemantic()
  expect(useSemantic.getState().phase).toBe('ready')
  expect((await localVectorStore().meta()).some((meta) => meta.id === fixture.node.id)).toBe(true)
})
