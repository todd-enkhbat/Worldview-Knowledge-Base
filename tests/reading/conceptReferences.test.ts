import { describe, expect, it } from 'vitest'
import { createShelfBook } from '../../src/bookshelf/model.ts'
import type { KnowledgeSource, SourceVersion } from '../../src/knowledge/types.ts'
import type { QuoteRecord } from '../../src/quotes/model.ts'
import { conceptReferences, type ConceptCorpus } from '../../src/reading/conceptReferences.ts'
import { defaultReadingItem } from '../../src/reading/model.ts'
import type { CanonicalTopic } from '../../src/reading/topics.ts'
import { conceptMentions } from '../../src/writing/concepts.ts'
import { defaultWritingAppearance } from '../../src/writing/model.ts'
import type { WritingDocument, WritingNode } from '../../src/writing/types.ts'

const topic: CanonicalTopic = { id:'virtue', name:'Virtù', aliases:['virtue','tag:virtù'], terms:['Virtus', 'Shared'], readingTopicIds:['virtue'], sourceIds:[] }
const topics = [topic, { ...topic, id:'luck', name:'Fortuna', aliases:['luck'], terms:['Shared'], readingTopicIds:['luck'] }]
const corpus = (): ConceptCorpus => ({ docs:[], books:[], quotes:[], nodes:new Map(), sources:[], versions:[], reading:{ items:[], notes:[], highlights:[] } })
const source = (id: string): KnowledgeSource => ({ id, externalId:'obsidian:' + id, title:id, kind:'obsidian', currentVersionId:id + '-v', createdAt:1, updatedAt:2, excluded:false, aiAllowed:true, tags:[] })
const version = (id: string, text: string): SourceVersion => ({ id:id+'-v', sourceId:id, text, contentHash:'h', originalBlobId:'blob', originalName:id+'.md', createdAt:1, authoredAt:null, origin:'import' })
const quote = (text: string): QuoteRecord => ({ id:'q', text, createdAt:7, origin:{ kind:'collection', id:'quotes', title:'Quotes' }, history:[{ at:7, action:'captured', attribution:'user-supplied', verification:{ status:'unlinked', checkedAt:7 }, source:{ title:'Discourses', author:'Machiavelli', edition:'Standard Ebooks', locator:'I.2' } }] })
const doc = (content: WritingNode[]): WritingDocument => ({ id:'draft', title:'A reflection', format:'note', subtitle:'', byline:'', archivedAt:null, appearance:defaultWritingAppearance(), createdAt:2, updatedAt:3, content:{ type:'doc', content:[{ type:'paragraph', content }] } })
const text = (value: string): WritingNode => ({ type:'text', text:value })

describe('a concept across the personal notebook', () => {
  it('recognizes canonically equivalent forms without shifting ProseMirror selections', () => {
    const input = 'E\u0301lan and Virtu\u0300. VIRTÙ also counts. Virtùosa does not.'
    const hits = conceptMentions([{ id:topic.id, label:topic.name }])(input)
    expect(hits.map(hit => input.slice(hit.from, hit.to))).toEqual(['Virtu\u0300','VIRTÙ'])
  })
  it('groups explicit, typed wiki links and unlinked aliases within one book note and returns to each passage', () => {
    const data = corpus(), book = createShelfBook({ title:'Discourses', notes:'An earlier note on virtus.' }, 1)
    data.books.push(book)
    const writing = doc([text('I see '), { ...text('Virtù'), marks:[{ type:'writingConcept', attrs:{ id:'p', topicId:topic.id, relation:'concept', createdAt:3, updatedAt:3 } }] },
      text(' beside fortune. '), { type:'writingTopicLink', attrs:{ topicId:'virtue', label:'Virtù' } }, text(' Later Virtu\u0300 and shared.')])
    data.docs.push({ ...writing, bookEditionId:book.id }, { ...writing, id:'archived', archivedAt:4 }, { ...writing, id:'hidden' })
    data.reading.items.push({ ...defaultReadingItem('writing:hidden'), libraryVisible:false })
    const refs = conceptReferences(topic, topics, data)
    expect(refs).toHaveLength(2)
    const r = refs.find(ref => ref.id === 'writing:draft')!
    expect(r.detail).toBe('Reading note · Discourses')
    expect(r.excerpts.map(p => p.relation)).toEqual(['Linked passage','Wiki link','Mention'])
    expect(r.excerpts.every(p => p.href.startsWith('#/bookshelf?book=' + book.id + '&note=draft'))).toBe(true)
    expect(r.excerpts[0].text).toContain('I see Virtù beside fortune')
    expect(r.excerpts[0].href).toContain('&passage=p')
    expect(r.excerpts[1].href).toMatch(/&atom=\d+&topic=virtue/)
    expect(r.excerpts[2].href).toContain('&term=Virtu%CC%80')
    expect(refs.find(ref => ref.id === 'book:' + book.id)?.excerpts[0].href).toContain('&legacyNote=1')
  })
  it('shows saved quotation wording, provenance and originating note without treating a quotation as ordinary prose', () => {
    const data = corpus()
    data.quotes.push(quote('Virtù and fortune.'), { ...quote('Something else.'), id:'unrelated' })
    data.docs.push(doc([{ ...text('Virtù and fortune.'), marks:[{ type:'writingQuote', attrs:{ quoteId:'q' } }] }]))
    const refs = conceptReferences(topic, topics, data)
    expect(refs).toHaveLength(2)
    expect(refs.find(r => r.kind === 'quote')).toMatchObject({ title:'Discourses', detail:expect.stringContaining('Machiavelli · I.2'), excerpts:[{ href:'#/quotes?quote=q', relation:'Quotation' }] })
    expect(refs.find(r => r.kind === 'note')?.excerpts.map(p => p.relation)).toEqual(['Quoted in this note'])
  })
  it('finds Markdown wiki links, notes in margins and highlight comments independently, and omits code, front matter and duplicate projections', () => {
    const data = corpus(), md = '---\naliases: Virtù\n---\n', words = md + 'Consider [[Ideas/Virtù|statecraft]] with Virtus. `Virtù` %%Virtù%%'
    const s = source('vault'), v = version('vault', words)
    v.metadata = { bodyStart:md.length }
    data.sources.push(s, { ...source('copy'), externalId:'writing:draft' }, { ...source('excluded'), excluded:true })
    data.versions.push(v, version('copy', 'Virtù'), version('excluded','Virtù'))
    data.reading.notes.push({ id:'margin', sourceId:s.id, text:'My point on Virtù.', createdAt:1, updatedAt:2 })
    data.reading.highlights.push({ id:'h', sourceId:s.id, versionId:v.id, start:0, end:5, quote:'Virtù', prefix:'', suffix:'', note:'Virtus is my gloss.', color:'yellow', createdAt:3, updatedAt:3 })
    const refs = conceptReferences(topic, topics, data)
    expect(refs.map(r => r.id).sort()).toEqual(['annotation:margin','comment:h','highlight:h','source:vault'])
    const passages = refs.find(r => r.id === 'source:vault')!.excerpts
    expect(passages.map(p => p.relation)).toEqual(['Wiki link', 'Mention'])
    for (const p of passages) {
      const params = new URLSearchParams(p.href.split('?')[1]), label = params.get('term')!
      expect(words.slice(+params.get('from')!, +params.get('from')! + label.length)).toBe(label)
    }
    expect(refs.find(r => r.id === 'annotation:margin')?.excerpts[0].href).toContain('&note=margin')
    expect(refs.find(r => r.id === 'highlight:h')?.kind).toBe('quote')
    expect(refs.find(r => r.id === 'comment:h')?.kind).toBe('note')
  })
})

it('keeps a synthesis page out of its own backlinks and includes its references to other concepts', () => {
  const data = corpus()
  data.docs.push({ ...doc([text('An account of Fortuna.')]), id:'concept-note:virtue', title:'Virtù', sourceId:'published' })
  data.sources.push({ ...source('published'), externalId:'writing:concept-note:virtue', kind:'document' })
  data.versions.push({ ...version('published', 'Virtù and Fortuna'), metadata:{ format:'writing' } })
  expect(conceptReferences(topic, topics, data)).toEqual([])
  const related = conceptReferences(topics[1], topics, data)
  expect(related.map(ref => ref.id)).toEqual(['writing:concept-note:virtue'])
  expect(related[0].excerpts[0].text).toContain('An account of Fortuna.')
})

it('retains an explicitly linked highlight through renames and keeps full edition text out of the notes list', () => {
  const data = corpus(), s = source('edition'), v = version(s.id, 'Virtù in the original text')
  data.sources.push(s); data.versions.push(v)
  data.books.push(createShelfBook({ title:'Discourses', sourceId:s.id, sourceVersionId:v.id }))
  const h = { id:'h', topicId:topic.id, sourceId:s.id, versionId:v.id, start:0, end:5, quote:'Virtù', prefix:'', suffix:'', note:'', color:'yellow' as const, createdAt:1, updatedAt:1 }
  data.reading.highlights.push(h)
  expect(conceptReferences(topic, topics, data).map(r => r.kind)).toEqual(['quote'])
  const renamed = { ...topic, name:'A different term', terms:[] }
  const [ref] = conceptReferences(renamed, [renamed], data)
  expect(ref).toMatchObject({ id:'highlight:h', kind:'quote', excerpts:[{ text:'Virtù', href:'#/library?source=edition&version=edition-v&highlight=h' }] })
})
