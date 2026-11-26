import { fetchProfileResource } from './crmProfileMedia.ts'
import { companyHomepage } from './crmCompanySourceEvidence.ts'
import type { CrmCompany } from '../src/crm/types.ts'
const brand=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'')
const host=(s:string)=>new URL(s).hostname.replace(/^www\./,'')
function linkedIn(value:string) {
  try {
    const url=new URL(value)
    return /^(?:www\.)?linkedin\.com$/i.test(url.hostname) ? url.pathname.toLowerCase().match(/^\/(?:school|company)\/([\w-]+)\/?$/)?.[1] : undefined
  } catch { return }
}

/** Only a stored domain or a first-party page linking the exact saved LinkedIn organization can supply artwork. */
export async function findCompanyArtwork(company:CrmCompany, current:()=>void, fetcher?:typeof fetch) {
  const verified=company.domain && companyHomepage(company.domain)
  const profiles=new Set(company.urls.map(linkedIn).filter(Boolean))
  const sites=new Set(company.urls.map(companyHomepage).filter(Boolean))
  if(verified) sites.add(verified)
  else if(profiles.size===1) {
    const slug=[...profiles][0]!
    if (/^[a-z][a-z0-9-]{2,54}$/.test(slug) && brand(slug)===brand(company.name)) {
      sites.add('https://'+slug+'.com/'); sites.add('https://'+slug+'.org/')
    }
  }
  for(const site of [...sites].slice(0,4)){
    current()
    let page
    try { page=await fetchProfileResource(site,{fetch:fetcher,current,maxBytes:3000000}) } catch {continue}
    const html=new TextDecoder().decode(page.bytes)
    const refs=Array.from(html.matchAll(/https?:\/\/(?:www\.)?linkedin\.com\/(?:company|school)\/[\w-]+\/?/gi),match=>linkedIn(match[0]))
    if (!(verified && host(verified)===host(page.url)) && !refs.some(ref=>ref && profiles.has(ref))) continue
    const tags=html.match(/<link\b[^>]*>/gi) ?? []
    const icons:string[]=[]
    for(const tag of tags){
      if(!/\brel\s*=\s*["'][^"']*\b(?:icon|apple-touch-icon)\b[^"']*["']/i.test(tag)) continue
      const href=tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
      if(href) try {icons.push(new URL(href.replaceAll('&amp;','&'),page.url).href)} catch { /* invalid publisher URL */ }
    }
    return {site:page.url,icons:[...new Set([...icons,new URL('/apple-touch-icon.png',page.url).href,new URL('/favicon.ico',page.url).href])].slice(0,9)}
  }
}
