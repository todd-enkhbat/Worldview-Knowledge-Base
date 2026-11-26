import {expect,it,vi} from 'vitest'
import { universityIdentity, universityMark } from '../../server/universityArtwork.ts'
import type {CrmCompany} from '../../src/crm/types.ts'

const identity={domain:'ox.ac.uk',names:['university of oxford','oxford university']}
it('only accepts the named parent university mark hosted by its institution',()=>{
  const page='https://www.maths.ox.ac.uk/'
  const mark='<a href="https://www.ox.ac.uk"><img alt="University of Oxford" src="/parent.svg"></a>'
  expect(universityMark(mark,page,identity)).toEqual({site:page,icons:[page+'parent.svg']})
  for(const markup of [mark.replace('University of Oxford','Oxford Mathematics'),mark.replace('/parent.svg','https://unrelated.org/image.png'),mark.replace('href="https://www.ox.ac.uk"','href="/department"')]) expect(universityMark(markup,page,identity)).toBeUndefined()
})
it('requires one exact active institution and rejects a conflicting retained domain',async()=>{
  const item={id:'https://ror.org/052gg0110',types:['education'],status:'active',names:[{types:['alias'],value:'Oxford University'}],links:[{type:'website',value:'https://www.ox.ac.uk'}]}
  const record={name:'Oxford University',urls:[],domain:''} as unknown as CrmCompany
  const get=(items:typeof item[])=>vi.fn<typeof fetch>(async()=>Response.json({number_of_results:items.length,items}))
  expect((await universityIdentity(record,()=>{},get([item])))?.domain).toBe('ox.ac.uk')
  expect(await universityIdentity(record,()=>{},get([item,item]))).toBeUndefined()
  expect(await universityIdentity({...record,domain:'other.edu'},()=>{},get([item]))).toBeUndefined()
})
