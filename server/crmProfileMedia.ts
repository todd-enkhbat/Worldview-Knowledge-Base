import { rasterCompanyIcon } from './companyIcon.ts'
import { createHash, randomUUID } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { constants, linkSync, rmSync } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { sniffImageMime } from '../src/data/attachments.ts'
import type { CrmPerson, CrmSourceRef } from '../src/crm/types.ts'
import type { KnowledgeSnapshot, SourceVersion } from '../src/knowledge/types.ts'
import { isPrivateAddress, type Lookup } from './fetchUrl.ts'
import { profilePlatform, publicProfileUrl } from './crmProfileUrls.ts'
export { profilePlatform, publicProfileUrl } from './crmProfileUrls.ts'
import { CrmError, type SqliteCrmStore } from './crmStore.ts'
import type { WorldDb } from './worldDb.ts'

const MAX_PHOTO = 12 * 1024 * 1024, MAX_PAGE = 2 * 1024 * 1024
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const check = (condition: unknown, message: string, status = 400): void => { if (!condition) throw new CrmError(message, status) }
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const normalizedName = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const unique = <T>(values: T[], key: (value: T) => string): T[] => [...new Map(values.map(value => [key(value), value])).values()]
const BLOCKED_PLATFORM = /(^|\.)(linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|tiktok\.com)$/i
export interface ProfilePhotoCandidate { id: string; url: string; sourceUrl: string; label: string; kind: 'imported' | 'page' | 'captured'; automatic: boolean }
export interface ProfileLink { url: string; platform: string; label: string; sourceUrl: string }
export interface ProfileMediaInspection { personId: string; recordRevision: number; avatarAssetId: string | null; photoCandidates: ProfilePhotoCandidate[]; links: ProfileLink[]; notices: string[] }
export interface ProfileMediaResult { record: CrmPerson; downloaded: boolean; addedLinks: number; notices: string[] }
export interface ProfileBatchItem { personId: string; name: string; status: 'updated' | 'unavailable' | 'skipped' | 'error'; downloaded?: boolean; addedLinks?: number; notices?: string[]; error?: string; message: string }
export interface ProfileBatchResult { total: number; processed: number; offset: number; nextOffset: number | null; results: ProfileBatchItem[]; downloaded: number; addedLinks: number; updated: number; cloudAiUsed: false }
interface ProfileBatchReceipt { fingerprint: string; selected: { personId: string; revision: number; name: string }[]; results: ProfileBatchItem[]; total: number; nextOffset: number | null; result?: ProfileBatchResult }
export interface ProfileResource { url: string; bytes: Uint8Array; contentType: string }
export interface ProfileMediaOptions { db: WorldDb; store: SqliteCrmStore; blobDir: string; now?: () => number; fetch?: typeof fetch; lookup?: Lookup; authorize?: () => void; retainedPhoto?: { personId: string; url: string; sourceUrl: string; originalAssetId: string; label: string; photoOnly?: boolean } }
const systemLookup: Lookup = async host => (await dnsLookup(host, { all: true, verbatim: true })).map(value => value.address)

/** Comparison only: original user/import URL strings are never rewritten. */
export function profileLinkIdentity(raw: string): string {
  const supplied = publicProfileUrl(raw) || (/^[\w.-]+\.[a-z]{2,}(?:[/?#]|$)/i.test(raw.trim()) ? publicProfileUrl(`https://${raw.trim()}`) : null)
  if (!supplied) return `original:${raw}`
  const url = new URL(supplied), platform = profilePlatform(supplied)
  if (platform !== 'website') { url.protocol = 'https:'; url.hostname = url.hostname.replace(/^www\./, ''); if (platform === 'x') url.hostname = 'x.com'; if (['linkedin', 'x', 'github', 'instagram'].includes(platform)) url.pathname = url.pathname.toLowerCase() }
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|trk$|trackingId$)/i.test(key)) url.searchParams.delete(key)
  return url.href.replace(/\/$/, '')
}
/** Gravatar defaults must fail closed rather than turning silhouettes into real portraits. */
export function profilePhotoRequestUrl(raw: string): string {
  const supplied = publicProfileUrl(raw); check(supplied, 'Choose a public image URL.'); const url = new URL(supplied!)
  if (/(^|\.)gravatar\.com$/i.test(url.hostname) && /^\/avatar\/[a-f0-9]{32,64}\/?$/i.test(url.pathname)) { for (const key of ['d', 'default', 'f', 'forcedefault']) url.searchParams.delete(key); url.searchParams.set('d', '404') }
  return url.href
}
const blockedPlatform = (raw: string) => BLOCKED_PLATFORM.test(new URL(raw).hostname)
/** Known Folk demo-avatar filenames identify defaults rather than person photos. */
function folkSampleAvatar(raw: string): boolean {
  try { const url = new URL(raw); return url.hostname.toLowerCase() === 'documents.folk.app' && /(?:^|\/)sample-contact-avatar-[a-z0-9_-]+\.webp$/i.test(decodeURIComponent(url.pathname)) } catch { return false }
}

/** A real request pins the validated DNS answer to the socket, preventing DNS rebinding. */
async function pinnedRequest(url: URL, address: string, limit: number): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', headers: { accept: 'text/html,application/xhtml+xml,image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.2', 'user-agent': 'Worldview-Profile-Archive/1.0', 'accept-encoding': 'identity' },
      lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)), family: isIP(address), timeout: 12000,
    }, response => {
      const headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      const length = Number(headers.get('content-length')); if (Number.isFinite(length) && length > limit) { response.destroy(); reject(new CrmError('This profile resource is too large.', 413)); return }
      const chunks: Buffer[] = []; let size = 0
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) { response.destroy(new CrmError('This profile resource is too large.', 413)); return } chunks.push(chunk) })
      response.once('end', () => resolve({ status: response.statusCode ?? 502, headers, bytes: Buffer.concat(chunks) })); response.once('error', reject)
    }); const deadline = setTimeout(() => request.destroy(new CrmError('The profile download exceeded its time limit.', 504)), 12000); deadline.unref(); request.once('close', () => clearTimeout(deadline)); request.once('error', reject); request.once('timeout', () => request.destroy(new CrmError('The profile host did not respond in time.', 504))); request.end()
  })
}
async function boundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length')); check(!Number.isFinite(length) || length <= limit, 'This profile resource is too large.', 413)
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []; let size = 0
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw new CrmError('This profile resource is too large.', 413) } chunks.push(value) } } finally { reader.releaseLock() }
  const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length } return result
}
export async function fetchProfileResource(raw: string, options: { fetch?: typeof fetch; lookup?: Lookup; maxBytes?: number; current?: () => void } = {}): Promise<ProfileResource> {
  const initial = publicProfileUrl(raw); check(initial, 'Choose a public HTTP or HTTPS profile link.'); let url = new URL(initial!), bytes: Uint8Array, headers: Headers, status: number
  const lookup = options.lookup ?? systemLookup, maxBytes = options.maxBytes ?? MAX_PAGE
  for (let hop = 0; ; hop++) {
    options.current?.(); const host = url.hostname.replace(/^\[|\]$/g, ''), addresses = isIP(host) ? [host] : await lookup(host).catch(() => [])
    check(addresses.length && addresses.every(address => !isPrivateAddress(address)), 'That link points into a private or unavailable network.'); options.current?.()
    if (options.fetch) { const response = await options.fetch(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(12000), headers: { accept: 'text/html,image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.2' } }); status = response.status; headers = response.headers; if (status >= 300 && status < 400 && headers.get('location')) { await response.body?.cancel(); bytes = new Uint8Array() } else bytes = await boundedResponse(response, maxBytes) }
    else { const response = await pinnedRequest(url, addresses[0], maxBytes); ({ status, headers, bytes } = response) }
    options.current?.(); const location = status >= 300 && status < 400 ? headers.get('location') : null
    if (location) { check(hop < 4, 'This profile redirects too many times.'); const next = publicProfileUrl(location, url.href); check(next && !(url.protocol === 'https:' && new URL(next).protocol !== 'https:'), 'This profile redirects to an unsupported address.'); url = new URL(next!); continue }
    check(status >= 200 && status < 300, status === 401 || status === 403 || status === 999 ? 'This source requires sign-in or does not allow public profile access. Use an explicitly captured photo or upload its original.' : `The profile source answered HTTP ${status}.`, status === 404 ? 404 : 422)
    check(!headers.get('content-encoding') || headers.get('content-encoding') === 'identity' || !!options.fetch, 'This profile source returned an unsupported encoding.')
    return { url: url.href, bytes, contentType: headers.get('content-type') ?? '' }
  }
}

function decode(value: string) { return value.replace(/&(?:amp|quot|apos|lt|gt|#(\d+)|#x([a-f0-9]+));/gi, (all, decimal: string, hex: string) => { if (decimal || hex) { const point = decimal ? Number(decimal) : parseInt(hex, 16); return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : all } return ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' } as Record<string, string>)[all.toLowerCase()] ?? all }) }
function attrs(tag: string) { const result: Record<string, string> = {}; for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? ''); return result }
function photo(url: string, sourceUrl: string, label: string, kind: ProfilePhotoCandidate['kind'], automatic: boolean): ProfilePhotoCandidate { return { id: digest(`${url}\n${sourceUrl}`).slice(0, 24), url, sourceUrl, label: folkSampleAvatar(url) ? 'Folk sample avatar — excluded from automatic imports' : label, kind, automatic: automatic && !folkSampleAvatar(url) } }
function link(url: string, sourceUrl: string): ProfileLink { const platform = profilePlatform(url); return { url, platform, label: platform === 'website' ? new URL(url).hostname.replace(/^www\./, '') : platform === 'linkedin' ? 'LinkedIn' : platform === 'x' ? 'X' : platform[0].toUpperCase() + platform.slice(1), sourceUrl } }

/** Static metadata only: no script execution, tracking images, cookies or name-search guessing. */
export function extractProfilePage(html: string, sourceUrl: string, person: Pick<CrmPerson, 'fullName' | 'firstName' | 'lastName' | 'urls'>): { photos: ProfilePhotoCandidate[]; links: ProfileLink[] } {
  const photos: ProfilePhotoCandidate[] = [], links: ProfileLink[] = [], meta: Record<string, string> = {}, name = normalizedName(person.fullName || `${person.firstName} ${person.lastName}`)
  for (const match of html.matchAll(/<meta\b[^>]{0,16000}>/gi)) { const item = attrs(match[0]), key = item.property || item.name; if (key && item.content && !meta[key.toLowerCase()]) meta[key.toLowerCase()] = item.content }
  const namedHeading = !!name && [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].some(match => normalizedName(decode(match[1].replace(/<[^>]+>/g, ' '))) === name)
  const ogImage = publicProfileUrl(meta['og:image'] || meta['twitter:image'], sourceUrl)
  if (ogImage) photos.push(photo(ogImage, sourceUrl, 'Page preview image — confirm this is their photo', 'page', false))
  for (const match of html.matchAll(/<(?:a|link)\b[^>]{0,16000}>/gi)) { const item = attrs(match[0]), url = publicProfileUrl(item.href, sourceUrl); if (!url || !/(?:^|\s)me(?:\s|$)/i.test(item.rel ?? '')) continue; const path = new URL(url).pathname; if (!/(?:\/share|\/intent|\/sharer|\/login|\/signup|\/watch|\/status|\/posts)(?:\/|$)/i.test(path)) links.push(link(url, sourceUrl)) }
  if (namedHeading) for (const match of html.matchAll(/<img\b[^>]{0,16000}>/gi)) { const item = attrs(match[0]), url = publicProfileUrl(item.src || item['data-src'], sourceUrl); if (url && normalizedName(item.alt || '').replace(/^photo of /, '') === name) photos.push(photo(url, sourceUrl, 'Headshot explicitly labeled with this person’s name', 'page', true)) }
  for (const match of html.matchAll(/<script\b([^>]{0,4000})>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/application\/ld\+json/i.test(attrs(match[1]).type ?? '') || match[2].length > 256000) continue
    let json: unknown; try { json = JSON.parse(match[2]) } catch { continue }
    function visit(value: unknown, depth = 0) { if (depth > 12) return; if (Array.isArray(value)) { for (const item of value.slice(0, 200)) visit(item, depth + 1); return } if (!object(value)) return
      const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']], candidateName = normalizedName(string(value.name)), candidateUrl = publicProfileUrl(value.url, sourceUrl), sameSource = candidateUrl && candidateUrl.replace(/\/$/, '') === sourceUrl.replace(/\/$/, '')
      if (types.includes('Person') && (candidateName && name && candidateName === name || !candidateName && sameSource)) { for (const entry of Array.isArray(value.image) ? value.image : [value.image]) { const url = publicProfileUrl(object(entry) ? entry.url ?? entry.contentUrl : entry, sourceUrl); if (url) photos.push(photo(url, sourceUrl, 'Photo from this person’s public profile metadata', 'page', true)) } for (const entry of Array.isArray(value.sameAs) ? value.sameAs : [value.sameAs]) { const url = publicProfileUrl(entry, sourceUrl); if (url) links.push(link(url, sourceUrl)) } }
      if (Array.isArray(value['@graph'])) visit(value['@graph'], depth + 1); if (value.mainEntity) visit(value.mainEntity, depth + 1)
    } visit(json)
  }
  return { photos: unique(photos.sort((a, b) => Number(b.automatic) - Number(a.automatic)), item => item.url).slice(0, 20), links: unique(links, item => item.url).slice(0, 40) }
}

export class CrmProfileMedia {
  private readonly options: ProfileMediaOptions
  private readonly flights = new Map<string, Promise<ProfileMediaResult>>()
  private readonly batchFlights = new Map<string, Promise<ProfileBatchResult>>()
  constructor(options: ProfileMediaOptions) { this.options = options }
  private now() { return this.options.now?.() ?? Date.now() }
  private person(id: string) { const row = this.options.store.get('people', id); check(row && row.archivedAt === null && !row.mergedIntoId, 'Choose an active person before updating profile media.', 404); return row! }
  private guard(id?: string, revision?: number) { const generation = this.options.db.getReplacementGeneration(); return () => { this.options.authorize?.(); check(generation === this.options.db.getReplacementGeneration() && !this.options.db.getKv('importInProgress') && this.options.db.getSettings()?.firstRunComplete, 'The workspace changed. Refresh People before downloading profile media.', 409); if (id) check(this.person(id).revision === revision, 'This contact changed. Refresh their profile before saving media.', 409) } }
  private attachedVersions(person: CrmPerson): SourceVersion[] {
    const corpus = this.options.db.getKv<KnowledgeSnapshot>('knowledge.v1'), versions: SourceVersion[] = [], profileUrls = new Set(person.urls.map(profileLinkIdentity)), name = normalizedName(person.fullName || `${person.firstName} ${person.lastName}`)
    const readerMatches = (version: SourceVersion) => {
      const metadata = version.metadata ?? {}, url = publicProfileUrl(metadata.canonicalUrl) || publicProfileUrl(metadata.url)
      if (metadata.captureMethod !== 'browser-extension' || !url || !profileUrls.has(profileLinkIdentity(url)) || !name) return false
      const matchingSubject = (value: unknown) => object(value) && !!string(value.subjectName).trim() && normalizedName(string(value.subjectName)) === name
      const images = Array.isArray(metadata.profileImages) ? metadata.profileImages : [], links = Array.isArray(metadata.profileLinks) ? metadata.profileLinks : []
      return images.some(value => matchingSubject(value) && object(value) && value.isProfile === true && !!publicProfileUrl(value.url)) || links.some(value => matchingSubject(value) && object(value) && !!publicProfileUrl(value.url))
    }
    for (const source of corpus?.sources ?? []) {
      if (source.excluded || source.deleted) continue
      const version = corpus?.versions.find(row => row.id === source.currentVersionId)
      if (!version || version.sourceId !== source.id || version.originalPurged || version.contentHash !== digest(version.text) || !this.options.db.getAssetMeta(version.originalBlobId)) continue
      const explicit = person.profileClipSourceId === source.id || person.sourceRefs.some(ref => /reader|selected-source/.test(ref.provider) && (ref.externalId === source.id || ref.externalId.startsWith(`${source.id}:`)))
      if (explicit || readerMatches(version)) versions.push(version)
    }
    return versions
  }
  private localInspection(person: CrmPerson): ProfileMediaInspection {
    const photos: ProfilePhotoCandidate[] = [], urls = person.urls.map(value => publicProfileUrl(value)).filter((value): value is string => !!value), notices: string[] = []
    const retained = this.options.retainedPhoto
    if (retained?.personId === person.id && this.options.db.getAssetMeta(retained.originalAssetId)) photos.push(photo(retained.url, retained.sourceUrl, retained.label, 'imported', true))
    const targetName = normalizedName(person.fullName || `${person.firstName} ${person.lastName}`)
    const sameCapturedSubject = (value: Record<string, unknown>) => !string(value.subjectName).trim() || normalizedName(string(value.subjectName)) === targetName
    const addPhotos = (value: unknown, sourceUrl: string, kind: ProfilePhotoCandidate['kind'], depth = 0, automatic = kind === 'imported') => { if (depth > 6) return; if (typeof value === 'string') { const url = publicProfileUrl(value); if (url) photos.push(photo(url, sourceUrl || url, kind === 'captured' ? 'Photo from your explicitly captured profile' : 'Photo retained in imported contact metadata', kind, automatic)); return } if (Array.isArray(value)) { for (const item of value.slice(0, 20)) addPhotos(item, sourceUrl, kind, depth + 1, automatic); return } if (object(value) && value.default !== true && value.isDefault !== true && (kind !== 'captured' || sameCapturedSubject(value))) { const direct = publicProfileUrl(value.url ?? value.src ?? value.imageUrl ?? value.contentUrl); if (direct) addPhotos(direct, publicProfileUrl(value.sourceUrl) || sourceUrl, kind, depth + 1, value.isProfile === true || automatic); else for (const key of ['displayImage', 'displayImage~', 'elements', 'identifiers', 'identifier', 'image', 'photo', 'picture', 'avatar', 'profilePicture']) if (value[key]) addPhotos(value[key], sourceUrl, kind, depth + 1, automatic) } }
    const sourceUrl = person.sourceRefs.map(ref => publicProfileUrl(ref.url)).find(Boolean) || urls[0] || ''
    const addLinks = (value: unknown, depth = 0) => { if (depth > 4) return; if (Array.isArray(value)) { for (const item of value.slice(0, 100)) addLinks(item, depth + 1); return } const url = publicProfileUrl(object(value) ? value.url ?? value.href ?? value.value : value); if (url) urls.push(url) }
    for (const source of [person, person.raw, person.extra]) if (object(source)) {
      for (const key of ['photos', 'photo', 'photoUrl', 'avatarUrl', 'imageUrl', 'picture', 'pictureUrl', 'profilePhoto', 'profilePicture', 'profileImage', 'profileImageUrl', 'avatar']) if (source[key]) addPhotos(source[key], sourceUrl, 'imported')
      for (const key of ['urls', 'website', 'websites', 'personalWebsite', 'linkedin', 'linkedinUrl', 'twitter', 'twitterUrl', 'socialProfiles', 'socialMedia']) if (source[key]) addLinks(source[key])
    }
    for (const version of this.attachedVersions(person)) { const metadata = version.metadata ?? {}, url = publicProfileUrl(metadata.url ?? metadata.canonicalUrl) || sourceUrl; for (const key of ['profileImages', 'profilePhoto', 'photoUrl', 'profileImage']) if (metadata[key]) addPhotos(metadata[key], url, 'captured'); const profileLinks = Array.isArray(metadata.profileLinks) ? metadata.profileLinks : []; for (const value of profileLinks) { if (object(value) && !sameCapturedSubject(value)) continue; const found = publicProfileUrl(object(value) ? value.url : value); if (found) urls.push(found) } }
    for (const ref of person.sourceRefs) { const url = publicProfileUrl(ref.url); if (url) urls.push(url) }
    if (urls.some(blockedPlatform)) notices.push('LinkedIn and some social platforms restrict automated profile access. Existing imported or explicitly captured photo originals can still be saved; no browser cookies or sign-in bypass are used.')
    return { personId: person.id, recordRevision: person.revision, avatarAssetId: person.avatarAssetId, photoCandidates: unique(photos, item => item.url).slice(0, 30), links: unique(urls, value => value).map(url => link(url, url)), notices }
  }
  private async discover(person: CrmPerson, inspection: ProfileMediaInspection, current: () => void, sourceUrl?: string) {
    const sources = inspection.links.map(value => value.url).filter(value => !blockedPlatform(value) && profilePlatform(value) === 'website'), selected = sourceUrl ? sources.filter(value => profileLinkIdentity(value) === profileLinkIdentity(sourceUrl)) : sources.slice(0, 3)
    for (const url of selected) { try { current(); const resource = await fetchProfileResource(url, { ...this.options, maxBytes: MAX_PAGE, current }); check(/(?:text\/html|application\/xhtml)/i.test(resource.contentType), 'This attached profile is not an HTML page.'); const result = extractProfilePage(new TextDecoder().decode(resource.bytes), resource.url, person); inspection.photoCandidates.push(...result.photos.map(value => ({ ...value, sourceUrl: url }))); inspection.links.push(...result.links.map(value => ({ ...value, sourceUrl: url }))); current() } catch (error) { if (error instanceof CrmError && error.status === 409) throw error; inspection.notices.push(`${new URL(url).hostname}: ${error instanceof Error ? error.message : 'Public profile unavailable.'}`) } }
    inspection.photoCandidates = unique(inspection.photoCandidates.sort((a, b) => Number(b.automatic) - Number(a.automatic)), item => item.url).slice(0, 40); inspection.links = unique(inspection.links, item => item.url).slice(0, 100)
    return inspection
  }
  async inspect(id: string, discover = false, sourceUrl?: string): Promise<ProfileMediaInspection> { const person = this.person(id), current = this.guard(id, person.revision); current(); const inspection = this.localInspection(person); if (sourceUrl) check(inspection.links.some(value => profileLinkIdentity(value.url) === profileLinkIdentity(sourceUrl)), 'Add the source website to this contact before reading it.'); return discover ? this.discover(person, inspection, current, publicProfileUrl(sourceUrl) || undefined) : inspection }
  private async retainPhoto(bytes: Uint8Array, current: () => void) {
    const mime = sniffImageMime(bytes.subarray(0, 4096)); check(mime && ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(mime), 'The photo source did not return a real PNG, JPEG, WebP, GIF or AVIF image. HTML and SVG are not saved as portraits.'); check(bytes.length > 0 && bytes.length <= MAX_PHOTO, 'Choose a photo up to 12 MiB.', 413)
    const id = `crm-avatar-${digest(bytes)}`, path = join(this.options.blobDir, id); current(); await mkdir(this.options.blobDir, { recursive: true }); current()
    // Other records can receive the same logo concurrently. Publish a complete
    // immutable file atomically so a second reader never opens a partial image.
    const temporary = join(this.options.blobDir, '.crm-image-' + randomUUID())
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      current()
      try { linkSync(temporary, path) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const stat = await file.stat()
          check(stat.isFile() && stat.size === bytes.length && digest(await file.readFile()) === digest(bytes), 'A retained portrait is damaged. Restore its original before downloading again.', 409)
          current()
        } finally { await file.close() }
      }
    } finally { rmSync(temporary, { force: true }) }
    return { id, mime: mime!, bytes: bytes.length }
  }
  async saveProfileImage(type: 'person' | 'company', id: string, url: string, sourceUrl: string, requestId: string, authorize?: () => void, importedLogoSource?: CrmSourceRef): Promise<'saved' | 'kept' | 'unavailable'> {
    const collection = type === 'person' ? 'people' : 'companies', field = type === 'person' ? 'avatarAssetId' : 'logoAssetId'
    const record = this.options.store.get(collection, id)
    if (!record || record.archivedAt !== null || record.mergedIntoId) throw new CrmError('The selected record is unavailable.', 409)
    if (record[field]) return 'kept'
    const guard = this.guard()
    const current = () => {
      authorize?.(); guard()
      check(this.options.store.get(collection, id)?.revision === record.revision, 'The record changed during the image download.', 409)
    }
    current()
    if (folkSampleAvatar(url)) return 'unavailable'
    const resource = await fetchProfileResource(profilePhotoRequestUrl(url), { ...this.options, maxBytes: MAX_PHOTO, current })
    if (folkSampleAvatar(resource.url)) return 'unavailable'
    const asset = await this.retainPhoto(type === 'company' ? await rasterCompanyIcon(resource.bytes) : resource.bytes, current)
    current()
    if (Array.isArray(record.portraitRejectedAssetIds) && record.portraitRejectedAssetIds.includes(asset.id)) return 'unavailable'
    const observedAt = this.now()
    this.options.db.putAssetMeta({ id: asset.id, kind: 'image', mime: asset.mime, bytes: asset.bytes, createdAt: observedAt, nodeId: null })
    const provenance = { url, sourceUrl, label: importedLogoSource ? 'Company logo retained from Folk' : type === 'person' ? 'Captured profile photo' : 'Captured company logo', provider: importedLogoSource?.provider ?? 'profile-capture', ...(importedLogoSource ? { sourceRef: importedLogoSource } : {}), observedAt, originalAssetId: asset.id }
    this.options.store.command({ requestId: `capture-image:${requestId}`, operation: 'update', collection, id, expectedRecordRevision: record.revision, patch: { [field]: asset.id, [type === 'person' ? 'portraitSource' : 'logoSource']: provenance } }, 'profile-media')
    return 'saved'
  }
  async populatePerson(id: string, input: Record<string, unknown>): Promise<ProfileMediaResult> {
    const requestId = string(input.requestId); check(requestId && requestId.length <= 140, 'Provide a unique profile media request identity.'); const receiptKey = `profile-media:${digest(requestId)}`, fingerprint = digest(stable({ id, ...input })), prior = this.options.db.db.prepare('SELECT body FROM crm_state WHERE key=?').get(receiptKey) as { body: string } | undefined
    if (prior) { const receipt = JSON.parse(prior.body) as { fingerprint: string; result?: ProfileMediaResult }; check(receipt.fingerprint === fingerprint, 'This media request identity was already used for different data.', 409); if (receipt.result) return receipt.result }
    const commandId = `profile-media:${requestId}`, saved = this.options.db.db.prepare('SELECT body FROM crm_command_receipts WHERE id=?').get(commandId) as { body: string } | undefined
    if (saved && prior) { const result = JSON.parse(saved.body) as { record: CrmPerson }, record = result.record, recovered = { record, downloaded: !!record.avatarAssetId, addedLinks: 0, notices: ['This profile update was already saved.'] }; return recovered }
    const active = this.flights.get(receiptKey); if (active) return active
    const promise = this.populateNow(id, input, receiptKey, fingerprint, commandId); this.flights.set(receiptKey, promise); try { return await promise } finally { this.flights.delete(receiptKey) }
  }
  private async populateNow(id: string, input: Record<string, unknown>, receiptKey: string, fingerprint: string, commandId: string): Promise<ProfileMediaResult> {
    const person = this.person(id); check(Number.isSafeInteger(input.expectedRecordRevision) && input.expectedRecordRevision === person.revision, 'This contact changed. Refresh their latest profile before saving media.', 409); const current = this.guard(id, person.revision); current()
    this.options.db.db.prepare('INSERT OR REPLACE INTO crm_state(key,body) VALUES(?,?)').run(receiptKey, JSON.stringify({ fingerprint }))
    let inspection = this.localInspection(person); const sourceUrl = publicProfileUrl(input.sourceUrl), manual = input.confirmManualPhoto === true
    if (sourceUrl) check(inspection.links.some(value => profileLinkIdentity(value.url) === profileLinkIdentity(sourceUrl)) || inspection.photoCandidates.some(value => profileLinkIdentity(value.sourceUrl) === profileLinkIdentity(sourceUrl)), 'Add the source website to this contact before reading it.')
    if (input.discover === true || input.photoUrl && !inspection.photoCandidates.some(value => value.url === input.photoUrl) && !manual) inspection = await this.discover(person, inspection, current, sourceUrl || undefined)
    let selected = typeof input.photoUrl === 'string' ? inspection.photoCandidates.find(value => value.url === publicProfileUrl(input.photoUrl) && (!sourceUrl || profileLinkIdentity(value.sourceUrl) === profileLinkIdentity(sourceUrl))) : inspection.photoCandidates.find(value => value.automatic)
    if (input.photoUrl && !selected && manual && sourceUrl) { const url = publicProfileUrl(input.photoUrl); check(url, 'Enter a public image URL.'); selected = photo(url!, sourceUrl, 'Photo explicitly selected by you from this source', 'captured', false) }
    check(!input.photoUrl || selected, 'Choose a photo discovered on an attached source, or explicitly confirm a manual image from that source.')
    check(!selected || manual || !folkSampleAvatar(selected.url), 'This is a known Folk sample avatar. Automatic contact photo imports exclude it; choose a person’s actual picture.', 422)
    const existingUrlKeys = new Set(person.urls.map(profileLinkIdentity)), newLinks = this.options.retainedPhoto?.photoOnly ? [] : inspection.links.filter(value => { const key = profileLinkIdentity(value.url); if (existingUrlKeys.has(key)) return false; existingUrlKeys.add(key); return true }), addedLinks = newLinks.length, patch: Record<string, unknown> = {}, observedAt = this.now(); let asset: { id: string; mime: string; bytes: number } | undefined
    if (addedLinks) { patch.urls = [...person.urls, ...newLinks.map(value => value.url)]; const existing = Array.isArray(person.profileLinkSources) ? person.profileLinkSources : []; patch.profileLinkSources = unique([...existing, ...newLinks.map(value => ({ ...value, observedAt }))], value => object(value) ? `${value.url}:${value.sourceUrl}` : stable(value)) }
    if (selected && (!person.avatarAssetId || input.replacePhoto === true)) {
      current(); const requestUrl = profilePhotoRequestUrl(selected.url), resource = await fetchProfileResource(requestUrl, { ...this.options, maxBytes: MAX_PHOTO, current }); current(); check(manual || !folkSampleAvatar(resource.url), 'This source redirected to a known Folk sample avatar. It cannot activate an automatic contact photo.', 422); const retained = await this.retainPhoto(resource.bytes, current); current()
      if (!manual && Array.isArray(person.portraitRejectedAssetIds) && person.portraitRejectedAssetIds.includes(retained.id)) inspection.notices.push('This source image was previously rejected as a default or incorrect picture. Choose a different photo, or explicitly select it to override the rejection.')
      else { asset = retained; patch.avatarAssetId = asset.id; patch.portraitSource = { url: selected.url, sourceUrl: selected.sourceUrl, label: selected.label, provider: selected.kind, observedAt, originalAssetId: asset.id, ...(requestUrl !== selected.url ? { requestUrl } : {}) }; patch.portraitOriginal = { assetId: asset.id, name: 'Profile photo', mime: asset.mime, bytes: asset.bytes } }
    }
    else if (person.avatarAssetId && selected) inspection.notices.push('The existing portrait was kept. Choose Replace photo to change it.')
    if (!selected && !person.avatarAssetId) inspection.notices.push(inspection.photoCandidates.length ? 'Page images were found. Confirm which image is the person before saving it.' : 'No accessible profile photo was found in the attached sources.')
    current(); let record = person
    if (Object.keys(patch).length) { if (asset) this.options.db.putAssetMeta({ id: asset.id, kind: 'image', mime: asset.mime, bytes: asset.bytes, createdAt: observedAt, nodeId: null }); current(); record = this.options.store.command({ requestId: commandId, operation: 'update', collection: 'people', id, expectedRecordRevision: person.revision, patch }, 'profile-media').record as CrmPerson }
    const result = { record, downloaded: !!asset, addedLinks, notices: inspection.notices }
    this.options.db.db.prepare('INSERT OR REPLACE INTO crm_state(key,body) VALUES(?,?)').run(receiptKey, JSON.stringify({ fingerprint, result })); return result
  }
  async populate(input: Record<string, unknown>): Promise<ProfileBatchResult> {
    const requestId = string(input.requestId), limit = Number(input.limit ?? 10), offset = Number(input.offset ?? 0); check(requestId && requestId.length <= 100, 'Provide a unique batch identity.'); check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 25 && Number.isSafeInteger(offset) && offset >= 0, 'Populate up to 25 contacts at a time.'); const current = this.guard(); current()
    const key = `profile-batch:${digest(requestId)}`, fingerprint = digest(stable(input)), saved = this.options.db.db.prepare('SELECT body FROM crm_state WHERE key=?').get(key) as { body: string } | undefined
    let receipt = saved ? JSON.parse(saved.body) as ProfileBatchReceipt : undefined
    if (receipt) { check(receipt.fingerprint === fingerprint, 'This batch identity was already used for different data.', 409); if (receipt.result) return receipt.result }
    const active = this.batchFlights.get(key); if (active) return active
    if (!receipt) {
      const groupId = string(input.groupId), members = groupId ? new Set(this.options.store.rows('memberships', false).filter(row => row.groupId === groupId && row.entityType === 'person').map(row => row.entityId)) : null
      if (groupId) check(this.options.store.get('groups', groupId)?.archivedAt === null, 'Choose an available group.', 404)
      let people = this.options.store.rows('people', false).filter(person => !person.mergedIntoId && (!members || members.has(person.id)))
      if (input.eligibleOnly === true) people = people.filter(person => { const inspection = this.localInspection(person); return inspection.photoCandidates.length > 0 || input.discover === true && inspection.links.some(value => profilePlatform(value.url) === 'website' && !blockedPlatform(value.url)) })
      const selected = people.slice(offset, offset + limit).map(person => ({ personId: person.id, revision: person.revision, name: person.fullName || `${person.firstName} ${person.lastName}`.trim() }))
      receipt = { fingerprint, selected, results: [], total: people.length, nextOffset: offset + selected.length < people.length ? offset + selected.length : null }
      this.options.db.db.prepare('INSERT OR REPLACE INTO crm_state(key,body) VALUES(?,?)').run(key, JSON.stringify(receipt))
    }
    const promise = this.populateBatchNow(input, key, receipt, current); this.batchFlights.set(key, promise); try { return await promise } finally { this.batchFlights.delete(key) }
  }
  private async populateBatchNow(input: Record<string, unknown>, key: string, receipt: ProfileBatchReceipt, current: () => void): Promise<ProfileBatchResult> {
    const offset = Number(input.offset ?? 0), requestId = string(input.requestId), checkpoint = () => { current(); this.options.db.db.prepare('INSERT OR REPLACE INTO crm_state(key,body) VALUES(?,?)').run(key, JSON.stringify(receipt)) }
    for (const selected of receipt.selected.slice(receipt.results.length)) {
      current(); const base = { personId: selected.personId, name: selected.name }; let row: ProfileBatchItem
      try {
        const person = this.person(selected.personId)
        if (person.avatarAssetId && input.discover !== true && person.revision === selected.revision) row = { ...base, status: 'skipped', message: 'The existing photo was kept.' }
        else { const result = await this.populatePerson(selected.personId, { requestId: `${requestId}:${offset}:${digest(selected.personId).slice(0, 24)}`, expectedRecordRevision: selected.revision, discover: input.discover === true }); current(); row = { ...base, status: result.downloaded || result.addedLinks ? 'updated' : 'unavailable', downloaded: result.downloaded, addedLinks: result.addedLinks, notices: result.notices, message: result.notices.at(-1) || (result.downloaded ? 'Profile photo retained locally.' : '') } }
      } catch (error) { current(); const message = error instanceof Error ? error.message : 'Profile unavailable.'; row = { ...base, status: 'error', error: message, message } }
      receipt.results.push(row); checkpoint()
    }
    const results = receipt.results; receipt.result = { total: receipt.total, processed: results.length, offset, nextOffset: receipt.nextOffset, results, downloaded: results.filter(value => value.downloaded).length, addedLinks: results.reduce((total, value) => total + (value.addedLinks || 0), 0), updated: results.filter(value => value.status === 'updated').length, cloudAiUsed: false }; checkpoint(); return receipt.result
  }
}
