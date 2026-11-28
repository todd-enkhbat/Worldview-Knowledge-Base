import { fetchProfileResource } from './crmProfileMedia.ts'
import { htmlToText } from './fetchUrl.ts'
import type { WorldDb } from './worldDb.ts'
import { applicationMetadata } from '../src/study/applicationMetadata.ts'

export { applicationMetadata }

const clean = (v: unknown) => String(v || '').replace(/\s+/g,' ').trim()
const decode = (s: string) => s.replace(/&(?:amp|quot|#39|apos|lt|gt|mdash|ndash);/g,v=>({'&amp;':'&','&quot;':'"','&#39;':"'",'&apos;':"'",'&lt;':'<','&gt;':'>','&mdash;':'—','&ndash;':'–'}[v] || v))
const attr = (tag: string,name: string) => decode(new RegExp('(?:^|\\s)'+name+'\\s*=\\s*["\']([^"\']*)["\']','i').exec(tag)?.[1] || '')
export function tallyQuestions(html: string) {
  const data=/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1]
  if(!data)return []
  try {
    const page=JSON.parse(data).props?.pageProps
    if(!Array.isArray(page?.blocks))return []
    const rows:{question:string;answer:string}[]=[]
    let label=''
    const schemaText=(value: unknown): string => Array.isArray(value) ? value.map(part=>Array.isArray(part)&&typeof part[0]==='string' ? part[0] : '').join(' ') : ''
    for(const block of page.blocks) {
      if(block.type==='TITLE'&&block.groupType==='QUESTION')label=clean(decode(schemaText(block.payload?.safeHTMLSchema)))
      else if(/^INPUT_|^TEXTAREA|^MULTIPLE_CHOICE|^DROPDOWN|^CHECKBOX/.test(block.type)) {
        const question=label || clean(block.payload?.placeholder)
        if(question&&!/password|credit card|card number|social security|bank account/i.test(question))rows.push({question,answer:''})
        label=''
      }
    }
    return rows.slice(0,180)
  } catch {return []}
}
export function applicationStructuredMetadata(html:string): Partial<ReturnType<typeof applicationMetadata>> {
  const candidates:Record<string,unknown>[]=[]
  for(const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const queue:unknown[]=[JSON.parse(match[1])]
      for(let n=0;queue.length&&n<100;n++) {
        const value=queue.shift()
        if(Array.isArray(value)){queue.push(...value.slice(0,50));continue}
        if(!value||typeof value!=='object')continue
        const row=value as Record<string,unknown>, types=[row['@type']].flat()
        if(types.some(type=>['JobPosting','EducationalOccupationalProgram','FundingScheme'].includes(String(type))))candidates.push(row)
        if(row['@graph'])queue.push(row['@graph'])
      }
    } catch { /* Ignore invalid publishing metadata. */ }
  }
  if(candidates.length!==1)return {}
  const row=candidates[0],org=row.hiringOrganization || row.provider || row.funder
  const organization=typeof org==='string'?org:org&&typeof org==='object'?String((org as Record<string,unknown>).name || ''):''
  return {opportunity:clean(row.title || row.name),...(organization?{organization:clean(organization)}:{}),
    ...(row.validThrough || row.applicationDeadline?{deadline:clean(row.validThrough || row.applicationDeadline),deadlineEvidence:'Published application deadline: '+clean(row.validThrough || row.applicationDeadline)}:{}),
    ...(row.description?{description:clean(htmlToText(String(row.description))).slice(0,1000)}:{})}
}
interface ContextInput {source?:unknown;opportunity?:unknown;organization?:unknown;answers?:unknown;hasAnswers?:unknown}
export async function applicationContext(input: ContextInput, db?: WorldDb, request?: typeof fetch) {
  const source=new URL(String(input.source || ''))
  if(source.protocol!=='https:'||source.username||source.password)throw Error('Choose the public application page you want to capture.')
  source.search='';source.hash=''
  const read=async(url:string)=>{const resource=await fetchProfileResource(url,{...(request?{fetch:request,lookup:async()=>['93.184.216.34']} : {}),maxBytes:1024*1024});if(!/html|text\//i.test(resource.contentType))throw Error('This application page has no readable text.');return new TextDecoder().decode(resource.bytes)}
  const html=await read(source.href)
  const title=decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || String(input.opportunity || ''))
  const structured=applicationStructuredMetadata(html)
  let metadata={...applicationMetadata(title,htmlToText(html)),...structured},deadlineSource=metadata.deadline?source.href:'',notice=''
  if(!metadata.deadline&&source.pathname!=='/') {
    try {
      const home=await read(source.origin+'/'), details=applicationMetadata(title,htmlToText(home))
      metadata={...metadata,deadline:details.deadline,deadlineEvidence:details.deadlineEvidence,description:metadata.description || details.description}
      if(details.deadline)deadlineSource=source.origin+'/'
    } catch {notice='The organization’s homepage could not be checked for a deadline.'}
  }
  let answers:{question:string;answer:string}[]=[]
  if(input.hasAnswers!==true&&(!Array.isArray(input.answers)||!input.answers.length))for(const frame of html.matchAll(/<iframe\b[^>]*>/gi)) {
    const raw=attr(frame[0],'src')||attr(frame[0],'data-tally-src')
    let target:URL
    try {target=new URL(raw,source.href)} catch {continue}
    if(target.origin!=='https://tally.so'||!/^\/embed\/[a-zA-Z0-9]+$/.test(target.pathname))continue
    try {answers=tallyQuestions(await read(target.href));if(answers.length){notice='Embedded form questions loaded. Enable embedded-form access in Reader to capture answers you type.';break}} catch {notice='The embedded form could not be read. Open it and try again.'}
  }
  const organization=structured.organization || clean(input.organization)||metadata.organization
  const websiteMatch=(values:unknown)=>Array.isArray(values)&&values.some(value=>{try{return new URL(String(value)).hostname.replace(/^www\./,'')===source.hostname.replace(/^www\./,'')}catch{return false}})
  const key=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()
  const matches=db?.crm.rows('companies',false).filter(row=>!row.mergedIntoId&&(key(String(row.name))===key(organization)||String(row.domain||'').replace(/^www\./,'')===source.hostname.replace(/^www\./,'')||websiteMatch(row.urls))) || []
  return {...metadata,organization:matches.length===1?String(matches[0].name):organization,
    opportunity:structured.opportunity || clean(input.opportunity)||metadata.opportunity,source:source.href,deadlineSource,answers,notice,...(db?{workspaceToken:db.crm.workspaceFingerprint()}:{}),...(matches.length===1?{organizationId:matches[0].id}:{})}
}
