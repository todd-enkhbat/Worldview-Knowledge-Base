import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sniffImageMime } from '../src/data/attachments.ts'
import type { CrmPerson } from '../src/crm/types.ts'
import type { KnowledgeSnapshot } from '../src/knowledge/types.ts'
import { CrmError } from './crmStore.ts'
import { CrmProfileMedia, profileLinkIdentity, profilePlatform, publicProfileUrl, type ProfileMediaOptions } from './crmProfileMedia.ts'
import { CrmFolkSearchPhotos } from './crmFolkSearchPhotos.ts'

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const nameKey = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const personName = (person: CrmPerson) => person.fullName || [person.firstName, person.lastName].filter(Boolean).join(' ') || person.emails[0] || 'Unnamed contact'
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
export interface SavedContactPhoto { status: 'saved' | 'kept' | 'unmatched' | 'unavailable'; personId?: string; name?: string; avatarAssetId?: string; message: string }
export interface CapturedPhotoRequest { sourceId: string; versionId: string; requestId: string; current: () => void }
export interface FolkPhotoInput { url?: unknown; title?: unknown; folkPhotos?: unknown; folkPhotoRows?: unknown; saveFolkSearchPhotos?: unknown }
export interface FolkPhotoBatch { total: number; saved: number; kept: number; unmatched: number; unavailable: number; diagnostic: boolean; results: SavedContactPhoto[]; message: string }
export interface SavedFolkPhotos { originalAssetId: string; folkPhotos: FolkPhotoBatch }
export function assertUniqueFolkPhotoPeople(value: unknown) {
  const ids = new Set<string>()
  for (const row of Array.isArray(value) ? value : []) if (object(row) && typeof row.personId === 'string' && /^per_[a-f0-9-]{36}$/i.test(row.personId)) {
    const id = row.personId.toLowerCase(); if (ids.has(id)) throw new CrmError('This visible Folk batch contains ambiguous duplicate person IDs. Capture each person once.', 400); ids.add(id)
  }
}
interface FolkReceipt { fingerprint: string; originalAssetId: string; targets: { personId: string; name: string; revision: number; hadPhoto: boolean; photoUrl: string; sourceUrl: string }[]; results: SavedContactPhoto[]; result?: SavedFolkPhotos }
export interface PhotoCoverageRow { personId: string; name: string; status: 'available' | 'missing' | 'damaged' | 'missing-original'; sources: string[]; reason: string }
function normalizedFolkRows(value: unknown, searchDiagnostics = false) {
  const bounded = (value: unknown, max = 500) => typeof value === 'string' ? value.slice(0, max) : ''
  const integer = (value: unknown, max = 65_536) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0
  const imageState = (value: unknown) => object(value) ? { alt: bounded(value.alt, 200), ariaLabel: bounded(value.ariaLabel, 200), title: bounded(value.title, 200), rowImageCount: integer(value.rowImageCount, 1000), complete: value.complete === true, naturalWidth: integer(value.naturalWidth), naturalHeight: integer(value.naturalHeight), currentSrc: bounded(value.currentSrc, 4096), requestedSources: (Array.isArray(value.requestedSources) ? value.requestedSources : []).slice(0, 8).map(source => bounded(source, 4096)), personLinkCount: integer(value.personLinkCount, 1000), verifiedReason: bounded(value.verifiedReason, 80) } : undefined
  const attributes = new Set(['data-person-id', 'data-contact-id', 'data-record-id', 'data-row-id', 'data-id', 'id', 'aria-label', 'role'])
  return (Array.isArray(value) ? value : []).filter(object).map(row => ({ photoUrl: bounded(row.photoUrl, 8192), name: bounded(row.name), groupId: bounded(row.groupId, 100), sourceUrl: bounded(row.sourceUrl, 8192), nearbyLinks: (Array.isArray(row.nearbyLinks) ? row.nearbyLinks : []).slice(0, 8).filter(object).map(link => ({ href: bounded(link.href, 8192), text: bounded(link.text) })), attributes: object(row.attributes) ? Object.fromEntries(Object.entries(row.attributes).filter(([key]) => attributes.has(key)).slice(0, 12).map(([key, value]) => [key, bounded(value)])) : {}, ...(imageState(row.imageState) ? { imageState: imageState(row.imageState) } : {}), ...(searchDiagnostics && ['visibleEmails', 'rowRole', 'avatarLabel', 'isPrimaryAvatar'].some(key => key in row) ? { visibleEmails: (Array.isArray(row.visibleEmails) ? row.visibleEmails : []).filter((email): email is string => typeof email === 'string').slice(0, 8).map(email => bounded(email, 320)), rowRole: bounded(row.rowRole, 40), avatarLabel: bounded(row.avatarLabel, 200), isPrimaryAvatar: row.isPrimaryAvatar === true } : {}) }))
}

/** All reads stay inside this workspace. No profile website is contacted by a coverage audit. */
export class CrmPhotoCoverage {
  private readonly options: ProfileMediaOptions
  constructor(options: ProfileMediaOptions) { this.options = options }
  private guard() { const generation = this.options.db.getReplacementGeneration(); return () => { if (generation !== this.options.db.getReplacementGeneration() || this.options.db.getKv('importInProgress')) throw new CrmError('The workspace changed. Refresh People before checking photos.', 409) } }
  private async original(id: string, prefix: 'crm-avatar-' | 'knowledge-' | 'crm-file-', limit: number): Promise<Uint8Array | null> {
    if (!new RegExp(`^${prefix}[a-f0-9]{64}$`).test(id)) return null
    const file = await open(join(this.options.blobDir, id), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
    if (!file) return null
    try { const info = await file.stat(); if (!info.isFile() || info.size < 1 || info.size > limit) return null; return new Uint8Array(await file.readFile()) } finally { await file.close() }
  }
  private async photoAvailable(id: string, current: () => void) {
    const meta = this.options.db.getAssetMeta(id), bytes = await this.original(id, 'crm-avatar-', 12 * 1024 * 1024); current()
    return !!meta && !!bytes && meta.kind === 'image' && meta.bytes === bytes.length && imageTypes.has(meta.mime) && sniffImageMime(bytes.subarray(0, 4096)) === meta.mime && digest(bytes) === id.slice('crm-avatar-'.length)
  }
  async inspect(query: { offset?: number; limit?: number; status?: string } = {}) {
    const current = this.guard(), offset = query.offset ?? 0, limit = query.limit ?? 500
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || query.status && !['available', 'missing', 'damaged', 'missing-original', 'needs-attention'].includes(query.status)) throw new CrmError('Choose a valid photo coverage page.')
    current(); const people = this.options.store.rows('people', false).filter(person => !person.mergedIntoId), rows: PhotoCoverageRow[] = []
    for (const person of people) {
      current(); const sources = [...new Set(person.urls.flatMap(url => { const value = publicProfileUrl(url); return value ? [({ linkedin: 'LinkedIn', x: 'X / Twitter', website: 'Website' } as Record<string, string>)[profilePlatform(value)] || 'Social profile'] : [] }))]
      if (person.sourceRefs.some(ref => /reader/.test(ref.provider)) || person.profileClipSourceId) sources.push('Reader capture')
      if (person.sourceRefs.some(ref => /google.*contacts/.test(ref.provider))) sources.push('Google Contacts')
      if (person.sourceRefs.some(ref => ref.provider === 'folk')) sources.push('Folk import')
      let status: PhotoCoverageRow['status'] = 'missing', reason = sources.includes('LinkedIn') ? 'Open the saved LinkedIn profile in Dia and choose Save contact photo in Reader.' : sources.length ? 'No verified photo has been saved from the attached sources. Capture their profile or upload a picture.' : 'Add a verified profile link or upload this person’s picture.'
      if (person.avatarAssetId) {
        const meta = this.options.db.getAssetMeta(person.avatarAssetId), bytes = await this.original(person.avatarAssetId, 'crm-avatar-', 12 * 1024 * 1024); current()
        if (!meta || !bytes) { status = 'missing-original'; reason = 'The contact references a photo whose original file or metadata is unavailable.' }
        else if (meta.kind !== 'image' || meta.bytes !== bytes.length || !imageTypes.has(meta.mime) || sniffImageMime(bytes.subarray(0, 4096)) !== meta.mime || digest(bytes) !== person.avatarAssetId.slice('crm-avatar-'.length)) { status = 'damaged'; reason = 'The saved original does not match its image metadata or content hash.' }
        else { status = 'available'; reason = 'The original image is saved locally and its content hash is verified.' }
      }
      rows.push({ personId: person.id, name: personName(person), status, sources: [...new Set(sources)], reason })
    }
    current(); const available = rows.filter(row => row.status === 'available').length, filtered = query.status ? rows.filter(row => query.status === 'needs-attention' ? row.status !== 'available' : row.status === query.status) : rows
    return { total: rows.length, available, missing: rows.length - available, needsAttention: rows.length - available, damaged: rows.filter(row => row.status === 'damaged').length, missingOriginal: rows.filter(row => row.status === 'missing-original').length, offset, rows: filtered.slice(offset, offset + limit), filteredTotal: filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null, checkedAt: this.options.now?.() ?? Date.now() }
  }
  /** Called only after an authenticated, explicit Reader photo action retained its source. */
  async saveCapturedProfile(input: CapturedPhotoRequest): Promise<SavedContactPhoto> {
    const worldCurrent = this.guard(), current = () => { worldCurrent(); input.current() }; current()
    const corpus = this.options.db.getKv<KnowledgeSnapshot>('knowledge.v1'), source = corpus?.sources.find(row => row.id === input.sourceId), version = corpus?.versions.find(row => row.id === input.versionId)
    const unavailable = (message: string): SavedContactPhoto => ({ status: 'unavailable', message })
    if (!source || source.deleted || source.excluded || source.currentVersionId !== input.versionId || !version || version.sourceId !== source.id || version.originalPurged || version.metadata?.captureMethod !== 'browser-extension' || version.contentHash !== digest(version.text)) return unavailable('The captured profile is no longer current or available. Capture the visible profile again.')
    const bytes = await this.original(version.originalBlobId, 'knowledge-', 1024 * 1024); current()
    if (!bytes || !this.options.db.getAssetMeta(version.originalBlobId) || digest(bytes) !== version.originalBlobId.slice('knowledge-'.length)) return unavailable('The profile text was retained, but its original could not be verified. Capture this profile again.')
    let original: unknown; try { original = JSON.parse(new TextDecoder().decode(bytes)) } catch { return unavailable('The retained profile original is not a Reader capture.') }
    if (!object(original) || original.format !== 'worldview-article-capture.v1' || original.text !== version.text) return unavailable('The retained profile original does not match its saved text.')
    const sourceUrl = publicProfileUrl(original.url), metadataUrl = publicProfileUrl(version.metadata.url)
    if (!sourceUrl || !metadataUrl || profileLinkIdentity(sourceUrl) !== profileLinkIdentity(metadataUrl)) return unavailable('The retained profile URL could not be verified.')
    const originalImages = Array.isArray(original.profileImages) ? original.profileImages.filter(object) : [], images = Array.isArray(version.metadata.profileImages) ? version.metadata.profileImages.filter(object) : []
    const verifiedImages = images.filter(image => image.isProfile === true && typeof image.subjectName === 'string' && nameKey(image.subjectName) && publicProfileUrl(image.url) && originalImages.some(retained => retained.isProfile === true && retained.subjectName === image.subjectName && retained.url === image.url))
    if (!verifiedImages.length) return unavailable('The profile was captured, but no verified person photo was visible. No contact photo was changed.')
    const active = this.options.store.rows('people', false).filter(person => !person.mergedIntoId), candidates = active.filter(person => person.urls.some(url => profileLinkIdentity(url) === profileLinkIdentity(sourceUrl)) && verifiedImages.some(image => nameKey(String(image.subjectName)) === nameKey(person.fullName || `${person.firstName} ${person.lastName}`)))
    if (candidates.length !== 1) return { status: 'unmatched', message: candidates.length ? 'The captured name and profile URL match several contacts. Choose the intended contact in People; no photo was changed.' : 'No existing contact matches both this profile URL and person name. Add or correct that contact in People first.' }
    const person = candidates[0], selected = verifiedImages.find(image => nameKey(String(image.subjectName)) === nameKey(person.fullName || `${person.firstName} ${person.lastName}`))!
    if (person.avatarAssetId) return await this.photoAvailable(person.avatarAssetId, current) ? { status: 'kept', personId: person.id, name: personName(person), avatarAssetId: person.avatarAssetId, message: 'The existing saved contact photo was kept. Use the contact editor to replace it.' } : { status: 'unavailable', personId: person.id, name: personName(person), message: 'The existing contact photo original is missing or damaged. Restore or replace it in People; it was not overwritten.' }
    const media = new CrmProfileMedia({ ...this.options, authorize: current }); current()
    try {
      const saved = await media.populatePerson(person.id, { requestId: input.requestId, expectedRecordRevision: person.revision, photoUrl: selected.url, sourceUrl, replacePhoto: false }); current()
      if (!saved.downloaded || !saved.record.avatarAssetId) return unavailable('The profile was captured, but no photo original was saved. Choose the image in People to retry.')
      return { status: 'saved', personId: person.id, name: personName(person), avatarAssetId: saved.record.avatarAssetId, message: 'The contact photo and its original image are saved locally.' }
    } catch (error) {
      current()
      if (error instanceof CrmError && (error.status === 404 || error.status === 422 && !/HTTP 5\d\d/.test(error.message) || error.status === 400 && /private|unsupported|public HTTP/.test(error.message))) return { status: 'unavailable', personId: person.id, name: personName(person), message: `The profile was captured, but its photo is unavailable: ${error.message}` }
      throw error
    }
  }
  /** Paired browser intent only. Folk contact rows never become general knowledge sources. */
  async saveFolkPhotos(input: FolkPhotoInput & { requestId: string; current: () => void }): Promise<SavedFolkPhotos> {
    const worldCurrent = this.guard(), current = () => { worldCurrent(); input.current() }; current()
    const sourceUrl = publicProfileUrl(input.url), parsed = sourceUrl ? new URL(sourceUrl) : null, match = parsed?.pathname.match(/^\/apps\/contacts\/network\/([a-f0-9-]{36})\/groups\/([a-f0-9-]{36})(?:\/|$)/i)
    const search = parsed?.pathname.match(/^\/apps\/contacts\/network\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/search$/i)
    if (input.saveFolkSearchPhotos !== undefined && typeof input.saveFolkSearchPhotos !== 'boolean') throw new CrmError('Choose an explicit matched Search photo action.')
    if (parsed?.hostname === 'app.folk.app' && parsed.protocol === 'https:' && search) {
      if (input.saveFolkSearchPhotos === true) {
        if (!Array.isArray(input.folkPhotos) || input.folkPhotos.length || !Array.isArray(input.folkPhotoRows) || input.folkPhotoRows.length > 50) throw new CrmError('Matched Search photos require an empty folkPhotos list and up to 50 retained visible rows; the server identifies people.')
        return new CrmFolkSearchPhotos(this.options).save({ url: sourceUrl!, networkId: search[1].toLowerCase(), title: typeof input.title === 'string' ? input.title.slice(0, 300) : 'Matched Folk Search photos', rows: normalizedFolkRows(input.folkPhotoRows, true), requestId: input.requestId, current })
      }
      return this.saveFolkSearchDiagnostics(input, sourceUrl!, search[1].toLowerCase(), current)
    }
    if (input.saveFolkSearchPhotos === true) throw new CrmError('Matched Search photos require the exact Folk Search route.')
    if (!parsed || parsed.hostname !== 'app.folk.app' || !match || parsed.protocol !== 'https:') throw new CrmError('Choose an imported Folk group in its normal browser page.')
    const groupId = `grp_${match[2].toLowerCase()}`, group = this.options.store.get('groups', groupId), groupSource = group?.sourceRefs.find(ref => ref.provider === 'folk' && ref.externalId.toLowerCase() === groupId)
    if (!group || group.archivedAt !== null || !groupSource) throw new CrmError('This Folk group is not present in the imported local workspace.', 404)
    if (!Array.isArray(input.folkPhotos) || input.folkPhotos.length > 50 || input.folkPhotoRows !== undefined && (!Array.isArray(input.folkPhotoRows) || input.folkPhotoRows.length > 50)) throw new CrmError('Import up to 50 visible Folk photos at a time.')
    assertUniqueFolkPhotoPeople(input.folkPhotos)
    const bounded = (value: unknown, max = 500) => typeof value === 'string' ? value.slice(0, max) : ''
    const photos = input.folkPhotos.filter(object).map(row => ({ personId: bounded(row.personId, 100), name: bounded(row.name), photoUrl: bounded(row.photoUrl, 8192), groupId: bounded(row.groupId, 100), sourceUrl: bounded(row.sourceUrl, 8192) }))
    const rows = normalizedFolkRows(input.folkPhotoRows)
    const original = Buffer.from(JSON.stringify({ format: 'worldview-folk-photo-capture.v1', url: sourceUrl, title: bounded(input.title, 300), groupId, folkPhotos: photos, folkPhotoRows: rows })), fingerprint = digest(original), stateKey = `reader-folk-photos:${digest(input.requestId)}`, prior = this.options.db.db.prepare('SELECT body FROM crm_state WHERE key=?').get(stateKey) as { body: string } | undefined
    if (original.length > 1024 * 1024) throw new CrmError('The visible Folk photo batch exceeds 1 MiB.', 413)
    let receipt: FolkReceipt
    if (prior) { receipt = JSON.parse(prior.body) as FolkReceipt; if (receipt.fingerprint !== fingerprint) throw new CrmError('This Folk photo request identity was already used for different data.', 409); if (receipt.result) return receipt.result }
    else {
      const id = `crm-file-${fingerprint}`; await mkdir(this.options.blobDir, { recursive: true }); current()
      try { await writeFile(join(this.options.blobDir, id), original, { flag: 'wx', mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const retained = await this.original(id, 'crm-file-', 1024 * 1024); current(); if (!retained || digest(retained) !== fingerprint) throw new CrmError('The retained Folk photo original is damaged.', 409) }
      current(); this.options.db.putAssetMeta({ id, kind: 'file', mime: 'application/json', bytes: original.length, createdAt: this.options.now?.() ?? Date.now(), nodeId: null })
      const members = new Set(this.options.store.rows('memberships', false).filter(row => row.groupId === group.id && row.entityType === 'person').map(row => row.entityId))
      const targets = photos.map(row => {
        const person = this.options.store.get('people', row.personId), photoUrl = publicProfileUrl(row.photoUrl), rowSource = publicProfileUrl(row.sourceUrl), expectedSource = `https://app.folk.app/apps/contacts/network/${match[1]}/groups/${match[2]}/people/${row.personId.replace(/^per_/, '')}`
        const validGroup = row.groupId.toLowerCase().replace(/^grp_/, '') === match[2].toLowerCase() && rowSource?.replace(/\/$/, '').toLowerCase() === expectedSource.toLowerCase()
        const validPerson = person && person.archivedAt === null && !person.mergedIntoId && /^per_[a-f0-9-]{36}$/i.test(row.personId) && person.sourceRefs.some(ref => ref.provider === 'folk' && ref.externalId === row.personId && ref.accountId === groupSource.accountId) && members.has(person.id) && !!row.name && nameKey(row.name) === nameKey(person.fullName || `${person.firstName} ${person.lastName}`)
        return { personId: validGroup && validPerson ? person.id : '', name: validPerson ? personName(person) : row.name, revision: validPerson ? person.revision : 0, hadPhoto: !!person?.avatarAssetId, photoUrl: photoUrl || '', sourceUrl: rowSource || '' }
      })
      receipt = { fingerprint, originalAssetId: id, targets, results: [] }
    }
    const checkpoint = () => { current(); this.options.db.db.prepare('INSERT OR REPLACE INTO crm_state(key,body) VALUES(?,?)').run(stateKey, JSON.stringify(receipt)) }; checkpoint()
    const importId = `reader-folk-photos-${digest(input.requestId).slice(0, 40)}`
    if (!this.options.store.get('imports', importId)) this.options.store.command({ requestId: `${input.requestId}:source`, operation: 'create', collection: 'imports', record: { id: importId, provider: 'folk-reader-photos', accountId: groupSource.accountId, name: `Visible Folk photos: ${group.name}`, status: 'partial', originalAssetIds: [receipt.originalAssetId], counts: { visibleRows: rows.length, verifiedRows: photos.length }, errors: [] } }, 'browser-reader')
    for (let index = receipt.results.length; index < receipt.targets.length; index++) {
      current(); const target = receipt.targets[index]; let result: SavedContactPhoto
      if (!target.personId) result = { status: 'unmatched', message: 'The visible row did not match an imported Folk person, source group and exact record identity.' }
      else if (!target.photoUrl) result = { status: 'unavailable', personId: target.personId, name: target.name, message: 'This visible image has no downloadable public photo URL.' }
      else if (target.hadPhoto) { const person = this.options.store.get('people', target.personId); result = person?.avatarAssetId && await this.photoAvailable(person.avatarAssetId, current) ? { status: 'kept', personId: target.personId, name: target.name, avatarAssetId: person.avatarAssetId, message: 'The existing contact photo was kept.' } : { status: 'unavailable', personId: target.personId, name: target.name, message: 'The existing contact photo original is missing or damaged; it was not overwritten.' } }
      else {
        const identityCurrent = () => { current(); const latestGroup = this.options.store.get('groups', group.id), latestPerson = this.options.store.get('people', target.personId); if (!latestGroup || latestGroup.archivedAt !== null || !latestGroup.sourceRefs.some(ref => ref.provider === 'folk' && ref.externalId.toLowerCase() === groupId && ref.accountId === groupSource.accountId) || !latestPerson || !latestPerson.sourceRefs.some(ref => ref.provider === 'folk' && ref.externalId === target.personId && ref.accountId === groupSource.accountId) || !this.options.store.rows('memberships', false).some(row => row.groupId === group.id && row.entityType === 'person' && row.entityId === target.personId)) throw new CrmError('The imported Folk person or group membership changed. Capture its current row again.', 409) }
        const media = new CrmProfileMedia({ ...this.options, authorize: identityCurrent, retainedPhoto: { personId: target.personId, url: target.photoUrl, sourceUrl: target.sourceUrl, originalAssetId: receipt.originalAssetId, label: 'Photo from an explicitly captured imported Folk contact row' } })
        try { const saved = await media.populatePerson(target.personId, { requestId: `${input.requestId}:${index}`, expectedRecordRevision: target.revision, photoUrl: target.photoUrl, sourceUrl: target.sourceUrl, replacePhoto: false }); current(); result = { status: saved.downloaded ? 'saved' : 'unavailable', personId: target.personId, name: target.name, ...(saved.record.avatarAssetId ? { avatarAssetId: saved.record.avatarAssetId } : {}), message: saved.downloaded ? 'The Folk contact photo and original are saved locally.' : 'No photo original was saved from this row.' } }
        catch (error) { current(); if (error instanceof CrmError && (error.status === 404 || error.status === 409 || error.status === 422 && !/HTTP 5\d\d/.test(error.message) || error.status === 400 && /private|unsupported|public HTTP/.test(error.message))) result = { status: 'unavailable', personId: target.personId, name: target.name, message: error.message }; else throw error }
      }
      receipt.results.push(result); checkpoint()
    }
    const count = (status: SavedContactPhoto['status']) => receipt.results.filter(result => result.status === status).length
    const folkPhotos: FolkPhotoBatch = { total: receipt.results.length, saved: count('saved'), kept: count('kept'), unmatched: count('unmatched'), unavailable: count('unavailable'), diagnostic: photos.length === 0, results: receipt.results, message: photos.length ? 'The explicitly selected visible Folk rows were checked. Other group members were not scanned.' : 'Visible image diagnostics were retained privately in CRM. No verified person IDs were found, so no contact photos were changed.' }
    current(); const imported = this.options.store.get('imports', importId)!
    this.options.store.command({ requestId: `${input.requestId}:complete`, operation: 'update', collection: 'imports', id: importId, expectedRecordRevision: imported.revision, patch: { status: folkPhotos.diagnostic || folkPhotos.unmatched || folkPhotos.unavailable ? 'partial' : 'complete', counts: { visibleRows: rows.length, verifiedRows: photos.length, saved: folkPhotos.saved, kept: folkPhotos.kept, unmatched: folkPhotos.unmatched, unavailable: folkPhotos.unavailable }, errors: folkPhotos.diagnostic ? [folkPhotos.message] : [] } }, 'browser-reader')
    receipt.result = { originalAssetId: receipt.originalAssetId, folkPhotos }; checkpoint(); return receipt.result
  }
  /** Search has no proven imported account/person binding. Retain diagnostics only. */
  private async saveFolkSearchDiagnostics(input: FolkPhotoInput & { requestId: string }, url: string, networkId: string, current: () => void): Promise<SavedFolkPhotos> {
    current()
    if (!Array.isArray(input.folkPhotos) || input.folkPhotos.length !== 0) throw new CrmError('Folk Search is diagnostic only. Send an empty folkPhotos list; no contact photos can be changed here.')
    if (!Array.isArray(input.folkPhotoRows) || input.folkPhotoRows.length > 50) throw new CrmError('Retain up to 50 visible Folk Search diagnostic rows at a time.')
    const rows = normalizedFolkRows(input.folkPhotoRows, true), title = typeof input.title === 'string' ? input.title.slice(0, 300) : 'Folk Search diagnostics'
    const original = Buffer.from(JSON.stringify({ format: 'worldview-folk-photo-capture.v1', scope: 'network-search-diagnostic', url, title, networkId, folkPhotos: [], folkPhotoRows: rows })), fingerprint = digest(original), stateKey = `reader-folk-search:${digest(input.requestId)}`
    if (original.length > 1024 * 1024) throw new CrmError('The visible Folk Search diagnostic batch exceeds 1 MiB.', 413)
    const prior = this.options.db.db.prepare('SELECT body FROM crm_state WHERE key=?').get(stateKey) as { body: string } | undefined
    if (prior) { const receipt = JSON.parse(prior.body) as { fingerprint: string; result: SavedFolkPhotos }; if (receipt.fingerprint !== fingerprint) throw new CrmError('This Folk Search request identity was already used for different data.', 409); return receipt.result }
    const id = `crm-file-${fingerprint}`; await mkdir(this.options.blobDir, { recursive: true }); current()
    try { await writeFile(join(this.options.blobDir, id), original, { flag: 'wx', mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const retained = await this.original(id, 'crm-file-', 1024 * 1024); current(); if (!retained || digest(retained) !== fingerprint) throw new CrmError('The retained Folk Search diagnostic original is damaged.', 409) }
    current(); this.options.db.putAssetMeta({ id, kind: 'file', mime: 'application/json', bytes: original.length, createdAt: this.options.now?.() ?? Date.now(), nodeId: null })
    const message = 'Visible Folk Search diagnostics were retained privately in CRM. Search-to-contact identity has not been verified; no people, companies or photos were changed.'
    const result: SavedFolkPhotos = { originalAssetId: id, folkPhotos: { total: 0, saved: 0, kept: 0, unmatched: 0, unavailable: 0, diagnostic: true, results: [], message } }
    current(); this.options.store.command({ requestId: `${input.requestId}:search-diagnostic`, operation: 'create', collection: 'imports', record: { id: `reader-folk-search-${digest(input.requestId).slice(0, 40)}`, provider: 'folk-reader-search-diagnostic', accountId: `folk-search-diagnostic-${digest(networkId).slice(0, 24)}`, name: 'Visible Folk Search diagnostics', status: 'partial', originalAssetIds: [id], counts: { visibleRows: rows.length, verifiedRows: 0, saved: 0 }, errors: [message] } }, 'browser-reader')
    current(); this.options.db.db.prepare('INSERT INTO crm_state(key,body) VALUES(?,?)').run(stateKey, JSON.stringify({ fingerprint, result })); return result
  }
}
