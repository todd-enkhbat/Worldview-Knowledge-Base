import { afterEach, describe, expect, it } from 'vitest'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'
import { startTestEngine } from '../helpers/engine.ts'
import { diffKnowledgeSnapshots } from '../../src/knowledge/storage.ts'

const opened: WorldDb[] = []
afterEach(() => { for (const db of opened.splice(0)) db.close() })

function corpus(): KnowledgeSnapshot {
  const late = `${'Background material. '.repeat(250)}The amber lighthouse launch was approved for November 29.`
  return {
    schemaVersion: 1, revision: 1, imports: [], proposals: [], jobs: [],
    sources: [{ id: 'source', externalId: 'external', title: 'Project record', kind: 'document', currentVersionId: 'v1', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: true, tags: [] }],
    versions: [{ id: 'v1', sourceId: 'source', contentHash: 'hash', originalBlobId: 'original', originalName: 'record.txt', text: late, createdAt: 1, authoredAt: null, origin: 'import' }],
    passages: [{ id: 'passage', sourceId: 'source', versionId: 'v1', title: 'Project record', text: late.slice(-58), start: late.length - 58, end: late.length, role: 'human', authoredAt: null }],
  }
}

describe('Disposable SQLite passage index', () => {
  it('retrieves late-document evidence with exact retained source offsets', () => {
    const db = openWorldDb(':memory:'); opened.push(db)
    const snapshot = corpus()
    db.putKv('knowledge.v1', snapshot)
    const result = db.searchKnowledge('"amber lighthouse"')
    expect(result.revision).toBe(1)
    expect(result.hits).toHaveLength(1)
    const hit = result.hits[0]
    expect(hit.start).toBeGreaterThan(2000)
    expect(snapshot.versions[0].text.slice(hit.start, hit.end)).toBe(hit.text)
    expect(db.searchKnowledge('lighthouse', { role: 'assistant' }).hits).toEqual([])
    expect(db.searchKnowledge('lighthouse', { sourceIds: [] }).hits).toEqual([])
  })

  it('enforces changed policies immediately and discards the derived index on wipe', () => {
    const db = openWorldDb(':memory:'); opened.push(db)
    const snapshot = corpus()
    db.putKv('knowledge.v1', snapshot)
    snapshot.sources[0].aiAllowed = false
    snapshot.revision = 2
    expect(db.compareAndSwapKv('knowledge.v1', snapshot, 1)).toBe(true)
    expect(db.searchKnowledge('lighthouse', { aiOnly: true }).hits).toEqual([])
    expect(db.searchKnowledge('lighthouse').hits).toHaveLength(1)
    snapshot.sources[0].excluded = true
    snapshot.revision = 3
    db.compareAndSwapKv('knowledge.v1', snapshot, 2)
    expect(db.searchKnowledge('lighthouse').hits).toEqual([])
    db.wipe()
    expect(db.searchKnowledge('lighthouse')).toEqual({ revision: 0, hits: [] })
  })

  it('keeps previous versions accessible only through explicit history scope and verifies content', () => {
    const db = openWorldDb(':memory:'); opened.push(db)
    const snapshot = corpus()
    snapshot.sources[0].currentVersionId = 'v2'
    snapshot.versions.push({ ...snapshot.versions[0], id: 'v2', text: 'The launch has been postponed.', previousVersionId: 'v1' })
    snapshot.passages.push({ ...snapshot.passages[0], id: 'bad-evidence', text: 'Invented secret value', start: 0, end: 21 })
    db.putKv('knowledge.v1', snapshot)
    expect(db.searchKnowledge('lighthouse').hits).toEqual([])
    expect(db.searchKnowledge('lighthouse', { includeHistory: true }).hits).toHaveLength(1)
    expect(db.searchKnowledge('Invented', { includeHistory: true }).hits).toEqual([])
  })

  it('refuses clamped and fractional citation offsets on import and incremental publication', () => {
    const db = openWorldDb(':memory:'); opened.push(db)
    const snapshot = corpus(), valid = structuredClone(snapshot)
    snapshot.passages[0].end++
    db.putKv('knowledge.v1', snapshot)
    expect(db.searchKnowledge('lighthouse').hits).toEqual([])
    valid.revision = 2
    expect(db.commitKnowledge(diffKnowledgeSnapshots(snapshot, valid), { expectedRevision: 1, idempotencyKey: 'valid-offset' })).toBe(true)
    expect(db.searchKnowledge('lighthouse').hits).toHaveLength(1)
    const broken = structuredClone(valid); broken.revision++; broken.passages[0].start += 0.5
    expect(db.commitKnowledge(diffKnowledgeSnapshots(valid, broken), { expectedRevision: 2, idempotencyKey: 'fractional-offset' })).toBe(true)
    expect(db.searchKnowledge('lighthouse').hits).toEqual([])
  })

  it('exposes query and source filters through the authenticated world API boundary', async () => {
    const engine = await startTestEngine()
    engine.db.putKv('knowledge.v1', corpus())
    const response = await fetch(`${engine.base}/world/knowledge-search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'lighthouse', filters: { role: 'human', sourceIds: ['source'] } }) })
    expect(response.status).toBe(200)
    const result = await response.json() as { revision: number; hits: { id: string }[] }
    expect(result).toMatchObject({ revision: 1, hits: [{ id: 'passage' }] })
  })
})
