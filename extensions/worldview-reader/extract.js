/** Self-contained so Chrome can serialize this function into the explicitly chosen tab. */
export function extractArticle(doc = document) {
  const root = doc.querySelector('article') ?? doc.querySelector('main') ?? doc.body
  if (!root) throw new Error('This page has no readable document.')
  const forbidden = 'script,style,noscript,nav,footer,header,form,button,textarea,input,select,[hidden],[aria-hidden="true"]'
  const walker = doc.createTreeWalker(root, 4), segments = []
  let node, text = '', previousBlock = null
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (!parent || parent.closest(forbidden)) continue
    let hidden = false
    for (let element = parent; element && root.contains(element); element = element.parentElement) {
      const style = doc.defaultView?.getComputedStyle(element)
      if (style?.display === 'none' || style?.visibility === 'hidden') { hidden = true; break }
      if (element === root) break
    }
    if (hidden || !node.nodeValue) continue
    const block = parent.closest('p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td') ?? root
    if (previousBlock && block !== previousBlock && node.nodeValue.trim()) text += '\n\n'
    const start = text.length; text += node.nodeValue
    segments.push({ node, start, end: text.length }); if (node.nodeValue.trim()) previousBlock = block
    if (text.length > 512 * 1024) throw new Error('This article is too large. Paste a smaller excerpt into Worldview instead.')
  }
  const leading = text.length - text.trimStart().length
  text = text.trim()
  if (!text || new TextEncoder().encode(text).byteLength > 512 * 1024) throw new Error('No readable article text was found, or it exceeds 512 KiB.')
  let selection = null
  const selected = doc.getSelection()
  if (selected?.rangeCount && !selected.isCollapsed) {
    const range = selected.getRangeAt(0)
    if (root.contains(range.commonAncestorContainer)) {
      const included = segments.filter((segment) => range.intersectsNode(segment.node))
      if (included.length) {
        const first = included[0], last = included.at(-1)
        const start = Math.max(0, first.start + (range.startContainer === first.node ? range.startOffset : 0) - leading)
        const end = Math.min(text.length, last.end - (range.endContainer === last.node ? last.node.length - range.endOffset : 0) - leading)
        const quote = text.slice(start, end)
        if (quote.trim() && quote.length <= 20_000) selection = { quote, start, end, prefix: text.slice(Math.max(0, start - 80), start), suffix: text.slice(end, end + 80) }
      }
    }
  }
  // These are references from the chosen page, never a crawl or a background image request.
  const pageUrl = doc.location.href, profileImages = [], profileLinks = []
  const publicUrl = value => { if (typeof value !== 'string' || !value.trim()) return ''; try { const url = new URL(value, pageUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return ''; url.hash = ''; return url.href } catch { return '' } }
  const nameKey = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const isLinkedInProfile = /(^|\.)linkedin\.com$/i.test(doc.location.hostname) && /^\/in\/[^/]+\/?$/.test(doc.location.pathname)
  const linkedInTitle = isLinkedInProfile ? doc.title.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*LinkedIn\s*$/i, '').trim().slice(0, 200) : ''
  const pageName = linkedInTitle || root.querySelector('h1')?.textContent?.trim().slice(0, 200) || ''
  const image = (value, label, isProfile = false, subjectName = '') => { const url = publicUrl(value); if (url && profileImages.length < 8 && !profileImages.some(item => item.url === url)) profileImages.push({ url, sourceUrl: pageUrl, label: String(label || 'Page image').slice(0, 200), isProfile, ...(subjectName ? { subjectName: String(subjectName).slice(0, 200) } : {}) }) }
  const link = (value, subjectName = '') => { const url = publicUrl(value); if (url && profileLinks.length < 32 && !profileLinks.some(item => item.url === url)) profileLinks.push({ url, rel: 'me', ...(subjectName ? { subjectName: String(subjectName).slice(0, 200) } : {}) }) }
  // Profile images often use aria-hidden to avoid repeating their enclosing link's label.
  // Actual visual hiding, rather than decorative accessibility semantics, controls capture.
  const visiblePhoto = element => { for (let part = element; part; part = part.parentElement) { const style = doc.defaultView?.getComputedStyle(part); if (part.hidden || style?.display === 'none' || style?.visibility === 'hidden') return false } return true }
  if (isLinkedInProfile) {
    const photoLink = [...doc.querySelectorAll('a,button,[role="img"]')].find(element => /^(?:profile photo|profile picture|open profile photo|view profile photo)$/i.test(element.getAttribute('aria-label') || ''))
    const namedPortrait = pageName ? [...root.querySelectorAll('img[alt]')].find(element => {
      const label = nameKey(element.getAttribute('alt')), name = nameKey(pageName)
      return label === name || label === `${name} s profile picture` || label === `profile photo of ${name}` || label === `profile picture of ${name}`
    }) : null
    const portrait = photoLink?.querySelector('img') || doc.querySelector('main img.pv-top-card-profile-picture__image,main img.profile-photo-edit__preview,main img[data-anonymize="headshot-photo"],main .pv-top-card__photo-wrapper img') || namedPortrait
    if (portrait && visiblePhoto(portrait)) image(portrait.currentSrc || portrait.src, portrait.alt || 'LinkedIn profile photo', true, pageName)
    if (!portrait && photoLink && visiblePhoto(photoLink)) {
      const background = doc.defaultView?.getComputedStyle(photoLink).backgroundImage?.match(/^url\(["']?(.*?)["']?\)$/)?.[1]
      if (background) image(background, 'Visible LinkedIn profile photo', true, pageName)
    }
  }
  for (const anchor of doc.querySelectorAll('a[rel~="me"]')) link(anchor.getAttribute('href'))
  const visit = (value, depth = 0) => {
    if (!value || depth > 8) return
    if (Array.isArray(value)) { for (const item of value.slice(0, 30)) visit(item, depth + 1); return }
    if (typeof value !== 'object') return
    if ([value['@type']].flat().includes('Person')) {
      const subjectName = typeof value.name === 'string' ? value.name : '', subjectUrl = publicUrl(value.url)
      const primaryPerson = !!subjectName && (nameKey(subjectName) === nameKey(pageName) || !!subjectUrl && subjectUrl.replace(/\/$/, '') === publicUrl(pageUrl)?.replace(/\/$/, ''))
      const portrait = [value.image].flat().find(Boolean)
      if (portrait) image(typeof portrait === 'string' ? portrait : portrait.url || portrait.contentUrl, value.name || 'Profile photo', primaryPerson, subjectName)
      if (primaryPerson) {
        for (const url of [value.sameAs].flat().slice(0, 32)) if (typeof url === 'string') link(url, subjectName)
        if (typeof value.url === 'string') link(value.url, subjectName)
      }
    }
    if (value['@graph']) visit(value['@graph'], depth + 1)
    if (value.mainEntity) visit(value.mainEntity, depth + 1)
  }
  for (const script of [...doc.querySelectorAll('script[type="application/ld+json"]')].slice(0, 12)) { if (script.textContent.length <= 64 * 1024) try { visit(JSON.parse(script.textContent)) } catch { /* A malformed site schema is not a capture failure. */ } }
  const meta = property => doc.querySelector(`meta[property="${property}"],meta[name="${property}"]`)?.content
  image(meta('og:image') || meta('twitter:image'), 'Page preview image', meta('og:type') === 'profile', meta('og:type') === 'profile' ? pageName : '')
  return { url: pageUrl, title: (doc.title || root.querySelector('h1')?.textContent || 'Saved article').trim().slice(0, 300), text, selection, profileImages, profileLinks }
}

/** A bounded diagnostic of rendered Folk rows, separate from article/knowledge capture. */
export function extractFolkPhotos(doc = document) {
  const sourceUrl = doc.location.href, page = new URL(sourceUrl), uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  const group = page.hostname === 'app.folk.app' && page.protocol === 'https:' && !page.username && !page.password ? page.pathname.match(new RegExp(`^/apps/contacts/network/(${uuid})/groups/(${uuid})(?:/|$)`, 'i')) : null
  const search = page.hostname === 'app.folk.app' && page.protocol === 'https:' && !page.username && !page.password ? page.pathname.match(new RegExp(`^/apps/contacts/network/(${uuid})/search$`, 'i')) : null
  if (!group && !search) throw new Error('Open a Folk contact group or its Search list before capturing visible photo diagnostics.')
  const groupId = group ? `grp_${group[2].toLowerCase()}` : '', rows = [], photos = [], seen = new Set(), identity = new RegExp(`^(?:per_)?${uuid}$`, 'i')
  const personPath = group ? new RegExp(`^/apps/contacts/network/${group[1]}/groups/${group[2]}/people/(${uuid})/?$`, 'i') : null
  const publicUrl = value => { if (typeof value !== 'string' || !value.trim()) return ''; try { const url = new URL(value, sourceUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) return ''; return url.href } catch { return '' } }
  const shown = element => {
    for (let part = element; part; part = part.parentElement) { const style = doc.defaultView?.getComputedStyle(part); if (part.hidden || style?.display === 'none' || style?.visibility === 'hidden' || style?.opacity === '0') return false }
    return true
  }
  const visible = element => {
    const box = element.getBoundingClientRect(), view = doc.defaultView
    if (box.width < 12 || box.height < 12 || box.bottom <= 0 || box.right <= 0 || view && (box.top >= view.innerHeight || box.left >= view.innerWidth)) return false
    return shown(element)
  }
  const visibleName = container => {
    const walker = doc.createTreeWalker(container, 4)
    let node
    while ((node = walker.nextNode())) {
      const parent = node.parentElement, value = node.nodeValue?.trim()
      if (!parent || !value || parent.closest('script,style,noscript,form,input,textarea,[hidden],[aria-hidden="true"]')) continue
      let hidden = false
      for (let part = parent; part; part = part.parentElement) { const style = doc.defaultView?.getComputedStyle(part); if (style?.display === 'none' || style?.visibility === 'hidden' || style?.opacity === '0') { hidden = true; break } if (part === container) break }
      if (!hidden) return value.slice(0, 200)
    }
    return ''
  }
  const visibleEmails = container => {
    const walker = doc.createTreeWalker(container, 4), parts = []
    let node, size = 0
    while ((node = walker.nextNode())) {
      const parent = node.parentElement, value = node.nodeValue?.trim()
      if (!parent || !value || parent.closest('script,style,noscript,form,input,textarea,[hidden],[aria-hidden="true"]') || !visible(parent)) continue
      parts.push(value); size += value.length
      if (size > 8000) break
    }
    return [...new Set((parts.join(' ').match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || []).filter(value => value.length <= 320).map(value => value.toLowerCase()))].slice(0, 8)
  }
  const avatarLabel = (image, row) => {
    for (let part = image, depth = 0; part && depth < 5; part = part.parentElement, depth++) {
      if (shown(part)) {
        const direct = part.getAttribute('alt') || part.getAttribute('aria-label') || part.getAttribute('title')
        if (direct?.trim()) return direct.trim().slice(0, 200)
        const labels = (part.getAttribute('aria-labelledby') || '').split(/\s+/).slice(0, 8).flatMap(id => { const label = doc.getElementById(id); return label && row.contains(label) && shown(label) ? [visibleName(label)] : [] }).filter(Boolean)
        if (labels.length) return labels.join(' ').slice(0, 200)
      }
      if (part === row) break
    }
    return ''
  }
  for (const image of doc.querySelectorAll('img')) {
    if (rows.length >= 50) break
    if (!visible(image)) continue
    const photoUrl = publicUrl(image.currentSrc || image.getAttribute('src'))
    if (!photoUrl) continue
    let row = image.closest('[role="row"],tr,[role="listitem"],[role="option"],li,[data-person-id],[data-contact-id],[data-record-id],[data-row-id],[data-id]')
    if (!row) { row = image.parentElement || image; for (let depth = 0; depth < 3 && row.parentElement; depth++) { const parent = row.parentElement; if (parent.getBoundingClientRect().height > 150 || parent.querySelectorAll('img').length > 3) break; row = parent } }
    const attributes = {}
    for (let part = image, depth = 0; part && depth < 7; part = part.parentElement, depth++) {
      for (const name of ['data-person-id', 'data-contact-id', 'data-record-id', 'data-row-id', 'data-id', 'id']) { const value = part.getAttribute(name); if (value && identity.test(value) && !attributes[name]) attributes[name] = value }
      if (part === row) break
    }
    const nearbyLinks = [...row.querySelectorAll('a[href]')].filter(shown).slice(0, 8).flatMap(anchor => { const href = publicUrl(anchor.getAttribute('href')); return href ? [{ href, text: visibleName(anchor) }] : [] })
    const personLinks = nearbyLinks.flatMap(link => { const url = new URL(link.href), person = personPath && url.origin === page.origin && !url.search && !url.hash && url.pathname.match(personPath); return person && link.text ? [{ ...link, personId: `per_${person[1].toLowerCase()}` }] : [] })
    const ids = new Set(personLinks.map(link => link.personId)), namedLink = ids.size === 1 ? personLinks[0] : null
    const alt = (image.getAttribute('alt') || '').trim(), firstLine = visibleName(row)
    const accessibleLabel = search ? avatarLabel(image, row) : ''
    const name = (search ? firstLine || accessibleLabel : namedLink?.text || (/^(?:avatar|photo|profile(?: photo| picture)?|logo|thumbnail)$/i.test(alt) ? '' : alt) || firstLine).slice(0, 200)
    const key = JSON.stringify([photoUrl, attributes, nearbyLinks])
    if (seen.has(key)) continue
    const rowImageCount = row.querySelectorAll('img').length
    const unambiguousRowImage = !alt && row.matches('tr,[role="row"]') && rowImageCount === 1 && personLinks.length === 1 && nearbyLinks.length === 1
    const namedImage = alt ? alt.replace(/\s+/g, ' ') === name.replace(/\s+/g, ' ') : unambiguousRowImage
    const requested = [publicUrl(image.getAttribute('src')), ...(image.getAttribute('srcset') || '').split(',').map(value => publicUrl(value.trim().split(/\s+/)[0]))].filter(Boolean)
    const loaded = image.complete && image.naturalWidth >= 24 && image.naturalHeight >= 24 && requested.includes(publicUrl(image.currentSrc))
    const verifiedReason = !namedLink ? ids.size > 1 ? 'ambiguous-person-links' : 'no-same-group-person-link' : !namedImage ? 'image-name-mismatch' : !image.complete ? 'loading' : image.naturalWidth < 24 || image.naturalHeight < 24 ? 'image-too-small' : !requested.includes(publicUrl(image.currentSrc)) ? 'stale-current-source' : !personLinks.every(link => link.text === namedLink.text) ? 'ambiguous-person-name' : 'verified'
    const imageState = { alt: alt.slice(0, 200), ariaLabel: (image.getAttribute('aria-label') || '').slice(0, 200), title: (image.getAttribute('title') || '').slice(0, 200), rowImageCount, complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, currentSrc: publicUrl(image.currentSrc), requestedSources: requested.slice(0, 8), personLinkCount: personLinks.length, verifiedReason }
    seen.add(key); rows.push({ photoUrl, name, nearbyLinks, attributes, sourceUrl, groupId, imageState, ...(search ? { visibleEmails: visibleEmails(row), rowRole: (row.getAttribute('role') || row.tagName.toLowerCase()).slice(0, 40), avatarLabel: accessibleLabel, isPrimaryAvatar: row.querySelector('img') === image } : {}) })
    if (namedLink && namedImage && loaded && personLinks.every(link => link.text === namedLink.text) && name === namedLink.text) photos.push({ personId: namedLink.personId, name, photoUrl, sourceUrl: namedLink.href, groupId })
  }
  // Only the verified same-workspace/group person-link shape can identify a row; names alone never do.
  const verified = photos.filter((photo, index) => photos.findIndex(other => other.personId === photo.personId) === index && !photos.some(other => other.personId === photo.personId && (other.photoUrl !== photo.photoUrl || other.name !== photo.name)))
  return { url: sourceUrl, title: (doc.title || 'Folk visible contact photos').slice(0, 300), groupId, ...(search ? { scope: 'network-search-diagnostic' } : {}), folkPhotos: search ? [] : verified, folkPhotoRows: rows }
}

/** Source-bound, non-AI profile extraction. Serialized only into a tab explicitly chosen by the user. */
export function extractProfile(doc = document, reportError = false) {
  try {
  doc = doc || document
  const page = new URL(doc.location.href), main = doc.querySelector('main,[role="main"],[aria-label="Primary content" i]') || doc.querySelector('article') || doc.body
  if (!main || !['http:', 'https:'].includes(page.protocol) || page.username || page.password || page.hostname === 'app.folk.app') throw new Error('Open the person’s profile or company website. Folk imports use their separate private capture action.')
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim(), nameKey = value => clean(value).normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const url = value => { try { const parsed = new URL(String(value || ''), page.href); if (!value || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href.length > 2048) return ''; parsed.hash = ''; return parsed.href } catch { return '' } }
  const canonical = value => { try { const parsed = new URL(value); parsed.hash = ''; parsed.search = ''; return parsed.href.replace(/\/$/, '') } catch { return '' } }
  const blocked = 'script,style,noscript,nav,footer,aside,[role="complementary"],[aria-label="Aside" i],form,input,textarea,select,button,[hidden],.visually-hidden,.sr-only,[class*="visually-hidden"],[data-worldview-reader]'
  const shown = element => { for (let part = element; part; part = part.parentElement) { const style = doc.defaultView?.getComputedStyle(part); if (part.matches(blocked) || style?.display === 'none' || style?.visibility === 'hidden' || style?.opacity === '0') return false } return true }
  const textOf = element => {
    if (!element || !shown(element)) return ''
    const walker = doc.createTreeWalker(element, 4); let node, previous = null, text = ''
    while ((node = walker.nextNode())) {
      const parent = node.parentElement
      if (!parent || !node.nodeValue?.trim() || !shown(parent)) continue
      const block = parent.closest('p,h1,h2,h3,h4,h5,h6,li,div,dt,dd,blockquote,section') || element
      if (previous && block !== previous) text += '\n'
      text += `${node.nodeValue} `; previous = block
      if (text.length > 512 * 1024) throw new Error('This profile exceeds the local capture limit. Open a smaller profile section.')
    }
    return text.split(/\n+/).map(clean).filter((line, index, all) => line && line !== all[index - 1]).join('\n')
  }
  const linkedIn = /(^|\.)linkedin\.com$/i.test(page.hostname), personPage = linkedIn && /^\/in\/[^/]+\/?$/.test(page.pathname), companyPage = linkedIn && /^\/(?:company|school)\/[^/]+(?:\/(?:about|people|posts|jobs|life))?\/?$/.test(page.pathname)
  if (linkedIn && !personPage && !companyPage) throw new Error('Open a person’s main LinkedIn profile or a company page before saving profile data.')
  if (linkedIn && main === doc.body) throw new Error('Reader could not find LinkedIn’s primary profile content. Wait for the main profile to load, then try again. Messaging and unrelated page areas are not captured.')
  const titleSubject = personPage && /\|\s*LinkedIn\s*$/i.test(doc.title) ? clean(doc.title.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*LinkedIn\s*$/i, '')).slice(0, 200) : ''
  let heading = [...main.querySelectorAll('h1,[role="heading"][aria-level="1"]')].find(shown), headingName = clean(textOf(heading)).slice(0, 200), subjectHeader = null, titleContactMatches = 0
  if (personPage && !headingName) {
    const verification = /\s+View\s+.+?[’']s\s+verifications?\s*$/i, anchors = [...main.querySelectorAll('a[href]')].filter(shown)
    const contacts = anchors.filter(anchor => { const href = url(anchor.getAttribute('href')); if (!href || !['contact info', 'contact information'].includes(nameKey(textOf(anchor) || anchor.getAttribute('aria-label')))) return false; const target = new URL(href); return target.origin === page.origin && target.pathname.replace(/\/$/, '') === `${page.pathname.replace(/\/$/, '')}/overlay/contact-info` })
    const candidates = anchors.flatMap(anchor => {
      const href = url(anchor.getAttribute('href')); if (!href) return []
      const label = clean(textOf(anchor) || anchor.getAttribute('aria-label')), primaryHeader = anchor.closest('header,[role="banner"],.pv-top-card'), titleAgreement = !!titleSubject && nameKey(label) === nameKey(titleSubject)
      let boundHeader = canonical(href) === canonical(page.href) && (primaryHeader || verification.test(label)) ? primaryHeader || anchor.parentElement : null
      let contactBound = false
      if (!boundHeader && (verification.test(label) || titleAgreement)) for (let part = anchor.parentElement, depth = 0; part && part !== main && depth < 8; part = part.parentElement, depth++) {
        if ([...part.querySelectorAll('h2,h3,[role="heading"]')].some(element => shown(element) && ['activity', 'experience', 'education', 'about', 'more profiles for you', 'people also viewed'].includes(nameKey(textOf(element))))) break
        if (contacts.some(contact => part.contains(contact))) { boundHeader = part; contactBound = true; break }
      }
      if (!boundHeader) return []
      const name = label.replace(verification, '').trim()
      return name && name.length <= 200 && !/^(?:view|show|see|open|contact|more|message|follow|connect|profile|back|experience|education)\b/i.test(name) ? [{ anchor, name, header: boundHeader, titleContact: titleAgreement && contactBound }] : []
    })
    titleContactMatches = candidates.filter(candidate => candidate.titleContact).length
    const names = new Set(candidates.map(item => nameKey(item.name)))
    if (names.size === 1 && (!titleContactMatches || candidates.length === 1)) { heading = candidates[0].anchor; headingName = candidates[0].name; subjectHeader = candidates[0].header }
    else if (names.size > 1) throw new Error('Several names appear on this profile’s header links. Keep one person’s main profile visible and try again.')
  }
  const schemas = []
  const visit = (value, primary = false, depth = 0) => {
    if (!value || depth > 8) return
    if (Array.isArray(value)) { for (const child of value.slice(0, 40)) visit(child, primary, depth + 1); return }
    if (typeof value !== 'object') return
    const types = [value['@type']].flat(), kind = types.includes('Person') ? 'person' : types.some(type => ['Organization', 'Corporation', 'EducationalOrganization', 'CollegeOrUniversity', 'School', 'LocalBusiness'].includes(type)) ? 'company' : ''
    const subjectName = clean(value.name), boundUrl = url(value.url || value['@id'])
    if (kind && subjectName && (headingName && nameKey(subjectName) === nameKey(headingName) || primary && boundUrl && canonical(boundUrl) === canonical(page.href))) schemas.push({ value, kind, name: subjectName })
    if (value['@graph']) visit(value['@graph'], false, depth + 1)
    if (value.mainEntity) visit(value.mainEntity, true, depth + 1)
  }
  for (const script of [...doc.querySelectorAll('script[type="application/ld+json"]')].slice(0, 12)) if (script.textContent.length <= 64 * 1024) try { visit(JSON.parse(script.textContent)) } catch { /* Site schema is optional; visible LinkedIn sections remain usable. */ }
  const matching = schemas.filter(item => !personPage && !companyPage || item.kind === (personPage ? 'person' : 'company'))
  const identities = new Set(matching.map(item => `${item.kind}:${nameKey(item.name)}`))
  if (identities.size > 1 && !personPage && !companyPage) throw new Error('Several primary profile identities are present. Open a page dedicated to one person or company.')
  const labeledHeadings = [...main.querySelectorAll('h2,h3')].filter(shown).map(element => nameKey(textOf(element)))
  const genericPerson = !linkedIn && !matching.length && !!headingName && labeledHeadings.includes('education') && labeledHeadings.some(label => ['experience', 'work experience', 'employment'].includes(label)) && [...main.querySelectorAll('img[alt]')].some(image => shown(image) && nameKey(image.alt) === nameKey(headingName))
  const schema = matching[0]?.value, entityType = personPage || genericPerson ? 'person' : companyPage ? 'company' : matching[0]?.kind
  const name = (personPage || companyPage ? headingName : matching[0]?.name || headingName).slice(0, 200)
  if (!entityType || !name || /^(?:experience|education|home|about|people|sign in|join linkedin)$/i.test(name)) throw new Error('No single named person or company was found. Open its main profile page with the name visible.')
  const top = subjectHeader || heading?.closest('section,header,[role="banner"],[itemscope],.pv-top-card,.org-top-card') || (companyPage ? main.querySelector('.org-top-card') : null) || heading?.parentElement || main
  const profile = { entityType, name, headline: '', description: '', location: '', emails: [], phones: [], urls: [], industry: '', affiliations: [], images: [] }
  const addUrl = value => { const next = url(value); if (next && profile.urls.length < 32 && !profile.urls.includes(next)) profile.urls.push(next) }
  addUrl(personPage || companyPage ? `${page.origin}/${personPage ? 'in' : page.pathname.split('/')[1]}/${page.pathname.split('/')[2]}/` : page.href)
  const addImage = (value, label, isProfile = false) => { const next = url(value); if (next && profile.images.length < 8 && !profile.images.some(image => image.url === next)) profile.images.push({ url: next, label: clean(label).slice(0, 200), isProfile, subjectName: name }) }
  const addAffiliation = value => {
    const organization = clean(value.organization).slice(0, 300)
    if (!organization || profile.affiliations.length >= 60) return
    const row = { kind: value.kind, organization, ...Object.fromEntries(['role', 'degree', 'field', 'startDate', 'endDate', 'excerpt'].flatMap(key => clean(value[key]) ? [[key, clean(value[key]).slice(0, key === 'excerpt' ? 2000 : 300)]] : [])), ...(value.current === true ? { current: true } : {}), ...(url(value.organizationUrl) ? { organizationUrl: url(value.organizationUrl) } : {}) }
    if (!profile.affiliations.some(old => JSON.stringify(old) === JSON.stringify(row))) profile.affiliations.push(row)
  }
  const schemaText = value => typeof value === 'string' ? clean(value) : value && typeof value === 'object' ? clean(value.name) : ''
  if (schema) {
    profile.headline = schemaText(schema.jobTitle || schema.slogan).slice(0, 500); profile.description = schemaText(schema.description).slice(0, 12_000)
    profile.location = typeof schema.address === 'string' ? clean(schema.address).slice(0, 500) : schema.address && typeof schema.address === 'object' ? ['addressLocality', 'addressRegion', 'addressCountry'].map(key => schemaText(schema.address[key])).filter(Boolean).join(', ').slice(0, 500) : ''
    profile.industry = schemaText(schema.industry).slice(0, 300)
    for (const value of [schema.email].flat()) if (typeof value === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.replace(/^mailto:/i, ''))) profile.emails.push(value.replace(/^mailto:/i, '').slice(0, 320))
    for (const value of [schema.telephone].flat()) if (typeof value === 'string' && /\d/.test(value)) profile.phones.push(clean(value).slice(0, 100))
    for (const value of [schema.url, ...[schema.sameAs].flat()]) addUrl(value)
    for (const value of [schema.image, schema.logo].flat()) if (value) addImage(typeof value === 'string' ? value : value.url || value.contentUrl, `${name} source image`, false)
    if (entityType === 'person') for (const [property, kind] of [['alumniOf', 'education'], ['worksFor', 'employment'], ['memberOf', 'membership'], ['affiliation', 'membership']]) for (const organization of [schema[property]].flat().slice(0, 30)) if (organization) addAffiliation({ kind, organization: schemaText(organization), organizationUrl: typeof organization === 'object' ? organization.url : '', ...(kind === 'employment' ? { role: profile.headline, current: true } : {}), degree: typeof organization === 'object' ? organization.degree : '', field: typeof organization === 'object' ? organization.fieldOfStudy : '', excerpt: `${name} · ${property}: ${schemaText(organization)}` })
  }
  const findSection = (id, labels) => {
    const anchor = main.querySelector(`[id="${id}"]`)
    if (anchor && shown(anchor)) { const section = anchor.matches('section') ? anchor : anchor.closest('section'); if (section && section !== main && shown(section)) return section }
    const label = [...main.querySelectorAll('h2,h3,[role="heading"]')].find(element => shown(element) && labels.includes(nameKey(textOf(element))))
    const section = label?.closest('section,[role="region"]'); if (section && section !== main) return section
    for (let part = label?.parentElement, depth = 0; part && part !== main && depth < 8; part = part.parentElement, depth++) {
      const headings = [...part.querySelectorAll('h2,h3,[role="heading"]')].filter(shown).map(element => nameKey(textOf(element)))
      if (headings.some(value => ['education', 'experience', 'work experience', 'employment', 'organizations', 'affiliations', 'more profiles for you', 'people also viewed'].includes(value) && !labels.includes(value))) return null
      if (part.querySelector('ul,ol,[role="list"]')) return part
    }
    return null
  }
  const datePattern = /\b((?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+)?(?:19|20)\d{2})\s*[–—-]\s*(Present|(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+)?(?:19|20)\d{2})\b/i
  const dates = parts => { const match = parts.map(part => part.match(datePattern)).find(Boolean); return match ? { startDate: match[1], ...(/^present$/i.test(match[2]) ? { current: true } : { endDate: match[2] }) } : {} }
  if (personPage || genericPerson) {
    profile.headline = clean(textOf(top.querySelector('.text-body-medium,.pv-text-details__left-panel .text-body-medium,[data-generated-suggestion-target="headline"]'))) || profile.headline
    profile.location = clean(textOf(top.querySelector('.text-body-small.inline.t-black--light,.pv-text-details__left-panel span.text-body-small'))) || profile.location
    const about = findSection('about', ['about']); if (about) profile.description = textOf(about).replace(/^About\s*/i, '').slice(0, 12_000) || profile.description
    for (const [id, labels, kind] of [['education', ['education'], 'education'], ['experience', ['experience', 'work experience', 'employment'], 'employment'], ['volunteering_experience', ['volunteering', 'volunteer experience'], 'membership'], ['organizations', ['organizations', 'affiliations'], 'membership']]) {
      const section = findSection(id, labels); if (!section) continue
      const records = [...new Set([...section.querySelectorAll('li,[role="listitem"]'), ...[...section.querySelectorAll('ul,ol,[role="list"]')].flatMap(list => [...list.children])])].filter(record => shown(record) && !record.querySelector('li,[role="listitem"],ul,ol,[role="list"]'))
      for (const record of records.slice(0, 40)) {
        if (kind !== 'employment' && record.parentElement?.closest('li,[role="listitem"]') && !record.querySelector('.t-bold,h3,h4,[role="heading"],[data-field="title"]')) continue
        const parts = textOf(record).split('\n').map(clean).filter(Boolean), linkSelector = kind === 'education' ? 'a[href*="/school/"]' : 'a[href*="/company/"],a[href*="/school/"]'
        const ownLinks = [...record.querySelectorAll(linkSelector)].filter(shown), ownIdentities = new Set(ownLinks.map(anchor => canonical(url(anchor.getAttribute('href')))))
        if (kind === 'employment' && ownIdentities.size > 1) continue
        let organizationLink = ownLinks.find(anchor => textOf(anchor) && !datePattern.test(textOf(anchor)))
        for (let parent = record.parentElement; !organizationLink && parent && parent !== section && section.contains(parent); parent = parent.parentElement) {
          const links = [...parent.querySelectorAll(linkSelector)].filter(shown), identities = new Set(links.map(anchor => canonical(url(anchor.getAttribute('href')))))
          if (identities.size > 1) break
          if (identities.size === 1) organizationLink = links.find(anchor => !!textOf(anchor) && !datePattern.test(textOf(anchor)))
        }
        if (kind === 'employment' && !organizationLink && ownLinks.length) continue
        const linkedName = organizationLink ? textOf(organizationLink).split('\n').find(Boolean) : '', organization = clean(linkedName || (kind === 'education' ? parts[0] : parts[1])).replace(/\s*[·|]\s*(?:full.time|part.time|self.employed|contract|internship|freelance).*$/i, '').replace(/\s+(?:full.time|part.time|self.employed|contract|internship|freelance)\s+(?:\d+\s+(?:yrs?|years?|mos?|months?).*)$/i, '')
        if (!organization || !parts.length) continue
        const recordDates = dates(parts)
        if (kind === 'employment' && record.parentElement?.closest('li,[role="listitem"]') && !recordDates.startDate) continue
        const degreeLine = kind === 'education' ? parts.find(part => part !== organization && !/\b(?:19|20)\d{2}\b/.test(part)) || '' : '', degreeParts = degreeLine.split(/,\s+/)
        const role = parts.map(part => { const date = part.match(datePattern); return date ? part.slice(0, date.index).trim() : part }).find(part => part && part !== organization && !/^(?:full.time|part.time|self.employed|contract|internship|freelance|\d+\s+(?:yrs?|years?|mos?|months?))\b/i.test(part))
        addAffiliation({ kind, organization, organizationUrl: organizationLink?.getAttribute('href'), ...(kind === 'education' ? { degree: degreeParts[0], field: degreeParts.slice(1).join(', ') } : { role }), ...recordDates, excerpt: parts.join(' · ').slice(0, 2000) })
      }
    }
    const portrait = top.querySelector('img.pv-top-card-profile-picture__image,img.profile-photo-edit__preview,img[data-anonymize="headshot-photo"],.pv-top-card__photo-wrapper img') || [...top.querySelectorAll('img[alt]')].find(image => nameKey(image.alt) === nameKey(name))
    if (portrait && shown(portrait)) addImage(portrait.currentSrc || portrait.getAttribute('src'), portrait.alt || `${name} profile photo`, true)
  }
  if (companyPage) {
    profile.headline = clean(textOf(main.querySelector('.org-top-card-summary__tagline'))) || profile.headline
    const about = findSection('about', ['overview', 'about', 'about us']) || main.querySelector('.org-page-details-module__card-spacing')
    if (about) {
      const paragraph = [...about.querySelectorAll('p')].find(shown); if (paragraph) profile.description = textOf(paragraph).slice(0, 12_000)
      for (const term of about.querySelectorAll('dt')) {
        if (!shown(term)) continue
        const definition = term.nextElementSibling, label = nameKey(textOf(term)), value = textOf(definition)
        if (label === 'industry') profile.industry = value.slice(0, 300)
        if (['headquarters', 'location'].includes(label)) profile.location = value.slice(0, 500)
        if (label === 'website') for (const anchor of definition?.querySelectorAll('a[href]') || []) addUrl(anchor.getAttribute('href'))
      }
    }
    const logo = main.querySelector('img.org-top-card-primary-content__logo,img.org-top-card-summary__logo') || [...top.querySelectorAll('img[alt]')].find(image => [nameKey(name), `${nameKey(name)} logo`].includes(nameKey(image.alt)))
    if (logo && shown(logo)) addImage(logo.currentSrc || logo.getAttribute('src'), logo.alt || `${name} logo`, true)
  }
  for (const anchor of top.querySelectorAll('a[href]')) if (shown(anchor)) {
    const href = anchor.getAttribute('href') || ''
    if (/^mailto:/i.test(href)) { const email = href.slice(7).split('?')[0]; if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !profile.emails.includes(email)) profile.emails.push(email.slice(0, 320)) }
    else if (/^tel:/i.test(href)) { const phone = href.slice(4); if (/\d/.test(phone) && !profile.phones.includes(phone)) profile.phones.push(phone.slice(0, 100)) }
    else if (anchor.rel.split(/\s+/).includes('me')) addUrl(href)
  }
  // Retain the readable structure of the chosen page; no executable DOM, forms or third-party widgets.
  const allowedTags = new Set(['ARTICLE', 'MAIN', 'SECTION', 'DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'BLOCKQUOTE', 'PRE', 'CODE', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'BR', 'HR', 'A', 'SPAN', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD'])
  const snapshot = doc.createElement('article'); let htmlSize = 0
  const copy = (source, destination) => {
    if (source.nodeType === 3) { if (source.nodeValue?.trim()) { const value = source.nodeValue; destination.appendChild(doc.createTextNode(value)); htmlSize += value.length } return }
    if (source.nodeType !== 1 || !shown(source)) return
    const target = allowedTags.has(source.tagName) ? doc.createElement(source.tagName.toLowerCase()) : destination
    if (target !== destination) {
      if (source.tagName === 'A') { const href = url(source.getAttribute('href')); if (href) { target.setAttribute('href', href); target.setAttribute('rel', 'noreferrer noopener') } }
      destination.appendChild(target)
    }
    for (const child of source.childNodes) { if (htmlSize > 384 * 1024) throw new Error('This profile snapshot is too large. Open a smaller profile section.'); copy(child, target) }
  }
  for (const child of main.childNodes) copy(child, snapshot)
  const text = textOf(main), html = snapshot.outerHTML
  if (!text || new TextEncoder().encode(text).byteLength > 512 * 1024 || new TextEncoder().encode(html).byteLength > 512 * 1024) throw new Error('No readable profile text was found, or the snapshot exceeds 512 KiB.')
  profile.emails = [...new Set(profile.emails)].slice(0, 32); profile.phones = [...new Set(profile.phones)].slice(0, 32)
  return { url: page.href, title: clean(doc.title || name).slice(0, 300), text, html, profile }
  } catch (error) {
    if (reportError) return { extractorError: error instanceof Error ? error.message : 'This page could not be read. Open its main profile with its name visible and try again.' }
    throw error
  }
}
