import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
const {matchNames}=createRequire(import.meta.url)('../../electron/contact-names.cjs')
it('returns only unique full-name matches and skips duplicates on either side',()=>{
  const names=['ANA JOSÉ','Unmatched Person','Alex Reed','Sam Lake','SAM LAKE','Cher']
  const candidates=['Ana Jose\u0301','Alex Reed','Alex Reed','Sam Lake','Cher','Ana Jose'].map((name,id)=>({name,id:String(id)}))
  expect(matchNames(candidates,names)).toEqual({ids:['0'],ambiguous:2})
})
