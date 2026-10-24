import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { _forgetMemoryForTests, findOriginal, rememberOriginal } from '../../src/ai/chat/originals.ts'

describe('pending originals', () => {
  it('survive a reload (memory gone, browser storage remains)', async () => {
    rememberOriginal(new File(['photo bytes'], 'portrait.jpg', { type: 'image/jpeg' }))
    // Let the background write land, then forget the in-memory copy.
    for (let i = 0; i < 50 && !(await findOriginalFromStorageOnly('portrait.jpg')); i++) await new Promise((r) => setTimeout(r, 5))
    _forgetMemoryForTests()
    const f = await findOriginal('portrait.jpg')
    expect(f?.name).toBe('portrait.jpg')
    expect(await f?.text()).toBe('photo bytes')
    expect(await findOriginal('folder/portrait.jpg')).toBeDefined()
    expect(await findOriginal('never-added.png')).toBeUndefined()
  })
})

async function findOriginalFromStorageOnly(name: string): Promise<boolean> {
  _forgetMemoryForTests()
  return !!(await findOriginal(name))
}
