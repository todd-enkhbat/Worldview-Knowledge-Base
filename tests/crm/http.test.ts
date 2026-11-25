import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createCrmHttp } from '../../server/crmHttp.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'

let db: WorldDb, server: Server, origin: string
beforeEach(async () => {
  db = openWorldDb(':memory:')
  db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 })
  const service = createCrmHttp(db, { store: db.crm })
  server = createServer((req, res) => { void service.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } }) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close() })
const headers = { 'x-wv-client': 'test', 'content-type': 'application/json' }
const command = (body: unknown) => fetch(origin + '/api/crm/command', { method: 'POST', headers, body: JSON.stringify(body) })

describe('CRM HTTP boundaries and persistence', () => {
  it('rejects cross-origin and headerless reads and commands', async () => {
    expect((await fetch(origin + '/api/crm/status')).status).toBe(403)
    expect((await fetch(origin + '/api/crm/status', { headers: { ...headers, origin: 'https://untrusted.example' } })).status).toBe(403)
    expect((await command({ requestId: 'one', operation: 'create', collection: 'people', record: { id: 'p', fullName: 'Person', raw: { private: 'original' } } })).status).toBe(200)
    const list = await (await fetch(origin + '/api/crm/people?limit=250', { headers })).json()
    expect(list).toMatchObject({ total: 1, rows: [{ id: 'p', fullName: 'Person' }] }); expect(list.rows[0].raw).toBeUndefined()
    expect(await (await fetch(origin + '/api/crm/people/p', { headers })).json()).toMatchObject({ record: { raw: { private: 'original' } }, related: { notes: [] }, relatedPagination: { notes: { hasMore: false } } })
    expect((await fetch(origin + '/api/crm/people?offset=-1', { headers })).status).toBe(400)
  })
  it('keeps CRM in atomic world snapshots and resets it with the rest of the workspace', async () => {
    await command({ requestId: 'one', operation: 'create', collection: 'people', record: { id: 'p', fullName: 'Person' } })
    const before = db.crm.status().workspaceFingerprint
    expect(db.readWorldSnapshot(['crm.v1']).kv['crm.v1']).toMatchObject({ people: [{ id: 'p' }] })
    const retained = db.getKv('crm.v1')
    db.resetWithKv('importInProgress', { startedAt: 1 })
    expect(db.crm.list('people').rows).toEqual([]); expect(db.getKv('crm.v1')).toBeUndefined()
    expect(db.crm.status().workspaceFingerprint).not.toBe(before)
    db.putKv('crm.v1', retained)
    expect(db.crm.get('people', 'p')?.fullName).toBe('Person')
    expect((await command({ requestId: 'blocked', operation: 'comment', record: { body: 'No late write' } })).status).toBe(409)
    db.wipe(); expect(db.crm.hasData()).toBe(false)
  })
})
