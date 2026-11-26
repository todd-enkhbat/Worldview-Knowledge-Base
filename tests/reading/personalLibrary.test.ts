import { expect, it } from 'vitest'
import { makeNodeDraft } from '../../src/domain/validate.ts'
import { personalLibrary } from '../../src/reading/personalLibrary.ts'
import { defaultReadingItem } from '../../src/reading/model.ts'
import type { KnowledgeSource } from '../../src/knowledge/types.ts'

it('keeps older unverified records for review, honors explicit inclusion, and never projects example or derived data as a personal note', () => {
  const nodes = new Map(['unknown','mine','example','derived'].map(title => [title,makeNodeDraft('idea',{ id:title, title })]))
  nodes.get('mine')!.libraryOrigin = 'saved'
  nodes.get('example')!.libraryOrigin = 'example'
  nodes.get('derived')!.provenance = {source:'file',ref:'worldview:artifact:generated',keptAt:1}
  const sources: KnowledgeSource[] = [...nodes.keys()].map(key => ({id:key,nodeId:key,kind:'legacy',title:key,currentVersionId:'v',externalId:'legacy:'+key,createdAt:1,updatedAt:2,tags:[],excluded:false,aiAllowed:false}))
  const personal = personalLibrary(sources,nodes,[],[])
  expect(personal.sources.map(s=>s.id)).toEqual(['mine'])
  expect(personal.earlierSources.map(s=>s.id)).toEqual(['unknown'])
  const confirmed = personalLibrary(sources,nodes,[],[{...defaultReadingItem('unknown'), libraryVisible:true}])
  expect([...confirmed.nodes.keys()]).toEqual(['unknown','mine'])
})
