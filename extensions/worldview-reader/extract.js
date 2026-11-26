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
  const visibility = new WeakMap()
  const rendered = element => {
    const style = doc.defaultView?.getComputedStyle(element)
    return !element.hidden && style?.display !== 'none' && style?.visibility !== 'hidden' && style?.opacity !== '0'
  }
  const shown = element => {
    if (!element) return false
    if (visibility.has(element)) return visibility.get(element)
    const visible = !element.matches(blocked) && rendered(element) && (!element.parentElement || shown(element.parentElement))
    visibility.set(element, visible)
    return visible
  }
  const listSelector = 'ul,ol,[role="list"]'
  const textOf = (element, directRecord = false) => {
    if (!element || !shown(element)) return ''
    const walker = doc.createTreeWalker(element, 4); let node, previous = null, text = ''
    while ((node = walker.nextNode())) {
      const parent = node.parentElement
      if (!parent || !node.nodeValue?.trim() || !shown(parent) || directRecord && element.contains(parent.closest(listSelector))) continue
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
  // New LinkedIn headers may render the name as H2 or plain text, even when
  // there is no portrait. Bind title agreement to this profile's Contact info.
  if (personPage && !headingName && titleSubject) {
    const contacts = [...main.querySelectorAll('a[href]')].filter(anchor => {
      if (!shown(anchor) || !['contact info', 'contact information'].includes(nameKey(textOf(anchor) || anchor.getAttribute('aria-label')))) return false
      const href = url(anchor.getAttribute('href')); if (!href) return false
      const target = new URL(href)
      return target.origin === page.origin && target.pathname.replace(/\/$/, '') === `${page.pathname.replace(/\/$/, '')}/overlay/contact-info`
    })
    const candidates = []
    for (const contact of contacts) for (let scope = contact.parentElement, depth = 0; scope && scope !== main && depth < 7; scope = scope.parentElement, depth++) {
      if ([...scope.querySelectorAll('h2,h3,[role="heading"]')].some(node => shown(node) && ['activity','experience','education','more profiles for you','people also viewed'].includes(nameKey(textOf(node))))) break
      const names = [...scope.querySelectorAll('h1,h2,h3,[role="heading"],p,span')].filter(node => shown(node) && nameKey(textOf(node).replace(/\s*[·•]\s*(?:1st|2nd|3rd\+?).*$/i, '')) === nameKey(titleSubject))
      if (names.length) { candidates.push({ node: names[0], scope }); break }
    }
    if (candidates.length === 1) { heading = candidates[0].node; headingName = titleSubject; subjectHeader = candidates[0].scope }
  }
  if (companyPage && (!headingName || /^(?:about|overview|home)$/i.test(headingName))) {
    const title = /\|\s*LinkedIn\s*$/i.test(doc.title) ? clean(doc.title.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*LinkedIn\s*$/i, '').replace(/:\s*(?:about|overview|home|people|jobs|posts|life)\s*$/i, '')) : ''
    const identity = page.pathname.split('/').slice(0, 3).join('/').toLowerCase()
    const named = [...main.querySelectorAll('a[href],p,[role="heading"]')].filter(node => title && nameKey(textOf(node)) === nameKey(title))
    const matched = named.find(node => {
      const anchor = node.closest('a[href]'), target = url(anchor?.getAttribute('href'))
      return target && new URL(target).origin === page.origin && new URL(target).pathname.replace(/\/$/, '').toLowerCase() === identity ||
        node.closest('.org-top-card,[data-view-name="organization-top-card"],header,[role="banner"]')
    })
    if (matched) { heading = matched; headingName = title }
  }
  // Keep these rules in sync with the URL collector. The browser runs this function in isolation.
  function facultyDegree(raw) {
    const excerpt = raw.trim().replace(/\s+/g, ' ')
    if (excerpt.length > 1000 || /\b(?:postdoc(?:toral)?|candidate|expected|in progress|fellowship)\b/i.test(excerpt) || !/^(?:Ph\.?D\b|D\.?Phil\b|[BM]\.?\s?(?:S(?:c)?|A|Eng|Tech)\b|Bachelor\b|Master\b|Doctorate\b|Diploma\b)/i.test(excerpt)) return null
    const item = excerpt.match(/^([^,;]{1,100}?)\s+((?:19|20)\d{2})\s+in\s+([^,;]{2,300}),\s*(.{2,300})$/i)
    const csv = !item && excerpt.match(/^([^,;]{1,100}),\s*([^,;]{2,300}),\s*([^,;]{2,300}),\s*((?:19|20)\d{2})\.?$/)
    if (!item && !csv) return null
    const [, degree, year, field, school] = item || [csv[0], csv[1], csv[4], csv[2], csv[3]]
    const institute = school.match(/^(.+?\b(?:Institute|Department|School|College)\b.*?)\s+at\s+(?:the\s+)?(University\s+of\s+.+)$/i)
    return { kind: 'education', degree: degree.trim(), field: field.trim(), endDate: year, organization: (institute?.[2] || school).trim(), ...(institute ? { description: institute[1] } : {}), excerpt }
  }
  const facultyDirectory = /(?:\.edu(?:\.[a-z]{2})?|\.ac\.[a-z]{2})$/i.test(page.hostname) &&
    /\/(?:people(?:_individual)?|faculty(?:-directory)?|directory|academic-staff|profiles)\/[^/]+/i.test(page.pathname)
  let faculty = null
  if (facultyDirectory && main !== doc.body) {
    const titleName = clean(doc.title.split(/\s+[–—|-]\s+/)[0]), names = [...main.querySelectorAll('h1,h2')].filter(node => shown(node) && nameKey(textOf(node)) === nameKey(titleName))
    const degreeHeading = [...main.querySelectorAll('h2,h3,h4')].filter(node => shown(node) && nameKey(textOf(node)) === 'education')
    const list = degreeHeading[0]?.nextElementSibling
    const surname = nameKey(titleName).split(' ').at(-1), slug = nameKey(page.pathname.split('/').filter(Boolean).at(-1) || '').replace(/ /g, '')
    if (names.length === 1 && titleName.length <= 120 && titleName.split(/\s+/).length >= 2 && surname && slug.includes(surname) && degreeHeading.length === 1 &&
        (names[0].compareDocumentPosition(degreeHeading[0]) & 4) && list?.matches('ol,ul') && shown(list)) {
      const rows = [...list.children].filter(node => node.tagName === 'LI' && shown(node)).map(node => facultyDegree(textOf(node))).filter(Boolean).slice(0, 60)
      if (rows.length) { heading = names[0]; headingName = clean(textOf(heading)); faculty = rows }
    }
  }
  const schemas = []
  const visit = (value, primary = false, depth = 0) => {
    if (!value || depth > 8) return
    if (Array.isArray(value)) { for (const child of value.slice(0, 40)) visit(child, primary, depth + 1); return }
    if (typeof value !== 'object') return
    const types = [value['@type']].flat().map(type => String(type).replace(/^https?:\/\/(?:www\.)?schema\.org\//i, '')), kind = types.includes('Person') ? 'person' : types.some(type => ['Organization', 'Corporation', 'EducationalOrganization', 'CollegeOrUniversity', 'School', 'LocalBusiness'].includes(type)) ? 'company' : ''
    const subjectName = clean(value.name), boundUrl = url(value.url || value['@id'])
    if (kind && subjectName && (headingName && nameKey(subjectName) === nameKey(headingName) || (primary || ['/', '/about', '/about/'].includes(page.pathname)) && boundUrl && canonical(boundUrl) === canonical(page.href))) schemas.push({ value, kind, name: subjectName })
    if (value['@graph']) visit(value['@graph'], false, depth + 1)
    if (value.mainEntity) visit(value.mainEntity, true, depth + 1)
  }
  for (const script of [...doc.querySelectorAll('script[type="application/ld+json"]')].slice(0, 12)) if (script.textContent.length <= 64 * 1024) try { visit(JSON.parse(script.textContent)) } catch { /* Site schema is optional; visible LinkedIn sections remain usable. */ }
  const matching = schemas.filter(item => faculty ? item.kind === 'person' && nameKey(item.name) === nameKey(headingName) : !personPage && !companyPage || item.kind === (personPage ? 'person' : 'company'))
  const identities = new Set(matching.map(item => `${item.kind}:${nameKey(item.name)}`))
  if (identities.size > 1 && !personPage && !companyPage) throw new Error('Several primary profile identities are present. Open a page dedicated to one person or company.')
  const labeledHeadings = [...main.querySelectorAll('h2,h3')].filter(shown).map(element => nameKey(textOf(element)))
  const meta = key => clean(doc.querySelector(`meta[property="${key}"],meta[name="${key}"]`)?.content)
    // Social pages are identified from their profile URL and rendered primary
  // header. Feed posts, suggestions and inboxes never become profile evidence.
  const instagram = /(^|\.)instagram\.com$/i.test(page.hostname), facebook = /(^|\.)facebook\.com$/i.test(page.hostname)
  let social = null
  if (instagram || facebook) {
    const segments = page.pathname.split('/').filter(Boolean), handle = segments[0] || ''
    const reserved = /^(?:accounts|explore|direct|p|reel|reels|stories|about|developer|login|login\.php|home\.php|watch|marketplace|groups|pages|friends|search|photo|photos|posts|share|help|settings|notifications|permalink\.php)$/i
    const profilePath = instagram ? segments.length === 1 && /^[A-Za-z0-9._]{1,30}$/.test(handle) && !reserved.test(handle) :
      segments.length === 1 && !reserved.test(handle) && handle !== 'profile.php' || handle === 'profile.php' && /^\d+$/.test(page.searchParams.get('id') || '') || segments.length === 3 && handle === 'people' && /^\d+$/.test(segments[2])
    if (!profilePath) throw new Error('Open the main Instagram or Facebook profile, rather than a post, feed, group, or sign-in page.')
    const declared = (meta('og:title') || clean(doc.title)).replace(/^\(\d+\+?\)\s*/, '')
    const instagramTitle = instagram && /^(.*?)\s*\(@([A-Za-z0-9._]+)\)/.exec(declared)
    const titleName = instagramTitle && instagramTitle[2].toLowerCase() === handle.toLowerCase() ? clean(instagramTitle[1]) : facebook ? clean(declared.replace(/\s*[|–—]\s*Facebook.*$/i, '').replace(/^Facebook$/i, '')) : ''
    const headers = [...main.querySelectorAll('header,[data-testid="profile-header"],[data-pagelet="ProfileHeader"]')].filter(shown)
    if (instagram) {
      const bound = headers.filter(header => [...header.querySelectorAll('h1,h2,[role="heading"],a,span')].some(node => shown(node) && nameKey(textOf(node)) === nameKey(handle)))
      if (bound.length !== 1) throw new Error('The Instagram profile header is not visible yet. Open the profile, sign in if requested, and try again.')
      const header = bound[0], visible = nameKey(textOf(header))
      social = { header, name: titleName && visible.includes(nameKey(titleName)) ? titleName : handle }
    } else {
      const names = [...main.querySelectorAll('h1,[role="heading"][aria-level="1"]')].filter(node => shown(node) && !/^(?:facebook|log in|sign up|notifications)$/i.test(clean(textOf(node))))
      const candidates = names.filter(node => !titleName || nameKey(textOf(node)) === nameKey(titleName))
      if (candidates.length !== 1) throw new Error('The Facebook profile name is not unambiguous. Open the main profile with its name visible and try again.')
      const node = candidates[0], header = node.closest('header,[data-testid="profile-header"],[data-pagelet="ProfileHeader"],section') || node.parentElement
      social = { header, name: clean(textOf(node)) }
    }
  }
  const namedPortrait = !!headingName && [...main.querySelectorAll('img[alt]')].some(image => shown(image) && nameKey(image.alt) === nameKey(headingName))
  const resume = labeledHeadings.includes('education') && labeledHeadings.some(label => ['experience', 'work experience', 'employment'].includes(label))
  const personalLinks = [...main.querySelectorAll('a[rel~="me"][href]')].some(shown)
  const explicitPerson = [meta('profile:first_name'), meta('profile:last_name')].filter(Boolean).join(' ')
  const genericPerson = !!faculty || !linkedIn && !matching.length && !!headingName && (namedPortrait && (resume || personalLinks) || meta('og:type') === 'profile' && nameKey(explicitPerson) === nameKey(headingName))
  const homepage = !linkedIn && !matching.length && !genericPerson && page.pathname === '/'
  const siteName = meta('og:site_name'), titleBrand = clean(doc.title.split(/\s+[|–—-]\s+/)[0])
  const companyName = siteName || titleBrand, brandKey = nameKey(companyName).replace(/ /g, '')
  const host = page.hostname.toLowerCase().replace(/^www\./, '').split('.')
  const matchesDomain = (host.length === 2 || host.length === 3 && /^(?:co|com|org|net)$/.test(host[1]) && host[2].length === 2) && host[0].replace(/-/g, '') === brandKey
  const ownCompanyUrl = homepage && matchesDomain && nameKey(titleBrand) === nameKey(companyName)
    ? [...doc.querySelectorAll('a[href]')].map(anchor => url(anchor.getAttribute('href'))).find(href => {
      if (!href) return false
      const link = new URL(href)
      return /^(?:www\.)?linkedin\.com$/.test(link.hostname) && link.pathname.match(/^\/company\/([^/]+)\/?$/i)?.[1].toLowerCase().replace(/-/g, '') === brandKey
    }) : ''
  const namedLogo = homepage && siteName ? [...doc.querySelectorAll('img[alt]')].find(image => shown(image) && nameKey(image.alt) === nameKey(siteName + ' logo')) : null
  const genericCompany = !!(ownCompanyUrl || namedLogo)
  const schema = matching[0]?.value, entityType = social ? (matching[0]?.kind || 'person') : personPage || genericPerson ? 'person' : companyPage || genericCompany ? 'company' : matching[0]?.kind
  const name = (social ? social.name : personPage || companyPage ? headingName : matching[0]?.name || (genericCompany ? companyName : headingName)).slice(0, 200)
  if (!entityType || !name || /^(?:experience|education|home|about|people|sign in|join linkedin)$/i.test(name)) throw new Error('No single named person or company was found. Open its main profile page with the name visible.')
  const top = social?.header || subjectHeader || heading?.closest('section,header,[role="banner"],[itemscope],.pv-top-card,.org-top-card') || (companyPage ? main.querySelector('.org-top-card') : null) || heading?.parentElement || main
  const profile = { entityType, name, headline: '', description: '', location: '', emails: [], phones: [], urls: [], industry: '', affiliations: [], images: [] }
  let headerEmployer = null
  const addUrl = value => { const next = url(value); if (next && profile.urls.length < 32 && !profile.urls.includes(next)) profile.urls.push(next) }
  addUrl(personPage || companyPage ? `${page.origin}/${personPage ? 'in' : page.pathname.split('/')[1]}/${page.pathname.split('/')[2]}/` : page.href)
  const addImage = (value, label, isProfile = false) => { const next = url(value); if (next && profile.images.length < 8 && !profile.images.some(image => image.url === next)) profile.images.push({ url: next, label: clean(label).slice(0, 200), isProfile, subjectName: name }) }
  const addAffiliation = value => {
    const organization = clean(value.organization).slice(0, 300)
    if (!organization || profile.affiliations.length >= 60) return
    const description = typeof value.description === 'string' ? clean(value.description).slice(0, 12_000) : ''
    const row = { kind: value.kind, organization, ...(description ? { description } : {}), ...Object.fromEntries(['role', 'degree', 'field', 'startDate', 'endDate', 'excerpt'].flatMap(key => clean(value[key]) ? [[key, clean(value[key]).slice(0, key === 'excerpt' ? 2000 : 300)]] : [])), ...(value.current === true ? { current: true } : {}), ...(url(value.organizationUrl) ? { organizationUrl: url(value.organizationUrl) } : {}), ...(url(value.organizationLogoUrl) ? { organizationLogoUrl: url(value.organizationLogoUrl) } : {}) }
    if (!profile.affiliations.some(old => JSON.stringify(old) === JSON.stringify(row))) profile.affiliations.push(row)
  }
  if (social) {
    const bio = top.querySelector('[data-testid="user-bio"],[data-testid="profile-bio"],[data-testid="UserDescription"]')
    const intro = facebook ? main.querySelector('[data-testid=profile_intro_card],[data-pagelet=ProfileTilesFeed_0]') : null
    const biography = [...top.querySelectorAll('span[dir=auto]')].filter(node => shown(node) && !node.querySelector('span[dir=auto]')).map(node => clean(textOf(node))).filter(value => value && nameKey(value) !== nameKey(name) && nameKey(value) !== nameKey(page.pathname.split('/').filter(Boolean)[0]) && !/^(?:[\d,.]+[kKmM]?\s*)?(?:posts|followers|following)$/i.test(value))
    profile.description = (textOf(bio) || textOf(intro) || biography.join('\n')).slice(0, 12000)
    const portraits = [...top.querySelectorAll('img[alt]')].filter(image => shown(image) && /profile|avatar/i.test(image.alt) && (nameKey(image.alt).includes(nameKey(name)) || instagram && nameKey(image.alt).includes(nameKey(page.pathname.split('/').filter(Boolean)[0]))))
    if (portraits.length === 1 && !/default|anonymous|silhouette|blank.avatar/i.test(portraits[0].src)) addImage(portraits[0].currentSrc || portraits[0].src, name + ' profile photo', true)
    for (const anchor of top.querySelectorAll('a[href]')) {
      if (!shown(anchor)) continue
      const href = url(anchor.getAttribute('href')); if (!href) continue
      const target = new URL(href)
      if (target.hostname !== page.hostname && !/(^|\.)(instagram\.com|facebook\.com)$/i.test(target.hostname)) addUrl(href)
    }
    for (const anchor of top.querySelectorAll('a[href^="mailto:"]')) { const email = anchor.getAttribute('href').slice(7).split('?')[0]; if (shown(anchor) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) profile.emails.push(email) }
    const text = [name, textOf(top), textOf(intro), page.href].filter(Boolean).join('\n').slice(0, 100000)
    const article = doc.createElement('article'); article.textContent = text
    return { url: page.href, title: clean(doc.title || name).slice(0, 300), text, html: article.outerHTML, profile }
  }
  const schemaText = value => typeof value === 'string' ? clean(value) : value && typeof value === 'object' ? clean(value.name) : ''
  if (!linkedIn && !faculty) profile.description = (meta('description') || meta('og:description')).slice(0, 12000)
  if (schema) {
    profile.headline = schemaText(schema.jobTitle || schema.slogan).slice(0, 500); profile.description = schemaText(schema.description).slice(0, 12_000) || profile.description
    profile.location = typeof schema.address === 'string' ? clean(schema.address).slice(0, 500) : schema.address && typeof schema.address === 'object' ? ['addressLocality', 'addressRegion', 'addressCountry'].map(key => schemaText(schema.address[key])).filter(Boolean).join(', ').slice(0, 500) : ''
    profile.industry = schemaText(schema.industry).slice(0, 300)
    for (const value of [schema.email].flat()) if (typeof value === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.replace(/^mailto:/i, ''))) profile.emails.push(value.replace(/^mailto:/i, '').slice(0, 320))
    for (const value of [schema.telephone].flat()) if (typeof value === 'string' && /\d/.test(value)) profile.phones.push(clean(value).slice(0, 100))
    for (const value of [schema.url, ...[schema.sameAs].flat()]) addUrl(value)
    for (const value of [entityType === 'person' ? schema.image : schema.logo].flat()) if (value) addImage(typeof value === 'string' ? value : value.url || value.contentUrl, `${name} ${entityType === 'person' ? 'profile photo' : 'logo'}`, true)
    if (entityType === 'person') for (const [property, kind] of [['alumniOf', 'education'], ['worksFor', 'employment'], ['memberOf', 'membership'], ['affiliation', 'membership']]) {
      for (const entry of [schema[property]].flat().slice(0, 30)) {
        const role = entry && [entry['@type']].flat().some(type => /^(?:https?:\/\/schema\.org\/)?(?:EmployeeRole|OrganizationRole|Role)$/.test(type)) ? entry : null
        const organization = role ? role[property] : entry
        if (!schemaText(organization)) continue
        const title = role ? schemaText(role.roleName || role.namedPosition) : kind === 'employment' ? profile.headline : ''
        const datedRole = kind === 'employment' ? role : null
        const endDate = clean(datedRole?.endDate)
        addAffiliation({
          kind, organization: schemaText(organization), role: title, description: role?.description,
          startDate: datedRole?.startDate, endDate: /^present$/i.test(endDate) ? '' : endDate,
          current: kind === 'employment' && (!endDate || /^present$/i.test(endDate)),
          degree: organization.degree, field: organization.fieldOfStudy, organizationUrl: organization.url,
          organizationLogoUrl: typeof organization.logo === 'string' ? organization.logo : organization.logo?.url || organization.logo?.contentUrl,
          excerpt: [name, property, schemaText(organization), title, datedRole?.startDate, endDate].filter(Boolean).join(' · '),
        })
      }
    }
  }
  if (faculty) {
    for (const row of faculty) addAffiliation(row)
    // Keep the person's education source. Faculty pages often put administrative
    // assistants' addresses, publication authors, and departmental news beside it.
    const article = doc.createElement('article'), identity = doc.createElement('h1'), label = doc.createElement('h2'), list = doc.createElement('ul')
    identity.textContent = name; label.textContent = 'Education'; article.append(identity, label, list)
    for (const row of faculty) { const item = doc.createElement('li'); item.textContent = row.excerpt; list.append(item) }
    return { url: page.href, title: clean(doc.title).slice(0, 300), text: [name, 'Education', ...faculty.map(row => row.excerpt)].join('\n'), html: article.outerHTML, profile }
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
  if (entityType === 'person') {
    profile.headline = clean(textOf(top.querySelector('.text-body-medium,.pv-text-details__left-panel .text-body-medium,[data-generated-suggestion-target="headline"]'))) || profile.headline
    profile.location = clean(textOf(top.querySelector('.text-body-small.inline.t-black--light,.pv-text-details__left-panel span.text-body-small'))) || profile.location
    const about = findSection('about', ['about']); if (about) profile.description = textOf(about).replace(/^About\s*/i, '').split(/^Top skills\s*$/im)[0].trim().slice(0, 12_000) || profile.description
    for (const [id, labels, kind] of [['education', ['education'], 'education'], ['experience', ['experience', 'work experience', 'employment'], 'employment'], ['volunteering_experience', ['volunteering', 'volunteer experience'], 'membership'], ['organizations', ['organizations', 'affiliations'], 'membership']]) {
      const section = findSection(id, labels); if (!section) continue
      const records = [...new Set([...section.querySelectorAll('li,[role="listitem"]'), ...[...section.querySelectorAll('ul,ol,[role="list"]')].flatMap(list => [...list.children])])].filter(record => shown(record) && (!record.querySelector(listSelector) || datePattern.test(textOf(record, true))))
      for (const record of records.slice(0, 40)) {
        if (kind !== 'employment' && record.parentElement?.closest('li,[role="listitem"]') && !record.querySelector('.t-bold,h3,h4,[role="heading"],[data-field="title"]')) continue
        const parts = textOf(record, true).split('\n').map(clean).filter(Boolean), linkSelector = kind === 'education' ? 'a[href*="/school/"]' : 'a[href*="/company/"],a[href*="/school/"]'
        const ownLinks = [...record.querySelectorAll(linkSelector)].filter(anchor => shown(anchor) && !record.contains(anchor.closest(listSelector))), ownIdentities = new Set(ownLinks.map(anchor => canonical(url(anchor.getAttribute('href')))))
        if (kind === 'employment' && ownIdentities.size > 1) continue
        const organizationLabel = anchor => {
          const label = textOf(anchor)
          if (label && !datePattern.test(label)) return label.split('\n')[0]
          const image = anchor.querySelector('img[alt]')
          const alt = image && shown(image) ? clean(image.alt) : ''
          return alt.match(/^(.+?)\s+logo$/i)?.[1] || alt.match(/^logo (?:of|for) (.+)$/i)?.[1] || ''
        }
        let organizationLink = ownLinks.find(anchor => organizationLabel(anchor))
        for (let parent = record.parentElement; !organizationLink && parent && parent !== section && section.contains(parent); parent = parent.parentElement) {
          const links = [...parent.querySelectorAll(linkSelector)].filter(shown), identities = new Set(links.map(anchor => canonical(url(anchor.getAttribute('href')))))
          if (identities.size > 1) break
          if (identities.size === 1) organizationLink = links.find(anchor => organizationLabel(anchor))
        }
        if (kind === 'employment' && !organizationLink && ownLinks.length) continue
        const linkedName = organizationLink ? organizationLabel(organizationLink) : '', organization = clean(linkedName || (kind === 'education' ? parts[0] : parts[1])).replace(/\s*[·|]\s*(?:full.time|part.time|self.employed|contract|internship|freelance).*$/i, '').replace(/\s+(?:full.time|part.time|self.employed|contract|internship|freelance)\s+(?:\d+\s+(?:yrs?|years?|mos?|months?).*)$/i, '')
        if (!organization || !parts.length) continue
        const recordDates = dates(parts)
        if (kind === 'employment' && record.parentElement?.closest('li,[role="listitem"]') && !recordDates.startDate) continue
        const degreeLine = kind === 'education' ? parts.find(part => nameKey(part) !== nameKey(organization) && !/\b(?:19|20)\d{2}\b/.test(part)) || '' : '', degreeParts = degreeLine.split(/,\s+/)
        const role = parts.map(part => { const date = part.match(datePattern); return date ? part.slice(0, date.index).trim() : part }).find(part => part && part !== organization && !/^(?:full.time|part.time|self.employed|contract|internship|freelance|\d+\s+(?:yrs?|years?|mos?|months?))\b/i.test(part))
        const linkedLogo = organizationLink?.querySelector('img') || [...record.querySelectorAll('img[alt]')].find(img => nameKey(img.alt) === nameKey(organization + ' logo'))
        addAffiliation({ kind, organization, organizationLogoUrl: linkedLogo && shown(linkedLogo) ? linkedLogo.currentSrc || linkedLogo.getAttribute('src') : '', organizationUrl: organizationLink?.getAttribute('href'), ...(kind === 'education' ? { degree: degreeParts[0], field: degreeParts.slice(1).join(', ') } : { role }), ...recordDates, excerpt: parts.join(' · ').slice(0, 2000) })
      }
    }
    // LinkedIn renders the photo link in a sibling of the name and Contact info.
    // Both belong to the same top-card section, above the activity and experience sections.
    const headerSelector = 'section,header,[role="banner"],.pv-top-card'
    const photoHeader = personPage && heading?.closest(headerSelector)
    const photoScope = photoHeader || top
    if (personPage && photoScope !== main) {
      const inHeader = element => !photoHeader || element.closest(headerSelector) === photoHeader
      const exactContact = `${page.origin}${page.pathname.replace(/\/$/, '')}/overlay/contact-info`
      const contact = [...photoScope.querySelectorAll('a[href]')].find(anchor => shown(anchor) && inHeader(anchor) && canonical(anchor.href) === exactContact)
      // The modern card places its headline after the name and before the
      // location / Contact info line. Its wrapping tags vary by profile.
      const contactLine = contact?.closest('p')?.parentElement
      if (contactLine && !contactLine.contains(heading) && contactLine.parentElement?.contains(heading)) {
        if (!profile.headline && (heading.compareDocumentPosition(contactLine) & 4)) {
          const range = doc.createRange()
          range.setStartAfter(heading)
          range.setEndBefore(contactLine)
          const walker = doc.createTreeWalker(contactLine.parentElement, 4), words = []
          let node
          while ((node = walker.nextNode())) {
            if (range.intersectsNode(node) && shown(node.parentElement) && !node.parentElement.closest('a,button,[role="button"]')) words.push(node.nodeValue)
          }
          profile.headline = clean(words.join(' ')).replace(/^[·•\s]*(?:1st|2nd|3rd\+?)(?:\s+degree(?:\s+connection)?)?\b[·•\s]*/i, '').trim().slice(0, 500)
        }
        const locations = [...contactLine.children].filter(element => element.matches('p') && !element.contains(contact) && !element.querySelector('a,button') && nameKey(textOf(element)))
        if (!profile.location && locations.length === 1) profile.location = clean(textOf(locations[0])).slice(0, 500)
      }
      // A headline alone can mention former employers. Require a matching organization
      // control in the same person's card before creating a current affiliation.
      const clause = profile.headline.split(/[;|]/)[0].trim()
      const job = clause.match(/^(.+?)(?:\s+(?:at|@)\s+|,\s+)(.+)$/i)
      if (job && !/\b(?:former(?:ly)?|previous(?:ly)?|past|retired)\b|\bex[-\s]/i.test(clause)) {
        const matches = []
        for (const control of photoScope.querySelectorAll('button,[role="button"],a[href*="/company/"],a[href*="/school/"]')) {
          if (!inHeader(control) || !shown(control.parentElement) || !rendered(control)) continue
          const labels = [control.getAttribute('aria-label'), control.innerText || control.textContent]
          for (const label of labels.map(clean).filter(Boolean)) {
            const count = label.match(/\s*\+\s*(\d{1,3})\s+more$/i)
            const organization = (count ? label.slice(0, count.index) : label).trim()
            const acronym = nameKey(organization).split(' ').filter(word => !['the', 'of', 'and', 'for'].includes(word)).map(word => word[0]).join('').toUpperCase()
            if (organization && (nameKey(job[2]) === nameKey(organization) || /^[A-Z]{2,8}$/.test(job[2]) && job[2] === acronym)) {
              matches.push({ organization, additional: Number(count?.[1] || 0) })
              break
            }
          }
        }
        if (matches.length === 1) {
          headerEmployer = matches[0]
          if (!profile.affiliations.some(row => row.kind === 'employment' && nameKey(row.organization) === nameKey(headerEmployer.organization))) {
            addAffiliation({ kind: 'employment', organization: headerEmployer.organization, role: job[1], current: true, excerpt: profile.headline })
          }
        }
      }
    }
    const photoLinks = personPage && photoScope !== main ? [...photoScope.querySelectorAll('a')].filter(anchor => {
      if (!shown(anchor) || photoHeader && anchor.closest(headerSelector) !== photoHeader) return false
      const label = anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.querySelector('img')?.alt
      return ['profile photo', 'profile picture', 'view profile photo', 'open profile photo'].includes(nameKey(label))
    }) : []
    const linkedImages = photoLinks.length === 1 ? [...photoLinks[0].querySelectorAll('img')].filter(shown) : []
    const portrait = (linkedImages.length === 1 ? linkedImages[0] : null) || top.querySelector('img.pv-top-card-profile-picture__image,img.profile-photo-edit__preview,img[data-anonymize="headshot-photo"],.pv-top-card__photo-wrapper img') || [...top.querySelectorAll('img[alt]')].find(image => nameKey(image.alt) === nameKey(name))
    if (portrait && shown(portrait)) addImage(portrait.currentSrc || portrait.getAttribute('src'), portrait.alt || `${name} profile photo`, true)
  }
  if (companyPage) {
    const headings = 'h1,h2,h3,h4,[role="heading"]'
    const unrelated = /^(?:similar (?:companies|pages|organizations)|people also (?:viewed|follow)|affiliated pages|pages people also viewed|posts|recent posts|updates|news|jobs|recommendations|highlights|people you may know)$/
    function owned(node, scope) {
      if (!node || !scope?.contains(node) || !shown(node) || node.closest('article,[role="article"],[data-urn*="activity"],.feed-shared-update-v2')) return false
      for (let part = node.parentElement; part && part !== main; part = part.parentElement) {
        if (!part.matches('section,[role="region"],li,div')) continue
        const title = part.querySelector(':scope > :is(h2,h3,h4,[role="heading"]),:scope > header :is(h2,h3,h4,[role="heading"])')
        if (title && unrelated.test(nameKey(textOf(title)))) return false
        if (part === scope) break
      }
      return true
    }
    const explicitHero = heading?.closest('.org-top-card,.org-top-card-primary-content,[data-view-name="organization-top-card"],header,[role="banner"]')
    let hero = explicitHero || (top !== main ? top : heading.parentElement)
    if (!explicitHero) for (let part = hero.parentElement; part && part !== main; part = part.parentElement) {
      if ([...part.querySelectorAll(headings)].some(node => node !== heading && shown(node))) break
      hero = part
    }
    function inHero(node) {
      if (!owned(node, hero)) return false
      if (hero !== main) return true
      // For a top-level heading, accept only immediately adjacent unsectioned hero elements.
      let block = node
      while (block.parentElement && block.parentElement !== main) block = block.parentElement
      for (let part = heading; part; part = part.nextElementSibling) {
        if (part !== heading && (part.matches('section,article,[role="region"],h2,h3,h4') || part.querySelector(headings))) break
        if (part === block) return true
      }
      return false
    }
    const tagline = hero.querySelector('.org-top-card-summary__tagline,[data-test-id="org-top-card-tagline"]')
    if (owned(tagline, hero)) profile.headline = clean(textOf(tagline)).slice(0, 500)
    const aboutNames = ['overview', 'about', 'about us']
    const aboutHeading = [...main.querySelectorAll(headings)].find(node => aboutNames.includes(nameKey(textOf(node))) && owned(node, main))
    let about = findSection('about', aboutNames) || main.querySelector('.org-page-details-module__card-spacing')
    if (!about && aboutHeading) for (let part = aboutHeading.parentElement; part && part !== main; part = part.parentElement) {
      const lead = aboutHeading.nextElementSibling
      if (lead && owned(lead, part) && textOf(lead).length > 20 || [...part.querySelectorAll('p,dl')].some(node => node !== aboutHeading && owned(node, part))) { about = part; break }
    }
    const labels = ['website', 'industry', 'headquarters', 'location', 'company size', 'type', 'founded', 'specialties']
    const fieldSelector = 'dt,h2,h3,h4,label,p,span,b,strong,[role="heading"],div'
    const isField = node => !node.closest('a,button') && !node.querySelector(fieldSelector) && labels.includes(nameKey(textOf(node)))
    if (about && owned(about, main)) {
      const paragraphs = []
      const firstField = [...about.querySelectorAll(fieldSelector)].find(node => isField(node) && owned(node, about))
      for (const node of about.querySelectorAll('p,[data-test-id="about-us__description"],.org-about-us-organization-description__text')) {
        if (!owned(node, about) || node.contains(aboutHeading) || aboutHeading?.contains(node)) continue
        if (firstField && (node.contains(firstField) || firstField.compareDocumentPosition(node) & 4)) break
        const value = textOf(node)
        if (labels.includes(nameKey(value)) || node.closest('dl,dd,dt') || node.closest('a')) break
        if (value && !aboutNames.includes(nameKey(value)) && !paragraphs.includes(value)) paragraphs.push(value)
      }
      if (!paragraphs.length && aboutHeading) {
        const lead = aboutHeading.nextElementSibling
        if (lead && owned(lead, about) && !lead.querySelector('a,dl,dt,h2,h3,h4,[role="heading"]') && !lead.contains(firstField)) {
          const copy = textOf(lead)
          if (copy.length > 20 && !labels.includes(nameKey(copy))) paragraphs.push(copy)
        }
      }
      if (paragraphs.length) profile.description = paragraphs.join('\n\n').slice(0, 12_000)
    }
    function officialWebsite(raw) {
      if (!raw || !/^(?:https?:\/\/|\/)/i.test(raw)) return ''
      const addressed = url(raw)
      if (!addressed) return ''
      let target = new URL(addressed)
      if (/(^|\.)linkedin\.com$/i.test(target.hostname)) {
        if (!/^\/(?:redir\/redirect|safety\/go)\/?$/i.test(target.pathname)) return ''
        const destination = target.searchParams.get('url')
        if (!destination || !/^https?:\/\//i.test(destination) || !url(destination)) return ''
        target = new URL(destination)
      }
      const host = target.hostname.toLowerCase().replace(/\.$/, '')
      if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || /(?:^|\.)(?:linkedin\.com|lnkd\.in|localhost|local|internal|lan)$/.test(host)) return ''
      for (const key of [...target.searchParams.keys()]) if (/^(utm_|trk$|trackingid$|li_fat_id$)/i.test(key)) target.searchParams.delete(key)
      target.hash = ''
      return target.href
    }
    const aboutSites = new Set(), heroSites = new Set()
    const fieldScope = /\/about\/?$/i.test(page.pathname) ? main : about
    if (fieldScope) for (const label of fieldScope.querySelectorAll(fieldSelector)) {
      if (!isField(label) || !owned(label, fieldScope)) continue
      const key = nameKey(textOf(label))
      for (let field = label, depth = 0; field && field !== fieldScope && depth < 4; field = field.parentElement, depth++) {
        const next = field.nextElementSibling
        if (!next) continue
        if (!owned(next, fieldScope) || next.matches('section,article,dl,dt') || isField(next) || [...next.querySelectorAll(fieldSelector)].some(isField)) break
        const value = clean(textOf(next))
        if (key === 'website') {
          const links = next.matches('a[href]') ? [next] : [...next.querySelectorAll('a[href]')].filter(link => owned(link, next))
          const raw = links.flatMap(link => {
            const site = officialWebsite(link.getAttribute('href')), label = clean(textOf(link) || link.getAttribute('aria-label'))
            if (!site) return []
            const visible = label.match(/^(?:https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,})(?:[/?#]|$)/i)
            if (visible && new URL(site).hostname.toLowerCase().replace(/^www\./,'') !== visible[1].toLowerCase().replace(/^www\./,'')) return []
            return visible || !label || /^(?:visit |official |company )?website\b/i.test(label) ? [site] : []
          })
          if (!links.length && /^(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(value)) raw.push(/^https?:\/\//i.test(value) ? value : 'https://' + value)
          for (const href of raw) { const site = officialWebsite(href); if (site) aboutSites.add(site) }
        }
        if (key === 'industry' && value && value.length <= 300) profile.industry = value
        if (['headquarters', 'location'].includes(key) && value && value.length <= 500) profile.location = value
        break
      }
    }
    for (const anchor of hero.querySelectorAll('a[href]')) {
      if (!inHero(anchor)) continue
      const actions = [textOf(anchor), anchor.getAttribute('aria-label')].map(value => nameKey(value).replace(/ opens? in (?:a )?new (?:tab|window).*$/, ''))
      const subject = nameKey(name)
      if (!actions.some(action => ['visit website', 'visit our website', 'company website', 'visit company website', 'official website',
        'visit website for ' + subject, 'visit ' + subject + ' website', 'visit ' + subject + ' s website'].includes(action))) continue
      const site = officialWebsite(anchor.getAttribute('href'))
      if (site) heroSites.add(site)
    }
    const sites = aboutSites.size ? aboutSites : heroSites
    if (sites.size === 1) addUrl([...sites][0])
    const images = [...hero.querySelectorAll('img')].filter(inHero)
    const logo = images.find(image => {
      const alt = nameKey(image.alt), subject = nameKey(name)
      return [subject, subject + ' logo', 'logo of ' + subject, 'logo for ' + subject].includes(alt)
    }) || images.find(image => image.matches('.org-top-card-primary-content__logo,.org-top-card-summary__logo') ||
      explicitHero && ['company logo','organization logo','school logo'].includes(nameKey(image.alt)))
    if (logo) {
      const src = [logo.currentSrc, logo.getAttribute('src'), logo.getAttribute('data-delayed-url'), logo.getAttribute('data-src')].find(value => url(value))
      if (src) addImage(src, logo.alt || name + ' logo', true)
    }
  }
  if (genericCompany) {
    addUrl(ownCompanyUrl)
    if (namedLogo) addImage(namedLogo.currentSrc || namedLogo.getAttribute('src'), namedLogo.alt, true)
    else {
      const icon = doc.head?.querySelector('link[rel~="apple-touch-icon" i][href]') || doc.head?.querySelector('link[rel~="icon" i][href]')
      if (icon) addImage(icon.href, name + ' website icon', true)
    }
  }
  if (!linkedIn) for (const anchor of main.querySelectorAll('a[rel~="me"][href]')) if (shown(anchor)) addUrl(anchor.getAttribute('href'))
  for (const anchor of top.querySelectorAll('a[href]')) if (shown(anchor)) {
    const href = anchor.getAttribute('href') || ''
    if (/^mailto:/i.test(href)) { const email = href.slice(7).split('?')[0]; if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !profile.emails.includes(email)) profile.emails.push(email.slice(0, 320)) }
    else if (/^tel:/i.test(href)) { const phone = href.slice(4); if (/\d/.test(phone) && !profile.phones.includes(phone)) profile.phones.push(phone.slice(0, 100)) }
    else if (!companyPage && anchor.rel.split(/\s+/).includes('me')) addUrl(href)
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
  let text = textOf(main)
  if (!text && genericCompany && ownCompanyUrl) {
    // Some sites hide the page wrapper until a startup animation finishes. Archive
    // the independently identified public metadata rather than hidden page text.
    text = [name, profile.description, page.href, ownCompanyUrl].filter(Boolean).join('\n')
    snapshot.textContent = text
  }
  const html = snapshot.outerHTML
  if (!text || new TextEncoder().encode(text).byteLength > 512 * 1024 || new TextEncoder().encode(html).byteLength > 512 * 1024) throw new Error('No readable profile text was found, or the snapshot exceeds 512 KiB.')
  profile.emails = [...new Set(profile.emails)].slice(0, 32); profile.phones = [...new Set(profile.phones)].slice(0, 32)
  return { url: page.href, title: clean(doc.title || name).slice(0, 300), text, html, profile, ...(headerEmployer?.additional ? { headerEmployer } : {}) }
  } catch (error) {
    if (reportError) return { extractorError: error instanceof Error ? error.message : 'This page could not be read. Open its main profile with its name visible and try again.' }
    throw error
  }
}

/** Explicit Save only. Read the rendered Experience section of this exact LinkedIn profile. */
export async function captureLinkedInExperience(profileUrl, employer = '', doc = document) {
  const profile = new URL(profileUrl), path = profile.pathname.replace(/\/$/, '')
  const here = new URL(doc.location.href), detailPath = path + '/details/experience'
  const detail = here.pathname.replace(/\/$/, '') === detailPath
  if (!/^https:\/\/(?:[\w-]+\.)*linkedin\.com$/.test(profile.origin) || !/^\/in\/[^/]+$/.test(path) || here.origin !== profile.origin || !detail && here.pathname.replace(/\/$/, '') !== path) throw new Error('The selected LinkedIn profile changed during capture.')
  const mainSelector = 'main,[role="main"],[aria-label="Primary content" i]'
  let main = doc.querySelector(mainSelector)
  for (let attempt = 0; detail && !main && attempt < 12; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200))
    main = doc.querySelector(mainSelector)
  }
  if (!main) return { roles: [] }
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim()
  const key = value => clean(value).toLocaleLowerCase()
  const visible = element => {
    if (!element || element.closest('[hidden],aside,nav,footer,form,[role="complementary"],[aria-label="Aside" i],.visually-hidden,.sr-only')) return false
    for (let parent = element; parent; parent = parent.parentElement) {
      const style = doc.defaultView?.getComputedStyle(parent)
      if (style?.display === 'none' || style?.visibility === 'hidden') return false
    }
    return true
  }
  const words = element => clean(element?.innerText || element?.textContent)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const checkPage = () => {
    const active = new URL(doc.location.href)
    if (active.origin !== here.origin || active.pathname.replace(/\/$/, '') !== here.pathname.replace(/\/$/, '')) throw new Error('The tab navigated to a different profile during capture.')
  }
  const findSection = () => {
    if (detail) return main
    const marker = main.querySelector('#experience')
    const heading = [...main.querySelectorAll('h2,h3,[role="heading"]')].find(node => key(words(node)) === 'experience' && visible(node))
    const section = (heading || marker)?.closest('section,[role="region"]')
    if (section && section !== main) return section
    for (let parent = heading?.parentElement; parent && parent !== main; parent = parent.parentElement) {
      if (parent.querySelectorAll('h2,[role="heading"][aria-level="2"]').length > 1) break
      if (parent.querySelector('[role="list"],ul,ol,a[href*="/company/"],a[href*="/school/"]')) return parent
    }
    return null
  }
  let scroller = main
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll|overlay/.test(doc.defaultView?.getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
  scroller ||= doc.scrollingElement || doc.documentElement
  const start = scroller.scrollTop
  const move = y => { if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: y, behavior: 'instant' }); else scroller.scrollTop = y }
  const date = /^((?:(?:Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+)?(?:19|20)\d{2})\s*[–—-]\s*(Present|(?:(?:Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\s+)?(?:19|20)\d{2})\b/i
  try {
    let section = findSection()
    if (!section && employer) {
      const contact = [...main.querySelectorAll('a[href]')].find(a => a.origin === profile.origin && a.pathname.replace(/\/$/, '') === path + '/overlay/contact-info')
      const card = contact?.closest('section,header,.pv-top-card,[role="banner"]')
      const buttons = [...(card?.querySelectorAll('button,[role="button"]') || [])].filter(button => visible(button) && !button.closest('a,form') && [button.getAttribute('aria-label'), words(button)].some(value => key(value).replace(/\s*\+\s*\d+\s+more$/, '') === key(employer)))
      if (buttons.length === 1) { buttons[0].click(); await wait(180); checkPage(); section = findSection() }
    }
    const viewport = scroller.clientHeight || doc.defaultView?.innerHeight || 700
    for (let step = 0; !section && step < 18 && scroller.scrollHeight > viewport; step++) {
      const before = scroller.scrollTop
      move(Math.min(before + viewport * .85, scroller.scrollHeight - viewport))
      await wait(220); checkPage(); section = findSection()
      if (before === scroller.scrollTop && step > 1) break
    }
    if (!section) return { roles: [] }
    if (detail || section.getBoundingClientRect().height > 0) {
      if (!detail) move(scroller.scrollTop + section.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
      let previous = '', stable = 0
      for (let attempt = 0; attempt < 10; attempt++) {
        await wait(160); checkPage()
        const marker = String(section.childElementCount) + ':' + String(section.textContent.length)
        stable = marker === previous ? stable + 1 : 0
        if (stable >= 2 && /(?:19|20)\d{2}\s*[–—-]/.test(section.textContent)) break
        previous = marker
      }
    }
    const orgLink = anchor => {
      if (!anchor || anchor.origin !== profile.origin || !/^\/(?:school|company)\/[^/]+\/?$/.test(anchor.pathname)) return ''
      return anchor.origin + anchor.pathname.replace(/\/?$/, '/')
    }
    const paragraphs = [...section.querySelectorAll('p')].filter(visible)
    const dated = paragraphs.filter(p => date.test(words(p)))
    const roles = []
    for (const line of dated.slice(0, 60)) {
      let row = line.parentElement
      while (row?.parentElement && row.parentElement !== section && !dated.some(other => other !== line && row.parentElement.contains(other))) row = row.parentElement
      if (!row || row === section) continue
      const paragraphsHere = paragraphs.filter(p => row.contains(p))
      const precedes = (a,b) => (a.compareDocumentPosition(b) & 4) !== 0
      const anchor = line.closest('a'), target = orgLink(anchor)
      const before = paragraphsHere.filter(p => precedes(p, line) && (!anchor || anchor.contains(p)) && !p.closest('button'))
      const titles = before.map(words).filter(value => value && !/^(?:full.time|part.time|self.employed|contract|internship|freelance)(?:\s*[·|]|$)/i.test(value))
      const role = titles[0]
      let organization = (titles[1] || '').split(/\s+[·|]\s+/)[0], logo, organizationUrl = target
      if (!organization && target) {
        for (let group = row.parentElement; group && section.contains(group); group = group.parentElement) {
          const all = [...group.querySelectorAll('a[href]')].filter(a => orgLink(a) === target && !dated.some(p => a.contains(p)))
          const label = all.find(a => precedes(a, line) && a.querySelector('p') && words(a))
          if (label) { organization = words(label.querySelector('p')); logo = all.map(a => a.querySelector('img')).find(Boolean); break }
          if (group === section) break
        }
      }
      if (!role || !organization || role === organization) continue
      const links = [...row.querySelectorAll('a[href]')].filter(a => orgLink(a))
      if (!organizationUrl && new Set(links.map(orgLink)).size === 1) organizationUrl = orgLink(links[0])
      logo ||= links.filter(a => orgLink(a) === organizationUrl).map(a => a.querySelector('img')).find(Boolean)
      const range = words(line).match(date)
      const descriptions = paragraphsHere.filter(p => precedes(line,p) && (!anchor || !anchor.contains(p)) && !p.closest('a,button') && !p.querySelector('a') && (p.querySelector('span') || p.matches('[data-field="description"]')))
        .map(words).filter(value => value && !/^(?:Present|Current|Remote|On-site|Hybrid)$/i.test(value))
      const description = [...new Set(descriptions)].join('\n').slice(0, 4000)
      const image = logo?.currentSrc || logo?.src
      roles.push({ kind: 'employment', role, organization, ...(organizationUrl ? { organizationUrl } : {}), ...(image && /^https?:\/\//.test(image) ? { organizationLogoUrl: image } : {}), startDate: range[1], ...(/^present$/i.test(range[2]) ? { current: true } : { endDate: range[2] }), ...(description ? { description } : {}), excerpt: [role, organization, words(line), description].filter(Boolean).join(' · ').slice(0,2000) })
    }
    const continuation = !detail && [...section.querySelectorAll('a[href]')].find(a => a.origin === profile.origin && a.pathname.replace(/\/$/, '') === detailPath && visible(a))
    return { roles, ...(continuation ? { continuation: continuation.href } : {}) }
  } finally { if (doc.location.pathname === here.pathname && scroller.scrollTop !== start) move(start) }
}

/** Runs in the chosen tab. A selected link must still name one visible person. */
export function extractVisiblePeople(doc = document, selectedUrl = '') {
  doc = doc || document
  const page = new URL(doc.location.href)
  const people = new Map(), ambiguous = new Set()
  const label = value => String(value || '').replace(/\s+/g, ' ').trim()
  const key = value => label(value).normalize('NFKC').toLowerCase()
  const cleanUrl = value => {
    if (!value) return null
    try {
      const u = new URL(value, page)
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.href.length > 2048) return null
      u.hash = ''
      return u
    } catch { return null }
  }
  const personUrl = (anchor, card) => {
    const u = cleanUrl(anchor.getAttribute('href'))
    if (!u) return ''
    const host = u.hostname.toLowerCase().replace(/^(?:www|m)\./, '')
    const path = u.pathname.replace(/\/$/, '')
    if (host === 'linkedin.com') {
      if (!/^\/in\/[\w%.~-]+$/i.test(path)) return ''
    } else if (host === 'instagram.com' || host === 'facebook.com') {
      if (host === 'facebook.com' && path === '/profile.php' && /^\d+$/.test(u.searchParams.get('id') || '')) return u.origin + path + '?id=' + u.searchParams.get('id')
      if (!/^\/[\w.-]+$/.test(path) && !(host === 'facebook.com' && /^\/people\/[^/]+\/\d+$/.test(path))) return ''
      if (/^\/(?:p|reels?|stories|accounts|explore|direct|about|login|watch|marketplace|groups|pages|friends|search|photos?|posts|share|settings|messages|notifications|[\w-]+\.php)$/i.test(path)) return ''
    } else if (!(card?.matches('[itemtype$="/Person"]') && anchor.matches('[itemprop~="url"],[rel~="me"]')) &&
      !(u.origin === page.origin && /^\/(?:.*\/)?(?:people|profiles?|team|faculty|staff|members?|authors?|speakers?|contributors)\/[^/]+$/i.test(path))) return ''
    return u.origin + path
  }
  const seen = new WeakMap()
  const visible = node => {
    if (!node) return true
    if (seen.has(node)) return seen.get(node)
    const style = doc.defaultView?.getComputedStyle(node)
    const ok = !node.matches('nav,footer,form,script,style,[hidden],[inert],[aria-hidden="true"],.sr-only,.visually-hidden,[data-worldview-reader]') &&
      style?.display !== 'none' && style?.visibility !== 'hidden' && style?.opacity !== '0' && visible(node.parentElement)
    seen.set(node, ok)
    return ok
  }
  const visibleText = node => {
    if (!node || !visible(node)) return ''
    const walker = doc.createTreeWalker(node, 4)
    let text = '', child
    while ((child = walker.nextNode()) && text.length < 600) if (visible(child.parentElement)) text += child.nodeValue + ' '
    return label(text)
  }
  const main = doc.body
  if (main && /^https?:$/.test(page.protocol) && !page.username && !page.password && page.hostname !== 'app.folk.app') {
    const cards = 'li,article,[role="listitem"],[itemtype$="/Person"],[data-person-card],.entity-result,.person-card,.search-result'
    for (const anchor of Array.from(main.querySelectorAll('a[href]')).slice(0, 4000)) {
      const card = anchor.closest(cards), url = personUrl(anchor, card)
      if (!url || ambiguous.has(url) || !visible(anchor)) continue
      const candidate = anchor.querySelector('[itemprop~="name"],h2,h3,h4,[data-person-name]')
      const name = (visibleText(candidate) || visibleText(anchor)).replace(/\s*[·•]\s*(?:1st|2nd|3rd\+?).*$/i, '').replace(/\s+View .+?[’']s profile$/i, '').trim()
      if (!name || name.length > 100 || name.split(/\s+/).length > 7 ||
        !/^[\p{L}\p{M}@][\p{L}\p{M}\p{N}\p{Zs}.'’_@-]+$/u.test(name) ||
        /^(?:view|see|read|follow|connect|contact|home|support|message|visit|our|meet|about|learn|show|click|more|back|profile|linkedin|instagram|facebook|website)(?:\s|$)/i.test(name)) continue
      if (people.has(url) && key(people.get(url).name) !== key(name)) { ambiguous.add(url); people.delete(url); continue }
      if (people.has(url) || people.size >= 40) continue
      const bound = card && [...card.querySelectorAll('a[href]')].every(other => {
        const otherUrl = personUrl(other, other.closest(cards))
        return !otherUrl || otherUrl === url || !visible(other)
      }) ? card : null
      const headline = visibleText(bound?.querySelector('[itemprop~="jobTitle"],[data-person-headline],.entity-result__primary-subtitle,.person-title')).slice(0, 180)
      const image = bound && [...bound.querySelectorAll('img[alt]')].find(img => visible(img) && key(img.alt) === key(name))
      const src = image && cleanUrl(image.currentSrc || image.getAttribute('src'))
      const photoUrl = src?.protocol === 'https:' && !src.port && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(src.hostname) && !/(^|\.)(?:local|internal|localhost|invalid)$/i.test(src.hostname) ? src.href : ''
      people.set(url, { name, url, headline, photoUrl })
    }
  }
  if (!selectedUrl) return { pageUrl: page.href, people: [...people.values()] }
  const row = people.get(selectedUrl)
  if (!row) return { extractorError: 'This person is no longer listed on the page. Read the page again.' }
  const text = [row.name, row.headline, row.url, 'Listed on ' + page.origin + page.pathname].filter(Boolean).join('\n')
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return { sourcePageUrl: page.href, url: row.url, title: row.name, text, html: '<article><pre>' + escape(text) + '</pre></article>',
    profile: { entityType: 'person', name: row.name, headline: row.headline, urls: [row.url], images: row.photoUrl ? [{ url: row.photoUrl, label: row.name, isProfile: true, subjectName: row.name }] : [], affiliations: [] } }
}
