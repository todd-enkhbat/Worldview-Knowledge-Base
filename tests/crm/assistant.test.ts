import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import { createMemoryClient, revokeMemoryClient } from '../../server/memoryAccess.ts'
import { createCrmAssistant } from '../../server/crmAssistant.ts'
import { createHost, type Host } from '../../server/host.ts'
import type { CrmProposal } from '../../src/crm/types.ts'

let db: WorldDb, serial = 0
const command = (operation: string, rest: Record<string, unknown> = {}) => db.crm.command({ requestId: String(++serial), operation, ...rest })
const asClient = (input: Parameters<typeof createMemoryClient>[2]) => ({ ...createMemoryClient(db, 'local', input, 1000).client, tokenHash: '' })
beforeEach(() => {
  db = openWorldDb(':memory:'); serial = 0
  db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 })
  for (const id of ['a', 'b']) command('create', { collection: 'people', record: { id, fullName: `Person ${id}`, raw: { secretOriginal: true } } })
})
afterEach(() => db.close())
const proposalInput = (rest: Record<string, unknown> = {}) => ({ requestId: 'proposal', collection: 'people', id: 'a', expectedRecordRevision: 1, patch: { jobTitle: 'Researcher' }, evidence: [{ label: 'Public profile', url: 'https://example.test/profile' }], explanation: 'Reviewed public profile evidence', ...rest })

describe('explicit assistant CRM scopes', () => {
  it('reviews education enrichment within the selected person and rejects out-of-scope organization links', () => {
    const assistant = createCrmAssistant(db, () => 2000), selected = asClient({ name: 'Education research', sourceIds: [], crmPersonIds: ['a'] })
    const affiliation = { id: 'education', kind: 'education', organization: 'Example University', degree: 'MSc', evidence: [{ label: 'Public profile', url: 'https://example.test/profile' }] }
    const pending = assistant.operation('propose_crm_change', proposalInput({ patch: { affiliations: [affiliation] } }), selected) as { proposalId: string }
    expect(db.crm.get('people', 'a')!.affiliations).toBeUndefined()
    command('review_proposal', { id: pending.proposalId, expectedRecordRevision: 1 })
    expect(assistant.operation('read_crm_record', { id: 'a' }, selected)).toMatchObject({ record: { affiliations: [affiliation] } })
    command('create', { collection: 'companies', record: { id: 'private-school', name: 'Unselected organization' } })
    expect(() => assistant.operation('propose_crm_change', proposalInput({ requestId: 'forbidden-organization', expectedRecordRevision: 2, patch: { affiliations: [{ ...affiliation, organizationId: 'private-school' }] } }), selected)).toThrow('outside the selected People scope')
    command('update', { collection: 'people', id: 'a', expectedRecordRevision: 2, patch: { affiliations: [{ ...affiliation, organizationId: 'private-school' }] } })
    expect(() => assistant.operation('propose_crm_change', proposalInput({ requestId: 'unrelated-title', expectedRecordRevision: 3 }), selected)).not.toThrow()
  })
  it('keeps CRM outside allSources grants, hides unrelated people, originals and mixed-scope comments', () => {
    const assistant = createCrmAssistant(db, () => 2000), allSources = asClient({ name: 'Knowledge reader', allSources: true })
    expect(() => assistant.operation('list_crm_records', {}, allSources)).toThrow('explicit People')
    const selected = asClient({ name: 'Selected contact reader', sourceIds: [], crmPersonIds: ['a'] })
    command('create', { collection: 'notes', record: { body: 'Contains another private person', entityRefs: [{ type: 'person', id: 'a' }, { type: 'person', id: 'b' }] } })
    expect(assistant.operation('list_crm_records', {}, selected)).toMatchObject({ rows: [{ id: 'a' }], total: 1 })
    expect(assistant.operation('list_crm_records', { collection: 'notes' }, selected)).toMatchObject({ rows: [], total: 0 })
    expect(assistant.operation('read_crm_record', { id: 'a' }, selected)).toMatchObject({ record: { id: 'a', revision: 1 } })
    expect(JSON.stringify(assistant.operation('read_crm_record', { id: 'a' }, selected))).not.toContain('secretOriginal')
    expect(() => assistant.operation('read_crm_record', { id: 'b' }, selected)).toThrow('outside')
    expect(() => assistant.operation('propose_crm_change', proposalInput({ id: 'b' }), selected)).toThrow('outside')
  })
  it('reviews source-backed enrichment, retries idempotently, and preserves target history', () => {
    const assistant = createCrmAssistant(db, () => 2000), selected = asClient({ name: 'Enricher', sourceIds: [], crmPersonIds: ['a'] })
    const pending = assistant.operation('propose_crm_change', proposalInput(), selected) as { proposalId: string }
    expect(db.crm.get('people', 'a')!.jobTitle).toBe('')
    expect(assistant.operation('propose_crm_change', proposalInput(), selected)).toMatchObject({ proposalId: pending.proposalId, replayed: true })
    const proposal = db.crm.get('proposals', pending.proposalId)!
    command('review_proposal', { id: pending.proposalId, expectedRecordRevision: proposal.revision })
    expect(db.crm.get('people', 'a')!.jobTitle).toBe('Researcher')
    expect(db.crm.rows('history').some(row => row.recordId === 'a' && row.operation === 'review_proposal')).toBe(true)
    expect(assistant.operation('propose_crm_change', proposalInput(), selected)).toMatchObject({ proposalId: pending.proposalId, status: 'approved', replayed: true })
    expect(() => assistant.operation('propose_crm_change', proposalInput({ patch: { jobTitle: 'Different' } }), selected)).toThrow('different CRM proposal')
  })
  it('rechecks revocation and current target revision at approval', () => {
    const assistant = createCrmAssistant(db, () => 2000), selected = asClient({ name: 'Revocable', sourceIds: [], crmPersonIds: ['a'] })
    const pending = assistant.operation('propose_crm_change', proposalInput(), selected) as { proposalId: string }
    revokeMemoryClient(db, selected.id, 1500)
    expect(() => command('review_proposal', { id: pending.proposalId, expectedRecordRevision: 1 })).toThrow('expired or was revoked')
    expect(db.crm.get('proposals', pending.proposalId)!.status).toBe('pending')
    const active = asClient({ name: 'Current', sourceIds: [], crmPersonIds: ['a'] })
    const next = assistant.operation('propose_crm_change', proposalInput({ requestId: 'next' }), active) as { proposalId: string }
    command('update', { collection: 'people', id: 'a', expectedRecordRevision: 1, patch: { jobTitle: 'My newer edit' } })
    expect(() => command('review_proposal', { id: next.proposalId, expectedRecordRevision: 1 })).toThrow('changed')
    expect(db.crm.get('people', 'a')!.jobTitle).toBe('My newer edit')
  })
  it('requires both selected group and person scope for field changes and rechecks membership at review', () => {
    command('create', { collection: 'groups', record: { id: 'g', name: 'Chosen group' } })
    command('membership', { groupId: 'g', entity: { type: 'person', id: 'a' } })
    const assistant = createCrmAssistant(db, () => 2000), selected = asClient({ name: 'Group', sourceIds: [], crmGroupIds: ['g'] })
    const pending = assistant.operation('propose_crm_change', proposalInput(), selected) as { proposalId: string }
    const membership = db.crm.rows('memberships')[0]
    command('membership', { groupId: 'g', entity: { type: 'person', id: 'a' }, remove: true, expectedRecordRevision: membership.revision })
    expect(() => command('review_proposal', { id: pending.proposalId, expectedRecordRevision: 1 })).toThrow('outside')
    expect(assistant.operation('list_crm_records', {}, selected)).toMatchObject({ rows: [] })
    command('membership', { groupId: 'g', entity: { type: 'person', id: 'b' } })
    expect(assistant.operation('list_crm_records', {}, selected)).toMatchObject({ rows: [{ id: 'b' }] })
  })
  it('requires explicit new-person permission and grants access to an approved creation', () => {
    const assistant = createCrmAssistant(db, () => 2000), creator = asClient({ name: 'Creator', sourceIds: [], allowCreateCrmPeople: true })
    const pending = assistant.operation('propose_crm_change', proposalInput({ id: undefined, expectedRecordRevision: undefined, patch: { fullName: 'New contact', emails: ['new@example.test'] } }), creator) as { proposalId: string }
    command('review_proposal', { id: pending.proposalId, expectedRecordRevision: 1 })
    const approved = db.crm.get('proposals', pending.proposalId) as CrmProposal
    expect(approved.targetId).toBeTruthy()
    expect(assistant.operation('read_crm_record', { id: approved.targetId }, creator)).toMatchObject({ record: { fullName: 'New contact' } })
    expect(() => assistant.operation('propose_crm_change', proposalInput({ requestId: 'protected-metadata', patch: { mergedIntoId: 'b' } }), creator)).toThrow('unsupported People fields')
  })
})

it('negotiates CRM MCP tools and applies an approved proposal through the live HTTP host', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'worldview-crm-mcp-')); let host: Host | undefined, server: Server | undefined
  const persisted = openWorldDb(join(directory, 'world.sqlite'))
  try {
    persisted.putSettings(db.getSettings()!); persisted.putKv('crm.v1', db.crm.getSnapshot())
    const access = createMemoryClient(persisted, 'local', { name: 'MCP integration', sourceIds: [], crmPersonIds: ['a'] })
    host = createHost({ dataDir: directory }); server = createServer(host.handler)
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, client = new Client({ name: 'CRM integration', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/api/mcp'), { requestInit: { headers: { authorization: `Bearer ${access.token}` } } }))
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('propose_crm_change')
      const listed = await client.callTool({ name: 'list_crm_records', arguments: {} }); expect(listed.structuredContent).toMatchObject({ total: 1, rows: [{ id: 'a' }] })
      const pending = await client.callTool({ name: 'propose_crm_change', arguments: proposalInput() }), proposalId = (pending.structuredContent as Record<string, unknown>).proposalId as string
      const approval = await fetch(origin + '/api/crm/command', { method: 'POST', headers: { 'x-wv-client': 'test', 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'approve', operation: 'review_proposal', id: proposalId, expectedRecordRevision: 1 }) })
      expect(approval.status).toBe(200); expect(persisted.crm.get('people', 'a')!.jobTitle).toBe('Researcher')
    } finally { await client.close() }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    host?.close(); persisted.close(); rmSync(directory, { recursive: true, force: true })
  }
})
