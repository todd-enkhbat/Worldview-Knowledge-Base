import { describe, expect, it } from 'vitest'
import { loadRetrievalEvalFixture, runRetrievalEvaluation, sourceRankingMetrics } from '../../scripts/eval-retrieval.ts'

describe('source-grain evidence evaluation', () => {
  it('uses one source rank for duplicate passages and standard graded nDCG', () => {
    const metrics = sourceRankingMetrics([{ sourceId: 'noise' }, { sourceId: 'a' }, { sourceId: 'a' }, { sourceId: 'b' }], { a: 3, b: 1, absent: 1 }, 3)
    expect(metrics.sourceRanking).toEqual(['noise', 'a', 'b'])
    expect(metrics.recall).toBeCloseTo(2 / 3)
    expect(metrics.reciprocalRank).toBe(1 / 2)
    expect(metrics.ndcg).toBeCloseTo((7 / Math.log2(3) + 1 / Math.log2(4)) / (7 + 1 / Math.log2(3) + 1 / Math.log2(4)))
  })

  it('executes all fifty tasks through SQLite FTS and portable search with real packet delivery', async () => {
    const fixture = await loadRetrievalEvalFixture()
    const report = await runRetrievalEvaluation(fixture)
    expect(fixture.questions).toHaveLength(50)
    expect(report.engines.map((result) => result.engine)).toEqual(['sqlite-fts5', 'portable-lexical'])
    for (const engine of report.engines) {
      expect(engine.questions).toBe(50)
      expect(engine.invariantFailures, JSON.stringify(engine.cases.filter((result) => result.failures.length), null, 2)).toBe(0)
      expect(engine.correctAbstentions).toBe(engine.abstentionQuestions)
      expect(engine.recallAtK).toBeGreaterThanOrEqual(.95)
      expect(engine.mrrAtK).toBeGreaterThanOrEqual(.9)
      expect(engine.ndcgAtK).toBeGreaterThanOrEqual(.9)
      expect(engine.cases.find((result) => result.id === '47')?.packet.evidenceOmissions).toBeGreaterThan(0)
      expect(engine.cases.find((result) => result.id === '44')?.packet.contextIds).toContain('orchid-project')
    }
  })
})
