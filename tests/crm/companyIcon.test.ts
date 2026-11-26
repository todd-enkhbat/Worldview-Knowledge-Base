import { expect,it } from 'vitest'
import { rasterCompanyIcon } from '../../server/companyIcon.ts'
it('retains a raster preview of an official vector mark',async()=>{
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>')
  expect(Buffer.from(await rasterCompanyIcon(svg)).subarray(1,4).toString()).toBe('PNG')
})
it('keeps remote references out of the decoder',async()=>{
  const bytes=Buffer.from('<svg><image href="https://example.test/logo"/></svg>')
  expect(await rasterCompanyIcon(bytes)).toBe(bytes)
})
