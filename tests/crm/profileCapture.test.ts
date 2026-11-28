import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { extractProfile } from '../../extensions/worldview-reader/extract.js'
import { quickAddProfile } from '../../server/crmProfileQuickAdd.ts'
import { createHash } from 'node:crypto'
import { CrmProfileCapture } from '../../server/crmProfileCapture.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import { crmAssetReferences } from '../../src/crm/model.ts'
import type { CrmPerson } from '../../src/crm/types.ts'
import type { KnowledgeSnapshot } from '../../src/knowledge/types.ts'

let db: WorldDb, blobDir: string, capture: CrmProfileCapture
beforeEach(async () => {
  db = openWorldDb(':memory:')
  db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 })
  blobDir = await mkdtemp(join(tmpdir(), 'wv-profile-capture-'))
  capture = new CrmProfileCapture({ db, store: db.crm, blobDir, now: () => 200 })
})
afterEach(async () => { db.close(); await rm(blobDir, { recursive: true, force: true }) })
const input = (requestId: string = crypto.randomUUID()) => ({ requestId, url: 'https://www.linkedin.com/in/ada-example/details/education/', title: 'Ada Example | LinkedIn', text: 'Ada Example\nEducation\nExample University\nBachelor of Science\n2012–2016', html: '<h1>Ada Example</h1><h2>Education</h2><p>Example University</p>', profile: { entityType: 'person', name: 'Ada Example', headline: 'Captured engineer', urls: ['https://www.linkedin.com/in/ada-example'], emails: ['ada@example.org'], affiliations: [{ kind: 'education', organization: 'Example University', degree: 'Bachelor of Science', startDate: '2012', endDate: '2016', organizationUrl: 'https://example.edu/', excerpt: 'Example University\nBachelor of Science\n2012–2016' }] } })
const person = (id = 'ada', overrides: Record<string, unknown> = {}) => db.crm.command({ requestId: crypto.randomUUID(), operation: 'create', collection: 'people', record: { id, fullName: 'Ada Example', jobTitle: 'My existing role', emails: ['original@example.net'], urls: ['http://www.linkedin.com/in/Ada-Example/'], ...overrides } }).record!
async function savedReader() {
  const supplied = input(), bytes = Buffer.from(JSON.stringify({ format: 'worldview-article-capture.v1', url: supplied.url, title: supplied.title, text: supplied.text })), originalBlobId = 'knowledge-' + createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(blobDir, originalBlobId), bytes)
  db.putAssetMeta({ id: originalBlobId, kind: 'file', mime: 'application/json', bytes: bytes.length, createdAt: 1, nodeId: null })
  const snapshot: KnowledgeSnapshot = { schemaVersion: 1, revision: 1, sources: [{ id: 'saved-source', externalId: 'web:saved-profile', title: supplied.title, kind: 'document', currentVersionId: 'saved-version', createdAt: 1, updatedAt: 1, excluded: false, aiAllowed: false, tags: [] }], versions: [{ id: 'saved-version', sourceId: 'saved-source', contentHash: createHash('sha256').update(supplied.text).digest('hex'), originalBlobId, originalName: 'article-capture.json', text: supplied.text, createdAt: 1, authoredAt: null, origin: 'capture', metadata: { url: supplied.url, captureMethod: 'browser-extension' } }], passages: [], imports: [], jobs: [], proposals: [] }
  db.putKv('knowledge.v1', snapshot)
  const draft = await capture.stage(supplied, { captureMethod: 'saved-source', sourceId: 'saved-source', sourceVersionId: 'saved-version' })
  return { draft, snapshot, originalBlobId }
}

describe('private profile capture and review', () => {
  it('retains an original and draft without altering people or knowledge, and deduplicates identical captures across requests', async () => {
    const before = person(), draft = await capture.stage(input('capture-one'))
    expect(draft).toMatchObject({ status: 'pending', cloudAiUsed: false, matches: [{ id: 'ada', reason: 'profile-url' }], targetId: 'ada' })
    expect(db.crm.get('people', 'ada')).toEqual(before)
    expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.listNodes()).toEqual([])
    const original = JSON.parse(await readFile(join(blobDir, draft.source.originalAssetId), 'utf8'))
    expect(original).toMatchObject({ format: 'worldview-profile-capture.v1', text: input().text, html: input().html, profile: { name: 'Ada Example' } })
    expect(crmAssetReferences(db.crm.portableSnapshot())).toContain(draft.source.originalAssetId)
    expect((await capture.stage(input('capture-two'))).id).toBe(draft.id)
    expect(db.crm.rows('candidates')).toHaveLength(1)
    await expect(capture.stage({ ...input('capture-one'), title: 'Changed payload' })).rejects.toThrow('already used')
  })
  it('applies only selected fields, preserves channels and adds evidence-backed education, with guarded replay', async () => {
    person(); const draft = await capture.stage(input()), payload = { requestId: 'apply-one', targetId: 'ada', expectedRecordRevision: 1, fields: ['emails', 'affiliations'] }
    const result = await capture.apply(draft.id, payload)
    expect(result.record).toMatchObject({ fullName: 'Ada Example', jobTitle: 'My existing role', emails: ['original@example.net', 'ada@example.org'], affiliations: [{ kind: 'education', organization: 'Example University', degree: 'Bachelor of Science', evidence: [{ sourceRef: { originalAssetId: draft.source.originalAssetId } }] }], profileCaptureIds: [draft.id] })
    expect(result.draft.status).toBe('accepted'); expect(db.crm.rows('history').some(row => row.actor === 'profile-capture' && row.collection === 'people')).toBe(true)
    const revision = result.record.revision
    expect(await capture.apply(draft.id, payload)).toMatchObject({ replayed: true, record: { revision } })
    await expect(capture.apply(draft.id, { ...payload, fields: ['name'] })).rejects.toThrow('already used')
  })
  it('preserves every original channel string and duplicate while appending only canonical-new values', async () => {
    const emails = ['Ada@Example.org', 'Ada@Example.org', 'ada@example.org'], phones = ['+1 (212) 555-0100', '+1 (212) 555-0100', '+12125550100'], urls = ['http://www.linkedin.com/in/Ada-Example/', 'http://www.linkedin.com/in/Ada-Example/', 'https://linkedin.com/in/ada-example']
    person('ada', { emails, phones, urls })
    const supplied = input(), draft = await capture.stage({ ...supplied, profile: { ...supplied.profile, emails: ['ada@example.org', 'NEW@example.net', 'new@example.net'], phones: ['+1 212 555 0100', '+1 212 555 0199', '+12125550199'], urls: ['https://www.linkedin.com/in/ADA-EXAMPLE/', 'https://new.example.org/', 'https://new.example.org'] } })
    const saved = await capture.apply(draft.id, { requestId: 'preserve-original-channels', targetId: 'ada', expectedRecordRevision: 1, fields: ['emails', 'phones', 'urls'] })
    expect(saved.record.emails).toEqual([...emails, 'NEW@example.net'])
    expect(saved.record.phones).toEqual([...phones, '+1 212 555 0199'])
    expect(saved.record.urls).toEqual([...urls, supplied.url, 'https://new.example.org/'])
  })
  it('does not guess identities by name and requires explicit creation when no profile URL matches', async () => {
    const before = person('different', { urls: ['https://different.example.org/'] }), draft = await capture.stage(input())
    expect(draft.matches).toEqual([]); expect(draft.targetId).toBeNull()
    await expect(capture.apply(draft.id, { requestId: 'no-target', fields: ['name'] })).rejects.toThrow('explicitly create')
    const result = await capture.apply(draft.id, { requestId: 'explicit-new', createNew: true, fields: ['name', 'urls', 'affiliations'] })
    expect(result.record.id).not.toBe(before.id); expect(db.crm.get('people', before.id)).toEqual(before)
  })
  it('creates a reviewed company and preserves its separate tagline, location, description and profile URLs', async () => {
    const draft = await capture.stage({ requestId: 'company', url: 'https://www.linkedin.com/company/example-ventures/people/', title: 'Example Ventures', text: 'Example Ventures\nBuilding the future.\nSan Francisco', profile: { entityType: 'company', name: 'Example Ventures', headline: 'Building the future.', description: 'Independent investment firm.', location: 'San Francisco', industry: 'Venture capital', urls: ['https://www.linkedin.com/company/example-ventures'], affiliations: [] } })
    const result = await capture.apply(draft.id, { requestId: 'create-company', createNew: true, fields: ['name', 'headline', 'description', 'location', 'industry', 'urls'] })
    expect(result.record).toMatchObject({ name: 'Example Ventures', tagline: 'Building the future.', description: 'Independent investment firm.', location: 'San Francisco', industry: 'Venture capital', logoAssetId: null })
    expect(db.crm.rows('people')).toHaveLength(0)
  })
  it('links only exact organization URLs, retains existing affiliations and respects per-entry selection', async () => {
    db.crm.command({ requestId: 'school', operation: 'create', collection: 'companies', record: { id: 'school', name: 'Example University', urls: ['https://example.edu/'] } })
    db.crm.command({ requestId: 'company', operation: 'create', collection: 'companies', record: { id: 'company', name: 'Example University', urls: ['https://unrelated.example.org/'] } })
    person(); const supplied = input(); supplied.profile.affiliations.push({ kind: 'education', organization: 'Unselected School', degree: '', startDate: '', endDate: '', organizationUrl: 'https://unselected.example.org/', excerpt: '' })
    const draft = await capture.stage(supplied), selected = draft.profile.affiliations[0].id
    const saved = await capture.apply(draft.id, { requestId: 'selected-school', targetId: 'ada', expectedRecordRevision: 1, fields: ['affiliations'], affiliationIds: [selected] })
    expect(saved.record.affiliations).toEqual([expect.objectContaining({ organization: 'Example University', organizationId: 'school' })])
    expect(db.crm.rows('companies')).toHaveLength(2)
  })
  it('refuses stale target edits and damaged originals before changing a contact', async () => {
    person(); const draft = await capture.stage(input()), before = db.crm.get('people', 'ada')
    await expect(capture.apply(draft.id, { requestId: 'stale', targetId: 'ada', expectedRecordRevision: 4, fields: ['name'] })).rejects.toThrow('changed')
    await writeFile(join(blobDir, draft.source.originalAssetId), '{}')
    await expect(capture.apply(draft.id, { requestId: 'damaged', targetId: 'ada', expectedRecordRevision: 1, fields: ['name'] })).rejects.toThrow('missing or damaged')
    expect(db.crm.get('people', 'ada')).toEqual(before); expect(capture.detail(draft.id).status).toBe('pending')
  })
  it('rejects token revocation during original verification and bounds list previews', async () => {
    person(); const draft = await capture.stage({ ...input(), text: 'Ada Example\n'.repeat(200) }), before = db.crm.get('people', 'ada')
    let calls = 0
    await expect(capture.apply(draft.id, { requestId: 'revoked', targetId: 'ada', expectedRecordRevision: 1, fields: ['name'] }, { authorize: () => { if (++calls > 1) throw new Error('revoked') } })).rejects.toThrow('revoked')
    expect(db.crm.get('people', 'ada')).toEqual(before)
    expect(capture.list().drafts[0].source.text.length).toBeLessThanOrEqual(500)
    expect(capture.detail(draft.id).source.text.length).toBeGreaterThan(500)
  })
  it('preserves the exact captured text and HTML including leading and trailing whitespace', async () => {
    const supplied = { ...input(), text: '\n  Ada Example\nEducation\nExample University  \n', html: '  <h1>Ada Example</h1>\n ' }, draft = await capture.stage(supplied)
    const original = JSON.parse(await readFile(join(blobDir, draft.source.originalAssetId), 'utf8'))
    expect(draft.source.text).toBe(supplied.text); expect(original.text).toBe(supplied.text); expect(original.html).toBe(supplied.html)
  })
  it('rejects review field tampering even when original bytes still pass their hash', async () => {
    person(); const draft = await capture.stage(input()), candidate = db.crm.get('candidates', draft.id)!, tampered = structuredClone(candidate.profileCapture) as { profile: { affiliations: { organization: string }[] } }
    tampered.profile.affiliations[0].organization = 'Unrelated University'
    db.crm.command({ requestId: 'tamper', operation: 'update', collection: 'candidates', id: draft.id, expectedRecordRevision: candidate.revision, patch: { profileCapture: tampered } })
    await expect(capture.apply(draft.id, { requestId: 'reject-tamper', targetId: 'ada', expectedRecordRevision: 1, fields: ['affiliations'] })).rejects.toThrow('no longer match')
    expect(db.crm.get('people', 'ada')?.affiliations).toBeUndefined()
  })
  it('unions new source evidence while keeping the original affiliation identity and values', async () => {
    person(); const first = await capture.stage(input()), saved = await capture.apply(first.id, { requestId: 'first-proof', targetId: 'ada', expectedRecordRevision: 1, fields: ['affiliations'] }), old = (saved.record as CrmPerson).affiliations![0]
    const next = await capture.stage({ ...input(), title: 'Updated captured profile', text: input().text + '\nUpdated page' })
    const result = await capture.apply(next.id, { requestId: 'second-proof', targetId: 'ada', expectedRecordRevision: 2, fields: ['affiliations'] })
    expect(result.record.affiliations).toHaveLength(1)
    expect((result.record as CrmPerson).affiliations![0]).toMatchObject({ ...old, evidence: expect.arrayContaining(old.evidence) })
    expect((result.record as CrmPerson).affiliations![0].evidence).toHaveLength(2)
  })
  it('recovers an applied review after a crash between the atomic command and its final wrapper receipt', async () => {
    person(); const draft = await capture.stage(input()), request = { requestId: 'crash-recovery', targetId: 'ada', expectedRecordRevision: 1, fields: ['affiliations'] }, saved = await capture.apply(draft.id, request)
    const key = 'profile-capture-apply:' + createHash('sha256').update(request.requestId).digest('hex'), state = JSON.parse((db.db.prepare('SELECT body FROM crm_state WHERE key=?').get(key) as { body: string }).body)
    delete state.result; db.db.prepare('UPDATE crm_state SET body=? WHERE key=?').run(JSON.stringify(state), key)
    expect(await capture.apply(draft.id, request)).toMatchObject({ replayed: true, record: { id: 'ada', revision: saved.record.revision } })
    expect(db.crm.get('people', 'ada')?.revision).toBe(saved.record.revision)
  })
  it('replays a dismissed capture without a second mutation and rejects identity reuse for another draft', async () => {
    const first = await capture.stage(input()), second = await capture.stage({ ...input(), title: 'Another version' })
    expect(capture.dismiss(first.id, { requestId: 'dismiss-one' }).status).toBe('dismissed')
    const revision = db.crm.get('candidates', first.id)?.revision
    expect(capture.dismiss(first.id, { requestId: 'dismiss-one' }).status).toBe('dismissed')
    expect(db.crm.get('candidates', first.id)?.revision).toBe(revision)
    expect(() => capture.dismiss(second.id, { requestId: 'dismiss-one' })).toThrow('another capture')
  })
  it('applies education extracted from an unchanged current retained Reader source', async () => {
    person(); const { draft } = await savedReader()
    const saved = await capture.apply(draft.id, { requestId: 'saved-source-apply', targetId: 'ada', expectedRecordRevision: 1, fields: ['affiliations'] })
    expect((saved.record as CrmPerson).affiliations?.[0].organization).toBe('Example University')
  })
  it.each(['excluded', 'deleted', 'purged', 'missing', 'tampered-bytes', 'text-hash', 'newer-version', 'wrong-mime', 'wrong-length'])('refuses a staged saved-source extraction after its parent becomes %s', async reason => {
    const before = person(), { draft, snapshot, originalBlobId } = await savedReader()
    if (reason === 'excluded') snapshot.sources[0].excluded = true
    if (reason === 'deleted') snapshot.sources[0].deleted = true
    if (reason === 'purged') snapshot.versions[0].originalPurged = true
    if (reason === 'missing') await rm(join(blobDir, originalBlobId))
    if (reason === 'tampered-bytes') await writeFile(join(blobDir, originalBlobId), '{}')
    if (reason === 'text-hash') snapshot.versions[0].text += '\nChanged text without changing its claimed hash'
    if (reason === 'newer-version') { snapshot.versions.push({ ...snapshot.versions[0], id: 'newer-version', previousVersionId: 'saved-version' }); snapshot.sources[0].currentVersionId = 'newer-version' }
    if (reason === 'wrong-mime' || reason === 'wrong-length') { const meta = db.getAssetMeta(originalBlobId)!; db.putAssetMeta({ ...meta, ...(reason === 'wrong-mime' ? { mime: 'text/html' } : { bytes: meta.bytes + 1 }) }) }
    snapshot.revision++; db.putKv('knowledge.v1', snapshot)
    await expect(capture.apply(draft.id, { requestId: `reject-parent-${reason}`, targetId: 'ada', expectedRecordRevision: 1, fields: ['affiliations'] })).rejects.toThrow(/saved|Reader|source|original/)
    expect(db.crm.get('people', 'ada')).toEqual(before); expect(capture.detail(draft.id).status).toBe('pending')
  })
})

it('links multiple workplaces and schools with provenance, creates one group membership, and moves an ended role out of the team', async () => {
  db.crm.command({ requestId: 'group', operation: 'create', collection: 'groups', record: { id: 'investors', name: 'Investors', entityType: 'person' } })
  const work = { kind: 'employment', organization: '8VC', role: 'Partner', startDate: '2021', current: true, organizationUrl: 'https://www.linkedin.com/company/8vc', organizationLogoUrl: 'https://images.example.org/8vc.png' }
  const profile = { ...input().profile, affiliations: [work, { ...work, organization: 'NewCo', organizationUrl: 'https://newco.org', organizationLogoUrl: '' }, ...input().profile.affiliations] }
  const stage = await capture.stage({ ...input(), profile })
  const submission = { requestId: 'save-work', fields: ['name', 'urls', 'affiliations'], createNew: true, groupId: 'investors' }
  const first = await capture.apply(stage.id, submission)
  await capture.apply(stage.id, submission)
  const employers = db.crm.rows('companies')
  const eight = employers.find(row => row.name === '8VC')!, school = employers.find(row => row.organizationType === 'school')!
  expect(employers).toHaveLength(3)
  expect(eight.logoUrl).toBe(work.organizationLogoUrl)
  expect(db.crm.rows('memberships')).toHaveLength(1)
  expect((first.record as CrmPerson).companyIds).toHaveLength(2)
  expect(db.crm.detail('companies', eight.id).companyRoster?.current.map(row => row.id)).toEqual([first.record.id])
  expect(db.crm.detail('companies', school.id).companyRoster?.education.map(row => row.id)).toEqual([first.record.id])
  const changed = await capture.stage({ ...input(), profile: { ...profile, affiliations: [{ ...work, current: false, endDate: '2025' }] } })
  await capture.apply(changed.id, { requestId: 'end-work', targetId: first.record.id, fields: ['affiliations'], expectedRecordRevision: first.record.revision })
  expect(db.crm.get('people', first.record.id)?.companyIds).not.toContain(eight.id)
  const company = db.crm.detail('companies', eight.id)
  expect(company.companyRoster?.former.map(row => row.id)).toEqual([first.record.id])
  expect(company.companyRoster?.current).toHaveLength(0)
  expect(db.crm.get('people', first.record.id)?.affiliations).toHaveLength(3)
})
it('rolls back the person, organizations and membership if the selected group cannot accept the capture', async () => {
  const draft = await capture.stage(input())
  await expect(capture.apply(draft.id, { requestId: 'bad-group', fields: ['name', 'affiliations'], createNew: true, groupId: 'does-not-exist' })).rejects.toThrow('compatible')
  expect(db.crm.rows('people')).toHaveLength(0)
  expect(db.crm.rows('companies')).toHaveLength(0)
  expect(capture.detail(draft.id).status).toBe('pending')
})
it('rechecks identity at commit when simultaneous captures discover the same new person', async () => {
  const one = await capture.stage(input()), two = await capture.stage({ ...input(), title: 'Newer page' })
  const apply = (id: string) => capture.apply(id, { requestId: crypto.randomUUID(), createNew: true, fields: ['name', 'urls'] })
  const results = await Promise.allSettled([apply(one.id), apply(two.id)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(db.crm.rows('people')).toHaveLength(1)
})
it('replaces a same-source header with the dated role and keeps distinct historical roles and descriptions', async () => {
  const existing = { kind: 'employment', role: 'Research Fellow', current: true, organization: 'Example University' }
  const school = { id: 'school', name: 'Example University', urls: ['https://www.linkedin.com/school/example-university'] }
  db.crm.command({ requestId: 'preserve-school', operation: 'create', collection: 'companies', record: school })
  const supplied = input()
  const first = await capture.stage({ ...supplied, profile: { ...supplied.profile, affiliations: [existing] } })
  const saved = await capture.apply(first.id, { requestId: 'header-only', createNew: true, fields: ['name','urls','affiliations'] })
  const current = { ...existing, description: 'Leads the computing program.', startDate: '2021', organizationUrl: 'https://linkedin.com/school/1503/' }
  const old = { ...current, description: 'Taught the introductory course.', startDate: '2012', endDate: '2018', current: false }
  const second = await capture.stage({ ...input(), profile: { ...supplied.profile, affiliations: [existing,current,old] } })
  const retained = await capture.apply(second.id, { requestId: 'full-career', targetId: saved.record.id, expectedRecordRevision: saved.record.revision, fields: ['affiliations'] })
  const roles = (retained.record as CrmPerson).affiliations!
  expect(roles.map(role => [role.description,role.organizationId])).toEqual([[current.description,school.id],[old.description,school.id]])
  expect(roles[0].evidence.some(item => item.sourceRef?.originalAssetId === first.source.originalAssetId)).toBe(true)
  expect(db.crm.rows('companies')).toHaveLength(1)
})

it('links a Michigan Tech degree to the verified Michigan Technological University employer in the same captured career', async () => {
  db.crm.command({ operation: 'create', requestId: 'mtu', collection: 'companies', record: { id: 'mtu', name: 'Michigan Technological University', domain: 'mtu.edu', urls: ['https://www.mtu.edu/'], organizationType: 'school' } })
  const draft = await capture.stage({ requestId: 'career', url: 'https://faculty.example.org/bio', title: 'Faculty profile', text: 'M.S., Michigan Tech. Previously a professor at Michigan Technological University.', profile: {
    entityType: 'person', name: 'Faculty Member', affiliations: [
      { kind: 'employment', organization: 'Michigan Technological University', role: 'Professor', endDate: '2010' },
      { kind: 'education', organization: 'Michigan Tech', degree: 'M.S.' },
    ],
  } })
  const { record } = await capture.apply(draft.id, { requestId: 'career-save', createNew: true, fields: ['name','affiliations'] })
  expect((record as CrmPerson).affiliations?.map(row => [row.organization, row.organizationId])).toEqual([['Michigan Technological University','mtu'],['Michigan Tech','mtu']])
  expect(db.crm.rows('companies')).toHaveLength(1)
  expect(db.crm.detail('companies','mtu').companyRoster).toMatchObject({ former: [{ id: record.id }], education: [{ id: record.id }] })
})

it('updates a saved contact with top-card education through the same quick-add path used by the native helper', async () => {
  const existing = person()
  const {JSDOM}=createRequire(import.meta.url)('jsdom')
  const url='https://www.linkedin.com/in/ada-example/'
  const dom=new JSDOM('<main><section><h1>Ada Example</h1><p class="text-body-medium">Investing @General Catalyst | ex-a16z</p><button>General Catalyst</button><button aria-label="Education: Columbia University in the City of New York">Columbia University in the City of New York</button></section></main>',{url})
  try {
    const snapshot=extractProfile(dom.window.document)
    const draft=await capture.stage({requestId:'header-school',...snapshot})
    expect(draft.matches[0].id).toBe(existing.id)
    const result=await quickAddProfile({capture,store:db.crm,media:null},draft,'update-header-school')
    expect(result).toMatchObject({status:'saved',recordId:existing.id})
    const saved=db.crm.get('people',existing.id) as CrmPerson
    expect(saved.jobTitle).toBe('My existing role')
    expect(saved.affiliations).toEqual(expect.arrayContaining([expect.objectContaining({kind:'education',organization:'Columbia University in the City of New York',evidence:[expect.objectContaining({url,excerpt:expect.stringContaining('Columbia University')})]})]))
    expect(db.crm.list('people',{filter:{field:'almaMater',operator:'contains',value:'Columbia'}}).rows.map(row=>row.id)).toContain(existing.id)
    expect(db.crm.list('people',{filter:{field:'almaMater',operator:'eq',value:'Columbia University'}}).rows.map(row=>row.id)).toContain(existing.id)
    expect(db.crm.list('people',{q:'Columbia University'}).rows.map(row=>row.id)).toContain(existing.id)
  } finally {dom.window.close()}
})
