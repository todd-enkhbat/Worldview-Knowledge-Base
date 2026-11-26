import { expect, it } from 'vitest'
import type { KnowledgeSource, SourceVersion } from '../../src/knowledge/types.ts'
import { sourceWritingContent } from '../../src/writing/sourceMarkdown.ts'
import { writingFromPlainText } from '../../src/writing/model.ts'
import type { WritingNode } from '../../src/writing/types.ts'

const source: KnowledgeSource = { id:'source-1', externalId:'vault/sample', title:'Sample', kind:'obsidian', currentVersionId:'version-1', createdAt:1, updatedAt:1, excluded:false, aiAllowed:true, tags:[] }
function version(text: string): SourceVersion {
  return {id:'version-1',sourceId:source.id,contentHash:'',originalBlobId:'original',originalName:'sample.md',text,createdAt:1,authoredAt:null,origin:'import',
    metadata:{path:'Books/sample.md',resolvedReferences:[{target:'Joseph Campbell',resolution:{status:'resolved',id:'source-campbell'}}]}}
}
const flatten = (n: WritingNode): WritingNode[] => [n,...(n.content ?? []).flatMap(flatten)]
it('creates native editable formatting, preserves original vault targets and leaves unresolved syntax legible',()=>{
  const raw = '# Notes\n\n- **Study** [the source](https://example.org/p)\n- *Visit* [[Joseph Campbell|Campbell]] and [[Missing]]\n\n> ==A finding== and ~~old~~\n\n```md\n[[literal]] **literal**\n```'
  const doc = sourceWritingContent(source,version(raw))
  expect(doc.content?.map(n=>n.type)).toEqual(['heading','bulletList','blockquote','codeBlock'])
  const nodes=flatten(doc)
  const mark=(name:string)=>nodes.filter(n=>n.marks?.some(m=>m.type===name))
  expect(mark('writingSourceLink')).toEqual([{type:'text',text:'Campbell',marks:[{type:'writingSourceLink',attrs:{sourceId:'source-campbell',target:'Joseph Campbell',embed:false}}]}])
  expect(mark('link')[0].marks?.[0].attrs?.href).toBe('https://example.org/p')
  expect(['bold','italic','highlight','strike'].map(name=>mark(name).length)).toEqual([1,1,1,1])
  expect(nodes.some(n=>n.text?.includes('[[Missing]]'))).toBe(true)
  expect(nodes.at(-1)).toEqual({type:'text',text:'[[literal]] **literal**'})
})

it('recovers intact legacy paragraphs and preserves edited paragraphs, rich marks, and newly written text',()=>{
  const raw = '[A](https://example.org/) and **B**.\n\nThis was changed.\n\n- N1\n- [[Joseph Campbell]]'
  const v = version(raw), old = writingFromPlainText(raw)
  old.content![1].content = [{type:'text',text:'My revised original!',marks:[{type:'italic'}]}]
  const added={type:'paragraph',content:[{type:'text',text:'Unpublished words.'}]}
  old.content!.push(added)
  const repaired=sourceWritingContent(source,v,old)
  expect(repaired.content?.map(n=>n.type)).toEqual(['paragraph','paragraph','bulletList','paragraph'])
  expect(repaired.content![0].content![0].marks![0].type).toBe('link')
  expect(repaired.content![1]).toEqual(old.content![1])
  expect(repaired.content!.at(-1)).toEqual(added)
  expect(sourceWritingContent(source,v,repaired)).toEqual(repaired)
  expect(v.text).toBe(raw)
})

it('rejects unsafe link schemes and respects local note paths and vault identities',()=>{
  const target = {...source,id:'target-note',currentVersionId:'version-target',title:'Other'}
  const other = {...source,id:'outside-vault',currentVersionId:'version-outside',title:'Elsewhere'}
  const v=version('[Related](Other.md) [danger](javascript:alert) [[Elsewhere]]')
  const corpus={sources:[source,target,other],versions:[v,{...v,id:target.currentVersionId,sourceId:target.id,metadata:{path:'Books/Other.md'}},{...v,id:other.currentVersionId,sourceId:other.id,metadata:{path:'Books/Elsewhere.md',vaultId:'outside'}}]}
  const nodes=flatten(sourceWritingContent(source,v,undefined,corpus))
  expect(nodes.find(n=>n.text==='Related')?.marks?.[0]).toMatchObject({type:'writingSourceLink',attrs:{sourceId:target.id}})
  expect(nodes.filter(n=>n.marks?.some(m=>m.type==='link'))).toHaveLength(0)
  expect(nodes.some(n=>n.text?.includes('[[Elsewhere]]'))).toBe(true)
})
