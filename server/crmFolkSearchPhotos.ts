import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sniffImageMime } from '../src/data/attachments.ts'
import type { CrmPerson } from '../src/crm/types.ts'
import { CrmError } from './crmStore.ts'
import { CrmProfileMedia, publicProfileUrl, type ProfileMediaOptions } from './crmProfileMedia.ts'
import type { SavedContactPhoto, SavedFolkPhotos } from './crmPhotoCoverage.ts'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown) => typeof value === 'string' ? value : ''
const emailKey = (value: unknown) => { const email = string(value).trim().toLowerCase(); return email.length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '' }
const nameKey = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const displayName = (person: CrmPerson) => person.fullName || [person.firstName, person.lastName].filter(Boolean).join(' ') || person.emails[0] || ''
const displayKey = (value: string) => emailKey(value) ? `email:${emailKey(value)}` : `name:${nameKey(value)}`
const groupPage = (value: unknown) => { const url = publicProfileUrl(value); if (!url) return null; const parsed = new URL(url), match = parsed.pathname.match(/^\/apps\/contacts\/network\/([a-f0-9-]{36})\/groups\/([a-f0-9-]{36})(?:\/|$)/i); return parsed.protocol === 'https:' && parsed.hostname === 'app.folk.app' && match ? { networkId: match[1].toLowerCase(), groupId: `grp_${match[2].toLowerCase()}` } : null }
interface Proof { receiptKey: string; groupId: string; personId: string; importId: string; originalAssetId: string }
interface Binding { networkId: string; accountId: string; proofSignature: string; proofs: Proof[] }
interface Target { personId: string; name: string; revision: number; hadPhoto: boolean; photoUrl: string; emails: string[]; rowIndex: number; error?: string; status?: 'unmatched' | 'unavailable' }
interface Receipt { fingerprint: string; originalAssetId: string; binding: Binding; targets: Target[]; results: SavedContactPhoto[]; result?: SavedFolkPhotos }

/** Explicit Search photo intent only; all identity evidence stays in private CRM originals. */
export class CrmFolkSearchPhotos {
  private readonly options: ProfileMediaOptions
  constructor(options: ProfileMediaOptions) { this.options = options }
  private async original(id: string) {
    if (!/^crm-file-[a-f0-9]{64}$/.test(id)) return null
    const file = await open(join(this.options.blobDir, id), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
    if (!file) return null
    try { const info = await file.stat(); if (!info.isFile() || info.size < 1 || info.size > 1024 * 1024) return null; const bytes = new Uint8Array(await file.readFile()), meta = this.options.db.getAssetMeta(id); return meta?.kind === 'file' && meta.mime === 'application/json' && meta.bytes === bytes.length && hash(bytes) === id.slice(9) ? bytes : null } finally { await file.close() }
  }
  private groupReceipts(networkId: string) {
    return (this.options.db.db.prepare("SELECT key,body FROM crm_state WHERE key LIKE 'reader-folk-photos:%'").all() as { key: string; body: string }[]).flatMap(row => {
      let value: unknown; try { value = JSON.parse(row.body) } catch { return [] }
      if (!object(value) || !object(value.result) || !Array.isArray(value.targets) || !Array.isArray(value.results) || !value.targets.some(target => object(target) && groupPage(target.sourceUrl)?.networkId === networkId)) return []
      return [{ key: row.key, value }]
    })
  }
  private proofSignature(networkId: string) { return hash(JSON.stringify(this.groupReceipts(networkId).map(row => [row.key, row.value.fingerprint]).sort())) }
  private proofValid(proof: Proof, accountId: string) {
    if (!accountId.trim()) return false
    const group = this.options.store.get('groups', proof.groupId), person = this.options.store.get('people', proof.personId), imported = this.options.store.get('imports', proof.importId)
    const accounts = new Set(group?.sourceRefs.filter(ref => ref.provider === 'folk' && ref.externalId === proof.groupId).map(ref => ref.accountId))
    return group?.archivedAt === null && accounts.size === 1 && accounts.has(accountId) && person?.archivedAt === null && !person.mergedIntoId && person.sourceRefs.some(ref => ref.provider === 'folk' && ref.accountId === accountId && ref.externalId === person.id) && imported?.archivedAt === null && imported.provider === 'folk-reader-photos' && imported.status === 'complete' && imported.accountId === accountId && imported.originalAssetIds.includes(proof.originalAssetId) && !!this.options.db.db.prepare("SELECT 1 FROM crm_rows WHERE collection='memberships' AND archived=0 AND group_id=? AND entity_id=? AND json_extract(body,'$.entityType')='person' LIMIT 1").get(proof.groupId, proof.personId)
  }
  private async binding(networkId: string, current: () => void): Promise<Binding> {
    const proofs: (Proof & { accountId: string })[] = [], imports = this.options.store.rows('imports', false).filter(row => row.provider === 'folk-reader-photos' && row.status === 'complete')
    for (const receipt of this.groupReceipts(networkId)) {
      const id = string(receipt.value.originalAssetId), candidates = imports.filter(row => row.originalAssetIds.includes(id)); if (!candidates.length || (receipt.value.result as Record<string, unknown>).originalAssetId !== id) continue
      const bytes = await this.original(id); current(); if (!bytes) continue
      let raw: unknown; try { raw = JSON.parse(new TextDecoder().decode(bytes)) } catch { continue }
      if (!object(raw) || raw.format !== 'worldview-folk-photo-capture.v1' || raw.scope || receipt.value.fingerprint !== hash(bytes) || groupPage(raw.url)?.networkId !== networkId || raw.groupId !== groupPage(raw.url)?.groupId || !Array.isArray(raw.folkPhotos)) continue
      for (let index = 0; index < (receipt.value.results as unknown[]).length; index++) {
        const result = (receipt.value.results as unknown[])[index], target = (receipt.value.targets as unknown[])[index]
        if (!object(result) || !['saved', 'kept'].includes(string(result.status)) || !object(target) || result.personId !== target.personId || !raw.folkPhotos.some(row => object(row) && row.personId === target.personId && row.photoUrl === target.photoUrl && row.sourceUrl === target.sourceUrl)) continue
        for (const imported of candidates) {
          const proof = { receiptKey: receipt.key, groupId: string(raw.groupId), personId: string(target.personId), importId: imported.id, originalAssetId: id, accountId: imported.accountId }
          if (this.proofValid(proof, imported.accountId)) proofs.push(proof)
        }
      }
    }
    const accounts = new Set(proofs.map(proof => proof.accountId)); if (accounts.size !== 1) throw new CrmError(accounts.size ? 'This Folk network has conflicting verified source accounts. Resolve that account ambiguity before matching Search photos.' : 'This Folk network has no completed verified group capture to prove its source account. Capture a known imported group first.', 409)
    return { networkId, accountId: [...accounts][0], proofSignature: this.proofSignature(networkId), proofs: [...new Map(proofs.map(proof => [`${proof.receiptKey}:${proof.importId}`, proof])).values()].slice(0, 16).map(({ accountId: _accountId, ...proof }) => proof) }
  }
  private bindingCurrent(binding: Binding) {
    if (this.proofSignature(binding.networkId) !== binding.proofSignature || !binding.proofs.some(proof => this.proofValid(proof, binding.accountId))) throw new CrmError('The verified Folk network/account evidence changed. Capture the visible rows again.', 409)
  }
  private match(row: Record<string, unknown>, rowIndex: number, accountId: string, sourceUrl: string): Target {
    const name = string(row.name), photoUrl = publicProfileUrl(row.photoUrl) || '', emails = [...new Set((Array.isArray(row.visibleEmails) ? row.visibleEmails : []).map(emailKey).filter(Boolean))], base = { personId: '', name, revision: 0, hadPhoto: false, photoUrl, emails, rowIndex }
    const state = object(row.imageState) ? row.imageState : {}, requested = Array.isArray(state.requestedSources) ? state.requestedSources.map(value => publicProfileUrl(value)).filter(Boolean) : []
    if (row.isPrimaryAvatar !== true || !['li', 'option', 'row', 'tr'].includes(string(row.rowRole)) || !nameKey(name) || displayKey(string(row.avatarLabel)) !== displayKey(name) || publicProfileUrl(row.sourceUrl) !== sourceUrl || state.complete !== true || !Number.isFinite(state.naturalWidth) || !Number.isFinite(state.naturalHeight) || Number(state.naturalWidth) < 24 || Number(state.naturalHeight) < 24 || !photoUrl || publicProfileUrl(state.currentSrc) !== photoUrl || !requested.includes(photoUrl) || /(?:company[-_/ ]?logo|logo[_/-])/i.test(photoUrl)) return { ...base, status: 'unavailable', error: 'This row does not prove a primary loaded person avatar with a matching visible label. Company logos and incomplete images are excluded.' }
    if (!emails.length) return { ...base, status: 'unmatched', error: 'No complete visible email is available for an exact imported-contact match.' }
    const active = this.options.store.rows('people', false).filter(person => !person.mergedIntoId && person.sourceRefs.some(ref => ref.provider === 'folk' && ref.accountId === accountId && ref.externalId === person.id)), matches = emails.map(email => active.filter(person => person.emails.some(value => emailKey(value) === email)))
    if (matches.some(people => people.length > 1)) return { ...base, status: 'unmatched', error: 'This visible email is shared by several imported people in the verified Folk account.' }
    const people = [...new Map(matches.flat().map(person => [person.id, person])).values()]
    if (people.length !== 1 || displayKey(displayName(people[0])) !== displayKey(name)) return { ...base, status: 'unmatched', error: 'The visible email and display name do not identify exactly one active imported person in this verified account.' }
    const person = people[0]; return { ...base, personId: person.id, name: displayName(person), revision: person.revision, hadPhoto: !!person.avatarAssetId }
  }
  async save(input: { url: string; networkId: string; title: string; rows: Record<string, unknown>[]; requestId: string; current: () => void }): Promise<SavedFolkPhotos> {
    const current = input.current; current()
    const modes = [...new URL(input.url).searchParams.entries()].filter(([key]) => key.toLowerCase() === 'type')
    if (modes.length && (modes.length !== 1 || modes[0][0] !== 'type' || modes[0][1] !== 'person')) throw new CrmError('Matched Search photos require the People view: use no type filter or one exact type=person. Company, unknown and ambiguous views cannot change contact photos.', 400)
    const stateKey = `reader-folk-search-photos:${hash(input.requestId)}`, requestHash = hash(JSON.stringify({ url: input.url, title: input.title, rows: input.rows })), prior = this.options.db.db.prepare('SELECT body FROM crm_state WHERE key=?').get(stateKey) as { body: string } | undefined
    let receipt: Receipt
    if (prior) {
      receipt = JSON.parse(prior.body) as Receipt; if (receipt.fingerprint !== requestHash) throw new CrmError('This matched Search photo identity was already used for different rows.', 409); if (receipt.result) return receipt.result; this.bindingCurrent(receipt.binding)
      const retained = await this.original(receipt.originalAssetId); current(); if (!retained) throw new CrmError('The private Search original is missing or damaged. Capture the visible rows again.', 409)
      let raw: unknown; try { raw = JSON.parse(new TextDecoder().decode(retained)) } catch { throw new CrmError('The private Search original is invalid.', 409) }
      if (!object(raw) || raw.format !== 'worldview-folk-search-photo-capture.v1' || hash(JSON.stringify({ url: raw.url, title: raw.title, rows: raw.folkPhotoRows })) !== requestHash) throw new CrmError('The retained Search evidence does not match this exact request.', 409)
    }
    else {
      const binding = await this.binding(input.networkId, current); current(); const targets = input.rows.map((row, index) => this.match(row, index, binding.accountId, input.url)), ids = targets.filter(row => row.personId).map(row => row.personId)
      if (new Set(ids).size !== ids.length) throw new CrmError('These visible Search rows contain an ambiguous duplicate matched person. Capture each person once.', 400)
      const bytes = Buffer.from(JSON.stringify({ format: 'worldview-folk-search-photo-capture.v1', url: input.url, title: input.title, networkId: input.networkId, folkPhotos: [], folkPhotoRows: input.rows, accountBinding: binding, matches: targets })), id = `crm-file-${hash(bytes)}`
      if (bytes.length > 1024 * 1024) throw new CrmError('The matched Search capture exceeds 1 MiB.', 413)
      await mkdir(this.options.blobDir, { recursive: true }); current(); try { await writeFile(join(this.options.blobDir, id), bytes, { flag: 'wx', mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const retained = await this.original(id); current(); if (!retained || hash(retained) !== hash(bytes)) throw new CrmError('The retained Search photo original is damaged.', 409) }
      current(); this.options.db.putAssetMeta({ id, kind: 'file', mime: 'application/json', bytes: bytes.length, createdAt: this.options.now?.() ?? Date.now(), nodeId: null }); receipt = { fingerprint: requestHash, originalAssetId: id, binding, targets, results: [] }
    }
    const checkpoint = () => { current(); this.options.db.db.prepare('INSERT OR REPLACE INTO crm_state(key,body) VALUES(?,?)').run(stateKey, JSON.stringify(receipt)) }; checkpoint()
    const importId = `reader-folk-search-photos-${hash(input.requestId).slice(0, 40)}`
    if (!this.options.store.get('imports', importId)) this.options.store.command({ requestId: `${input.requestId}:search-source`, operation: 'create', collection: 'imports', record: { id: importId, provider: 'folk-reader-search-photos', accountId: receipt.binding.accountId, name: 'Explicit matched Folk Search photos', status: 'partial', originalAssetIds: [receipt.originalAssetId], counts: { visibleRows: input.rows.length }, errors: [] } }, 'browser-reader')
    for (let index = receipt.results.length; index < receipt.targets.length; index++) {
      current(); this.bindingCurrent(receipt.binding); const target = receipt.targets[index], row = input.rows[target.rowIndex]; let result: SavedContactPhoto
      if (!target.personId) result = { status: target.status || 'unmatched', message: target.error || 'No unique imported contact was verified.' }
      else {
        const identityCurrent = () => { current(); this.bindingCurrent(receipt.binding); const match = this.match(row, target.rowIndex, receipt.binding.accountId, input.url); if (match.personId !== target.personId) throw new CrmError('The visible Search email/name no longer identifies the captured contact.', 409) }
        try {
          identityCurrent()
          if (target.hadPhoto) {
            const person = this.options.store.get('people', target.personId); if (!person || person.revision !== target.revision) throw new CrmError('This contact changed after the visible Search match.', 409)
            const id = person.avatarAssetId || '', file = /^crm-avatar-[a-f0-9]{64}$/.test(id) ? await open(join(this.options.blobDir, id), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null) : null; let valid = false
            if (file) try { const info = await file.stat(); if (info.isFile() && info.size <= 12 * 1024 * 1024) { const bytes = new Uint8Array(await file.readFile()), meta = this.options.db.getAssetMeta(id); valid = meta?.kind === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(meta.mime) && meta.bytes === bytes.length && sniffImageMime(bytes.subarray(0, 4096)) === meta.mime && hash(bytes) === id.slice(11) } } finally { await file.close() }
            identityCurrent(); if (this.options.store.get('people', target.personId)?.revision !== target.revision) throw new CrmError('This contact changed while checking its existing photo.', 409)
            result = valid ? { status: 'kept', personId: target.personId, name: target.name, avatarAssetId: id, message: 'The existing original photo was verified and kept.' } : { status: 'unavailable', personId: target.personId, name: target.name, message: 'The existing photo original is missing or damaged; it was not overwritten.' }
          } else {
            const media = new CrmProfileMedia({ ...this.options, authorize: identityCurrent, retainedPhoto: { personId: target.personId, url: target.photoUrl, sourceUrl: input.url, originalAssetId: receipt.originalAssetId, label: 'Primary Folk Search avatar matched by verified account, exact visible email and display name', photoOnly: true } })
            const saved = await media.populatePerson(target.personId, { requestId: `${input.requestId}:search:${index}`, expectedRecordRevision: target.revision, photoUrl: target.photoUrl, sourceUrl: input.url, replacePhoto: false }); identityCurrent()
            const latest = this.options.store.get('people', target.personId)
            result = saved.downloaded && saved.record.avatarAssetId && latest?.revision === saved.record.revision && latest.avatarAssetId === saved.record.avatarAssetId ? { status: 'saved', personId: target.personId, name: target.name, avatarAssetId: saved.record.avatarAssetId, message: 'The exactly matched Search photo and private evidence are saved locally.' } : { status: 'unavailable', personId: target.personId, name: target.name, message: saved.notices.at(-1) || 'No accepted photo original was saved from this matched row.' }
          }
        } catch (error) { current(); if (error instanceof CrmError && (error.status === 404 || error.status === 409 || error.status === 422 && !/HTTP 5\d\d/.test(error.message) || error.status === 400 && /private|unsupported|public HTTP/.test(error.message))) result = { status: 'unavailable', personId: target.personId, name: target.name, message: error.message }; else throw error }
      }
      receipt.results.push(result); checkpoint()
    }
    const count = (status: SavedContactPhoto['status']) => receipt.results.filter(row => row.status === status).length
    const result: SavedFolkPhotos = { originalAssetId: receipt.originalAssetId, folkPhotos: { total: receipt.results.length, saved: count('saved'), kept: count('kept'), unmatched: count('unmatched'), unavailable: count('unavailable'), diagnostic: false, results: receipt.results, message: 'Only exactly matched visible primary avatars were checked. No contacts were created or existing pictures replaced.' } }
    const imported = this.options.store.get('imports', importId)!; current(); this.options.store.command({ requestId: `${input.requestId}:search-complete`, operation: 'update', collection: 'imports', id: importId, expectedRecordRevision: imported.revision, patch: { status: result.folkPhotos.unmatched || result.folkPhotos.unavailable ? 'partial' : 'complete', counts: { visibleRows: input.rows.length, saved: result.folkPhotos.saved, kept: result.folkPhotos.kept, unmatched: result.folkPhotos.unmatched, unavailable: result.folkPhotos.unavailable } } }, 'browser-reader')
    receipt.result = result; checkpoint(); return result
  }
}
