import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { KnowledgeSnapshot, SourceVersion } from '../src/knowledge/types.ts'
import type { CrmProfileCaptureDraft, CrmProfileCaptureScanResult } from '../src/crm/profileCaptureTypes.ts'
import { CrmError } from './crmStore.ts'
import type { CatalogCompanyWebsite } from './crmProfileUrls.ts'
import { fetchProfileResource, publicProfileUrl } from './crmProfileMedia.ts'
import { profileFromHtml, profileFromSavedText } from './crmProfileExtract.ts'
import type { CrmProfileCapture } from './crmProfileCapture.ts'
import type { WorldDb } from './worldDb.ts'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function check(value: unknown, message: string, status = 400): asserts value { if (!value) throw new CrmError(message, status) }
interface Options { db: WorldDb; capture: CrmProfileCapture; blobDir: string; fetch?: typeof fetch; lookup?: (host: string) => Promise<string[]> }

/** Public reads and retained-source scanning stage review drafts; they never apply contact edits. */
export class CrmProfileCollection {
  private readonly options: Options
  private readonly urlFlights = new Map<string, { url: string; promise: Promise<CrmProfileCaptureDraft> }>()
  constructor(options: Options) { this.options = options }
  private current(generation: number) { check(generation === this.options.db.getReplacementGeneration() && !this.options.db.getKv('importInProgress') && this.options.db.getSettings()?.firstRunComplete, 'The workspace changed. Reopen Collect profiles and try again.', 409) }
  async fromUrl(input: Record<string, unknown>, authorize?: () => void, catalog?: CatalogCompanyWebsite): Promise<CrmProfileCaptureDraft> {
    check(typeof input.requestId === 'string' && input.requestId.length > 0 && input.requestId.length <= 100, 'Provide a bounded unique URL import identity.')
    const url = publicProfileUrl(input.url); check(url, 'Choose a public profile URL.')
    const signature = typeof input.expectedCompanyName === 'string' ? JSON.stringify([url, input.expectedCompanyName, ...(catalog ? [catalog.labels.en || input.expectedCompanyName] : [])]) : url
    const flight = this.urlFlights.get(input.requestId)
    if (flight) { check(flight.url === signature, 'This URL import identity was already used for a different address.', 409); return flight.promise }
    const promise = this.collectUrl(input, signature, authorize, catalog); this.urlFlights.set(input.requestId, { url: signature, promise })
    try { return await promise } finally { if (this.urlFlights.get(input.requestId)?.promise === promise) this.urlFlights.delete(input.requestId) }
  }
  private recoveredUrlDraft(requestId: string): CrmProfileCaptureDraft | null {
    const staged = this.options.db.db.prepare('SELECT body FROM crm_state WHERE key=?').get(`profile-capture-stage:${hash(`url:${requestId}`)}`) as { body: string } | undefined
    if (staged) return this.options.capture.detail(String((JSON.parse(staged.body) as { id: string }).id))
    const committed = this.options.db.db.prepare('SELECT body FROM crm_command_receipts WHERE id=?').get(`profile-stage:url:${requestId}`) as { body: string } | undefined
    if (!committed) return null
    const importId = (JSON.parse(committed.body) as { importId?: string }).importId, imported = importId ? this.options.db.crm.get('imports', importId) : undefined
    check(imported?.provider === 'profile-capture' && imported.originalAssetIds.length === 1, 'The retained URL import receipt needs repair before retrying.', 409)
    const assetId = imported.originalAssetIds[0]; check(/^crm-file-[a-f0-9]{64}$/.test(assetId), 'The retained URL source identity is invalid.', 409)
    const draft = this.options.capture.detail(`crm-profile-capture-${assetId.slice(9)}`)
    check(draft.source.originalAssetId === assetId && draft.source.captureMethod === 'public-url', 'The retained URL import does not match its capture.', 409)
    return draft
  }
  private async collectUrl(input: Record<string, unknown>, signature: string, authorize?: () => void, catalog?: CatalogCompanyWebsite) {
    const generation = this.options.db.getReplacementGeneration(), current = () => { authorize?.(); this.current(generation) }, url = publicProfileUrl(input.url)
    current(); check(url && new URL(url).hostname.replace(/\.$/, '').toLowerCase() !== 'app.folk.app', 'Use a public person or company URL; Folk has its own private import.')
    check(typeof input.requestId === 'string' && input.requestId.length > 0 && input.requestId.length <= 100, 'Provide a bounded unique URL import identity.')
    if (/(^|\.)linkedin\.com$/i.test(new URL(url).hostname)) throw new CrmError('For LinkedIn, open the profile in Dia and use Worldview’s floating capture or Worldview Reader. You can also sign in through the floating control’s Worldview browser.', 422)
    const stateKey = `profile-url:${hash(input.requestId)}`, fingerprint = hash(signature), prior = this.options.db.db.prepare('SELECT body FROM crm_state WHERE key=?').get(stateKey) as { body: string } | undefined
    if (prior) {
      const receipt = JSON.parse(prior.body) as { fingerprint: string; id?: string }; check(receipt.fingerprint === fingerprint, 'This URL import identity was already used for a different address.', 409)
      if (receipt.id) return this.options.capture.detail(receipt.id)
      const recovered = this.recoveredUrlDraft(input.requestId)
      if (recovered) { this.options.db.db.prepare('INSERT OR REPLACE INTO crm_state(key,body) VALUES(?,?)').run(stateKey, JSON.stringify({ fingerprint, id: recovered.id })); return recovered }
    }
    else this.options.db.db.prepare('INSERT INTO crm_state(key,body) VALUES(?,?)').run(stateKey, JSON.stringify({ fingerprint }))
    const resource = await fetchProfileResource(url, { fetch: this.options.fetch, lookup: this.options.lookup, maxBytes: 512 * 1024, current }); current()
    check(/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(resource.contentType), 'This link did not return a readable HTML profile. Open the page and use floating capture or Worldview Reader.', 422)
    const parsed = profileFromHtml(new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes), resource.url, typeof input.expectedCompanyName === 'string' ? input.expectedCompanyName : undefined, catalog)
    const draft = await this.options.capture.stage({ ...parsed, requestId: `url:${input.requestId}` }, { authorize: current, captureMethod: 'public-url' }); current()
    this.options.db.db.prepare('INSERT OR REPLACE INTO crm_state(key,body) VALUES(?,?)').run(stateKey, JSON.stringify({ fingerprint, id: draft.id })); return draft
  }
  private retainedVersion(sourceId: string, expected?: SourceVersion): SourceVersion {
    const corpus = this.options.db.getKv<KnowledgeSnapshot>('knowledge.v1'), source = corpus?.sources.find(value => value.id === sourceId)
    check(source && !source.deleted && !source.excluded, 'This saved source was deleted or excluded.', 409)
    const version = corpus?.versions.find(value => value.id === source.currentVersionId && value.sourceId === sourceId)
    check(version && !version.originalPurged && version.origin === 'capture' && version.metadata?.captureMethod === 'browser-extension' && /^knowledge-[a-f0-9]{64}$/.test(version.originalBlobId) && hash(version.text) === version.contentHash, 'This source has no unchanged retained Reader original.', 409)
    if (expected) check(version.id === expected.id && version.originalBlobId === expected.originalBlobId && version.contentHash === expected.contentHash, 'This saved source changed during its scan.', 409)
    return version
  }
  async scanSaved(input: Record<string, unknown>): Promise<CrmProfileCaptureScanResult> {
    const generation = this.options.db.getReplacementGeneration(), current = () => this.current(generation); current()
    const offset = input.offset ?? 0, limit = input.limit ?? 10
    check(Number.isSafeInteger(offset) && Number(offset) >= 0 && Number.isSafeInteger(limit) && Number(limit) >= 1 && Number(limit) <= 20, 'Scan a page of at most 20 saved sources.')
    check(typeof input.requestId === 'string' && input.requestId.length > 0 && input.requestId.length <= 100, 'Provide a bounded unique saved-source scan identity.')
    const corpus = this.options.db.getKv<KnowledgeSnapshot>('knowledge.v1'), sources = (corpus?.sources ?? []).filter(source => !source.deleted && !source.excluded && corpus?.versions.some(version => version.id === source.currentVersionId && version.origin === 'capture' && version.metadata?.captureMethod === 'browser-extension'))
    const page = sources.slice(Number(offset), Number(offset) + Number(limit)), result: CrmProfileCaptureScanResult = { drafts: [], processed: 0, total: sources.length, nextOffset: Number(offset) + page.length < sources.length ? Number(offset) + page.length : null, skipped: [], cloudAiUsed: false }
    for (const source of page) {
      current()
      try {
        const version = this.retainedVersion(source.id), path = join(this.options.blobDir, version.originalBlobId), file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
        check(file, 'The saved source original is missing.', 409)
        let bytes: Uint8Array
        try { const info = await file.stat(); check(info.isFile() && info.size > 0 && info.size <= 1024 * 1024, 'The saved source original is unavailable or too large.', 409); bytes = new Uint8Array(await file.readFile()) } finally { await file.close() }
        const bound = () => { current(); this.retainedVersion(source.id, version) }; bound()
        const meta = this.options.db.getAssetMeta(version.originalBlobId)
        check(meta?.kind === 'file' && meta.mime === 'application/json' && meta.bytes === bytes.length && hash(bytes) === version.originalBlobId.slice(10), 'The saved source original is damaged.', 409)
        const original: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        check(object(original) && original.format === 'worldview-article-capture.v1' && original.text === version.text && typeof original.url === 'string' && original.url === version.metadata?.url, 'The source metadata no longer matches its original.', 409)
        const parsed = profileFromSavedText(version.text, original, original.url)
        const draft = await this.options.capture.stage({ ...parsed, requestId: `scan:${input.requestId}:${hash(source.id).slice(0, 16)}` }, { authorize: bound, captureMethod: 'saved-source', sourceId: source.id, sourceVersionId: version.id })
        bound(); result.drafts.push(draft)
      } catch (error) { current(); result.skipped.push({ sourceId: source.id, reason: error instanceof Error ? error.message : 'This source could not be scanned.' }) }
      result.processed++
    }
    return result
  }
}
