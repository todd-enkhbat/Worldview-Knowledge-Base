import { registerDevApi } from '../app/devApi.ts'
import { useWorld } from '../app/store.ts'
import { applyReanchorPlan, planReanchoring } from '../data/repo.ts'
import { recrystallise } from './layout.ts'
import { semanticVectors } from './semanticIndex.ts'

// The re-crystallise event: lay the whole world out by meaning in one undoable step.

export function previewRecrystallise() {
  const { nodes, settings } = useWorld.getState()
  if (!settings) throw new Error('The world is not ready')
  const result = recrystallise({ records: [...nodes.values()], vectors: semanticVectors(), seed: settings.physicsSeed })
  return { plan: planReanchoring(result.targets), meanTurn: result.meanTurn }
}

export async function runRecrystallise(preview = previewRecrystallise()): Promise<{ moved: number; meanTurn: number }> {
  const moved = await applyReanchorPlan(preview.plan, 'Re-crystallised')
  return { moved: moved.length, meanTurn: preview.meanTurn }
}

registerDevApi('recrystallise', () => runRecrystallise())
