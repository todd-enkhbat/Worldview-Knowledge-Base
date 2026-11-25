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
