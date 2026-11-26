import { matchesPublisher, publisherSearch } from '../src/bookshelf/publishers.ts'
import {fetchReadable} from './fetchUrl.ts'
import {memoryOriginAllowed,readMemoryBody} from './memoryHttp.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CatalogEdition, CatalogWork } from '../src/bookshelf/catalog.ts'

const api = 'https://openlibrary.org'
const pageSize = 20
const workId = /^OL\d{1,15}W$/, editionId = /^OL\d{1,15}M$/, authorId = /^OL\d{1,15}A$/
const text = (value: unknown, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const integer = (value: unknown, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max ? value : null
function key(value: unknown, pattern: RegExp, prefix: string) {
  const raw = text(value), id = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
  return pattern.test(id) ? id : null
}
function work(value: unknown): CatalogWork[] {
  const doc = object(value), id = key(doc.key, workId, '/works/'), title = text(doc.title)
  if (!id || !title) return []
  const authors = list(doc.author_name).slice(0, 30).flatMap((name, i) => text(name, 300) ? [{ name: text(name, 300), id: key(list(doc.author_key)[i], authorId, '/authors/') }] : [])
  const preferred = object(list(object(doc.editions).docs)[0])
  return [{ id, title, authors, year: integer(doc.first_publish_year, 9999), editionCount: integer(doc.edition_count, 1e8) ?? 0, preferredEdition: key(preferred.key, editionId, '/books/') }]
}
function edition(value: unknown): CatalogEdition[] {
  const row = object(value), id = key(row.key, editionId, '/books/'), title = text(row.title)
  if (!id || !title) return []
  const date = text(row.publish_date, 100)
  const language = text(object(list(row.languages)[0]).key).replace(/^\/languages\//, '')
  return [{ id, title, subtitle: text(row.subtitle, 2000), translator: list(row.contributors).map(object).filter(x=>/translat/i.test(text(x.role))).map(x=>text(x.name)).filter(Boolean).join(', ') || /(?:translated (?:into English )?by|translation by)\s+([^;,.]{3,65})/i.exec(text(row.by_statement))?.[1]?.trim(), editionLabel: text(row.edition_name, 300) || text(row.physical_format, 300), publisher: list(row.publishers).map((p) => text(p, 150)).filter(Boolean).slice(0, 3).join(', '), date, year: Number(date.match(/\b\d{4}\b/)?.[0]) || null, language: /^[a-z]{3}$/.test(language) ? language : '', isbn: [...list(row.isbn_13), ...list(row.isbn_10)].map((s) => text(s).replace(/[\s-]/g, '')).find((s) => /^(?:\d{13}|\d{9}[\dX])$/i.test(s)) ?? '', pages: integer(row.number_of_pages, 1e6), coverId: list(row.covers).map((n) => integer(n, 1e10)).find((n) => n !== null) ?? null }]
}
class CatalogError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status } }
const bad = (message: string): never => { throw new CatalogError(400, message) }
const cache = new Map<string, { expires: number; bytes: Buffer }>()
const pending = new Map<string, Promise<Buffer>>()
let nextRequest = 0
async function read(url: URL, cover = false): Promise<Buffer> {
  const cached = cache.get(url.href)
  if (cached && cached.expires > Date.now()) return cached.bytes
  const scheduled = pending.get(url.href)
  if (scheduled) return scheduled
  const wait = cover || url.hostname!=='openlibrary.org' ? 0 : Math.max(0, nextRequest - Date.now())
  if (wait > 4000) throw new CatalogError(429, 'The catalog is busy. Please try again in a moment.')
  if (!cover && url.hostname==='openlibrary.org') nextRequest = Date.now() + wait + 1000
  const task = (async () => {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    const init: RequestInit = { redirect: 'manual', signal: AbortSignal.timeout(14000), headers: { 'user-agent': 'Worldview-Bookshelf/1.0', accept: cover ? 'image/jpeg' : 'application/json' } }
    let response = await fetch(url, init)
    for (let hop = 0; cover && response.status >= 300 && response.status < 400; hop++) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || hop >= 4) throw new CatalogError(502, 'The catalog cover could not be located.')
      const target = new URL(location, url)
      const archivePath = target.pathname === '/view_archive.php' ? target.searchParams.get('archive') ?? '' : target.pathname
      const imageFile = target.pathname === '/view_archive.php' ? target.searchParams.get('file') : target.pathname.split('/').at(-1)
      const fileId = /^0*(\d+)-L\.jpg$/.exec(imageFile ?? '')?.[1]
      const coverId = url.pathname.split('/').at(-1)?.split('-')[0]
      if (target.protocol !== 'https:' || target.username || target.password || target.port || !/(?:^|\.)archive\.org$/.test(target.hostname) || !/\/(?:download|items)\/(?:l_covers_\d+|olcovers\d+)\//.test(archivePath) || fileId !== coverId) throw new CatalogError(502, 'The catalog returned an unsupported cover location.')
      response = await fetch(target, init)
    }
    if (!response.ok || !response.body) throw new CatalogError(response.status === 404 ? 404 : response.status === 429 ? 429 : 502, response.status === 404 ? 'Open Library has no record or cover at this address.' : 'Open Library is unavailable. Try again shortly.')
    const reader = response.body.getReader(), parts: Uint8Array[] = []
    let size = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new CatalogError(502, 'This catalog result is too large to display.') }
      parts.push(chunk.value)
    }
    const bytes = Buffer.concat(parts)
    if (cover && (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255)) throw new CatalogError(502, 'The catalog did not return a JPEG cover.')
    cache.delete(url.href)
    cache.set(url.href, { expires: Date.now() + 15 * 60000, bytes })
    let total = 0
    for (const item of cache.values()) total += item.bytes.length
    while (cache.size > 64 || total > 8 * 1024 * 1024) {
      const oldest = cache.keys().next().value!
      total -= cache.get(oldest)!.bytes.length
      cache.delete(oldest)
    }
    return bytes
  })()
  pending.set(url.href, task)
  try { return await task } finally { pending.delete(url.href) }
}
function strings(value:unknown) { return list(value).map(v=>text(v,300)).filter(Boolean) }
async function visibleEditions(provider:string, input:string, offset:number, selectedPublisher = '') {
  const q=input.replace(/\bphenom(?:on|en)ology\b/ig,'Phenomenology').replace(/\billiad\b/ig,'Iliad')
  const selection = publisherSearch(q, selectedPublisher)
  const publisherQuery = selection.forProvider
  if(provider==='google'){
    const target=new URL('https://www.googleapis.com/books/v1/volumes')
    target.searchParams.set('q',publisherQuery('inpublisher'));target.searchParams.set('maxResults','20');target.searchParams.set('startIndex',String(offset))
    if(process.env.GOOGLE_BOOKS_API_KEY)target.searchParams.set('key',process.env.GOOGLE_BOOKS_API_KEY)
    const data=await json(target)
    const items=list(data.items)
    const results=items.flatMap(item=>{
      const row=object(item),v=object(row.volumeInfo), id=text(row.id), title=text(v.title)
      if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)||!title)return []
      const authors=strings(v.authors).map(name=>({name,id:null})),date=text(v.publishedDate),year=Number(date.slice(0,4))||null
      const isbn=list(v.industryIdentifiers).map(object).find(x=>x.type==='ISBN_13')??list(v.industryIdentifiers).map(object).find(x=>x.type==='ISBN_10')
      const edition={id:'gb:'+id,title,subtitle:text(v.subtitle),editionLabel:'',publisher:text(v.publisher),date,year,language:text(v.language),isbn:text(isbn?.identifier),pages:integer(v.pageCount,1e6),coverId:null,googleCover:!!object(v.imageLinks).thumbnail}
      return [{work:{id:edition.id,title,authors,year,editionCount:1,preferredEdition:edition.id},edition}]
    })
    return {results:results.filter(row => matchesPublisher(row.edition.publisher, selection.publisher)),nextOffset:items.length===20?offset+20:null}
  }
  const isbn=q.replace(/[-\s]/g,'')
  if(/^(?:97[89]\d{10}|\d{9}[\dXx])$/.test(isbn)){
    const target=new URL('/search.json',api)
    target.searchParams.set('isbn',isbn);target.searchParams.set('fields','key,title,author_name,author_key,editions,editions.key')
    const match=list((await json(target)).docs)[0],w=work(match)[0]
    if(!w?.preferredEdition)return {results:[],nextOffset:null}
    const details=await json(new URL('/books/'+w.preferredEdition+'.json',api))
    const editions=edition(details).filter(()=>[...list(details.isbn_10),...list(details.isbn_13)].includes(isbn.toUpperCase()))
    return {results:editions.filter(e => matchesPublisher(e.publisher, selection.publisher)).map(e=>({work:w,edition:e})),nextOffset:null}
  }
  const target=new URL('/search.json',api)
  target.searchParams.set('q',publisherQuery('publisher'));target.searchParams.set('lang','en');target.searchParams.set('limit','12');target.searchParams.set('offset',String(offset))
  target.searchParams.set('editions.limit','6')
  target.searchParams.set('fields','key,title,author_name,author_key,edition_count,cover_i,editions,editions.key,editions.title,editions.publisher,editions.language,editions.publish_date,editions.isbn,editions.cover_i')
  const docs=list((await json(target)).docs)
  const results:import('../src/bookshelf/catalog.ts').EditionResult[]=docs.flatMap(doc=>{
    const d=object(doc), w=work(d)[0]
    if(!w)return []
    return list(object(d.editions).docs).flatMap(raw=>{
      const e=object(raw),id=key(e.key,editionId,'/books/')
      if(!id)return []
      const date=strings(e.publish_date)[0]??'', coverId=integer(e.cover_i,1e10)
      return [{work:w, edition:{id,title:text(e.title)||w.title,subtitle:'',editionLabel:'',publisher:strings(e.publisher).join(', '),date,year:Number(date.match(/\b\d{4}\b/)?.[0])||null,language:strings(e.language).join(', '),isbn:strings(e.isbn).find(x=>x.length===13)??strings(e.isbn)[0]??'',pages:null,coverId:coverId??integer(d.cover_i,1e10),representative:!coverId&&!!d.cover_i}}]
    })
  })
  if(!offset && docs.length){
    // Catalog work search generally returns a single preferred edition. Retrieve
    // bibliographic records for the closest title so its other editions can compete.
    const candidates=docs.flatMap(work)
    const norm=(value:string)=>value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()
    const terms=norm(q).split(' ')
    const weight=(w:CatalogWork)=>{const t=norm(w.title),a=norm(w.authors.map(v=>v.name).join(' '));return terms.filter(x=>a.includes(x)||t.includes(x)).length*8+Number(norm(q).includes(t))*5-Math.abs(t.split(' ').length-terms.length)*0.15}
    const closest=candidates.sort((a,b)=>weight(b)-weight(a))[0]
    const prolific=[...candidates].sort((a,b)=>b.editionCount-a.editionCount)[0]
    for(const best of [...new Map([closest,prolific].filter(Boolean).map(w=>[w.id,w])).values()].slice(0,2))try{
      const page=await json(new URL('/works/'+best.id+'/editions.json?limit=120',api))
      for(const value of list(page.entries)){
        const e=edition(value)[0];if(!e)continue
        results.push({work:best,edition:{...e,representative:false}})
      }
    }catch{/* Work search results remain available. */}
  }
  return {results:results.filter(row => matchesPublisher(row.edition.publisher, selection.publisher)),nextOffset:docs.length===12?offset+12:null}
}

async function json(url: URL) { return object(JSON.parse((await read(url)).toString('utf8'))) }
export async function handleBookCatalog(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const reply = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
  if(req.method==='POST' && url.pathname==='/api/book-catalog/evidence') {
    if(!memoryOriginAllowed(req)||!req.headers['x-wv-client'])return reply(403,{error:'Open this book in Worldview.'})
    try {
      const v=await readMemoryBody(req), page=await fetchReadable(text(v.url,4000))
      const line=(label:string)=>new RegExp('(?:^|\\n)\\s*[-*]?\\s*'+label+'\\s*:\\s*([^\\n]+)','i').exec(page.text)?.[1]?.trim().slice(0,220)||''
      const publisher=line('publisher'), year=Number(publisher.match(/\b(?:1[5-9]|20)\d{2}\b/)?.[0])||null
      const start=Math.max(0,page.text.search(/(?:^|\n)\s*[-*]?\s*(?:Author|Publisher)\s*:/i))
      return reply(200,{title:page.title.split(/\s(?:–|\||-)\s/)[0].slice(0,500),url:page.url,author:line('author'),publisher:publisher.replace(/,?\s*\b(?:1[5-9]|20)\d{2}\b.*$/,''),year,binding:line('binding'),excerpt:page.text.slice(start,start+700)})
    } catch(e) { return reply(422,{error:e instanceof Error?e.message:'The listing could not be read.'}) }
  }
  if (req.method !== 'GET') return reply(405, { error: 'Use GET for catalog lookups.' })
  try {
    if (url.pathname === '/api/book-catalog/visual') {
      const publisher = text(url.searchParams.get('publisher'), 121)
      if (publisher.length > 120) bad('Publisher names must be at most 120 characters.')
      const query=text(url.searchParams.get('q'),241), provider=url.searchParams.get('provider')??'', offset=Number(url.searchParams.get('offset')??0)
      if (query.length<2||query.length>240||!['openlibrary','google'].includes(provider)||!Number.isInteger(offset)||offset<0||offset>2000) bad('Invalid edition search.')
      return reply(200,await visibleEditions(provider,query,offset,publisher))
    }
    if (url.pathname === '/api/book-catalog/google-cover') {
      const id=url.searchParams.get('id')??''
      if(!/^[A-Za-z0-9_-]{1,80}$/.test(id))bad('Invalid volume ID.')
      const bytes=await read(new URL('https://books.google.com/books/content?id='+id+'&printsec=frontcover&img=1&zoom=1&source=gbs_api'),true)
      res.writeHead(200,{'content-type':'image/jpeg','cache-control':'private, max-age=86400'});res.end(bytes);return
    }
    if (url.pathname === '/api/book-catalog/search') {
      const query = url.searchParams.get('q')?.trim() ?? ''
      if (query.length < 2 || query.length > 240) bad('Enter a title, author, or ISBN between 2 and 240 characters.')
      const target = new URL('/search.json', api)
      const isbn = query.replace(/[-\s]/g, '')
      target.searchParams.set('q', /^(?:\d{13}|\d{9}[\dX])$/i.test(isbn) ? 'isbn:' + isbn : query)
      target.searchParams.set('lang', 'en')
      target.searchParams.set('limit', '12')
      target.searchParams.set('fields', 'key,title,author_name,author_key,first_publish_year,edition_count,editions,editions.key')
      return reply(200, { works: list((await json(target)).docs).flatMap(work) })
    }
    if (url.pathname === '/api/book-catalog/editions') {
      const id = url.searchParams.get('work') ?? '', selected = url.searchParams.get('edition'), offset = Number(url.searchParams.get('offset') ?? 0)
      if (!workId.test(id) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || selected !== null && !editionId.test(selected)) bad('Invalid Open Library work or edition.')
      if (selected) {
        const row = await json(new URL('/books/' + selected + '.json', api))
        const attached = list(row.works).some((entry) => key(object(entry).key, workId, '/works/') === id)
        const editions = edition(row).filter((entry) => entry.id === selected && attached)
        return reply(200, { editions, nextOffset: null })
      }
      const page = await json(new URL('/works/' + id + '/editions.json?limit=' + pageSize + '&offset=' + offset, api))
      const entries = list(page.entries)
      return reply(200, { editions: entries.flatMap(edition), nextOffset: entries.length === pageSize && (typeof page.size !== 'number' || offset + pageSize < page.size) ? offset + pageSize : null })
    }
    if (url.pathname === '/api/book-catalog/cover') {
      const id = url.searchParams.get('id') ?? ''
      if (!/^[1-9]\d{0,9}$/.test(id)) bad('Invalid Open Library cover.')
      const bytes = await read(new URL('https://covers.openlibrary.org/b/id/' + id + '-L.jpg?default=false'), true)
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': bytes.length, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=900' }); res.end(bytes); return
    }
    reply(404, { error: 'Unknown book catalog operation.' })
  } catch (cause) { reply(cause instanceof CatalogError ? cause.status : 502, { error: cause instanceof CatalogError ? cause.message : 'Could not reach Open Library. Retry or enter the details by hand.' }) }
}
