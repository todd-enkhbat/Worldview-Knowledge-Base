// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeRepo, completeFirstRun, getStore, initRepo } from '../../src/data/repo.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { initializeKnowledge, resetKnowledge, useKnowledge } from '../../src/knowledge/index.ts'
import { initializeWriting, plainTextFromWriting, resetWriting, useWriting, writingFromPlainText, createWritingFromSource, archiveWritingDocument } from '../../src/writing/store.ts'
import { captureArticle } from '../../src/reading/captureArticle.ts'
import { resetReading } from '../../src/reading/store.ts'
import SourceEditor from '../../src/reading/SourceEditor.tsx'
import type { WritingNode } from '../../src/writing/types.ts'
vi.mock('../../src/writing/RichEditor.tsx', () => ({ default: ({ content, onChange }: {content: WritingNode; onChange:(value:WritingNode)=>void}) => <textarea aria-label="Body" value={plainTextFromWriting(content)} onChange={event => onChange(writingFromPlainText(event.target.value))} /> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root, sourceId: string
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('Blob', NodeBlob)
  resetWriting(); resetKnowledge(); resetReading()
  await initRepo({store:createMemoryStore()}); await completeFirstRun({T0:0,start:'empty'}); await initializeKnowledge(); await initializeWriting()
  sourceId = (await captureArticle({title:'Imported note',url:'https://example.org/note',text:'Original source words.'})).sourceId
  host=document.createElement('div'); document.body.append(host); root=createRoot(host)
})
afterEach(async () => { await act(async()=>root.unmount());host.remove();await closeRepo();resetWriting();resetKnowledge();resetReading();vi.unstubAllGlobals() })
async function render() { const state=useKnowledge.getState(), source=state.sources.find(row=>row.id===sourceId)!; await act(async()=>root.render(<SourceEditor source={source} version={state.versions.find(row=>row.id===source.currentVersionId)!} />)) }
async function type(label:string,value:string) { await act(async()=>{const input=host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))}) }
it('edits in place, autosaves one linked document, reopens it, and preserves the source',async()=>{
  await render(); expect(useWriting.getState().docs).toHaveLength(0)
  await type('Document title','Working study notes'); await type('Body','My revised understanding.')
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,800))})
  const saved=useWriting.getState().docs[0]
  expect(saved).toMatchObject({title:'Working study notes',basedOnSourceId:sourceId})
  expect(plainTextFromWriting(saved.content)).toBe('My revised understanding.')
  expect(await createWritingFromSource(sourceId)).toMatchObject({id:saved.id})
  expect(useWriting.getState().docs).toHaveLength(1)
  const corpus=await getStore().getKv<{versions:{text:string}[]}>('knowledge.v1')
  expect(corpus!.versions[0].text).toBe('Original source words.')
  await act(async()=>root.render(null)); await render()
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Body"]')!.value).toBe('My revised understanding.')
})
it('flushes the first edit when leaving before the autosave delay', async () => {
  await render(); await type('Body','Typed immediately before switching files.')
  await act(async()=>root.render(null))
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,50))})
  expect(useWriting.getState().docs).toHaveLength(1)
  expect(useWriting.getState().docs[0].basedOnSourceId).toBe(sourceId)
  expect(plainTextFromWriting(useWriting.getState().docs[0].content)).toBe('Typed immediately before switching files.')
})

it('allows a fresh working document after the previous working document was archived', async () => {
  const previous = await createWritingFromSource(sourceId)
  await archiveWritingDocument(previous.id)
  await render(); await type('Body','A fresh working version.')
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,800))})
  const active=useWriting.getState().docs.filter(doc=>!doc.archivedAt)
  expect(active).toHaveLength(1)
  expect(plainTextFromWriting(active[0].content)).toBe('A fresh working version.')
})
