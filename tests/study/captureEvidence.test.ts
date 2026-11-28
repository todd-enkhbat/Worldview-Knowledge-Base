import {createRequire} from 'node:module'
import {it,expect,vi} from 'vitest'
import {docTarget,extractApplicationTab} from '../../server/connections/applicationDoc.ts'
import {parseApplicationPaste,safeApplicationText} from '../../src/study/model.ts'
const require=createRequire(import.meta.url)
const {JSDOM}=require('jsdom')
type FormAnswers = {answers:{question:string;answer:string}[]}
const {mergeApplicationForms,readEmbeddedApplicationForms}: {
  mergeApplicationForms: <T extends FormAnswers>(outer:T, frames:FormAnswers[]) => T
  readEmbeddedApplicationForms: (tabId:number,outer:FormAnswers & {documentId:string;embeddedForms:{url:string}[]}) => Promise<{result:FormAnswers}[]>
}=require('../../extensions/worldview-reader/application-form.js')
it('reads offscreen application fields and preserves typed paragraphs without password or card fields',()=>{
  const {readApplicationForm}=require('../../electron/application-capture.cjs')
  const dom=new JSDOM('<h1>Fellowship</h1><input aria-label="Password" value="private"><input type="password" value="secret"><input aria-label="Card number" value="private"><textarea aria-label="Why this program?"></textarea><input aria-label="Another question">',{url:'https://example.org/apply?auth=test',runScripts:'outside-only'})
  dom.window.HTMLElement.prototype.getClientRects=()=>[{top:3000,bottom:3100}] as unknown as DOMRectList
  dom.window.document.querySelector('textarea')!.value='First line.\n\nSecond paragraph.'
  const form=dom.window.eval('('+readApplicationForm.toString()+')()')
  expect(form.source).toBe('https://example.org/apply')
  expect(form.answers).toEqual([{question:'Why this program?',answer:'First line.\n\nSecond paragraph.'},{question:'Another question',answer:''}])
  dom.window.close()
})
it('uses the specified nested Google tab, preserving its text as evidence when it has no questions',()=>{
  const target=docTarget('https://docs.google.com/document/d/abc123/edit?tab=t.two')
  const p=(value:string)=>({paragraph:{elements:[{textRun:{content:value}}]}})
  const tabs=[{tabProperties:{tabId:'t.one'},documentTab:{body:{content:[p('Other tab')]}},childTabs:[{tabProperties:{tabId:'t.two',title:'Résumé'},documentTab:{body:{content:[p('Education\n'),p('Work experience\n')]}}}]}]
  const value=extractApplicationTab({title:'Biography',tabs},target.tab)
  expect(value).toEqual({title:'Résumé',text:'Education\nWork experience\n'})
  expect(parseApplicationPaste(value.text)).toEqual([])
  expect(()=>extractApplicationTab({title:'Biography',tabs},'t.missing')).toThrow()
  expect(safeApplicationText('Password:\nsecret\nWhy apply?\nMy answer')).toBe('Why apply?\nMy answer')
})
it('reads Tally aria-labelledby labels, email fields and outer application metadata',()=>{
  const {readApplicationForm}=require('../../electron/application-capture.cjs')
  const dom=new JSDOM('<title>Alive Prize — Apply</title><main><h3 id="question">What makes you come alive?</h3><textarea aria-labelledby="question"></textarea><label>Email<input type="email" value="sample@example.org"></label><iframe title="Alive Prize" src="https://tally.so/embed/yXZYg6"></iframe></main>',{url:'https://aliveprize.com/apply',runScripts:'outside-only'})
  dom.window.HTMLElement.prototype.getClientRects=()=>[{}]
  const result=dom.window.eval('('+readApplicationForm.toString()+')()')
  expect(result).toMatchObject({organization:'Alive Prize',opportunity:'Alive Prize',submitted:false,embeddedForms:[{url:'https://tally.so/embed/yXZYg6',title:'Alive Prize'}]})
  expect(result.answers.map((row:{question:string})=>row.question)).toEqual(['What makes you come alive?','Email'])
  dom.window.close()
})
it('reads only approved direct-frame documents when permission becomes available',async()=>{
  const url='https://tally.so/embed/yXZYg6?hideTitle=1'
  const outer={documentId:'top',organization:'Alive Prize',opportunity:'Alive Prize',submitted:false,answers:[{question:'Name',answer:''}],embeddedForms:[{url,title:'Alive Prize'}]}
  const form={answers:[{question:'Name',answer:'Ada'},{question:'Why apply?',answer:'My answer.'}]}
  const visible={documentId:'verified',documentLifecycle:'active',parentDocumentId:'top',parentFrameId:0,frameId:2,url}
  const getAllFrames=vi.fn().mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValueOnce([
    visible,{...visible,documentId:'wrong-query',frameId:3,url:url+'0'},
    {...visible,documentId:'nested',frameId:4,parentDocumentId:'other',parentFrameId:3},
    {...visible,documentId:'hidden',frameId:5,url:'https://tally.so/embed/unlisted'},
    {...visible,documentId:'cached',frameId:6,documentLifecycle:'cached'},
  ])
  const executeScript=vi.fn().mockResolvedValue([{documentId:'verified',frameId:2,result:form}])
  vi.stubGlobal('chrome',{scripting:{executeScript},webNavigation:{getAllFrames}})
  try {
    expect(await readEmbeddedApplicationForms(7,outer)).toEqual([])
    expect(executeScript).not.toHaveBeenCalled()
    const frames=await readEmbeddedApplicationForms(7,outer)
    expect(executeScript).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({target:{tabId:7,documentIds:['verified']},args:[{expectedUrl:url,embedded:true}]}))
    const merged=mergeApplicationForms(outer,frames.map(frame=>frame.result))
    expect(merged.answers).toEqual(form.answers)
    expect(outer.answers[0].answer).toBe('')
    expect(merged.opportunity).toBe('Alive Prize')
  } finally {vi.unstubAllGlobals()}
})
it.each([['https://example.org/apply','Thank you for your application'],['https://tally.so/embed/fixture','Thank you!']])('records an application only after submit intent followed by a visible successful acknowledgement: %s',async(url,acknowledgement)=>{
  const {readApplicationForm}=require('../../electron/application-capture.cjs')
  const dom=new JSDOM('<title>Prize</title><form><label>Why apply?<textarea>My full answer.</textarea></label><p>You will see a confirmation when your application is submitted.</p><button type="submit">Submit</button></form>',{url,runScripts:'outside-only'})
  dom.window.HTMLElement.prototype.getClientRects=()=>[{}]
  const messages:unknown[]=[]
  dom.window.chrome={runtime:{sendMessage:async(message:unknown)=>messages.push(message)}}
  const result=dom.window.eval('('+readApplicationForm.toString()+')({watch:{nonce:"nonce",applicationId:"saved",source:"https://example.org/apply"}})')
  expect(result.submitted).toBe(false)
  dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}))
  expect(messages).toEqual([])
  dom.window.document.body.innerHTML='<h1>'+acknowledgement+'</h1>'
  await new Promise(resolve=>setTimeout(resolve,0))
  expect(messages).toEqual([expect.objectContaining({type:'application-submitted',applicationId:'saved',form:expect.objectContaining({submitted:true,appliedAt:expect.any(Number),answers:[{question:'Why apply?',answer:'My full answer.'}]})})])
  dom.window.close()
})
