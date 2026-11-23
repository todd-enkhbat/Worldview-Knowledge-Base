import { lazy, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react'
import { useAuth } from './data/auth.ts'
import { SignIn } from './hud/SignIn.tsx'
import { parseAppRoute, type AppRoute } from './workspace/routes.ts'
import { ExploreBoundary } from './workspace/ExploreBoundary.tsx'
import { WorkspaceBoundary } from './workspace/WorkspaceBoundary.tsx'
import { useRepoStatus } from './data/repo.ts'
import { initializeWorkspacePersistence } from './workspace/persistence.ts'
import { workspaceScopeForAccount } from './workspace/state.ts'
import { initialWorkspaceTheme } from './workspace/appearance.ts'

// Daily routes open without WebGL; #/explore retains the full world, alongside the lab routes.
// Static hosting needs no server rewrites.
const parseHash = (hash: string): AppRoute => parseAppRoute(hash, import.meta.env.DEV)

const WorldPage = lazy(() => import('./world/WorldPage.tsx'))
const ExploreBridge = lazy(() => import('./workspace/ExploreBridge.tsx'))
const Workbench = lazy(() => import('./workspace/Workbench.tsx'))
const LabPage = lazy(() => import('./lab/LabPage.tsx'))
const PerfBench = lazy(() => import('./lab/PerfBench.tsx'))
const S1Spike = lazy(() => import('./lab/S1Spike.tsx'))

// Dev sandboxes: each src/sandbox/<name>.tsx default-exports an isolated page for one module.
const sandboxModules = import.meta.glob<{ default: ComponentType }>('./sandbox/*.tsx')
const sandboxCache = new Map<string, LazyExoticComponent<ComponentType>>()
function sandboxFor(hash: string): LazyExoticComponent<ComponentType> | null {
  const name = hash.replace(/^#\/sandbox\//, '').split(/[/?]/)[0]
  const loader = sandboxModules[`./sandbox/${name}.tsx`]
  if (!loader) return null
  if (!sandboxCache.has(name)) sandboxCache.set(name, lazy(loader))
  return sandboxCache.get(name)!
}

export default function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseHash(location.hash))
  const [hash, setHash] = useState(() => location.hash)

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash(location.hash))
      setHash(location.hash)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const auth = useAuth((s) => s.state)
  const userId = useAuth((s) => s.user?.id)
  const ready = useRepoStatus((s) => s.ready)
  useEffect(() => {
    if (ready && auth !== 'signed-out') void initializeWorkspacePersistence(workspaceScopeForAccount(userId, location.search, import.meta.env.DEV))
  }, [ready, auth, userId])
  if (auth === 'signed-out' && route !== 'sandbox') return <SignIn />

  return (
    <Suspense fallback={<Boot />}>
      {route === 'world' && <ExploreBoundary key={hash}><WorldPage /><ExploreBridge hash={hash} /></ExploreBoundary>}
      {(route === 'today' || route === 'search' || route === 'library' || route === 'topics' || route === 'knowledge' || route === 'review' || route === 'sources') && <WorkspaceBoundary key={userId ?? 'local'}><Workbench section={route} hash={hash} /></WorkspaceBoundary>}
      {route === 'lab' && <LabPage />}
      {route === 'perf' && <PerfBench />}
      {route === 's1' && <S1Spike />}
      {route === 'sandbox' && <Sandbox hash={hash} />}
    </Suspense>
  )
}

function Boot() {
  const [theme] = useState(initialWorkspaceTheme)
  return (
    <div className="workspace-boot" data-theme={theme} role="status">
      <span className="workspace-boot-spinner" aria-hidden="true" />
      <strong>Worldview</strong>
      <p>Opening your saved workspace…</p>
    </div>
  )
}

function Sandbox({ hash }: { hash: string }) {
  const Page = sandboxFor(hash)
  if (!Page) {
    const names = Object.keys(sandboxModules).map((k) => k.replace('./sandbox/', '').replace('.tsx', ''))
    return (
      <div className="p-6 font-mono text-[12px] text-bone">
        <div className="hud-label mb-2">sandboxes</div>
        {names.map((n) => (
          <div key={n}>
            <a className="underline" href={`#/sandbox/${n}`}>
              {n}
            </a>
          </div>
        ))}
      </div>
    )
  }
  return <Page />
}
