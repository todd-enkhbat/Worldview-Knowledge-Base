import { createHash } from 'node:crypto'
import { CrmProfileCapture } from './crmProfileCapture.ts'
import { profileFromHtml } from './crmProfileExtract.ts'
import { fetchProfileResource, publicProfileUrl } from './crmProfileMedia.ts'
import { CrmError } from './crmStore.ts'
import { entityUrl } from './crmProfileCapture.ts'
import type { WorldDb } from './worldDb.ts'
import type { CapturedProfileData } from '../src/crm/profileCaptureTypes.ts'
import { normalizeEmail, normalizePhone } from '../src/crm/model.ts'

const keyName = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
const empty = (value: unknown) => value == null || value === '' || Array.isArray(value) && !value.length
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex')
const socialHost = /(?:^|\.)(?:linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|folk\.app|whatsapp\.com)$/i
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const host = (href: string) => new URL(href).hostname.replace(/^www\./, '').toLowerCase()

export function readerEnrichmentEvidence(record: Record<string, unknown>) {
  const entries = object(record.readerEnrichment) ? record.readerEnrichment : {}
  return Object.fromEntries(Object.entries(entries).flatMap(([field, raw]) => {
    if (!object(raw) || raw.digest !== digest(record[field]) || typeof raw.url !== 'string' || typeof raw.provider !== 'string') return []
    return [[field, { url: raw.url, provider: raw.provider }]]
  }))
}

/** Only facts declared by the matching organization's own structured profile. */
function publicCompanyFacts(html: string, url: string, name: string) {
  const candidates: Record<string, unknown>[] = []
  function visit(value: unknown, depth = 0) {
    if (depth > 5) return
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 30)) visit(item, depth + 1)
      return
    }
    if (!object(value)) return
    const types = [value['@type']].flat().map(type => String(type).replace(/^https?:\/\/schema\.org\//i, ''))
    const official = publicProfileUrl(value.url, url)
    if (types.some(type => ['Organization','Corporation','EducationalOrganization','CollegeOrUniversity','School','LocalBusiness'].includes(type)) &&
        typeof value.name === 'string' && keyName(value.name) === keyName(name) && official && host(official) === host(url)) candidates.push(value)
    visit(value['@graph'], depth + 1)
    visit(value.mainEntity, depth + 1)
  }
  for (const [, script] of [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].slice(0, 12)) {
    if (script.length <= 65536) try { visit(JSON.parse(script)) } catch { /* Structured data is optional. */ }
  }
  if (candidates.length !== 1) return {}
  const declared = candidates[0]
  const date = typeof declared.foundingDate === 'string' ? declared.foundingDate.match(/^(\d{4})(?:-\d\d(?:-\d\d)?)?$/)?.[1] : undefined
  const number = object(declared.numberOfEmployees) ? declared.numberOfEmployees : { value: declared.numberOfEmployees }
  const employee = (value: unknown) => typeof value === 'string' && /^\d{1,9}$/.test(value) || typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1e9 ? String(value) : ''
  const min = employee(number.minValue), max = employee(number.maxValue)
  const employeeRange = employee(number.value) || (min && max && Number(min) <= Number(max) ? min + '–' + max : '')
  const addresses = [declared.address].flat().slice(0, 8).map(address => {
    if (typeof address === 'string') return address.trim().slice(0, 500)
    if (!object(address)) return ''
    return ['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'].map(key => address[key]).filter((value): value is string => typeof value === 'string' && !!value.trim()).join(', ').slice(0, 500)
  }).filter(Boolean)
  return { ...(date && Number(date) > 0 ? { foundationYear: Number(date) } : {}), employeeRange, addresses }
}

export async function enrichReaderRecord(db: WorldDb, blobDir: string, type: 'company' | 'person', id: string, requestId: unknown, now: number, current: () => void, changed: () => void) {
  if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId)) throw new CrmError('Start a new enrichment request.')
  const collection = type === 'company' ? 'companies' : 'people'
  const initial = db.crm.get(collection, id)
  if (!initial || initial.archivedAt !== null || initial.mergedIntoId) throw new CrmError('This saved profile is unavailable.', 409)
  const name = String(type === 'company' ? initial.name : initial.fullName || [initial.firstName, initial.lastName].filter(Boolean).join(' '))
  const patch: Record<string, unknown> = {}, evidence: Record<string, { provider: string; url: string; at: number; digest: string }> = {}
  const sources: Array<{ provider: string; status: string }> = []

  function applyProfile(profile: CapturedProfileData, url: string, provider: string, extra: Record<string, unknown> = {}) {
    if (profile.entityType !== type || keyName(name) !== keyName(profile.name)) return false
    const additions: Record<string, unknown> = {
      ...extra, description: profile.description, location: profile.location,
      emails: strings(profile.emails).map(normalizeEmail).filter(item => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item) && (type === 'company' || !/^(?:info|contact|sales|support|hello|office|careers|jobs|press|team|admin)@/.test(item))).slice(0, 24),
      phones: strings(profile.phones).filter(item => /\d{7}/.test(normalizePhone(item))).slice(0, 24),
      urls: [...new Set(strings(profile.urls).flatMap(url => publicProfileUrl(url) || []))].slice(0, 24),
      ...(type === 'company' ? { industry: profile.industry, tagline: profile.headline } : { jobTitle: profile.affiliations?.find(row => row.kind === 'employment' && row.current)?.role || profile.headline }),
    }
    if (type === 'person' && empty(initial?.companyIds)) {
      const organizations = profile.affiliations?.filter(row => row.kind === 'employment' && row.current) ?? []
      const companies = organizations.flatMap(row => {
        const link = row.organizationUrl && entityUrl(row.organizationUrl, 'company')
        const matches = db.crm.rows('companies', false).filter(company =>
          link ? company.urls.some(href => entityUrl(href, 'company') === link) : keyName(company.name) === keyName(row.organization))
        return matches.length === 1 ? [matches[0].id] : []
      })
      additions.companyIds = [...new Set(companies)]
    }
    for (const [field, raw] of Object.entries(additions)) {
      const value = typeof raw === 'string' ? raw.trim() : raw
      if (!empty(initial?.[field]) || !empty(patch[field]) || empty(value)) continue
      patch[field] = value
      evidence[field] = { provider, url, at: now, digest: digest(value) }
    }
    return true
  }

  const capture = new CrmProfileCapture({ db, store: db.crm, blobDir })
  let retained = 0
  for (const id of strings(initial.profileCaptureIds).slice(-8).reverse()) {
    let draft
    try { draft = capture.detail(id) } catch { continue }
    if (draft.targetId === initial.id && draft.status === 'accepted' && applyProfile(draft.profile, draft.source.url, 'Saved profile')) retained++
  }
  sources.push({ provider: 'Saved profile', status: retained ? 'Checked' : 'No confirmed capture' })
  const stored = [...strings(initial.urls), ...(type === 'company' && typeof initial.domain === 'string' && initial.domain ? [initial.domain.includes('://') ? initial.domain : 'https://' + initial.domain] : [])]
  const site = stored.map(value => publicProfileUrl(value)).find(url => url && !socialHost.test(host(url)))
  const searchable = ['description', 'location', 'emails', 'phones', 'urls', ...(type === 'company' ? ['industry', 'tagline', 'foundationYear', 'employeeRange', 'addresses'] : ['jobTitle', 'companyIds'])]
  if (site && searchable.some(field => empty(initial[field]) && empty(patch[field]))) {
    try {
      const result = await fetchProfileResource(site, { current })
      current()
      const html = new TextDecoder().decode(result.bytes)
      const matched = host(site) === host(result.url) && /html/i.test(result.contentType) &&
        applyProfile(profileFromHtml(html, result.url, type === 'company' ? name : undefined).profile, result.url, 'Public website', type === 'company' ? publicCompanyFacts(html, result.url, name) : {})
      sources.push({ provider: 'Public website', status: matched ? 'Verified' : 'Could not verify the profile' })
    } catch {
      current()
      sources.push({ provider: 'Public website', status: 'Unavailable' })
    }
  } else sources.push({ provider: 'Public website', status: site ? 'Fields already filled' : 'No official website saved' })

  current()
  const latest = db.crm.get(collection, id)
  if (!latest || latest.archivedAt !== null || latest.mergedIntoId || latest.revision !== initial.revision) throw new CrmError('The record changed during enrichment. Try again from the latest details.', 409)
  const fields = Object.keys(patch)
  if (fields.length) {
    const result = db.crm.command({
      requestId: 'reader-enrich:' + requestId, operation: 'update', collection, id,
      expectedRecordRevision: latest.revision,
      patch: { ...patch, readerEnrichment: { ...(object(latest.readerEnrichment) ? latest.readerEnrichment : {}), ...evidence } },
    }, 'reader-enrichment')
    if (!result.replayed) changed()
  }
  return { fields, sources }
}
