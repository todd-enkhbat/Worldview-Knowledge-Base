import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorld } from '../../src/app/store.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, emptyTrash, getStore, importWorld, initRepo, softDelete, updateNode, useRepoStatus } from '../../src/data/repo.ts'
import { blobSink, exportArchive } from '../../src/data/archive.ts'
import { cancelKnowledgeJob, captureThought, getSourceOriginal, importKnowledgeFiles, initializeKnowledge, KNOWLEDGE_KV, readKnowledgePassage, resetKnowledge, retryImport, reviewProposal, searchKnowledge, setSourcePolicy, syncKnowledgeNodes, topicWords, useKnowledge, waitForKnowledgeJobs } from '../../src/knowledge/index.ts'
import { parseKnowledgeText, splitPassages } from '../../src/knowledge/parsers.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

beforeEach(async () => {
  resetKnowledge()
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  await initializeKnowledge()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetKnowledge()
  await closeRepo()
})

const file = (name: string, text: string) => new File([text], name, { type: name.endsWith('.json') ? 'application/json' : 'text/markdown' })

describe('durable knowledge corpus', () => {
  it('does not retain late original bytes in a replacement world when hashing finishes after restore', async () => {
    const incoming = blobSink(); await exportArchive(createMemoryStore(), incoming)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => { await gate; return digest(algorithm, data) })
    const capture = captureThought('These old-workspace words must never enter the restored world.')
    const denied = expect(capture).rejects.toThrow(/workspace|changed/i)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    await importWorld(incoming.blob(), { allowWithoutBackup: true })
    release(); await denied
    expect(await getStore().listAssets()).toEqual([])
    expect(await getStore().listNodes()).toEqual([])
    spy.mockRestore()
  })
  it('stores originals before parsing, imports full conversation branches with roles, and recognizes identical imports', async () => {
    const raw = JSON.stringify([{ id: 'chat-1', title: 'Entropy discussion', mapping: {
      a: { parent: null, message: { id: 'human-a', author: { role: 'user' }, create_time: 1700000000, content: { parts: ['I want to study entropy.'] } } },
      b: { parent: 'a', message: { id: 'assistant-b', author: { role: 'assistant' }, create_time: 1700000001, content: { parts: ['A suggested explanation of entropy.'] } } },
      c: { parent: 'a', message: { id: 'assistant-c', author: { role: 'assistant' }, create_time: 1700000002, content: { parts: ['An alternative branch.'] } } },
    } }])
    const first = await importKnowledgeFiles([file('conversations.json', raw)])
    expect(first).toMatchObject({ status: 'complete', saved: 1, failed: 0 })
    expect(useKnowledge.getState().sources).toHaveLength(1)
    expect(useWorld.getState().nodes.size).toBe(1)
    expect(useKnowledge.getState().passages.map((p) => [p.messageId, p.role, p.parentId])).toEqual([
      ['human-a', 'human', undefined], ['assistant-b', 'assistant', 'a'], ['assistant-c', 'assistant', 'a'],
    ])
    const source = useKnowledge.getState().sources[0]
    expect(await (await getSourceOriginal(source.id))!.blob.text()).toBe(raw)
    const second = await importKnowledgeFiles([file('conversations.json', raw)])
    expect(second).toMatchObject({ status: 'complete', unchanged: 1, saved: 0 })
    expect(useKnowledge.getState().versions).toHaveLength(1)
    expect(useWorld.getState().nodes.size).toBe(1)
    const stored = await getStore().getKv<KnowledgeSnapshot>(KNOWLEDGE_KV)
    expect(stored?.imports).toHaveLength(2)
  })

  it('keeps changed versions, precise late-source passages and history while applying source policy before AI retrieval', async () => {
    const text = `${'An introductory paragraph with background. '.repeat(160)}\nThe archival decision was to select the cobalt receiver.`
    await importKnowledgeFiles([file('research.md', text)])
    const source = useKnowledge.getState().sources[0]
    const hit = (await searchKnowledge('"cobalt receiver"'))[0]
    expect(hit.start).toBeGreaterThan(2000)
    expect((await readKnowledgePassage(hit.id))?.text).toContain('cobalt receiver')
    await importKnowledgeFiles([file('research.md', text.replace('cobalt receiver', 'silver receiver'))])
    expect(useKnowledge.getState().sources).toHaveLength(1)
    expect(useKnowledge.getState().versions).toHaveLength(2)
    expect(await readKnowledgePassage(hit.id)).toBeNull()
    expect((await readKnowledgePassage(hit.id, { includeHistory: true }))?.text).toContain('cobalt receiver')
    await setSourcePolicy(source.id, { aiAllowed: false })
    expect(await searchKnowledge('silver receiver', { aiOnly: true })).toEqual([])
    expect(await searchKnowledge('silver receiver')).not.toEqual([])
    await setSourcePolicy(source.id, { excluded: true })
    expect(await searchKnowledge('silver receiver')).toEqual([])
    expect(await readKnowledgePassage(hit.id, { includeHistory: true })).toBeNull()
  })

  it('captures plain thoughts, offers explainable connections, and keeps accepted source wording unchanged through review and undo', async () => {
    const first = await captureThought('Entropy and temperature determine the behavior of this thermal system.')
    const second = await captureThought('Temperature and entropy also matter to the design of a thermal engine.')
    await waitForKnowledgeJobs()
    const proposal = useKnowledge.getState().proposals.find((p) => [first.id, second.id].includes(p.sourceNodeId))!
    expect(proposal.explanation).toContain('lexical suggestion')
    const originals = useKnowledge.getState().versions.map((v) => v.text)
    await reviewProposal(proposal.id, 'accept')
    expect(useWorld.getState().nodes.get(proposal.sourceNodeId)?.links.some((l) => l.targetId === proposal.targetNodeId)).toBe(true)
    await reviewProposal(proposal.id, 'undo')
    expect(useWorld.getState().nodes.get(proposal.sourceNodeId)?.links.some((l) => l.targetId === proposal.targetNodeId)).toBe(false)
    await reviewProposal(proposal.id, 'reject')
    await syncKnowledgeNodes([...useWorld.getState().nodes.values()])
    await waitForKnowledgeJobs()
    expect(useKnowledge.getState().versions.map((v) => v.text)).toEqual(originals)
    expect(useKnowledge.getState().proposals.find((p) => p.id === proposal.id)?.status).toBe('rejected')
    expect(first.tags.length).toBeGreaterThan(0)
  })

  it('retains failed input bytes and retries from a receipt rather than asking for the original again', async () => {
    const bytes = 'not json yet'
    const receipt = await importKnowledgeFiles([file('invalid.json', bytes)])
    expect(receipt).toMatchObject({ status: 'failed', failed: 1 })
    expect(await (await getStore().getBlob(receipt.fileBlobIds[0]))!.text()).toBe(bytes)
    const again = await retryImport(receipt.id)
    expect(again.failed).toBe(1)
    expect(useKnowledge.getState().imports).toHaveLength(1)
    expect(useKnowledge.getState().jobs[0].status).toBe('failed')
  })

  it('records direct edits as new versions and hides soft-deleted records without changing immutable source versions', async () => {
    const node = await captureThought('The first wording about structured memory.')
    await updateNode(node.id, { contentMd: 'The corrected wording about structured memory.' })
    await syncKnowledgeNodes([...useWorld.getState().nodes.values()])
    expect(useKnowledge.getState().versions.map((v) => v.text)).toEqual(['The first wording about structured memory.', 'The corrected wording about structured memory.'])
    await softDelete(node.id)
    await syncKnowledgeNodes([...useWorld.getState().trash.values()])
    expect(await searchKnowledge('structured memory')).toEqual([])
    expect(useKnowledge.getState().versions).toHaveLength(2)
  })

  it('isolates same-name files in different source paths and clamps only render birth dates, preserving actual source times', async () => {
    const first = file('note.md', '---\ndate: 1850-01-01\n---\nHistorical source on epistemology.')
    const second = file('note.md', 'Contemporary source on thermal energy.')
    Object.defineProperty(first, 'webkitRelativePath', { value: 'vault-a/note.md' })
    Object.defineProperty(second, 'webkitRelativePath', { value: 'vault-b/note.md' })
    await importKnowledgeFiles([first, second])
    expect(useKnowledge.getState().sources).toHaveLength(2)
    expect(useKnowledge.getState().versions[0].authoredAt).toBe(Date.parse('1850-01-01'))
    expect([...useWorld.getState().nodes.values()][0].temporalOrigin).toBe(Date.UTC(1990, 0, 1))
  })

  it('reloads the active store and marks interrupted imports as recoverable', async () => {
    await captureThought('A durable note survives reopening the knowledge state.')
    const snapshot = (await getStore().getKv<KnowledgeSnapshot>(KNOWLEDGE_KV))!
    snapshot.imports.push({ id: 'interrupted', title: 'Interrupted', createdAt: 1, status: 'running', total: 1, saved: 0, unchanged: 0, failed: 0, errors: [], checkpoint: 0, fileBlobIds: [], items: [] })
    await getStore().putKv(KNOWLEDGE_KV, snapshot)
    resetKnowledge()
    await initializeKnowledge()
    expect(useKnowledge.getState().sources).toHaveLength(1)
    expect(useKnowledge.getState().imports[0].status).toBe('partial')
    expect(useKnowledge.getState().imports[0].errors[0]).toContain('interrupted')
  })

  it('indexes only authored user text from legacy chat and preserves raw history/cards without indexing copied evidence', async () => {
    const legacy = { history: [
      { role: 'user', content: [{ type: 'text', text: '[world] internal context' }, { type: 'text', text: 'My original research question about entropy.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'A copied answer with forbidden-context-marker.' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'forbidden-context-marker' }, { type: 'text', text: '[ui:kept] hidden application bookkeeping' }] },
    ], cards: { pending: [{ key: 'p1', status: 'open' }] } }
    await getStore().putKv('chat.v1', legacy)
    resetKnowledge()
    await initializeKnowledge({ migrateChat: true })
    expect(await searchKnowledge('forbidden-context-marker', { aiOnly: true })).toEqual([])
    expect((await searchKnowledge('research question', { aiOnly: true }))[0].role).toBe('human')
    expect(await getStore().getKv('chat.v1')).toEqual(legacy)
    const original = await getSourceOriginal(useKnowledge.getState().sources[0].id)
    expect(JSON.parse(await original!.blob.text())).toEqual(legacy)
    expect(useKnowledge.getState().versions[0].metadata).toMatchObject({ indexedRoles: ['human'], omittedDueToDerivedContext: true })
    await initializeKnowledge({ migrateChat: true })
    expect(useKnowledge.getState().sources).toHaveLength(1)
    expect(useKnowledge.getState().versions).toHaveLength(1)
  })

  it('makes excluded sources leave the world and restores them without treating exclusion as deletion', async () => {
    const node = await captureThought('A private thought about stable mental maps.')
    const source = useKnowledge.getState().sources[0]
    await setSourcePolicy(source.id, { excluded: true })
    expect(useWorld.getState().nodes.has(node.id)).toBe(false)
    expect(useWorld.getState().excluded.has(node.id)).toBe(true)
    await syncKnowledgeNodes([])
    expect(useKnowledge.getState().sources[0].deleted).not.toBe(true)
    await setSourcePolicy(source.id, { excluded: false })
    expect(useWorld.getState().nodes.has(node.id)).toBe(true)
    expect(await searchKnowledge('stable mental maps')).not.toEqual([])
  })

  it('removes permanently purged source text and the shared original bundle without losing retained normalized sources', async () => {
    const raw = JSON.stringify([{ uuid: 'purge-a', name: 'First source', chat_messages: [{ uuid: 'a', sender: 'human', text: 'Remove this confidential thought.' }] }, { uuid: 'keep-b', name: 'Second source', chat_messages: [{ uuid: 'b', sender: 'human', text: 'Keep this independent astronomy thought.' }] }])
    const receipt = await importKnowledgeFiles([file('claude.json', raw)])
    const sources = useKnowledge.getState().sources
    await softDelete(sources[0].nodeId!)
    await emptyTrash({ confirm: true })
    await syncKnowledgeNodes([])
    expect(useKnowledge.getState().sources).toHaveLength(1)
    expect(await searchKnowledge('confidential')).toEqual([])
    expect(await searchKnowledge('astronomy')).not.toEqual([])
    expect(await getStore().getBlob(receipt.fileBlobIds[0])).toBeUndefined()
    expect(await getSourceOriginal(sources[1].id)).toBeNull()
    expect((await retryImport(receipt.id)).status).toBe('failed')
    expect(useKnowledge.getState().sources).toHaveLength(1)
  })

  it('extracts PDFs only after preserving their bytes and gives passages accurate page-bounded locators', async () => {
    const firstPage = 'First page context. '
    const secondPage = `${'Scientific background. '.repeat(160)}The late conclusion selects the cobalt receiver.`
    const text = `${firstPage}\f${secondPage}`
    vi.stubGlobal('fetch', vi.fn(async () => {
      expect((await getStore().listAssets()).length).toBeGreaterThan(0)
      return new Response(JSON.stringify({ text, pages: [{ page: 1, start: 0, end: firstPage.length }, { page: 2, start: firstPage.length + 1, end: text.length }] }), { status: 200 })
    }))
    const pdf = new File(['%PDF-original'], 'study.pdf', { type: 'application/pdf' })
    const receipt = await importKnowledgeFiles([pdf])
    expect(receipt.status).toBe('complete')
    const hit = (await searchKnowledge('"cobalt receiver"'))[0]
    expect(hit.locator).toBe('Page 2')
    expect(hit.start).toBeGreaterThan(2000)
    expect(useKnowledge.getState().passages.every((p) => !p.text.includes('\f'))).toBe(true)
  })

  it('enforces authorship, kind and inclusive date filters before limiting results', async () => {
    const raw = JSON.stringify([{ uuid: 'dates', name: 'Dated source', chat_messages: [{ uuid: 'old', sender: 'human', text: 'Cobalt design before the interval.', created_at: '2026-01-01T00:00:00Z' }, { uuid: 'inside', sender: 'human', text: 'Cobalt design in the interval.', created_at: '2026-03-31T23:59:59.999Z' }, { uuid: 'machine', sender: 'assistant', text: 'Cobalt design from assistant.', created_at: '2026-03-31T23:59:59.999Z' }, { uuid: 'unknown', sender: 'human', text: 'Cobalt design with unknown date.' }] }])
    await importKnowledgeFiles([file('claude.json', raw)])
    const hits = await searchKnowledge('cobalt design', { role: 'human', kinds: ['claude'], authoredAfter: Date.parse('2026-03-01'), authoredBefore: Date.parse('2026-03-31T23:59:59.999Z'), limit: 1 })
    expect(hits.map((h) => h.messageId)).toEqual(['inside'])
    expect(await searchKnowledge('cobalt design', { kinds: ['document'] })).toEqual([])
  })

  it('pauses processing at a committed boundary and resumes from retained originals', async () => {
    let paused: Promise<void> | undefined
    const unsubscribe = useKnowledge.subscribe((state) => {
      const running = state.jobs.find((job) => job.status === 'running')
      if (running && !paused) paused = cancelKnowledgeJob(running.id)
    })
    const receipt = await importKnowledgeFiles([file('one.md', 'A source about astronomy.'), file('two.md', 'A source about biology.')])
    unsubscribe()
    await paused
    expect(receipt.status).toBe('partial')
    expect(useKnowledge.getState().jobs[0].status).toBe('cancelled')
    expect(receipt.fileBlobIds).toHaveLength(2)
    expect((await retryImport(receipt.id)).status).toBe('complete')
    expect(useKnowledge.getState().sources).toHaveLength(2)
  })

  it('compensates a relationship mutation if its review ledger compare-and-swap conflicts', async () => {
    await captureThought('Entropy and temperature shape this thermal system.')
    await captureThought('Temperature and entropy also govern thermal engines.')
    await waitForKnowledgeJobs()
    const proposal = useKnowledge.getState().proposals[0]
    vi.spyOn(getStore(), 'commitKnowledge').mockResolvedValueOnce(false)
    await expect(reviewProposal(proposal.id, 'accept')).rejects.toThrow()
    expect(useWorld.getState().nodes.get(proposal.sourceNodeId)?.links.some((link) => link.targetId === proposal.targetNodeId)).toBe(false)
    expect(useKnowledge.getState().proposals[0].status).toBe('proposed')
    await reviewProposal(proposal.id, 'accept')
    expect(useKnowledge.getState().proposals[0].status).toBe('accepted')
  })

  it('acknowledges capture with durable bytes, projection and queued organization before suggestions run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = await captureThought('Amber lighthouse project examines the energy budget before publication.')
    const second = await captureThought('The lighthouse project compares its energy budget after review.')
    const durable = (await getStore().getKv<KnowledgeSnapshot>(KNOWLEDGE_KV))!
    expect(await getStore().getNode(second.id)).toBeDefined()
    expect(durable.sources.every((source) => source.pendingProjection === false)).toBe(true)
    expect(durable.jobs.find((job) => job.kind === 'organize')).toMatchObject({ status: 'queued', completed: 0, total: 2 })
    expect(durable.proposals).toEqual([])
    expect(await getStore().getBlob(durable.versions[1].originalBlobId)).toBeDefined()
    await waitForKnowledgeJobs()
    expect(useKnowledge.getState().jobs.find((job) => job.kind === 'organize')?.status).toBe('complete')
    expect(useKnowledge.getState().proposals.some((proposal) => [first.id, second.id].includes(proposal.sourceNodeId))).toBe(true)
  })

  it('resumes a durable interrupted organization job without duplicating sources or relationships', async () => {
    await captureThought('Entropy and temperature explain a thermal experiment.')
    await captureThought('Temperature and entropy constrain the thermal design.')
    const durable = (await getStore().getKv<KnowledgeSnapshot>(KNOWLEDGE_KV))!
    const job = durable.jobs.find((job) => job.kind === 'organize')!
    job.status = 'running'
    await getStore().putKv(KNOWLEDGE_KV, durable)
    const ids = durable.sources.map((source) => source.id)
    resetKnowledge()
    await initializeKnowledge()
    await vi.waitFor(() => expect(useKnowledge.getState().jobs.find((entry) => entry.id === job.id)?.status).toBe('complete'), { timeout: 5000, interval: 10 })
    expect(useKnowledge.getState().sources.map((source) => source.id)).toEqual(ids)
    expect(useKnowledge.getState().jobs.find((entry) => entry.id === job.id)?.status).toBe('complete')
    expect(useKnowledge.getState().proposals).toHaveLength(1)
    await initializeKnowledge()
    await waitForKnowledgeJobs()
    expect(useKnowledge.getState().proposals).toHaveLength(1)
  })

  it('does not rehash unchanged immutable record bodies during reconciliation', async () => {
    const node = await captureThought('An immutable astronomy note for reconciliation.')
    await captureThought('A separate biology note for reconciliation.')
    await syncKnowledgeNodes([...useWorld.getState().nodes.values()])
    const digest = vi.spyOn(crypto.subtle, 'digest')
    try {
      await syncKnowledgeNodes([...useWorld.getState().nodes.values()])
      expect(digest).not.toHaveBeenCalled()
      await updateNode(node.id, { contentMd: 'The astronomy note has a genuine correction.' })
      await syncKnowledgeNodes([...useWorld.getState().nodes.values()])
      expect(digest.mock.calls.length).toBeGreaterThan(0)
      expect(useKnowledge.getState().versions).toHaveLength(3)
    } finally { digest.mockRestore() }
  })

  it('does not migrate the current chat into independent sources during ordinary search initialization', async () => {
    await getStore().putKv('chat.v1', { history: [{ role: 'user', content: 'A draft that has not been kept.' }], cards: {} })
    await initializeKnowledge()
    expect(useKnowledge.getState().sources).toEqual([])
    expect(useWorld.getState().nodes.size).toBe(0)
  })

  it('chooses subject terms in source order while ignoring ordinary connective words', () => {
    expect(topicWords('Amber lighthouse project: we approved the receiver after reviewing the energy budget before publication.').slice(0, 3)).toEqual(['amber', 'lighthouse', 'project'])
  })

  it('catches up an excluded external source on return while keeping explicit placement pins', async () => {
    await importKnowledgeFiles([file('watched.md', 'Initial external source wording.')])
    const source = useKnowledge.getState().sources[0]
    await updateNode(source.nodeId!, { fieldAnchorXZ: [42, 11] }, { keepAnchor: true })
    const originalAnchor = useWorld.getState().nodes.get(source.nodeId!)!.anchorXZ
    await setSourcePolicy(source.id, { excluded: true })
    await importKnowledgeFiles([file('watched.md', 'Updated external source wording.')])
    expect(useKnowledge.getState().sources[0].pendingProjection).toBe(true)
    expect(useWorld.getState().excluded.get(source.nodeId!)?.contentMd).toBe('Initial external source wording.')
    await setSourcePolicy(source.id, { excluded: false })
    const returned = useWorld.getState().nodes.get(source.nodeId!)!
    expect(returned.contentMd).toBe('Updated external source wording.')
    expect(returned.fieldAnchorXZ).toEqual([42, 11])
    expect(returned.anchorXZ).toEqual(originalAnchor)
    expect(useKnowledge.getState().sources[0].pendingProjection).toBe(false)
  })

  it('preserves a manual interpretation when catching up an excluded external source', async () => {
    await importKnowledgeFiles([file('edited.md', 'Initial imported wording.')])
    const source = useKnowledge.getState().sources[0]
    await updateNode(source.nodeId!, { contentMd: 'My deliberate correction.' })
    await syncKnowledgeNodes([...useWorld.getState().nodes.values()])
    await setSourcePolicy(source.id, { excluded: true })
    await importKnowledgeFiles([file('edited.md', 'The newly imported original.')])
    await setSourcePolicy(source.id, { excluded: false })
    expect(useWorld.getState().nodes.get(source.nodeId!)?.contentMd).toBe('My deliberate correction.')
    const current = useKnowledge.getState().versions.find((version) => version.id === useKnowledge.getState().sources[0].currentVersionId)
    expect(current?.text).toBe('The newly imported original.')
  })

  it('retries a conflicted organization checkpoint without delaying or losing acknowledged sources', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await captureThought('Entropy and temperature explain the thermal budget.')
    await captureThought('Temperature and entropy constrain a thermal receiver.')
    const ids = useKnowledge.getState().sources.map((source) => source.id)
    vi.spyOn(getStore(), 'commitKnowledge').mockResolvedValueOnce(false)
    await waitForKnowledgeJobs()
    const job = useKnowledge.getState().jobs.find((entry) => entry.kind === 'organize')!
    expect(job.status).toBe('complete')
    expect(job.attempts).toBe(1)
    expect(useKnowledge.getState().sources.map((source) => source.id)).toEqual(ids)
    expect(useKnowledge.getState().proposals).toHaveLength(1)
  })

  it('leaves a partial restore untouched until its interrupted-import marker is resolved', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await captureThought('A retained source waiting for recovery.')
    const store = getStore()
    const durable = (await store.getKv<KnowledgeSnapshot>(KNOWLEDGE_KV))!
    durable.sources[0].pendingProjection = true
    await store.putKv(KNOWLEDGE_KV, durable)
    await store.putKv('chat.v1', { history: [{ role: 'user', content: 'Do not migrate this during recovery.' }] })
    const marker = { backupName: 'verified-previous-world', startedAt: Date.now() }
    await store.putKv('importInProgress', marker)
    useRepoStatus.setState({ interruptedImport: marker })
    resetKnowledge()
    await initializeKnowledge({ migrateChat: true })
    await syncKnowledgeNodes([...useWorld.getState().nodes.values()])
    await vi.advanceTimersByTimeAsync(1000)
    expect(await store.getKv(KNOWLEDGE_KV)).toEqual(durable)
    expect(useKnowledge.getState().sources).toHaveLength(1)
    expect(useKnowledge.getState().jobs.find((job) => job.kind === 'organize')?.status).toBe('queued')
    await store.deleteKv('importInProgress')
    useRepoStatus.setState({ interruptedImport: null })
    await initializeKnowledge()
    await waitForKnowledgeJobs()
    expect(useKnowledge.getState().sources[0].pendingProjection).toBe(false)
    expect(useKnowledge.getState().jobs.find((job) => job.kind === 'organize')?.status).toBe('complete')
  })
})

describe('source parsers and passage locations', () => {
  it('imports repeated Gemini activity with stable identity and separate authorship', () => {
    const row = { header: 'Gemini Apps', title: 'Prompted What did I decide?', time: '2026-03-21T00:00:00Z', safeHtmlItem: [{ html: '<p>Current plan &amp; dates.</p><script>private detail</script>' }] }
    const [parsed] = parseKnowledgeText(JSON.stringify([row, row]), 'MyActivity.json')
    expect(parseKnowledgeText(JSON.stringify(row), 'reimport.json')[0]).toEqual(parsed)
    expect(parsed.messages).toMatchObject([{ role: 'human', text: 'What did I decide?' }, { role: 'assistant', parentId: 'prompt', text: 'Current plan & dates.', authoredAt: null }])
    expect(splitPassages(parsed).every((item) => parsed.text.slice(item.start, item.end) === item.text)).toBe(true)
  })

  it('imports stable Codex rollout messages while avoiding duplicate events and tool output', () => {
    const rows = [
      { type: 'session_meta', payload: { id: 'codex-thread' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'Find the save path' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Find the save path' } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'Private test tool output' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'The save path is local.' }] } },
    ].map((row) => JSON.stringify(row)).join('\n')
    const [parsed] = parseKnowledgeText(rows, 'rollout.jsonl')
    expect(parseKnowledgeText(rows, 'backup.jsonl')[0]).toEqual(parsed)
    expect(parsed.externalId).toBe('conversation:codex:codex-thread')
    expect(splitPassages(parsed).map(({ text, role, locator }) => ({ text, role, locator }))).toEqual([
      { text: 'Find the save path', role: 'human', locator: 'Message 1' },
      { text: 'The save path is local.', role: 'assistant', locator: 'Message 2' },
    ])
  })

  it('parses Claude role/time identity and verifies every chunk against the full source', () => {
    const parsed = parseKnowledgeText(JSON.stringify([{ uuid: 'c1', name: 'Claude thread', chat_messages: [{ uuid: 'm1', sender: 'human', text: 'An exact human question.', created_at: '2026-01-01T00:00:00Z' }, { uuid: 'm2', sender: 'assistant', content: [{ type: 'text', text: 'A reply. '.repeat(400) }], created_at: '2026-01-01T00:00:01Z' }] }]), 'claude.json')[0]
    const passages = splitPassages(parsed)
    expect(parsed.messages[0].role).toBe('human')
    expect(passages.length).toBeGreaterThan(2)
    expect(passages.every((p) => parsed.text.slice(p.start, p.end) === p.text)).toBe(true)
    expect(passages.filter((p) => p.role === 'assistant').every((p) => p.id === 'm2')).toBe(true)
  })
})
