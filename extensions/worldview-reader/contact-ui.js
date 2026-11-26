export function contactActions(kind) {
  const noun = kind === 'company' ? 'company' : 'contact'
  return { save: 'Save ' + noun, open: 'Open ' + noun, group: 'Add group', activity: 'Log interaction' }
}

/** Shared contact list for the extension popup and the desktop companion. */
export function renderPeopleRows(host, people, onAction, busy = false) {
  const doc = host.ownerDocument
  const prev = host.contains(doc.activeElement) ? doc.activeElement.dataset : null
  const rows = people.map(person => {
    const li = doc.createElement('li'), review = doc.createElement('button'), action = doc.createElement('button')
    const avatar = doc.createElement('span'), copy = doc.createElement('span'), name = doc.createElement('strong')
    review.type = action.type = 'button'
    review.className = 'wv-person-review'
    review.dataset.action = 'review'
    review.dataset.url = action.dataset.url = person.url
    review.ariaLabel = 'Review ' + person.name
    review.disabled = action.disabled = busy
    avatar.className = 'wv-person-avatar'
    avatar.setAttribute('aria-hidden', 'true')
    avatar.textContent = person.name.trim().split(/\s+/).filter((_, index, parts) => index === 0 || index === parts.length - 1).map(word => Array.from(word)[0]).join('').toUpperCase()
    if (person.photoUrl) {
      const img = doc.createElement('img')
      img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'
      img.onerror = () => img.remove()
      img.src = person.photoUrl
      avatar.append(img)
    }
    copy.className = 'wv-person-label'
    name.textContent = person.name
    copy.append(name)
    if (person.headline) { const detail = doc.createElement('small'); detail.textContent = person.headline; copy.append(detail) }
    review.append(avatar, copy)
    const verb = person.pending ? 'Queued' : person.reviewId ? 'Review' : person.existing ? 'Open' : 'Add'
    action.textContent = verb
    action.className = 'wv-row-action'
    action.dataset.action = 'primary'
    action.dataset.existing = String(!!person.existing)
    action.disabled ||= !!person.pending
    action.setAttribute('aria-label', verb + ' ' + person.name)
    review.addEventListener('click', () => onAction(person, 'review'))
    action.addEventListener('click', () => onAction(person, 'primary'))
    li.append(review, action)
    return li
  })
  host.replaceChildren(...rows)
  if (prev && !busy) Array.from(host.querySelectorAll('button')).find(btn => btn.dataset.url === prev.url && btn.dataset.action === prev.action)?.focus({preventScroll:true})
}

function publicPhoto(raw) {
  try {
    const src = new URL(raw)
    const host = src.hostname.toLowerCase().replace(/\.$/, '')
    if (!['http:', 'https:'].includes(src.protocol) || src.username || src.password || src.port || !host.includes('.') ||
        /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host) || host.endsWith('.home.arpa') || host.includes(':') || /^[\d.]+$/.test(host)) return ''
    return src.href
  } catch { return '' }
}

const identityKey = value => value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()

/** One profile header for Reader and Enki. External profile text is always inserted as text. */
export function renderProfileIdentity(host, profile, {saved=false, idPrefix='', nameId}={}) {
  const doc = host.ownerDocument
  const make = (tag, className, suffix) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (idPrefix && suffix) node.id = idPrefix + '-' + suffix
    return node
  }
  const used = [profile.name, profile.entityType].filter(Boolean).map(identityKey)
  function unique(values) {
    return values.filter(value => {
      if (typeof value !== 'string' || !value.trim()) return false
      const key = identityKey(value)
      if (!key || used.some(text => (' ' + text + ' ').includes(' ' + key + ' '))) return false
      used.push(key)
      return true
    }).map(value => value.trim()).join(' · ')
  }
  host.classList.add('wv-profile-identity')
  host.dataset.entity = profile.entityType || 'person'
  const portrait = make('div','wv-profile-portrait')
  portrait.setAttribute('aria-hidden','true')
  const initials = make('span','', 'initials')
  const words = profile.name.trim().split(/\s+/)
  initials.textContent = words.filter((_,i) => i === 0 || i === words.length-1).map(word => Array.from(word)[0]).join('').toLocaleUpperCase()
  portrait.append(initials)
  const src = publicPhoto(profile.photoUrl)
  if (src || idPrefix) {
    const img = make('img','', 'avatar')
    img.alt = ''
    img.referrerPolicy = 'no-referrer'
    img.hidden = true
    img.onload = () => { if (img.naturalWidth) {img.hidden=false;initials.hidden=true} }
    img.onerror = () => {img.hidden=true;initials.hidden=false}
    portrait.append(img)
    if (src) img.src = src
  }
  const copy = make('div','wv-identity-copy'), nameLine = make('div','wv-name-line')
  const name = make('h1','', 'name'), badge = make('span','wv-saved', 'kind')
  if (nameId) name.id = nameId
  name.textContent = profile.name
  badge.textContent = saved ? 'Saved' : ''
  badge.hidden = !saved
  nameLine.append(name,badge)
  copy.append(nameLine)
  const fields = [
    ['summary',unique([profile.headline,profile.role])],
    ['affiliations',unique([...(profile.current || []),...(profile.schools || [])])],
    ['location',unique([profile.location])],
  ]
  for (const [field,value] of fields) {
    const line=make('p','wv-profile-'+field,field)
    line.textContent=value
    line.hidden=!value
    copy.append(line)
  }
  host.replaceChildren(portrait,copy)
}
