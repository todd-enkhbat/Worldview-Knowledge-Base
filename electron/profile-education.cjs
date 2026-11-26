// Serialized into the selected profile tab. Read school evidence only inside the
// person's Education section or its exact, explicitly linked continuation.
async function captureEducation(sourceUrl, load, doc = document) {
  const source = new URL(sourceUrl), mainPath = source.pathname.replace(/\/$/, ''), here = new URL(doc.location.href)
  const detailsPath = mainPath + '/details/education', path = here.pathname.replace(/\/$/, '')
  if (!/(^|\.)linkedin\.com$/i.test(source.hostname) || !/^\/in\/[^/]+$/.test(mainPath) || here.origin !== source.origin || ![mainPath, detailsPath].includes(path)) return { roles: [] }
  const main = doc.querySelector('main,[role="main"],[aria-label="Primary content" i]')
  if (!main) return { roles: [] }
  const text = node => String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim()
  const visible = node => {
    for (let p = node; p; p = p.parentElement) {
      if (p.matches('aside,nav,footer,form,[hidden],[role="complementary"],[aria-label="Aside" i],.visually-hidden,.sr-only')) return false
      const st = doc.defaultView.getComputedStyle(p)
      if (st.display === 'none' || st.visibility === 'hidden') return false
    }
    return true
  }
  const locate = () => {
    if (path === detailsPath) return main
    const heading = [...main.querySelectorAll('h2,h3,[role="heading"]')].find(el => text(el).toLowerCase() === 'education' && visible(el))
    const section = (heading || main.querySelector('#education'))?.closest('section,[role="region"]')
    if (section && section !== main) return section
    for (let p = heading?.parentElement; p && p !== main; p = p.parentElement) {
      if (p.querySelectorAll('h2,[role="heading"][aria-level="2"]').length > 1) break
      if (p.querySelector('a[href*="/school/"],ul,[role="list"]')) return p
    }
    return null
  }
  let scroll = main
  while (scroll && !(scroll.scrollHeight > scroll.clientHeight && /auto|scroll|overlay/.test(doc.defaultView.getComputedStyle(scroll).overflowY))) scroll = scroll.parentElement
  scroll ||= doc.scrollingElement || doc.documentElement
  const start = scroll.scrollTop, height = scroll.clientHeight || doc.defaultView.innerHeight || 700
  let section = locate()
  try {
    for (let i = 0; load && !section && i < 18 && scroll.scrollHeight > height; i++) {
      const at = scroll.scrollTop
      scroll.scrollTop = Math.min(at + height * .85, scroll.scrollHeight - height)
      await new Promise(resolve => setTimeout(resolve, 180))
      if (doc.location.href !== here.href) throw new Error('The selected tab changed.')
      section = locate()
      if (!section && at === scroll.scrollTop && i > 1) break
    }
    if (!section) return { roles: [] }
    const links = [...section.querySelectorAll('a[href]')].filter(a => a.origin === source.origin && visible(a))
    const roles = []
    for (const link of links.filter(a => /^\/school\/[^/]+\/?$/.test(a.pathname))) {
      const lines = [...link.querySelectorAll('p,h3,h4')].filter(visible).map(text).filter(Boolean)
      const organization = lines[0] || text(link)
      if (!organization || organization.length > 300) continue
      const row = link.closest('li,[role="listitem"]')
      if (lines.length < 2 && row && new Set([...row.querySelectorAll('a[href*="/school/"]')].map(a => a.pathname)).size === 1) {
        for (const element of row.querySelectorAll('p,h3,h4')) if (!link.contains(element) && visible(element) && text(element)) lines.push(text(element))
      }
      if (!lines.includes(organization)) lines.unshift(organization)
      const date = lines.map(s => s.match(/\b((?:[A-Z][a-z]{2,8}\s+)?(?:19|20)\d{2})\s*[–—-]\s*(Present|Current|(?:[A-Z][a-z]{2,8}\s+)?(?:19|20)\d{2})\b/i)).find(Boolean)
      const degreeLine = lines.find(s => s !== organization && !/\b(?:19|20)\d{2}\b/.test(s) && /\b(?:bachelor|master|doctoral|doctorate|diploma|ph\.?d|MBA|B\.?[AS]\b|M\.?[AS]\b|degree|certificate)/i.test(s))
      const [degree, ...fields] = (degreeLine || '').split(/,\s*/)
      const organizationUrl = link.origin + link.pathname.replace(/\/?$/, '/')
      const logo = links.filter(a => a.pathname === link.pathname).map(a => a.querySelector('img')).find(Boolean)
      const image = logo?.currentSrc || logo?.src
      const result = { kind: 'education', organization, organizationUrl, ...(image && /^https?:\/\//.test(image) ? { organizationLogoUrl: image } : {}), ...(degree ? { degree } : {}), ...(fields.length ? { field: fields.join(', ') } : {}), ...(date ? { startDate: date[1], ...(/^(present|current)$/i.test(date[2]) ? { current: true } : { endDate: date[2] }) } : {}), excerpt: lines.join(' · ').slice(0,2000) }
      if (!roles.some(r => r.organization === organization && r.degree === result.degree && r.startDate === result.startDate)) roles.push(result)
    }
    const next = path !== detailsPath && links.find(a => a.pathname.replace(/\/$/, '') === detailsPath)
    return { roles, ...(next ? { continuation: next.href } : {}) }
  } finally { if (doc.location.href === here.href && scroll.scrollTop !== start) scroll.scrollTop = start }
}
module.exports = { captureEducation }
