import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeEmail, normalizePhone } from '../src/crm/model.ts'
import { PROFILE_CAPTURE_FIELDS, type CrmCapturedProfile, type CrmProfileCaptureApplyResult, type CrmProfileCaptureDraft, type CrmProfileCaptureList, type CrmProfileCaptureMatch, type CrmProfileCaptureSource } from '../src/crm/profileCaptureTypes.ts'
import type { CrmAffiliation, CrmCandidate, CrmCompany, CrmPerson } from '../src/crm/types.ts'
import type { KnowledgeSnapshot, SourceVersion } from '../src/knowledge/types.ts'
import { CrmError, type SqliteCrmStore } from './crmStore.ts'
import { profileLinkIdentity, publicProfileUrl } from './crmProfileMedia.ts'
import type { WorldDb } from './worldDb.ts'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const stable = (value: unknown): string => JSON.stringify(value, (_key, part) => object(part) ? Object.fromEntries(Object.keys(part).sort().map(key => [key, part[key]])) : part)
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
function check(value: unknown, message: string, status = 400): asserts value { if (!value) throw new CrmError(message, status) }
function text(value: unknown, limit = 500) { check(value === undefined || typeof value === 'string' && value.length <= limit, `Keep captured text within ${limit} characters.`); return typeof value === 'string' ? value.trim() : '' }
const unique = <T>(values: T[], identity: (value: T) => string) => { const seen = new Set<string>(); return values.filter(value => { const key = identity(value); if (seen.has(key)) return false; seen.add(key); return true }) }
const identity = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const affiliationKey = (value: Pick<CrmAffiliation, 'kind' | 'organization' | 'role' | 'degree' | 'field' | 'startDate' | 'endDate'>) => stable([value.kind, identity(value.organization), identity(value.role ?? ''), identity(value.degree ?? ''), identity(value.field ?? ''), value.startDate ?? '', value.endDate ?? ''])
const affiliationEvidence = (row: CrmAffiliation, source: CrmProfileCaptureSource) => [{ label: `Captured ${row.kind} entry; review against the retained source`, url: source.url, sourceRef: { provider: 'profile-capture', accountId: 'local', externalId: entityUrl(source.url, 'person') || profileLinkIdentity(source.url), url: source.url, version: source.contentHash, originalAssetId: source.originalAssetId, observedAt: source.capturedAt }, ...(row.excerpt ? { excerpt: row.excerpt } : {}) }]
function entityUrl(raw: string, type: 'person' | 'company') {
  const accepted = publicProfileUrl(raw); if (!accepted) return ''
  const parsed = new URL(accepted)
  if (/(^|\.)linkedin\.com$/i.test(parsed.hostname)) {
    const match = parsed.pathname.match(/^\/(in|company|school)\/([^/]+)(?:\/|$)/i)
    return match && (type === 'person' ? match[1].toLowerCase() === 'in' : match[1].toLowerCase() !== 'in') ? `https://linkedin.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}` : ''
  }
  return profileLinkIdentity(accepted)
}
interface StoredCapture { profile: CrmCapturedProfile; source: CrmProfileCaptureSource }
interface CaptureOptions { db: WorldDb; store: SqliteCrmStore; blobDir: string; now?: () => number }
interface StageOptions { authorize?: () => void; captureMethod?: CrmProfileCaptureSource['captureMethod']; sourceId?: string; sourceVersionId?: string }

/** Explicit, private CRM capture. No knowledge rows, embeddings or cloud requests are created. */
export class CrmProfileCapture {
  private readonly options: CaptureOptions
  constructor(options: CaptureOptions) { this.options = options }
  private current(generation: number, authorize?: () => void) {
    authorize?.()
    check(generation === this.options.db.getReplacementGeneration() && !this.options.db.getKv('importInProgress'), 'The workspace changed. Capture or review this profile again.', 409)
  }
  private candidate(id: string): CrmCandidate {
    const row = this.options.store.get('candidates', id)
    check(row?.provider === 'profile-capture' && row.archivedAt === null && object(row.profileCapture), 'This profile capture is unavailable.', 404)
    return row
  }
  private stored(row: CrmCandidate): StoredCapture {
    const stored = row.profileCapture
    check(object(stored) && object(stored.profile) && object(stored.source), 'This profile capture is incomplete.', 409)
    return stored as unknown as StoredCapture
  }
  private matches(profile: CrmCapturedProfile, sourceUrl: string): CrmProfileCaptureMatch[] {
    const collection = profile.entityType === 'person' ? 'people' : 'companies', keys = new Set([sourceUrl, ...profile.urls].map(url => entityUrl(url, profile.entityType)).filter(Boolean))
    return this.options.store.rows(collection, false).filter(row => !(collection === 'people' && (row as CrmPerson).mergedIntoId)).flatMap(row => {
      const matched = row.urls.some(url => keys.has(entityUrl(url, profile.entityType)))
      const continuity = row.sourceRefs.some(ref => ref.provider === 'profile-capture' && keys.has(entityUrl(ref.url ?? ref.externalId, profile.entityType)))
      return matched || continuity ? [{ collection, id: row.id, name: collection === 'people' ? (row as CrmPerson).fullName || (row as CrmPerson).emails[0] || 'Unnamed contact' : (row as CrmCompany).name, revision: row.revision, reason: matched ? 'profile-url' as const : 'source-continuity' as const }] : []
    })
  }
  private draft(row: CrmCandidate, preview = false): CrmProfileCaptureDraft {
    const stored = this.stored(row), matches = this.matches(stored.profile, stored.source.url)
    return { id: row.id, draftId: row.id, revision: row.revision, status: row.status, profile: preview ? { ...stored.profile, description: stored.profile.description.slice(0, 500) } : stored.profile, source: preview ? { ...stored.source, text: stored.source.text.slice(0, 500) } : stored.source, matches, targetId: row.targetId ?? (matches.length === 1 ? matches[0].id : null), reviewUrl: `/#/people?capture=${encodeURIComponent(row.id)}`, cloudAiUsed: false }
  }
  list(input: { offset?: number; limit?: number; status?: string } = {}): CrmProfileCaptureList {
    const offset = input.offset ?? 0, limit = input.limit ?? 20
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'Choose a profile capture page of at most 50 records.')
    check(input.status === undefined || ['pending', 'accepted', 'dismissed', 'all'].includes(input.status), 'Choose a valid capture review status.')
    const where = "collection='candidates' AND archived=0 AND json_extract(body,'$.provider')='profile-capture' AND json_type(body,'$.profileCapture')='object'" + (input.status === 'all' ? '' : " AND json_extract(body,'$.status')=?"), params = input.status === 'all' ? [] : [input.status ?? 'pending']
    const total = Number((this.options.db.db.prepare(`SELECT COUNT(*) AS n FROM crm_rows WHERE ${where}`).get(...params) as { n: number }).n)
    const rows = (this.options.db.db.prepare(`SELECT body FROM crm_rows WHERE ${where} ORDER BY ord DESC,id LIMIT ? OFFSET ?`).all(...params, limit, offset) as { body: string }[]).map(row => JSON.parse(row.body) as CrmCandidate)
    return { drafts: rows.map(row => this.draft(row, true)), total, nextOffset: offset + rows.length < total ? offset + rows.length : null }
  }
  detail(id: string) { return this.draft(this.candidate(id)) }
  private normalize(input: Record<string, unknown>) {
    const sourceUrl = publicProfileUrl(input.url); check(sourceUrl, 'Capture a valid public HTTP or HTTPS profile URL.')
    check(sourceUrl.length <= 2000, 'Capture a profile URL of at most 2,000 characters.')
    const title = text(input.title, 2000)
    check(typeof input.text === 'string' && (input.html === undefined || typeof input.html === 'string'), 'A profile capture needs readable text and an optional HTML snapshot.')
    const sourceText = input.text, html = typeof input.html === 'string' ? input.html : ''
    check(Buffer.byteLength(sourceText) <= 512 * 1024 && Buffer.byteLength(html) <= 512 * 1024 && !!sourceText.trim(), 'A profile capture needs readable text of at most 512 KiB.')
    const value = object(input.profile) ? input.profile : input
    check(value.entityType === 'person' || value.entityType === 'company', 'Choose a person or company profile.')
    const name = text(value.name, 400); check(name, 'The captured profile must explicitly name its person or company.')
    const list = (key: string, validator: (item: string) => string = value => value) => { const values = value[key] ?? []; check(Array.isArray(values) && values.length <= 32 && values.every(item => typeof item === 'string' && item.length <= 2048), `Capture at most 32 ${key}.`); return unique(values.map(item => validator(item.trim())).filter(Boolean), item => key === 'emails' ? normalizeEmail(item) : key === 'urls' ? profileLinkIdentity(item) : item) }
    const emails = list('emails', email => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : ''), phones = list('phones'), urls = list('urls', url => publicProfileUrl(url) ?? '')
    const rawAffiliations = value.affiliations ?? []; check(Array.isArray(rawAffiliations) && rawAffiliations.length <= 60, 'Capture at most 60 education, work or affiliation entries.')
    const affiliations: CrmAffiliation[] = unique(rawAffiliations.map((row: unknown) => {
      check(object(row) && ['education', 'employment', 'membership', 'advisory'].includes(String(row.kind)), 'Choose a supported captured affiliation.')
      const organization = text(row.organization, 500); check(organization, 'A captured affiliation needs an organization name.')
      const fields = Object.fromEntries(['role', 'degree', 'field', 'startDate', 'endDate'].flatMap(key => { const supplied = text(row[key], 500); return supplied ? [[key, supplied]] : [] }))
      const organizationUrl = publicProfileUrl(row.organizationUrl), excerpt = text(row.excerpt, 4000)
      check(row.current === undefined || typeof row.current === 'boolean', 'The captured current-affiliation flag must be explicit.')
      const result = { kind: row.kind as CrmAffiliation['kind'], organization, ...fields, ...(organizationUrl ? { organizationUrl } : {}), ...(row.current === undefined ? {} : { current: row.current }), ...(excerpt ? { excerpt } : {}), evidence: [] }
      return { ...result, id: `affiliation-${hash(affiliationKey(result)).slice(0, 40)}` }
    }), affiliationKey)
    const rawImages = value.images ?? []; check(Array.isArray(rawImages) && rawImages.length <= 8, 'Capture at most eight named profile image references.')
    const images = rawImages.flatMap(row => { if (!object(row)) return []; const url = publicProfileUrl(row.url); return url ? [{ url, label: text(row.label, 200), isProfile: row.isProfile === true, subjectName: text(row.subjectName, 400) }] : [] })
    const profile: CrmCapturedProfile = { entityType: value.entityType, name, headline: text(value.headline, 2000), description: text(value.description, 20000), location: text(value.location, 2000), industry: text(value.industry, 2000), emails, phones, urls: unique([sourceUrl, ...urls], profileLinkIdentity), affiliations, images }
    return { url: sourceUrl, title: title || name, text: sourceText, html, profile }
  }
  async stage(input: Record<string, unknown>, options: StageOptions = {}): Promise<CrmProfileCaptureDraft> {
    const generation = this.options.db.getReplacementGeneration(), current = () => this.current(generation, options.authorize); current()
    const requestId = text(input.requestId, 150); check(requestId, 'Provide a unique profile capture request identity.')
    const normalized = this.normalize(input), original = { format: 'worldview-profile-capture.v1', ...normalized, captureMethod: options.captureMethod ?? 'browser-extension', ...(options.sourceId ? { sourceId: options.sourceId, sourceVersionId: options.sourceVersionId } : {}) }, bytes = Buffer.from(stable(original)), digest = hash(bytes), originalAssetId = `crm-file-${digest}`, id = `crm-profile-capture-${digest}`, key = `profile-capture-stage:${hash(requestId)}`
    check(bytes.length <= 2 * 1024 * 1024, 'This captured profile original exceeds two MiB.', 413)
    const prior = this.options.db.db.prepare('SELECT body FROM crm_state WHERE key=?').get(key) as { body: string } | undefined
    if (prior) { const receipt = JSON.parse(prior.body) as { fingerprint: string; id: string }; check(receipt.fingerprint === digest, 'This profile capture request identity was already used for different data.', 409); return this.detail(receipt.id) }
    if (this.options.store.get('candidates', id)) { const draft = this.detail(id); this.options.db.db.prepare('INSERT INTO crm_state(key,body) VALUES(?,?)').run(key, JSON.stringify({ fingerprint: digest, id })); return draft }
    await mkdir(this.options.blobDir, { recursive: true }); current()
    try { await writeFile(join(this.options.blobDir, originalAssetId), bytes, { flag: 'wx', mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const found = await this.original(originalAssetId); current(); check(found && hash(found) === digest, 'This retained profile original is damaged.', 409) }
    current()
    if (this.options.store.get('candidates', id)) return this.detail(id)
    const capturedAt = this.options.now?.() ?? Date.now(), source: CrmProfileCaptureSource = { url: normalized.url, title: normalized.title, text: normalized.text, originalAssetId, capturedAt, contentHash: digest, captureMethod: original.captureMethod, ...(options.sourceId ? { sourceId: options.sourceId, sourceVersionId: options.sourceVersionId } : {}) }
    const ref = { provider: 'profile-capture', accountId: 'local', externalId: entityUrl(normalized.url, normalized.profile.entityType) || profileLinkIdentity(normalized.url), url: normalized.url, version: digest, originalAssetId, observedAt: capturedAt }
    const profile = { ...normalized.profile, affiliations: normalized.profile.affiliations.map(row => ({ ...row, evidence: [{ label: `Captured ${row.kind} entry; review against the retained source`, url: source.url, sourceRef: ref, ...(row.excerpt ? { excerpt: row.excerpt } : {}) }] })) }, matches = this.matches(profile, source.url)
    this.options.db.putAssetMeta({ id: originalAssetId, kind: 'file', mime: 'application/json', bytes: bytes.length, createdAt: capturedAt, nodeId: null })
    current()
    this.options.store.command({ requestId: `profile-stage:${requestId}`, operation: 'import', provider: 'profile-capture', accountId: 'local', name: source.title, originalAssetIds: [originalAssetId], collections: { candidates: [{ id, kind: profile.entityType, status: 'pending', provider: 'profile-capture', accountId: 'local', externalId: ref.externalId, payload: {}, targetId: matches.length === 1 ? matches[0].id : null, confidence: matches.length === 1 ? 'exact' : 'unknown', evidence: [{ label: 'Explicit profile capture awaiting field review', url: source.url, sourceRef: ref }], sourceRefs: [ref], profileCapture: { profile, source } }] } }, 'profile-capture')
    this.options.db.db.prepare('INSERT OR REPLACE INTO crm_state(key,body) VALUES(?,?)').run(key, JSON.stringify({ fingerprint: digest, id }))
    return this.detail(id)
  }
  private async original(id: string): Promise<Uint8Array | null> {
    if (!/^crm-file-[a-f0-9]{64}$/.test(id)) return null
    const file = await open(join(this.options.blobDir, id), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null); if (!file) return null
    try { const info = await file.stat(); if (!info.isFile() || info.size < 1 || info.size > 2 * 1024 * 1024) return null; const bytes = new Uint8Array(await file.readFile()); return hash(bytes) === id.slice(9) ? bytes : null } finally { await file.close() }
  }
  private savedVersion(source: CrmProfileCaptureSource): SourceVersion {
    const corpus = this.options.db.getKv<KnowledgeSnapshot>('knowledge.v1'), parent = corpus?.sources.find(row => row.id === source.sourceId)
    check(parent && !parent.deleted && !parent.excluded, 'The saved source was deleted or excluded. Restore its source policy before reviewing this extraction.', 409)
    check(typeof source.sourceVersionId === 'string' && parent.currentVersionId === source.sourceVersionId, 'The saved source has a newer version. Scan its current version before applying fields.', 409)
    const version = corpus?.versions.find(row => row.id === source.sourceVersionId && row.sourceId === parent.id)
    check(version && !version.originalPurged && version.origin === 'capture' && version.metadata?.captureMethod === 'browser-extension' && /^knowledge-[a-f0-9]{64}$/.test(version.originalBlobId) && hash(version.text) === version.contentHash && version.text === source.text && publicProfileUrl(version.metadata.url) === source.url, 'The saved Reader source text or retained original changed. Scan the current source again.', 409)
    return version
  }
  private async verifySavedSource(source: CrmProfileCaptureSource, current: () => void) {
    if (source.captureMethod !== 'saved-source') return
    const version = this.savedVersion(source), file = await open(join(this.options.blobDir, version.originalBlobId), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
    if (!file) { current(); throw new CrmError('The saved source original is missing. Restore it before applying this extraction.', 409) }
    let bytes: Uint8Array
    try { current(); const info = await file.stat(); check(info.isFile() && info.size > 0 && info.size <= 1024 * 1024, 'The saved source original is unavailable or too large.', 409); bytes = new Uint8Array(await file.readFile()) } finally { await file.close() }
    current(); const latest = this.savedVersion(source), meta = this.options.db.getAssetMeta(version.originalBlobId)
    check(latest.originalBlobId === version.originalBlobId && latest.contentHash === version.contentHash && meta?.kind === 'file' && meta.mime === 'application/json' && meta.bytes === bytes.length && hash(bytes) === version.originalBlobId.slice(10), 'The saved source original is missing or damaged. Restore it before applying fields.', 409)
    let original: unknown; try { original = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new CrmError('The saved source original is not valid JSON.', 409) }
    check(object(original) && original.format === 'worldview-article-capture.v1' && original.text === version.text && original.url === version.metadata?.url, 'The saved source metadata no longer matches its retained original.', 409)
    current(); this.savedVersion(source)
  }
  async apply(id: string, input: Record<string, unknown>, options: { authorize?: () => void } = {}): Promise<CrmProfileCaptureApplyResult> {
    const generation = this.options.db.getReplacementGeneration(), current = () => this.current(generation, options.authorize); current()
    const candidate = this.candidate(id), draft = this.draft(candidate), requestId = text(input.requestId, 150); check(requestId, 'Provide a unique review request identity.')
    const receiptId = `profile-apply:${requestId}`, requestHash = hash(stable({ id, input })), stateKey = `profile-capture-apply:${hash(requestId)}`, prior = this.options.db.db.prepare('SELECT body FROM crm_state WHERE key=?').get(stateKey) as { body: string } | undefined
    if (prior) {
      const receipt = JSON.parse(prior.body) as { fingerprint: string; result?: CrmProfileCaptureApplyResult }
      check(receipt.fingerprint === requestHash, 'This review identity was already used for different data.', 409)
      if (receipt.result) return { ...receipt.result, replayed: true }
      const committed = this.options.db.db.prepare('SELECT body FROM crm_command_receipts WHERE id=?').get(receiptId) as { body: string } | undefined
      if (committed) {
        const saved = JSON.parse(committed.body) as { record?: CrmPerson | CrmCompany }
        check(saved.record, 'The saved profile receipt is incomplete. Review its history before retrying.', 409)
        return { ok: true, record: saved.record, draft: this.detail(id), replayed: true }
      }
    }
    check(candidate.status === 'pending', 'This profile capture has already been reviewed.', 409)
    const bytes = await this.original(draft.source.originalAssetId); current(); const meta = this.options.db.getAssetMeta(draft.source.originalAssetId)
    check(bytes && meta?.kind === 'file' && meta.mime === 'application/json' && meta.bytes === bytes.length && hash(bytes) === draft.source.contentHash, 'The retained profile original is missing or damaged. Capture it again before applying fields.', 409)
    let original: unknown; try { original = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new CrmError('The retained profile original is not valid JSON.', 409) }
    const originalProfile = { ...draft.profile, affiliations: draft.profile.affiliations.map(row => ({ ...row, evidence: [] })) }
    check(object(original) && original.format === 'worldview-profile-capture.v1' && original.url === draft.source.url && original.title === draft.source.title && original.text === draft.source.text && original.captureMethod === draft.source.captureMethod && original.sourceId === draft.source.sourceId && original.sourceVersionId === draft.source.sourceVersionId && stable(original.profile) === stable(originalProfile), 'The review fields no longer match their retained profile original. Capture the source again.', 409)
    await this.verifySavedSource(draft.source, current); current()
    check(this.candidate(id).revision === candidate.revision, 'This capture changed while its original was checked.', 409)
    check(Array.isArray(input.fields) && input.fields.length > 0 && input.fields.length <= PROFILE_CAPTURE_FIELDS.length && input.fields.every(key => PROFILE_CAPTURE_FIELDS.includes(key as typeof PROFILE_CAPTURE_FIELDS[number])) && new Set(input.fields).size === input.fields.length, 'Choose the captured fields to save.')
    const collection = draft.profile.entityType === 'person' ? 'people' : 'companies', targetId = typeof input.targetId === 'string' ? input.targetId : input.createNew === true ? null : draft.targetId
    check(targetId || input.createNew === true, 'Choose an existing record or explicitly create a new one.')
    const target = targetId ? this.options.store.get(collection, targetId) : undefined
    check(!targetId || target && target.archivedAt === null && !(collection === 'people' && (target as CrmPerson).mergedIntoId) && target.revision === input.expectedRecordRevision, 'The selected record changed or is unavailable. Refresh before applying.', 409)
    check(!input.createNew || !draft.matches.length, 'This profile already matches a saved record. Review the existing record instead of duplicating it.', 409)
    check(input.groupId === undefined, 'Add the saved record to a group through its group controls after review.')
    const patch: Record<string, unknown> = {}, profile = draft.profile, fields = new Set(input.fields as string[])
    if (!target) check(fields.has('name'), 'Include the captured name when creating a person or company.')
    for (const key of ['name', 'headline', 'description', 'location', 'industry'] as const) if (fields.has(key) && profile[key]) { if (key === 'name') patch[collection === 'people' ? 'fullName' : 'name'] = profile.name; else if (key === 'headline') patch[collection === 'people' ? 'jobTitle' : 'tagline'] = profile.headline; else patch[key] = profile[key] }
    for (const key of ['emails', 'phones', 'urls'] as const) if (fields.has(key)) {
      const existing = target?.[key] ?? [], canonical = (value: string) => key === 'emails' ? normalizeEmail(value) : key === 'urls' ? profileLinkIdentity(value) : normalizePhone(value), seen = new Set(existing.map(canonical))
      const additions = profile[key].filter(value => { const normalized = canonical(value); if (seen.has(normalized)) return false; seen.add(normalized); return true })
      patch[key] = [...existing, ...additions]
    }
    if (collection === 'people' && fields.has('affiliations')) {
      check(input.affiliationIds === undefined || Array.isArray(input.affiliationIds) && input.affiliationIds.length <= 60 && input.affiliationIds.every(value => typeof value === 'string' && profile.affiliations.some(row => row.id === value)), 'Select affiliations from this captured profile only.')
      const selected = profile.affiliations.filter(row => !Array.isArray(input.affiliationIds) || input.affiliationIds.includes(row.id)).map(row => {
        const reviewed = { ...row, evidence: affiliationEvidence(row, draft.source) }
        if (!row.organizationUrl) return reviewed
        const key = profileLinkIdentity(row.organizationUrl), companies = this.options.store.rows('companies', false).filter(company => company.urls.some(url => profileLinkIdentity(url) === key))
        return companies.length === 1 ? { ...reviewed, organizationId: companies[0].id } : reviewed
      })
      const merged = new Map(((target as CrmPerson | undefined)?.affiliations ?? []).map(row => [affiliationKey(row), row]))
      for (const row of selected) {
        const key = affiliationKey(row), previous = merged.get(key)
        merged.set(key, previous ? { ...previous, evidence: unique([...previous.evidence, ...row.evidence], stable) } : row)
      }
      patch.affiliations = [...merged.values()]
      const employmentCompanies = selected.filter(row => row.kind === 'employment' && row.current === true && row.organizationId).map(row => row.organizationId!)
      patch.companyIds = [...new Set([...((target as CrmPerson | undefined)?.companyIds ?? []), ...employmentCompanies])]
    }
    patch.profileCaptureIds = [...new Set([...(target?.profileCaptureIds ?? []), candidate.id])]
    current()
    this.options.db.db.prepare('INSERT OR REPLACE INTO crm_state(key,body) VALUES(?,?)').run(stateKey, JSON.stringify({ fingerprint: requestHash }))
    const saved = this.options.store.command({ requestId: receiptId, operation: 'review_candidate', id, expectedRecordRevision: candidate.revision, accept: true, ...(targetId ? { targetId, expectedTargetRevision: input.expectedRecordRevision } : {}), patch }, 'profile-capture')
    const record = saved.record as CrmPerson | CrmCompany; check(record, 'The profile review did not return its saved record.', 500)
    const result: CrmProfileCaptureApplyResult = { ok: true, record, draft: this.detail(id), ...(saved.replayed ? { replayed: true } : {}) }
    this.options.db.db.prepare('INSERT OR REPLACE INTO crm_state(key,body) VALUES(?,?)').run(stateKey, JSON.stringify({ fingerprint: requestHash, result }))
    return result
  }
  dismiss(id: string, input: Record<string, unknown>) {
    const candidate = this.candidate(id), requestId = text(input.requestId, 150); check(requestId, 'Provide a unique review request identity.')
    const receiptId = `profile-dismiss:${requestId}`, prior = this.options.db.db.prepare('SELECT body FROM crm_command_receipts WHERE id=?').get(receiptId) as { body: string } | undefined
    if (prior) { const receipt = JSON.parse(prior.body) as { candidate?: CrmCandidate }; check(receipt.candidate?.id === id, 'This review identity was already used for another capture.', 409); return this.detail(id) }
    this.options.store.command({ requestId: receiptId, operation: 'review_candidate', id, expectedRecordRevision: candidate.revision, accept: false }, 'profile-capture')
    return this.detail(id)
  }
}
