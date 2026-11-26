import {expect,it} from 'vitest'
import {organizationClusters} from '../../src/crm/organizationClusters.ts'
import type {CrmPerson,CrmCompany} from '../../src/crm/types.ts'
it('connects school and employment records to the same organization and skips ambiguous bare names',()=>{
  const companies=[{id:'u',name:'Columbia University'},{id:'a',name:'Acme'},{id:'b',name:'Acme'}] as CrmCompany[]
  const people=[{id:'worker',companyIds:['u']},{id:'student',companyIds:[],affiliations:[{kind:'education',organization:'Columbia University'}]},{id:'other',companyIds:[],affiliations:[{organization:'Acme'}]}] as CrmPerson[]
  const graph=organizationClusters(people,companies)
  expect([...graph.byOrg.get('u')!]).toEqual(['worker','student'])
  expect(graph.byPerson.get('other')?.size).toBe(0)
})
