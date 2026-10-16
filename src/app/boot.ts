import { initRepo, useRepoStatus } from '../data/repo.ts'
import type { RepoStatus } from '../data/repo.ts'
import { installDevApi } from './devApi.ts'
import { isSemanticEnabled, startSemantic } from '../ai/semanticIndex.ts'

// Start the data layer once per page, outside React (StrictMode runs effects twice, and the
// world must load before the first frame needs it). Components read useWorld / useRepoStatus.

let booted: Promise<RepoStatus | null> | null = null

/** Open the world store, hydrate useWorld, take (or queue for) the writer lock, install window.__wv in dev. */
export function bootData(): Promise<RepoStatus | null> {
  booted ??= (async () => {
    installDevApi()
    try {
      const status = await initRepo()
      // Opt-in per browser (a 175 MB model download): only resume if it was turned on.
      if (isSemanticEnabled()) startSemantic().catch((e) => console.warn('[boot] semantic index failed to start', e))
      return status
    } catch (e) {
      console.error('[boot] the data layer failed to start', e)
      if (!useRepoStatus.getState().error) {
        useRepoStatus.setState({ error: `The world could not be opened: ${e instanceof Error ? e.message : String(e)}` })
      }
      return null
    }
  })()
  return booted
}
