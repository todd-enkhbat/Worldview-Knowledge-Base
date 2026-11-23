import { checkAuth, signedIn } from '../data/auth.ts'
import { adoptServerDefault, probeEngine } from '../data/engine.ts'
import { initRepo, isRepoReady, useRepoStatus } from '../data/repo.ts'
import type { RepoStatus } from '../data/repo.ts'
import { installDevApi } from './devApi.ts'
import { markOnce } from './timings.ts'
import { isSemanticEnabled, isSemanticReady, startSemantic, useSemantic } from '../ai/semanticIndex.ts'
import { getStore, subscribeRepo } from '../data/repo.ts'
import { useWorld } from './store.ts'
import { initializeKnowledge, refreshKnowledge, syncKnowledgeNodes } from '../knowledge/index.ts'
import { invalidateCorpusSemantic, pruneCorpusSemantic, syncCorpusSemantic } from '../ai/corpusSemantic.ts'
import type { KnowledgeSnapshot } from '../knowledge/types.ts'
import { createWriterLock } from '../data/locks.ts'
import { initializeArtifacts, refreshArtifacts } from '../knowledge/artifacts/index.ts'

// Start the data layer once per page, outside React (StrictMode runs effects twice, and the
// world must load before the first frame needs it). Components read useWorld / useRepoStatus.

let booted: Promise<RepoStatus | null> | null = null

/** Open the world store, hydrate useWorld, take (or queue for) the writer lock, install window.__wv in dev. */
export function bootData(): Promise<RepoStatus | null> {
  booted ??= (async () => {
    installDevApi()
    markOnce('boot-start')
    try {
      // A hosted server with accounts: sign in first, then the world is the account's, on the
      // server. Locally: a browser with no world of its own starts on the server engine.
      const health = await probeEngine()
      const auth = health?.auth ?? 'none'
      // Explicit dev-only QA uses the server's isolated data directory and a separate
      // writer scope. It never switches or clears the browser's existing personal world.
      const qa = import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('qa') : null
      if (auth !== 'none') {
        if ((await checkAuth(auth)) !== 'signed-in') await signedIn()
      } else {
        await checkAuth('none')
        await adoptServerDefault(health).catch((e) => console.warn('[boot] engine default', e))
      }
      const status = await initRepo(qa && auth === 'none' && health ? {
        engine: 'sqlite', lock: createWriterLock({ name: `hyperspace-qa-${qa.slice(0, 80)}` }), sync: null, autoBackup: false, storageStatus: false,
      } : auth !== 'none' ? { engine: 'sqlite' } : {})
      markOnce('repo-ready')
      // The corpus follows the same committed world and writer lock, including restored
      // archives. A failed index must never prevent access to the user's original world.
      if (!status.interruptedImport) {
        await initializeKnowledge({ migrateChat: true }).catch((e) => console.warn('[boot] knowledge startup', e))
        await initializeArtifacts().catch((e) => console.warn('[boot] knowledge pages', e))
        if (status.writer) await syncKnowledgeNodes(await getStore().listNodes()).catch((e) => console.warn('[boot] legacy source migration', e))
      }
      let semanticTimer: ReturnType<typeof setTimeout> | null = null
      const knowledgeStore = getStore()
      let active = true
      const indexCorpus = () => {
        if (!active || useRepoStatus.getState().interruptedImport) return
        invalidateCorpusSemantic()
        if (semanticTimer) clearTimeout(semanticTimer)
        semanticTimer = setTimeout(() => {
          semanticTimer = null
          if (!active || !isRepoReady() || getStore() !== knowledgeStore || useRepoStatus.getState().interruptedImport) return
          void getStore().getKv<KnowledgeSnapshot>('knowledge.v1').then(async (snapshot) => {
            if (!snapshot) return
            await pruneCorpusSemantic(snapshot)
            if (isSemanticReady()) await syncCorpusSemantic(snapshot)
          }).catch((e) => console.warn('[knowledge] passage index', e))
        }, 250)
      }
      const unsubscribeSemantic = useSemantic.subscribe((next, previous) => {
        if (next.phase === 'ready' && previous.phase !== 'ready') indexCorpus()
        if (next.phase === 'off') invalidateCorpusSemantic()
      })
      indexCorpus()
      const unsubscribeKnowledge = subscribeRepo((change, origin) => {
        if (!active || !isRepoReady() || getStore() !== knowledgeStore) return
        if (change.type === 'kv' && change.keys.includes('knowledge.v1')) {
          indexCorpus()
          if (origin === 'remote') void refreshKnowledge().catch((e) => console.warn('[knowledge] refresh', e))
        } else if (change.type === 'wipe' || change.type === 'import') {
          invalidateCorpusSemantic()
          void refreshKnowledge().then(async () => {
            await refreshArtifacts()
            if (useRepoStatus.getState().writer) await syncKnowledgeNodes(await getStore().listNodes())
          }).catch((e) => console.warn('[knowledge] restored world', e))
        } else if (change.type === 'nodes' && useRepoStatus.getState().writer) {
          const world = useWorld.getState()
          void syncKnowledgeNodes([...world.nodes.values(), ...world.trash.values(), ...world.excluded.values()]).catch((e) => console.warn('[knowledge] record sync', e))
        }
      })
      const cleanup = () => {
        if (!active) return
        active = false
        unsubscribeKnowledge(); unsubscribeSemantic(); unsubscribeStatus()
        if (semanticTimer) clearTimeout(semanticTimer)
        invalidateCorpusSemantic()
      }
      const unsubscribeStatus = useRepoStatus.subscribe((next, previous) => {
        if (!next.ready) cleanup()
        else if (previous.interruptedImport && !next.interruptedImport) {
          void initializeKnowledge({ migrateChat: true }).then(async () => {
            await initializeArtifacts()
            if (active && next.writer) await syncKnowledgeNodes(await knowledgeStore.listNodes())
            indexCorpus()
          }).catch((e) => console.warn('[knowledge] recovery completed', e))
        }
      })
      import.meta.hot?.dispose(cleanup)
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
