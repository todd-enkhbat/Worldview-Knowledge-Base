import { openWorldDb } from '../../server/worldDb.ts'
import { describe,it,expect,vi } from 'vitest'
import { applicationContext,applicationMetadata,tallyQuestions,applicationStructuredMetadata } from '../../server/applicationContext.ts'
import { applyStudy,decodeStudy,applicationAppliedAt } from '../../src/study/model.ts'
const tally = '<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{name:'Alive Prize 3.0',blocks:[{type:'TITLE',groupType:'QUESTION',payload:{safeHTMLSchema:[['What makes you come alive? (&lt; 200 words)']]}},{type:'TEXTAREA',payload:{}},{type:'TEXTAREA',payload:{placeholder:'website, manifesto, deck, demo'}}]}}})+'</script>'
describe('application page context',()=>{
 it('reads the parent opportunity, follows the published same-origin deadline, and extracts embedded Tally questions',async()=>{
  const request=vi.fn(async(address:unknown)=>new Response(String(address)==='https://aliveprize.com/apply'?'<title>Alive Prize — Apply</title><iframe src="https://tally.so/embed/yXZYg6"></iframe>':String(address)==='https://aliveprize.com/'?'<title>Alive Prize</title><p>The Alive Prize provides $100k to build what makes you come alive.</p><p>Applications take ten minutes and close 11/25.</p>':tally,{headers:{'content-type':'text/html'}}))
  const result=await applicationContext({source:'https://aliveprize.com/apply?token=not-forwarded',answers:[]},undefined,request as typeof fetch)
  expect(result).toMatchObject({opportunity:'Alive Prize',organization:'Alive Prize',deadline:'11/25',deadlineSource:'https://aliveprize.com/',source:'https://aliveprize.com/apply'})
  expect(result.answers).toEqual([{question:'What makes you come alive? (< 200 words)',answer:''},{question:'website, manifesto, deck, demo',answer:''}])
  expect(result).not.toHaveProperty('appliedAt')
  expect(request).toHaveBeenCalledTimes(3)
 })
 it('never fabricates a year or a submission time and ignores dates unrelated to a deadline',()=>{
  expect(applicationMetadata('Research fellowship — Apply','Founded in 2020. Award $100,000.')).toMatchObject({deadline:'',deadlineEvidence:''})
  expect(applicationMetadata('Award','Deadline: November 25, 2026')).toMatchObject({deadline:'November 25, 2026'})
  expect(tallyQuestions('<script>not form data</script>')).toEqual([])
 })
 it('preserves a first confirmed application time, deadline evidence and archive compatibility',()=>{
  const state=decodeStudy(undefined),entry={organization:'Alive Prize',opportunity:'Alive Prize',source:'https://aliveprize.com/apply',step:'Application',submitted:false,answers:[],deadline:'11/25',deadlineEvidence:'Applications close 11/25',deadlineSource:'https://aliveprize.com/'}
  const id=applyStudy(state,'application',entry,100)
  expect(state.applications[0].appliedAt).toBeUndefined()
  applyStudy(state,'application',{...entry,id,submitted:true,appliedAt:200,step:'Submission confirmation'},220)
  applyStudy(state,'application',{...entry,id,submitted:true,step:'Submission confirmation'},300)
  expect(state.applications[0]).toMatchObject({appliedAt:200,deadline:'11/25'})
  expect(state.applications[0].revisions).toHaveLength(2)
  expect(decodeStudy(state)).toEqual(state)
 })
})

it('uses source-published job metadata for opportunity, hiring organization, and exact deadline',()=>{
 const html='<script type="application/ld+json">'+JSON.stringify({'@type':'JobPosting',title:'Research Fellow',hiringOrganization:{name:'Example Institute'},validThrough:'2026-12-01T23:59:00Z'})+'</script>'
 expect(applicationStructuredMetadata(html)).toMatchObject({opportunity:'Research Fellow',organization:'Example Institute',deadline:'2026-12-01T23:59:00Z'})
})

it('uses dated historical confirmations but never treats an old capture timestamp as the applied date',()=>{
 const state=decodeStudy(undefined),base={organization:'Prize',opportunity:'Prize',source:'saved confirmation',step:'Confirmation',submitted:true,answers:[]}
 applyStudy(state,'application',base,500)
 expect(applicationAppliedAt(state.applications[0])).toBeNull()
 applyStudy(state,'application',{...base,id:state.applications[0].id,sourceDate:'2026-11-20T12:00:00Z'},600)
 expect(applicationAppliedAt(state.applications[0])).toBe(Date.parse('2026-11-20T12:00:00Z'))
})

it('recognizes a saved CRM organization by the application website rather than guessing from the prize title',async()=>{
 const db=openWorldDb(':memory:')
 db.putSettings({T0:0,yPerYear:12,stepsPerYear:600,physicsSeed:42,qualityTier:'auto',firstRunComplete:true,lastBackupAt:null,autoBackupEnabled:false,createdAt:1,schemaVersion:1})
 try {
  db.crm.command({requestId:'example-foundation',operation:'create',collection:'companies',record:{id:'foundation',name:'Example Foundation',domain:'example.org'}})
  const request=vi.fn(async()=>new Response('<title>Example Prize — Apply</title><p>Deadline: December 1, 2026</p>',{headers:{'content-type':'text/html'}}))
  expect(await applicationContext({source:'https://example.org/apply',hasAnswers:true},db,request as typeof fetch)).toMatchObject({opportunity:'Example Prize',organization:'Example Foundation',organizationId:'foundation',deadline:'December 1, 2026',workspaceToken:expect.any(String)})
 } finally {db.close()}
})
