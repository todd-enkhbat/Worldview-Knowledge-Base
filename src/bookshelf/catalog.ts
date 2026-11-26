export interface CatalogAuthor { name: string; id: string | null }
export interface CatalogWork { id: string; title: string; authors: CatalogAuthor[]; year: number | null; editionCount: number; preferredEdition: string | null }
export interface CatalogEdition { sourceUrl?:string; providerIds?:string[]; googleCover?:boolean; translator?:string; representative?:boolean; id: string; title: string; subtitle: string; editionLabel: string; publisher: string; date: string; year: number | null; language: string; isbn: string; pages: number | null; coverId: number | null }
export interface BookCatalogRef { providerIds?:string[]; representative?:boolean; workId: string; editionId: string; authors: CatalogAuthor[]; editionLabel: string; publisher: string; language: string; coverId: number | null }
export const catalogEditionLabel = (edition: CatalogEdition) => [edition.editionLabel, edition.translator, edition.publisher, edition.date, edition.language].filter(Boolean).join(' · ') || edition.id
export const authorNameKey = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
export const editionIsbn = (isbn?: string) => {
  const value = isbn?.replace(/[\s-]/g, '').toUpperCase() ?? ''
  if (/^\d{9}[\dX]$/.test(value)) {
    const check = Array.from(value).reduce((total, digit, index) => total + (digit === 'X' ? 10 : Number(digit)) * (10 - index), 0)
    if (check % 11) return ''
    const prefix = '978' + value.slice(0, -1)
    const sum = Array.from(prefix).reduce((total, n, index) => total + Number(n) * (index % 2 ? 3 : 1), 0)
    return prefix + (10 - sum % 10) % 10
  }
  if (!/^97[89]\d{10}$/.test(value)) return ''
  const check = Array.from(value).reduce((total, n, index) => total + Number(n) * (index % 2 ? 3 : 1), 0)
  return check % 10 ? '' : value
}

export interface EditionResult { work: CatalogWork; edition: CatalogEdition }
export function catalogLink(id:string) {
  return id.startsWith('gb:') ? 'https://books.google.com/books?id='+encodeURIComponent(id.slice(3)) : 'https://openlibrary.org/books/'+id
}
export function editionCover(row:CatalogEdition) {
  if (row.coverId) return '/api/book-catalog/cover?id='+row.coverId
  if (row.googleCover && row.id.startsWith('gb:')) return '/api/book-catalog/google-cover?id='+encodeURIComponent(row.id.slice(3))
  return ''
}
export function rankedEditions(rows:EditionResult[], query:string) {
  const terms=query.replace(/phenomonology/ig,'phenomenology').normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean)
  const score=({work,edition:e}:EditionResult)=>{
    const text=[e.title,...work.authors.map(a=>a.name),e.translator,e.publisher,e.language,e.editionLabel].join(' ').toLowerCase()
    return Number(!!e.sourceUrl)*200+(editionIsbn(query) && editionIsbn(query)===editionIsbn(e.isbn)?1000:0)+terms.filter(t=>text.includes(t)).length*10+Number(!!editionCover(e))*3+Number(!!e.translator)*4+terms.filter(t=>work.authors.some(a=>a.name.toLowerCase().split(/\s+/).includes(t))).length*3
  }
  const seen=new Map<string,EditionResult>()
  for(const row of rows){
    const old=seen.get(row.edition.id)
    if(!old || (row.edition.pages || row.edition.translator || row.edition.editionLabel) || !editionCover(old.edition)&&editionCover(row.edition))seen.set(row.edition.id,{...row,edition:{...row.edition,...(old?.edition.sourceUrl ? {sourceUrl:old.edition.sourceUrl} : {})}})
  }
  const found=new Map<string,EditionResult>()
  const covers=new Map<number,Set<string>>()
  for(const {edition:e} of seen.values())if(e.coverId){
    const identities=covers.get(e.coverId)??new Set<string>()
    identities.add(editionIsbn(e.isbn)||e.id);covers.set(e.coverId,identities)
  }
  for(const row of [...seen.values()].sort((a,b)=>score(b)-score(a))){
    const e=row.edition,isbn=editionIsbn(e.isbn)
    const key=isbn?[isbn,e.title,e.year,e.language,e.publisher,e.editionLabel,e.translator].join('|').toLowerCase():e.id
    const existing=found.get(key)
    if(existing){existing.edition.providerIds=[...new Set([...(existing.edition.providerIds??[]),e.id])];continue}
    found.set(key,{...row,edition:{...e,providerIds:e.providerIds??[e.id],representative:e.representative||!!e.coverId&&(covers.get(e.coverId)?.size??0)>1}})
  }
  return [...found.values()]
}
