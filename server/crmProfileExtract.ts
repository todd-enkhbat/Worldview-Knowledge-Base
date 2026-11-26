import type { CapturedProfileData, CrmProfileCaptureInput } from '../src/crm/profileCaptureTypes.ts'
import type { CrmAffiliation } from '../src/crm/types.ts'
import { CrmError } from './crmStore.ts'
import { organizationHomepageHost, type CatalogCompanyWebsite } from './crmProfileUrls.ts'

export type ExtractedCrmProfile = Omit<CrmProfileCaptureInput, 'requestId'>
const MAX_BYTES = 512 * 1024
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const clean = (value: unknown, max = 500) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
const nameKey = (value: unknown) => clean(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const textValue = (value: unknown) => typeof value === 'string' ? clean(value) : object(value) ? clean(value.name) : ''
function sourceUrl(value: string) { try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048 || url.hostname === 'app.folk.app') throw new Error(); return url.href } catch { throw new CrmError('Choose a public person or company profile URL; Folk uses its separate private import.', 422) } }
function publicUrl(value: unknown, base: string) { if (typeof value !== 'string' || !value.trim()) return ''; try { const url = new URL(value, base); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return ''; url.hash = ''; return url.href } catch { return '' } }
function canonical(value: string) { const url = new URL(value); url.hash = ''; url.search = ''; return url.href.replace(/\/$/, '') }
function bounded(value: string, label: string) { if (!value.trim() || Buffer.byteLength(value, 'utf8') > MAX_BYTES) throw new CrmError(`${label} must contain readable content within512KiB. Use Reader on a smaller loaded profile.`, 422) }
const decode = (value: string) => value.replace(/&#(?:x([a-f0-9]+)|(\d+));|&(amp|quot|apos|lt|gt|nbsp|ndash|mdash|middot|hellip);/gi, (match, hex, number, name: string) => { if (hex || number) { const code = Number.parseInt(hex || number, hex ? 16 : 10); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match } return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', middot: '·', hellip: '…' } as Record<string, string>)[name.toLowerCase()] || match })
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const tags = new Set(['article', 'main', 'section', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i', 'u', 's', 'br', 'hr', 'a', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td'])
function readableHtml(source: string, url: string) {
  let html = source.replace(/<!--[\s\S]*?-->/g, '')
  for (const tag of ['script', 'style', 'noscript', 'iframe', 'object', 'svg', 'math', 'form', 'textarea', 'select', 'button', 'nav', 'aside', 'footer', 'template']) html = html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '')
  html = html.replace(/<(?:input|embed|link|meta)\b[^>]*\/?\s*>/gi, '')
  const main = html.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/i); if (main) html = main[2]
  const stack: { tag: string; hidden: boolean }[] = []
  return (html.match(/<[^>]*>|[^<]+|</g) || []).map(token => {
    if (!token.startsWith('<')) return stack.some(frame => frame.hidden) ? '' : escape(decode(token))
    const match = token.match(/^<(\/?)\s*([a-z][a-z0-9]*)\b([^>]*)>/i); if (!match) return ''
    const tag = match[2].toLowerCase()
    if (match[1]) { const index = stack.map(frame => frame.tag).lastIndexOf(tag), frame = stack[index]; if (index >= 0) stack.splice(index); return frame && !frame.hidden && tags.has(tag) ? `</${tag}>` : '' }
    const hidden = stack.some(frame => frame.hidden) || /(?:^|\s)hidden(?:\s|=|$)|aria-hidden\s*=\s*["']?true\b|(?:display\s*:\s*none|visibility\s*:\s*hidden)|\b(?:visually-hidden|sr-only)\b/i.test(match[3])
    if (!['br', 'hr', 'img', 'wbr', 'area', 'base', 'col', 'source', 'track', 'param'].includes(tag) && !/\/\s*$/.test(match[3])) stack.push({ tag, hidden })
    if (hidden || !tags.has(tag)) return ''
    const href = tag === 'a' ? match[3].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) : null, target = href ? publicUrl(decode(href[1] ?? href[2] ?? href[3]), url) : ''
    return `<${tag}${target ? ` href="${escape(target)}" rel="noreferrer noopener"` : ''}>`
  }).join('')
}
function readableText(html: string) { return decode(html.replace(/<\/(?:p|div|li|h[1-6]|section|dt|dd|tr|blockquote)>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).split(/\n+/).map(line => clean(line, MAX_BYTES)).filter(Boolean).join('\n') }
function affiliation(kind: CrmAffiliation['kind'], organization: unknown, row: Record<string, unknown> = {}): Omit<CrmAffiliation, 'id' | 'evidence'> | null {
  const name = textValue(organization); if (!name) return null
  return { kind, organization: name.slice(0, 300), ...Object.fromEntries(['role', 'degree', 'field', 'startDate', 'endDate', 'organizationUrl', 'organizationLogoUrl', 'description', 'excerpt'].flatMap(key => clean(row[key], key === 'description' ? 12000 : key === 'excerpt' ? 4000 : 500) ? [[key, clean(row[key], key === 'description' ? 12000 : key === 'excerpt' ? 4000 : 500)]] : [])), ...(row.current === true ? { current: true } : {}) }
}
function schemaProfile(schema: Record<string, unknown>, entityType: 'person' | 'company', url: string): CapturedProfileData {
  const profile: CapturedProfileData = { entityType, name: clean(schema.name, 400), headline: textValue(schema.jobTitle || schema.slogan), description: clean(schema.description, 12_000), location: typeof schema.address === 'string' ? clean(schema.address) : object(schema.address) ? ['addressLocality', 'addressRegion', 'addressCountry'].map(key => textValue((schema.address as Record<string, unknown>)[key])).filter(Boolean).join(', ') : '', industry: textValue(schema.industry), emails: [], phones: [], urls: [url], affiliations: [], images: [] }
  for (const value of [schema.email].flat()) { const email = clean(value).replace(/^mailto:/i, ''); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) profile.emails!.push(email) }
  for (const value of [schema.telephone].flat()) if (/\d/.test(clean(value))) profile.phones!.push(clean(value, 100))
  for (const value of [schema.url, ...[schema.sameAs].flat()].slice(0, 32)) { const next = publicUrl(value, url); if (next && !profile.urls!.includes(next)) profile.urls!.push(next) }
  for (const value of [entityType === 'person' ? schema.image : schema.logo].flat().slice(0, 8)) { const next = publicUrl(typeof value === 'string' ? value : object(value) ? value.url || value.contentUrl : '', url); if (next) profile.images!.push({ url: next, label: `${profile.name} source image`, subjectName: profile.name, isProfile: true }) }
  if (entityType === 'person') for (const [property, kind] of [['alumniOf', 'education'], ['worksFor', 'employment'], ['memberOf', 'membership'], ['affiliation', 'membership']] as const) {
    for (const entry of [schema[property]].flat().slice(0, 30)) {
      const role = object(entry) && [entry['@type']].flat().some(type => /^(?:https?:\/\/schema\.org\/)?(?:EmployeeRole|OrganizationRole|Role)$/.test(String(type))) ? entry : undefined
      const organization = role ? role[property] : entry
      const details = object(organization) ? organization : {}
      const title = role ? textValue(role.roleName || role.namedPosition) : kind === 'employment' ? profile.headline : ''
      // On alumniOf, a Role startDate can be the date alumni status began, not enrollment.
      const datedRole = kind === 'employment' ? role : undefined
      const endDate = clean(datedRole?.endDate)
      const row = affiliation(kind, organization, {
        role: title, description: role?.description, startDate: datedRole?.startDate,
        endDate: /^present$/i.test(endDate) ? '' : endDate, current: kind === 'employment' && (!endDate || /^present$/i.test(endDate)),
        degree: details.degree, field: details.fieldOfStudy, organizationUrl: publicUrl(details.url, url),
        organizationLogoUrl: publicUrl(object(details.logo) ? details.logo.url || details.logo.contentUrl : details.logo, url),
        excerpt: [profile.name, property, textValue(organization), title, datedRole?.startDate, endDate].filter(Boolean).join(' · '),
      })
      if (row) profile.affiliations!.push(row)
    }
  }
  profile.affiliations = profile.affiliations!.slice(0, 60); profile.emails = [...new Set(profile.emails)].slice(0, 32); profile.phones = [...new Set(profile.phones)].slice(0, 32); profile.urls = profile.urls!.slice(0, 32)
  return profile
}

function tagAttributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1].toLowerCase(), decode(match[2] ?? match[3])]))
}

function homepageMetadata(source: string, url: string) {
  const head = source.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? ''
  const tags = [...head.matchAll(/<meta\b[^>]*>/gi)].map(hit => tagAttributes(hit[0]))
  const meta = (field: string) => tags.find(tag => (tag.property || tag.name || '').toLowerCase() === field)?.content || ''
  const icons = [...head.matchAll(/<link\b[^>]*>/gi)].map(hit => tagAttributes(hit[0]))
    .filter(tag => tag.rel?.toLowerCase().split(/\s+/).some(token => token === 'icon' || token === 'apple-touch-icon'))
  function rank(tag: Record<string, string>) {
    if (/apple-touch-icon/i.test(tag.rel)) return 0
    return /image\/(?:png|webp|jpeg)/i.test(tag.type || '') || /\.(?:png|webp|jpe?g)(?:$|\?)/i.test(tag.href) ? 1 : 2
  }
  const icon = publicUrl(icons.sort((a, b) => rank(a) - rank(b))[0]?.href, url)
  return { siteName: clean(meta('og:site_name'), 400), description: clean(meta('description') || meta('og:description'), 2000), icon }
}

/** A named official homepage can identify its organization even without JSON-LD. */
function companyHomepage(source: string, url: string, expectedName?: string, catalog?: CatalogCompanyWebsite): CapturedProfileData | null {
  const page = new URL(url)
  const hostKey = organizationHomepageHost(url)
  const official = !!catalog && !!hostKey && hostKey === organizationHomepageHost(catalog.url)
  if (page.search || page.pathname !== '/' && !official || catalog && !official) return null
  const { siteName, description, icon } = homepageMetadata(source, url)
  const name = clean(expectedName || siteName, 400)
  if (!name) return null
  const title = decode(source.match(/<title\b[^>]*>([^<]+)<\/title>/i)?.[1] || '')
  const titleParts = clean(title).split(/\s+[|–—-]\s+/).map(nameKey)
  const lang = (tagAttributes(source.match(/<html\b[^>]*>/i)?.[0] || '').lang || '').toLowerCase()
  const names = [name, catalog?.labels.en, catalog?.labels[lang], catalog?.labels[lang.split('-')[0]]].filter((value): value is string => !!value).map(nameKey)
  const host = page.hostname.toLowerCase().replace(/^www\./, '').split('.')[0]
  const attribution = [nameKey(siteName), ...titleParts]
  if (!names.some(value => attribution.includes(value))) return null
  if (official && siteName && !names.includes(nameKey(siteName)) && siteName.toLowerCase().replace(/^www\./, '') !== hostKey) return null
  const compact = (value: string) => value.replace(/ /g, '')
  const handles = new Set(names.map(compact))
  const urls = new Set([url])
  for (const hit of source.matchAll(/<a\s[^>]{0,8000}>/gi)) {
    const href = publicUrl(tagAttributes(hit[0]).href, url)
    if (!href) continue
    const social = new URL(href)
    const slug = social.pathname.match(/^\/(?:company|school)\/([^/]+)\/?$/i)?.[1]
    let handle = ''
    if (slug) try { handle = compact(nameKey(decodeURIComponent(slug))) } catch { /* A malformed link cannot corroborate this company. */ }
    if (/^(?:www\.)?linkedin\.com$/i.test(social.hostname) && handle && handles.has(handle)) urls.add(href)
  }
  const initials = nameKey(name).split(' ').filter(word => !['of', 'the', 'and', 'for', 'at'].includes(word)).map(word => word[0]).join('')
  const domainMatches = handles.has(host) || initials.length >= 2 && host === initials && attribution.includes(initials)
  const identifiesOrganization = urls.size > 1 && names.includes(nameKey(siteName))
  // For a new URL, a brand-like domain can just as easily belong to a personal
  // blog. Require the site's own matching company/school identity in that case.
  if (!official && !identifiesOrganization && !(expectedName && domainMatches)) return null
  return { name, entityType: 'company', description, urls: [...urls].slice(0,32), images: icon ? [{ url: icon, label: name + ' website icon', subjectName: name, isProfile: true }] : [] }
}

function facultyDegree(raw: string): Omit<CrmAffiliation, 'id' | 'evidence'> | null {
  const excerpt = raw.trim().replace(/\s+/g, ' ')
  if (excerpt.length > 1000 || /\b(?:postdoc(?:toral)?|candidate|expected|in progress|fellowship)\b/i.test(excerpt) || !/^(?:Ph\.?D\b|D\.?Phil\b|[BM]\.?\s?(?:S(?:c)?|A|Eng|Tech)\b|Bachelor\b|Master\b|Doctorate\b|Diploma\b)/i.test(excerpt)) return null
  const item = excerpt.match(/^([^,;]{1,100}?)\s+((?:19|20)\d{2})\s+in\s+([^,;]{2,300}),\s*(.{2,300})$/i)
  const csv = excerpt.match(/^([^,;]{1,100}),\s*([^,;]{2,300}),\s*([^,;]{2,300}),\s*((?:19|20)\d{2})\.?$/)
  if (!item && !csv) return null
  const [, degree, year, field, school] = item || [csv![0], csv![1], csv![4], csv![2], csv![3]]
  const institute = school.match(/^(.+?\b(?:Institute|Department|School|College)\b.*?)\s+at\s+(?:the\s+)?(University\s+of\s+.+)$/i)
  return { kind: 'education', degree: degree.trim(), field: field.trim(), endDate: year, organization: (institute?.[2] || school).trim(), ...(institute ? { description: institute[1] } : {}), excerpt }
}

function facultyEducationPage(source: string, html: string, url: string, title: string, entities: { kind: string; schema: Record<string, unknown> }[]): ExtractedCrmProfile | null {
  if (!/<(?:main|article)\b/i.test(source)) return null
  const page = new URL(url)
  const titleName = clean(title.split(/\s+[–—|-]\s+/)[0])
  const surname = nameKey(titleName).split(' ').at(-1), slug = nameKey(page.pathname.split('/').filter(Boolean).at(-1) || '').replace(/ /g, '')
  if (titleName.length > 120 || titleName.split(/\s+/).length < 2 || !surname || !slug.includes(surname)) return null
  const headings = [...html.matchAll(/<(h[1-6])>([\s\S]*?)<\/\1>/gi)]
  const names = headings.filter(match => /h[12]/i.test(match[1]) && nameKey(readableText(match[2])) === nameKey(titleName))
  const education = headings.filter(match => /h[234]/i.test(match[1]) && nameKey(readableText(match[2])) === 'education')
  if (names.length !== 1 || education.length !== 1 || names[0].index! >= education[0].index!) return null
  const list = html.slice(education[0].index! + education[0][0].length).match(/^\s*<(ul|ol)>([\s\S]*?)<\/\1>/i)
  if (!list) return null
  const rows = [...list[2].matchAll(/<li>([\s\S]*?)<\/li>/gi)].flatMap(item => facultyDegree(readableText(item[1])) || []).slice(0, 60)
  if (!rows.length) return null
  const name = clean(readableText(names[0][2]), 200)
  const declared = entities.find(item => item.kind === 'person' && nameKey(item.schema.name) === nameKey(name))
  const profile: CapturedProfileData = declared ? schemaProfile(declared.schema, 'person', url) : { entityType: 'person', name, urls: [url] }
  profile.affiliations = [...rows, ...(profile.affiliations || [])].slice(0, 60)
  const lines = rows.map(row => row.excerpt!)
  return { url, title, profile, text: [name, 'Education', ...lines].join('\n'), html: '<article><h1>' + escape(name) + '</h1><h2>Education</h2><ul>' + lines.map(line => '<li>' + escape(line) + '</li>').join('') + '</ul></article>' }
}

/** Parse declared primary entities only. Does not execute HTML, fetch links, or inspect Article.author. */
export function profileFromHtml(source: string, inputUrl: string, expectedCompanyName?: string, catalog?: CatalogCompanyWebsite): ExtractedCrmProfile {
  const url = sourceUrl(inputUrl); bounded(source, 'The source HTML')
  const html = readableHtml(source, url), text = readableText(html), h1 = clean(readableText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ''), 400)
  const page = new URL(url), pageTitle = clean(decode(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''), 300)
  const facultyDirectory = /(?:\.edu(?:\.[a-z]{2})?|\.ac\.[a-z]{2})$/i.test(page.hostname) &&
    /\/(?:people(?:_individual)?|faculty(?:-directory)?|directory|academic-staff|profiles)\/[^/]+/i.test(page.pathname)
  const entities: { schema: Record<string, unknown>; kind: 'person' | 'company' }[] = []
  const visit = (value: unknown, primary = false, depth = 0) => {
    if (depth > 8 || !value) return
    if (Array.isArray(value)) { for (const item of value.slice(0, 40)) visit(item, primary, depth + 1); return }
    if (!object(value)) return
    const types = [value['@type']].flat().map(type => clean(type).replace(/^https?:\/\/(?:www\.)?schema\.org\//i, '')), kind = types.includes('Person') ? 'person' : types.some(type => ['Organization', 'Corporation', 'EducationalOrganization', 'CollegeOrUniversity', 'School', 'LocalBusiness'].includes(type)) ? 'company' : null
    const name = clean(value.name, 400), entityUrl = publicUrl(value.url || value['@id'], url)
    const publisher = facultyDirectory && kind === 'company' && nameKey(name) !== nameKey(pageTitle.split(/\s+[–—|-]\s+/)[0])
    if (!publisher && kind && name && (depth === 0 && entityUrl && canonical(entityUrl) === canonical(url) || h1 && nameKey(name) === nameKey(h1) || (primary || ['/', '/about', '/about/'].includes(new URL(url).pathname)) && entityUrl && canonical(entityUrl) === canonical(url))) entities.push({ schema: value, kind })
    if (value['@graph']) visit(value['@graph'], false, depth + 1)
    if (value.mainEntity) visit(value.mainEntity, true, depth + 1)
  }
  const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(match => /\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json(?=\s|$))/i.test(match[1])).slice(0, 12)
  for (const script of scripts) if (Buffer.byteLength(script[2]) <= 64 * 1024) try { visit(JSON.parse(script[2])) } catch { /* Malformed source schema has no authority. */ }
  const faculty = facultyDirectory && facultyEducationPage(source, html, url, pageTitle, entities)
  if (faculty) return faculty
  const identities = new Set(entities.map(entity => `${entity.kind}:${nameKey(entity.schema.name)}`))
  if (!identities.size && text) {
    const profile = companyHomepage(source, url, expectedCompanyName, catalog)
    if (profile) { bounded(text, 'The readable profile'); bounded(html, 'The readable snapshot'); return { url, title: profile.name, text, html, profile } }
  }
  if (identities.size !== 1 || !text) throw new CrmError('No single verified public profile was found. Open the named person or company in Reader and capture the loaded page.', 422)
  bounded(text, 'The readable profile'); bounded(html, 'The readable snapshot')
  const selected = entities[0], title = pageTitle || clean(selected.schema.name, 300)
  const profile = schemaProfile(selected.schema, selected.kind, url)
  if (selected.kind === 'company' && page.pathname === '/' && !page.search) {
    const meta = homepageMetadata(source, url)
    if (!meta.siteName || nameKey(meta.siteName) === nameKey(profile.name)) {
      if (!profile.description) profile.description = meta.description
      if (!profile.images?.length && meta.icon) profile.images = [{ url: meta.icon, label: profile.name + ' website icon', subjectName: profile.name, isProfile: true }]
    }
  }
  return { url, title, text, html, profile }
}

/** Re-read retained Reader text only when its named subject is established by primary capture metadata. */
export function profileFromSavedText(text: string, metadata: Record<string, unknown>, inputUrl: string): ExtractedCrmProfile {
  const url = sourceUrl(inputUrl); bounded(text, 'The retained profile text')
  const lines = text.split(/\n+/).map(line => clean(line, 2000)).filter((line, index, all) => line && line !== all[index - 1]), supplied = object(metadata.profile) ? metadata.profile : null
  const linkedPerson = /(^|\.)linkedin\.com$/i.test(new URL(url).hostname) && /^\/in\//i.test(new URL(url).pathname)
  const explicitPerson = supplied?.entityType === 'person' && !!clean(supplied.name) && Array.isArray(supplied.affiliations)
  if (linkedPerson && !explicitPerson) throw new CrmError('This older LinkedIn text capture does not retain section boundaries and may include other people. Recapture the main profile with Reader 0.4 or newer before collecting its education or work.', 422)
  const references = [...(Array.isArray(metadata.profileImages) ? metadata.profileImages.slice(0, 8).filter(row => object(row) && row.isProfile === true) : []), ...(Array.isArray(metadata.profileLinks) ? metadata.profileLinks.slice(0, 32) : [])].filter(object)
  const names = new Set(references.filter(row => !row.sourceUrl || publicUrl(row.sourceUrl, url) && canonical(publicUrl(row.sourceUrl, url)) === canonical(url)).map(row => clean(row.subjectName, 400)).filter(Boolean))
  if (supplied && ['person', 'company'].includes(String(supplied.entityType)) && clean(supplied.name)) names.add(clean(supplied.name, 400))
  if (names.size !== 1) throw new CrmError('This saved source has no single named profile subject. Capture its main profile with Reader first.', 422)
  const name = [...names][0]
  if (!lines.slice(0, 12).some(line => nameKey(line) === nameKey(name))) throw new CrmError('The retained text does not begin with its captured subject. Reopen the main profile in Reader.', 422)
  const source = new URL(url), linkedKind = /(^|\.)linkedin\.com$/i.test(source.hostname) ? /^\/(?:company|school)\//i.test(source.pathname) ? 'company' : /^\/in\//i.test(source.pathname) ? 'person' : null : null
  if (linkedKind && supplied?.entityType && supplied.entityType !== linkedKind) throw new CrmError('The captured entity type conflicts with its LinkedIn source. Reopen the main profile in Reader.', 422)
  const profile: CapturedProfileData = { entityType: linkedKind || (supplied?.entityType === 'company' ? 'company' : 'person'), name, urls: [url], affiliations: [] }
  if (supplied) {
    for (const key of ['headline', 'description', 'location', 'industry'] as const) profile[key] = clean(supplied[key], key === 'description' ? 12_000 : 500)
    for (const key of ['emails', 'phones', 'urls'] as const) if (Array.isArray(supplied[key])) profile[key] = (supplied[key] as unknown[]).filter((value): value is string => typeof value === 'string').slice(0, 32)
    if (!profile.urls?.includes(url)) profile.urls = [url, ...profile.urls || []].slice(0, 32)
    if (Array.isArray(supplied.affiliations)) profile.affiliations = supplied.affiliations.slice(0, 60).filter(object).flatMap(row => { if (!['education', 'employment', 'membership', 'advisory'].includes(String(row.kind))) return []; const value = affiliation(row.kind as CrmAffiliation['kind'], row.organization, row); return value ? [value] : [] })
  }
  const kinds: Record<string, CrmAffiliation['kind']> = { education: 'education', experience: 'employment', 'work experience': 'employment', employment: 'employment', affiliations: 'membership', organizations: 'membership' }, stops = new Set(['about', 'skills', 'projects', 'publications', 'people also viewed', 'more profiles for you', 'more profiles to browse', 'people you may know', 'recommended for you', 'suggested for you', 'interests', 'contact', ...Object.keys(kinds)])
  if (profile.entityType === 'person' && !profile.affiliations?.length && !linkedPerson && !Array.isArray(supplied?.affiliations)) for (let index = 0; index < lines.length; index++) {
    const kind = kinds[nameKey(lines[index])]; if (!kind) continue
    const block: string[] = []; let cursor = index + 1
    while (cursor < lines.length && block.length < 80 && !stops.has(nameKey(lines[cursor]))) block.push(lines[cursor++])
    index = cursor - 1
    for (let row = 0; row < block.length && profile.affiliations!.length < 60; row++) {
      const first = block[row], next = block[row + 1] || '', third = block[row + 2] || '', range = (value: string) => value.match(/^((?:[A-Za-z]+\s+)?(?:19|20)\d{2})\s*(?:[–—]|\s-\s|(?<=\d{4})-(?=\d{4}))\s*((?:[A-Za-z]+\s+)?(?:19|20)\d{2}|Present)\b/i)
      let value: ReturnType<typeof affiliation> = null, consumed = 0
      if (kind === 'education') {
        const degreePattern = /\b(?:bachelor|master|doctor|phd|degree|diploma|certificate|BSc|MSc|BEng|MEng|B\.?A\.?|B\.?S\.?|M\.?A\.?|M\.?S\.?|MBA)\b/i
        if (range(first) || degreePattern.test(first) && !/\b(?:university|college|school|institute|academy)\b/i.test(first)) continue
        const degree = degreePattern.test(next) ? next : '', date = range(degree ? third : next)
        if (degree || date || /\b(?:university|college|school|institute|academy)\b/i.test(first)) { const parts = degree.split(/,\s+/); value = affiliation(kind, first, { degree: parts[0], field: parts.slice(1).join(', '), ...(date ? { startDate: date[1], ...(/^present$/i.test(date[2]) ? { current: true } : { endDate: date[2] }) } : {}), excerpt: [first, degree, date?.[0]].filter(Boolean).join(' · ') }); consumed = Number(!!degree) + Number(!!date) }
      } else if (kind === 'employment') {
        const date = range(third), explicit = first.match(/^(.+?)\s+(?:at|@)\s+(.+)$/)
        if (date || explicit) { value = affiliation(kind, explicit?.[2] || next, { role: explicit?.[1] || first, ...(date ? { startDate: date[1], ...(/^present$/i.test(date[2]) ? { current: true } : { endDate: date[2] }) } : {}), excerpt: [first, explicit ? '' : next, date?.[0]].filter(Boolean).join(' · ') }); consumed = explicit ? 0 : 2 }
      } else { const pair = first.split(/\s+[–—|·]\s+/); if (pair.length === 2) value = affiliation(kind, pair[0], { role: pair[1], excerpt: first }) }
      if (value) { profile.affiliations!.push(value); row += consumed }
    }
  }
  const html = `<article><pre>${escape(text)}</pre></article>`
  return { url, title: clean(metadata.title, 300) || name, text, ...(Buffer.byteLength(html) <= MAX_BYTES ? { html } : {}), profile }
}
