import { registerDevApi } from '../app/devApi.ts'
import { useWorld } from '../app/store.ts'
import { reanchorNodes } from '../data/repo.ts'
import { recrystallise } from './layout.ts'
import { semanticVectors } from './semanticIndex.ts'

// The re-crystallise event: lay the whole world out by meaning in one undoable step.

export async function runRecrystallise(): Promise<{ moved: number; meanTurn: number }> {
  const { nodes, settings } = useWorld.getState()
  if (!settings) throw new Error('The world is not ready')
  const result = recrystallise({ records: [...nodes.values()], vectors: semanticVectors(), seed: settings.physicsSeed })
  const moved = await reanchorNodes(result.targets, 'Re-crystallised')
  return { moved: moved.length, meanTurn: result.meanTurn }
}

registerDevApi('recrystallise', () => runRecrystallise())
