import { selectedWikidataProfile } from './crmProfileDiscovery.ts'
import type { CrmProfileCaptureDraft } from '../src/crm/profileCaptureTypes.ts'
import { quickAddProfile } from './crmProfileQuickAdd.ts'
import type { CrmProfileCollection } from './crmProfileCollection.ts'
import type { CrmProfileCapture } from './crmProfileCapture.ts'
import type { CrmProfileMedia } from './crmProfileMedia.ts'
import { CrmError, type SqliteCrmStore } from './crmStore.ts'
import { organizationHomepageHost, type CatalogCompanyWebsite } from './crmProfileUrls.ts'

export async function enrichWebsite(services: { collect: CrmProfileCollection; capture: CrmProfileCapture; store: SqliteCrmStore; media: CrmProfileMedia | null; fetch?: typeof fetch }, body: Record<string, unknown>, authorize: () => void, checked?: { homepage?: CrmProfileCaptureDraft; catalog?: Awaited<ReturnType<typeof selectedWikidataProfile>> }) {
  const { type, targetId, groupId, requestId } = body
  if (type !== 'person' && type !== 'company' || typeof requestId !== 'string' || !requestId || requestId.length > 100 ||
      (targetId !== undefined && typeof targetId !== 'string') || (groupId !== undefined && typeof groupId !== 'string')) throw new CrmError('Choose a person or company and a public profile URL.')
  const collection = type === 'person' ? 'people' : 'companies'
  const original = targetId ? services.store.get(collection, targetId) : undefined
  if (targetId && (!original || original.archivedAt !== null || original.mergedIntoId)) throw new CrmError('This record is unavailable.', 409)
  const name = String(original ? type === 'company' ? original.name : original.fullName || [original.firstName, original.lastName].filter(Boolean).join(' ') : body.name ?? '')
  let metadataDraft: CrmProfileCaptureDraft | undefined
  let catalog: CatalogCompanyWebsite | undefined
  if (body.wikidataSourceUrl !== undefined) {
    const selected = checked?.catalog ?? await selectedWikidataProfile(body.wikidataSourceUrl, body.url, name, type, services.fetch)
    authorize()
    if (type === 'company') catalog = selected.catalogWebsite
    metadataDraft = await services.capture.stage({ ...selected, requestId: 'wikidata:' + requestId }, { captureMethod: 'public-url', authorize })
  }
  let draft: CrmProfileCaptureDraft, sourceNotice = ''
  try { draft = checked?.homepage ?? await services.collect.fromUrl({ requestId, url: body.url, expectedCompanyName: type === 'company' ? name : undefined }, authorize, catalog) }
  catch (cause) {
    authorize()
    if (!metadataDraft || cause instanceof CrmError && cause.status === 409) throw cause
    draft = metadataDraft
    sourceNotice = 'Used the selected Wikidata entry. The official website did not provide a readable profile.'
  }
  authorize()
  const review = (message: string) => ({ status: 'review', draftId: draft.id, message })
  if (draft.profile.entityType !== type) return review('This page describes a different record type. Review the source before saving.')
  const norm = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
  let verifiedCatalogName
  if (catalog && draft.id !== metadataDraft?.id) {
    if (new URL(catalog.url).hostname.replace(/^www\./, '') !== new URL(draft.source.url).hostname.replace(/^www\./, '')) return review('This website redirected to a different organization domain.')
    if (organizationHomepageHost(catalog.url) && organizationHomepageHost(draft.source.url) === organizationHomepageHost(catalog.url)) {
      verifiedCatalogName = Object.values(catalog.labels).find(label => norm(label) === norm(draft.profile.name))
    }
  }
  if (original) {
    if (draft.matches.some(match => match.id !== original.id) || draft.status === 'accepted' && draft.targetId !== original.id) return review('This website is associated with another record.')
    if (norm(name) !== norm(draft.profile.name) && (!verifiedCatalogName || norm(verifiedCatalogName) !== norm(draft.profile.name))) return review('The name on this website differs from the saved record.')
    if (services.store.get(collection, original.id)?.revision !== original.revision) return review('This record changed during enrichment.')
  }
  const result = await quickAddProfile(services, draft, 'web:' + requestId, groupId, authorize, original && { id: original.id, revision: original.revision, name, verifiedCatalogName })
  if (result.recordId && metadataDraft && draft.id !== metadataDraft.id) {
    const supplemental = services.capture.detail(metadataDraft.id)
    const target = services.store.get(collection, result.recordId)
    if (target && !supplemental.matches.some(match => match.id !== target.id) &&
        (supplemental.status !== 'accepted' || supplemental.targetId === target.id)) {
      try {
        const supplement = await quickAddProfile(services, supplemental, 'metadata:' + requestId, undefined, authorize, { id: target.id, revision: target.revision, name })
        if (supplement.status !== 'saved') sourceNotice = 'Website saved. The Wikidata entry is available in capture review.'
      } catch { authorize(); sourceNotice = 'Website saved. The Wikidata entry is available in capture review.' }
    } else sourceNotice = 'Website saved. Review the Wikidata entry because another record may match.'
  }
  return { ...result, draftId: draft.id, ...(sourceNotice ? { sourceNotice } : {}), ...(result.recordId ? { record: services.store.get(collection, result.recordId) } : {}) }
}
