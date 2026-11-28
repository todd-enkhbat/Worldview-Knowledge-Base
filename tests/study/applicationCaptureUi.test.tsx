// @vitest-environment jsdom
import { act } from 'react'
import { createRoot,type Root } from 'react-dom/client'
import { beforeEach,afterEach,it,expect,vi } from 'vitest'
import { Applications,type StudyNative } from '../../src/study/StudyDesk.tsx'
import { applyStudy, decodeStudy } from '../../src/study/model.ts'
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
vi.mock('../../src/study/Discovery.tsx',()=>({Discovery:()=>null}))
let host:HTMLDivElement,root:Root
beforeEach(()=>{sessionStorage.clear();host=document.createElement('div');document.body.append(host);root=createRoot(host)})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()})
it('reads the current application automatically, fills published facts, and saves without manual metadata entry',async()=>{
 const api=vi.fn(async(url:string,_init?:RequestInit)=>Response.json(url.endsWith('/application-context')?{organization:'Alive Prize',opportunity:'Alive Prize',deadline:'11/25',deadlineSource:'https://aliveprize.com/',deadlineEvidence:'Applications close 11/25',answers:[{question:'Why apply?',answer:''}]}:{id:'saved-application'}))
 vi.stubGlobal('fetch',api)
 const native:StudyNative={form:vi.fn(async()=>({organization:'Alive Prize',opportunity:'Alive Prize',source:'https://aliveprize.com/apply',answers:[]})),activeTab:true,saved:vi.fn(async()=>{})}
 await act(async()=>root.render(<Applications state={decodeStudy(undefined)} refresh={()=>{}} native={native} helper />))
 expect(native.form).toHaveBeenCalledOnce()
 expect(host.querySelector<HTMLInputElement>('[name=opportunity]')?.value).toBe('Alive Prize')
 expect(host.querySelector<HTMLInputElement>('[name=deadline]')?.value).toBe('11/25')
 expect(host.textContent).toContain('does not specify a year')
 expect(host.querySelector<HTMLDetailsElement>('.application-answer-review')?.open).toBe(false)
 expect(host.textContent).toContain('1 question · 0 answers captured')
 const save=[...host.querySelectorAll('button')].find(b=>b.textContent==='Save application')!
 await act(async()=>save.click())
 const body=JSON.parse((api.mock.calls.find(([url])=>url.endsWith('/application')) as unknown as [string,RequestInit])[1].body as string)
 expect(body).toMatchObject({organization:'Alive Prize',deadline:'11/25',submitted:false,source:'https://aliveprize.com/apply'})
 expect(native.saved).toHaveBeenCalledWith('saved-application',expect.objectContaining({deadline:'11/25'}))
 // A different page is a new application, never an overwrite of the last capture.
 vi.mocked(native.form).mockResolvedValue({organization:'Another Institute',opportunity:'Research Fellowship',source:'https://example.org/fellowship',answers:[]})
 await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='Capture application')!.click())
 await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='Save application')!.click())
 const next=JSON.parse((api.mock.calls.filter(([url])=>url.endsWith('/application')).at(-1) as unknown as [string,RequestInit])[1].body as string)
 expect(next.captureId).not.toBe(body.captureId)
 expect(next.source).toBe('https://example.org/fellowship')

})

it('keeps saved final answers when rereading a confirmation page with no remaining form fields',async()=>{
 const state=decodeStudy(undefined),source='https://aliveprize.com/apply'
 applyStudy(state,'application',{organization:'Alive Prize',opportunity:'Alive Prize',source,step:'Submission confirmation',submitted:true,appliedAt:200,answers:[{question:'Why apply?',answer:'The saved final answer.'}]},220)
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({organization:'Alive Prize',opportunity:'Alive Prize',answers:[{question:'Why apply?',answer:''}]})))
 const native:StudyNative={form:async()=>({organization:'Alive Prize',opportunity:'Alive Prize',source,submitted:true,answers:[]}),activeTab:true}
 await act(async()=>root.render(<Applications state={state} refresh={()=>{}} native={native} helper />))
 expect(host.querySelector('.application-answer-review summary')?.textContent).toContain('1 answers captured')
 expect(host.querySelector<HTMLTextAreaElement>('.study-pair textarea')?.value).toBe('The saved final answer.')
})

it('uses the save receipt to watch a form when its published details could not be reached', async()=>{
 const source='https://example.org/apply', saved=vi.fn(async()=>{})
 const native:StudyNative={form:async()=>({organization:'Example',opportunity:'Example Prize',source,answers:[{question:'Why apply?',answer:''}]}),activeTab:true,saved}
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/application-context') ? Response.json({error:'Unavailable'},{status:503}) : Response.json({id:'saved',workspaceToken:'authoritative-workspace'})))
 await act(async()=>root.render(<Applications state={decodeStudy(undefined)} refresh={()=>{}} native={native} helper />))
 expect(host.textContent).toContain('Published opportunity details could not be checked')
 await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='Save application')!.click())
 expect(saved).toHaveBeenCalledExactlyOnceWith('saved',expect.objectContaining({source,workspaceToken:'authoritative-workspace'}))
})

it('retains the visible deadline and its citation even when the server cannot read the page', async()=>{
 const source='http://127.0.0.1:5187/apply'
 const native:StudyNative={form:async()=>({organization:'West Hall',opportunity:'Fellowship',source,
   pageText:'The deadline will appear below. Applications close December 18, 2026. Unrelated private page text.',
   answers:[{question:'Why apply?',answer:''}]}),activeTab:true}
 const fetcher=vi.fn(async(url:string,_init?:RequestInit)=>url.endsWith('/application-context') ? Response.json({error:'Unavailable'},{status:503}) : Response.json({id:'saved'}))
 vi.stubGlobal('fetch',fetcher)
 await act(async()=>root.render(<Applications state={decodeStudy(undefined)} refresh={()=>{}} native={native} helper />))
 expect(host.querySelector<HTMLInputElement>('[name=deadline]')?.value).toBe('December 18, 2026')
 expect(host.textContent).toContain('Applications close December 18, 2026')
 expect(host.querySelector<HTMLAnchorElement>('a[href="'+source+'"]')).toBeTruthy()
 await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent==='Save application')!.click())
 const body=JSON.parse(String(fetcher.mock.calls.find(([url])=>url.endsWith('/application'))?.[1]?.body))
 expect(body).toMatchObject({deadline:'December 18, 2026',deadlineSource:source,deadlineEvidence:'Applications close December 18, 2026',submitted:false})
 expect(body).not.toHaveProperty('pageText')
})
