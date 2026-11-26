import { create } from 'zustand'
import type { RetrievalRun } from './evidenceRanking.ts'

export { fuseEvidence, retrievalCoverage, type RetrievalRun } from './evidenceRanking.ts'

export const useRetrievalTrace = create<{ run: RetrievalRun | null }>(() => ({ run: null }))
