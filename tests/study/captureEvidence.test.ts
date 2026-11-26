import {createRequire} from 'node:module'
import {it,expect} from 'vitest'
import {docTarget,extractApplicationTab} from '../../server/connections/applicationDoc.ts'
import {parseApplicationPaste,safeApplicationText} from '../../src/study/model.ts'
const require=createRequire(import.meta.url)
const {JSDOM}=require('jsdom')
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
