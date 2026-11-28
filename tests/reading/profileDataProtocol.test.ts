import { applyStudy, decodeStudy, STUDY_KEY } from '../../src/study/model.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CrmProfileCapture } from '../../server/crmProfileCapture.ts'
import { CrmProfileMedia } from '../../server/crmProfileMedia.ts'
import { quickAddProfile } from '../../server/crmProfileQuickAdd.ts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArticleCapture } from '../../server/articleCapture.ts'
import { openWorldDb, type WorldDb } from '../../server/worldDb.ts'
import type { CrmProfileCaptureDraft } from '../../src/crm/profileCaptureTypes.ts'
import { PORTABLE_WORLD_KEYS } from '../../src/data/worldSnapshot.ts'

let db: WorldDb
beforeEach(() => { db = openWorldDb(':memory:'); db.putSettings({ T0: 0, yPerYear: 12, stepsPerYear: 600, physicsSeed: 42, qualityTier: 'auto', firstRunComplete: true, lastBackupAt: null, autoBackupEnabled: false, createdAt: 1, schemaVersion: 1 }) })
afterEach(() => db.close())
type StageInput = Record<string, unknown> & { requestId: string; current: () => void }
const origin = `chrome-extension://${'a'.repeat(32)}`
const input = { saveProfileData: true as const, sequence: 1, url: 'https://example.org/ada', title: 'Ada Example', text: 'Ada Example\nEducation\nExample University', profile: { entityType: 'person', name: 'Ada Example' } }
const draft: CrmProfileCaptureDraft = { id: 'capture-ada', draftId: 'capture-ada', revision: 1, status: 'pending', profile: { entityType: 'person', name: 'Ada Example', headline: '', description: '', location: '', industry: '', emails: [], phones: [], urls: [input.url], affiliations: [], images: [] }, source: { url: input.url, title: input.title, text: input.text, originalAssetId: `crm-file-${'a'.repeat(64)}`, capturedAt: 1, contentHash: 'b'.repeat(64), captureMethod: 'browser-extension' }, matches: [], targetId: null, reviewUrl: '/#/people?capture=capture-ada', cloudAiUsed: false }

it('stages explicit profile data privately and replays a confirmed receipt across worker restarts', async () => {
  const stage = vi.fn(async (value: StageInput) => { value.current(); return draft }), service = new ArticleCapture({ db, blobDir: '/unused', saveProfileData: stage }), paired = service.pair({ origin })
  const first = await service.capture(input, origin, paired.token)
  expect(first).toMatchObject({ sequence: 1, profileDraft: draft, reviewUrl: 'http://127.0.0.1:5173/#/people?capture=capture-ada' })
  expect(stage.mock.calls[0][0].requestId).toBe(`reader-profile:${paired.clientId}:1`)
  expect(db.getKv('knowledge.v1')).toBeUndefined(); expect(db.getKv('reading.v1')).toBeUndefined(); expect(db.listNodes()).toEqual([])
  const restarted = new ArticleCapture({ db, blobDir: '/unused', saveProfileData: stage })
  expect(await restarted.capture(input, origin, paired.token)).toEqual(first); expect(stage).toHaveBeenCalledOnce()
  await expect(restarted.capture({ ...input, text: 'Changed same sequence' }, origin, paired.token)).rejects.toMatchObject({ status: 409 })
  expect(PORTABLE_WORLD_KEYS).not.toContain('reading.capture.profile-data.receipts.v1')
})
it('rejects mixed capture intents and Folk pages before invoking the profile service', async () => {
  const stage = vi.fn(async () => draft), service = new ArticleCapture({ db, blobDir: '/unused', saveProfileData: stage }), paired = service.pair({ origin })
  for (const extra of [{ saveContactPhoto: true }, { saveFolkPhotos: true }, { progress: { fraction: 1 } }, { remark: 'Unfinished note' }]) await expect(service.capture({ ...input, ...extra }, origin, paired.token)).rejects.toMatchObject({ status: 400 })
  await expect(service.capture({ ...input, url: 'https://app.folk.app/private' }, origin, paired.token)).rejects.toMatchObject({ status: 403 })
  await expect(service.capture(input, origin, 'invalid')).rejects.toMatchObject({ status: 401 })
  expect(stage).not.toHaveBeenCalled()
})
it('rechecks pairing after asynchronous work and leaves a failed delivery retryable', async () => {
  let clientId = ''
  const stage = vi.fn(async (value: StageInput) => { service.revoke(clientId); value.current(); return draft })
  const service = new ArticleCapture({ db, blobDir: '/unused', saveProfileData: stage }); const paired = service.pair({ origin }); clientId = paired.clientId
  await expect(service.capture(input, origin, paired.token)).rejects.toMatchObject({ status: 401 })
  const receipts = db.getKv<{ entries: Record<string, { result?: unknown }> }>('reading.capture.profile-data.receipts.v1')!
  expect(Object.values(receipts.entries).every(row => !row.result)).toBe(true)
})

it('lists compatible group names and saved marks for a paired reader and denies a revoked token', () => {
  const service = new ArticleCapture({ db, blobDir: '/unused' }), paired = service.pair({ origin })
  for (const type of ['person', 'company']) db.crm.command({ operation: 'create', requestId: type, collection: 'groups', record: { id: type, name: type, entityType: type, emoji: type === 'person' ? '🦁' : '' } })
  expect(service.profileGroups('person', origin, paired.token)).toEqual({ groups: [{ id: 'person', name: 'person', emoji: '🦁' }] })
  db.crm.command({ operation: 'create', requestId: 'create-known', collection: 'people', record: { id: 'known', fullName: 'Known Person', urls: ['https://www.linkedin.com/in/known/'] } })
  const revisit = () => service.profileGroups('person', origin, paired.token, 'https://linkedin.com/in/KNOWN/?trk=feed')
  expect(revisit().existing).toEqual({recordId: 'known', groupIds: []})
  db.crm.command({ operation: 'create', requestId: 'create-ambiguous', collection: 'people', record: { id: 'second', fullName: 'Another Person', urls: ['https://www.linkedin.com/in/known/'] } })
  expect(revisit().existing).toBeNull()
  service.revoke(paired.clientId)
  expect(() => service.profileGroups('company', origin, paired.token)).toThrow('revoked')
})

it('saves a profile, its portrait and group, then reuses the same contact on retry and recapture', async () => {
  const blobDir = await mkdtemp(join(tmpdir(), 'wv-reader-add-'))
  try {
    const store = db.crm, capture = new CrmProfileCapture({ db, store, blobDir })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6kcAAAAASUVORK5CYII=', 'base64')
    const fetch = vi.fn(async () => new Response(png)), media = new CrmProfileMedia({ db, store, blobDir, fetch, lookup: async () => ['93.184.216.34'] })
    const service = new ArticleCapture({ db, blobDir, saveProfileData: input => capture.stage(input, { authorize: input.current }), quickAddProfile: (draft, requestId, groupId, authorize) => quickAddProfile({ capture, store, media }, draft, requestId, groupId, authorize) })
    const paired = service.pair({ origin })
    for (const name of ['Founders', 'Friends']) store.command({ requestId: name, operation: 'create', collection: 'groups', record: { id: name, name, entityType: 'person' } })
    const params = { ...input, groupId: 'Founders', quickAdd: true, profile: { ...input.profile, description: 'Engineer', images: [{ url: 'https://images.example.org/ada.png', isProfile: true, subjectName: input.profile.name }] } }
    const saved = await service.capture(params, origin, paired.token)
    expect(saved.quickAdd).toMatchObject({ status: 'saved', image: 'saved' })
    expect((await service.capture(params, origin, paired.token)).quickAdd).toEqual(saved.quickAdd)
    expect((await service.capture({ ...params, sequence: 2, groupId: 'Friends' }, origin, paired.token)).quickAdd).toMatchObject({ status: 'saved', image: 'kept', recordId: saved.quickAdd?.recordId })
    expect(store.rows('people')).toHaveLength(1)
    expect(store.rows('people')[0].avatarAssetId).toBeTruthy()
    expect(store.rows('memberships').map(m => m.groupId).sort()).toEqual(['Founders', 'Friends'])
    expect(fetch).toHaveBeenCalledOnce()
    const conflicting = { ...params, sequence: 3, url: 'https://other.example/', profile: { ...params.profile, name: 'Different Person', urls: [input.url] } }
    const ambiguous = await service.capture(conflicting, origin, paired.token)
    expect(ambiguous.quickAdd).toMatchObject({ status: 'review', message: expect.stringContaining('different name') })
    expect(store.rows('people')[0].fullName).toBe('Ada Example')
    expect(store.rows('people')[0].urls).not.toContain(conflicting.url)
  } finally { await rm(blobDir, { recursive: true, force: true }) }
})
it('records a source-bound successful application submission with the observed time and typed answers',()=>{
  const now=Date.UTC(2026,10,26,18), service=new ArticleCapture({db,blobDir:'/unused',now:()=>now}), paired=service.pair({origin})
  const state=decodeStudy(undefined),id=applyStudy(state,'application',{organization:'Alive Prize',opportunity:'Alive Prize',source:'https://aliveprize.com/apply',step:'Application',deadline:'11/25',submitted:false,answers:[{question:'Why apply?',answer:''}]},now-1000)
  db.putKv(STUDY_KEY,state)
  const payload={workspaceToken:db.crm.workspaceFingerprint(),applicationId:id,source:'https://aliveprize.com/apply',form:{submitted:true,appliedAt:now,submissionEvidence:'Thank you for your application',answers:[{question:'Why apply?',answer:'The exact final answer.'}]}}
  expect(()=>service.applicationSubmitted(payload,origin,'wrong')).toThrow()
  expect(()=>service.applicationSubmitted({...payload,source:'https://different.example/'},origin,paired.token)).toThrow()
  expect(()=>service.applicationSubmitted({...payload,form:{...payload.form,submitted:false}},origin,paired.token)).toThrow()
  expect(service.applicationSubmitted(payload,origin,paired.token)).toMatchObject({id,appliedAt:now})
  expect(decodeStudy(db.getKv(STUDY_KEY)).applications[0]).toMatchObject({deadline:'11/25',appliedAt:now,revisions:[expect.anything(),expect.objectContaining({step:'Submission confirmation',submitted:true,answers:[{question:'Why apply?',answer:'The exact final answer.'}]})]})
})
