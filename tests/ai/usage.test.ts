import { describe, expect, it } from 'vitest'
import { addUsage, estimateCost, ledgerCost, type UsageLedger } from '../../src/ai/usage.ts'

describe('AI usage estimate', () => {
  it('prices Opus 5.5 at $4 in, $20 out, $0.20 cache read, 1.25× input for cache writes', () => {
    expect(estimateCost('claude-opus-5-5', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(4)
    expect(estimateCost('claude-opus-5-5', { input: 0, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 })).toBeCloseTo(20 + 0.2 + 5)
    expect(estimateCost('claude-haiku-5-5', { input: 2e6, output: 2e6, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(1.2)
    expect(estimateCost('some-unknown-model', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull()
  })

  it('counts OpenAI cached input separately from uncached input and includes reasoning in total output', () => {
    expect(estimateCost('gpt-6.2-sol', { input: 9000, output: 1000, cacheRead: 1000, cacheWrite: 0 })).toBeCloseTo(0.0281)
  })

  it('adds per model and reports unpriced models', () => {
    let l: UsageLedger = { byModel: {}, since: 0 }
    l = addUsage(l, 'claude-opus-5-5', { input: 500_000, output: 10_000 })
    l = addUsage(l, 'claude-opus-5-5', { input: 500_000, cacheRead: 100 })
    l = addUsage(l, 'mystery', { input: 5 })
    expect(l.byModel['claude-opus-5-5']).toEqual({ input: 1_000_000, output: 10_000, cacheRead: 100, cacheWrite: 0 })
    const c = ledgerCost(l)
    expect(c.usd).toBeCloseTo(4 + 0.2 + 0.00002)
    expect(c.unpriced).toEqual(['mystery'])
  })
})
