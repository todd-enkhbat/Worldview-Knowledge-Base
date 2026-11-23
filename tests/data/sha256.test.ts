import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { sha256Text } from '../../src/data/sha256.ts'

it('matches SHA-256 standard vectors and UTF-8/block-boundary reference hashes', () => {
  expect(sha256Text('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(sha256Text('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(sha256Text('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  for (const length of [1, 31, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024, 10001]) {
    const text = '🧠 Evidence café עברית\ud800'.repeat(length)
    expect(sha256Text(text)).toBe(createHash('sha256').update(text).digest('hex'))
  }
})
