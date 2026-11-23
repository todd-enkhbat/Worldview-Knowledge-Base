import { describe, expect, it } from 'vitest'
import { passageLocator } from '../../src/workspace/evidence.ts'

describe('reader source location', () => {
  it('shows retained PDF page metadata even for an older character-only citation', () => {
    expect(passageLocator({ start: 6704, end: 6871, locator: 'Characters 6705–6871' }, { metadata: { pages: [{ page: 1, start: 0, end: 5000 }, { page: 2, start: 5001, end: 8000 }] } })).toBe('Page 2')
  })
  it('identifies a passage spanning pages and retains conversation locators without PDF metadata', () => {
    expect(passageLocator({ start: 20, end: 80 }, { metadata: { pages: [{ page: 1, start: 0, end: 50 }, { page: 2, start: 51, end: 100 }] } })).toBe('Pages 1–2')
    expect(passageLocator({ start: 20, end: 80, locator: 'Message 3' })).toBe('Message 3')
  })
})
