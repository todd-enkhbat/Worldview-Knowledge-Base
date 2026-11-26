import { companyHomepage } from './crmCompanySourceEvidence.ts'
import { fetchProfileResource } from './crmProfileMedia.ts'
import { organizationHomepageHost, publicProfileUrl } from './crmProfileUrls.ts'
import type { CrmCompany } from '../src/crm/types.ts'

export const universityCandidate = (company: CrmCompany) => ['school','university'].includes(company.organizationType ?? '') || /\b(university|universit[yéàät]|universidad|universidade|college|polytechnic|institute of technology)\b/iu.test(company.name)
const key = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()
type Institution = {id:string; names:{value:string;types:string[]}[]; links:{type:string;value:string}[]; types:string[]; status:string}
export async function universityIdentity(company: CrmCompany, current:()=>void, fetcher?:typeof fetch) {
  if (!universityCandidate(company) || company.name.length>200) return
  const query=new URL('https://api.ror.org/v2/organizations')
  query.searchParams.set('query.advanced','names.value:"'+key(company.name)+'"')
  query.searchParams.set('filter','status:active,types:education')
  const response=await fetchProfileResource(query.href,{fetch:fetcher,current,maxBytes:1_200_000})
  const catalog=JSON.parse(new TextDecoder().decode(response.bytes)) as {items:Institution[];number_of_results:number}
  if (!Array.isArray(catalog.items) || catalog.items.length!==catalog.number_of_results) return
  const matches=catalog.items.filter(i=>i.status==='active' && i.types.includes('education') && i.names.some(n=>!n.types.includes('acronym') && key(n.value)===key(company.name)))
  if(matches.length!==1) return
  const record=matches[0], sites=[...new Set(record.links.filter(l=>l.type==='website').map(l=>companyHomepage(l.value)).filter(Boolean))]
  if(sites.length!==1 || !/^https:\/\/ror\.org\/[a-z0-9]+$/.test(record.id)) return
  const site=sites[0], domain=organizationHomepageHost(site)
  if(!domain || [company.domain,...company.urls].map(companyHomepage).some(url=>url && organizationHomepageHost(url)!==domain)) return
  return {site,domain,source:record.id,names:record.names.filter(n=>!n.types.includes('acronym')).map(n=>key(n.value))}
}

function attr(tag:string, field:string) {
  return tag.match(new RegExp('(?:^|\\s)'+field+'\\s*=\\s*(["\'])(.*?)\\1','i'))?.[2]?.replaceAll('&amp;','&') ?? ''
}
export function universityMark(html:string,page:string,identity:{domain:string;names:string[]}) {
  const within=(url:string)=>{const host=new URL(url).hostname;return host===identity.domain || host.endsWith('.'+identity.domain)}
  if(!within(page)) return
  for(const match of html.matchAll(/(<a\b[^>]*>)([^]*?)<\/a\s*>/gi)) {
    const link=publicProfileUrl(attr(match[1],'href'),page)
    if(!link || organizationHomepageHost(link)!==identity.domain) continue
    for(const [img] of match[2].matchAll(/<img\b[^>]*>/gi)) {
      const label=key(attr(img,'alt')).replace(/^(?:logo of |logo )| logo$/g,'')
      const src=publicProfileUrl(attr(img,'src'),page)
      if(src && within(src) && identity.names.includes(label)) return {site:page,icons:[src]}
    }
  }
}
// A department may publish the parent mark even when the main homepage is unavailable.
// Only an explicitly named image linking back to the registered institution qualifies.
export async function departmentArtwork(identity:NonNullable<Awaited<ReturnType<typeof universityIdentity>>>,current:()=>void,fetcher?:typeof fetch) {
  for(const prefix of ['www.maths.','library.','www.math.']){
    current()
    try {
      const page=await fetchProfileResource('https://'+prefix+identity.domain+'/',{current,fetch:fetcher,maxBytes:1500000})
      const mark=universityMark(new TextDecoder().decode(page.bytes),page.url,identity)
      if(mark) return mark
    } catch {current()}
  }
}
