import { initRepo, useRepoStatus } from '../data/repo.ts'
import type { RepoStatus } from '../data/repo.ts'
import { installDevApi } from './devApi.ts'

// Start the data layer once per page, outside React (StrictMode runs effects twice, and the
// world must load before the first frame needs it). Components read useWorld / useRepoStatus.

let booted: Promise<RepoStatus | null> | null = null

/** Open the world store, hydrate useWorld, take (or queue for) the writer lock, install window.__wv in dev. */
export function bootData(): Promise<RepoStatus | null> {
  booted ??= (async () => {
    installDevApi()
    try {
      return await initRepo()
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
