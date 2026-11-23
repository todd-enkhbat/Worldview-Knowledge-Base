// Native models live in a separate process. IPC, rather than stdout, carries results:
// llama.cpp can write diagnostics directly to stdout before JavaScript log hooks exist.
import { pathToFileURL } from 'node:url'

let store = null
let queue = Promise.resolve()
const sdk = await import(pathToFileURL(process.env.WORLDVIEW_QMD_MODULE).href)
process.on('message', (message) => {
  queue = queue.catch(() => {}).then(async () => {
    const { id, operation, input = {} } = message
    try {
      let result
      if (operation === 'open') {
        if (store) await store.close()
        store = await sdk.createStore({ dbPath: input.dbPath, config: { collections: { [input.collection]: { path: input.directory, pattern: '**/*.md' } } } })
        const update = await store.update()
        const embed = input.mode === 'hybrid' ? await store.embed({ collection: input.collection, maxDocsPerBatch: 16, maxBatchBytes: 1024 * 1024, onProgress: (progress) => process.send?.({ progress: { phase: 'embedding', ...progress } }) }) : null
        result = { update, embed, status: await store.getStatus() }
      } else if (operation === 'search') {
        if (!store) throw new Error('QMD has not indexed this workspace.')
        const options = { collection: input.collection, limit: input.limit, filter: input.filter }
        const rows = input.mode === 'lexical' ? await store.searchLex(input.query, options) : await store.search({ ...options, query: input.query, candidateLimit: input.candidates, rerank: true, explain: true })
        result = rows.map((row) => ({ file: row.file ?? row.filepath ?? row.displayPath, score: row.score, explain: row.explain }))
      } else if (operation === 'close') {
        if (store) await store.close()
        store = null; result = { ok: true }
      } else throw new Error('Unknown QMD worker command.')
      process.send?.({ id, result })
    } catch (error) { process.send?.({ id, error: error instanceof Error ? error.message : String(error) }) }
  })
})
process.once('disconnect', () => { void queue.finally(async () => { if (store) await store.close(); process.exit(0) }) })
