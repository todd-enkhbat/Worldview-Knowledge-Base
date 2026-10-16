import { lazy, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react'

// Hash routes: #/ world · #/lab · #/lab/perf · #/lab/s1 · #/sandbox/<name> (dev only).
// Static hosting needs no server rewrites.
type Route = 'world' | 'lab' | 'perf' | 's1' | 'sandbox'

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/'
  if (import.meta.env.DEV && path.startsWith('/sandbox/')) return 'sandbox'
  if (path.startsWith('/lab/perf')) return 'perf'
  if (path.startsWith('/lab/s1')) return 's1'
  if (path.startsWith('/lab')) return 'lab'
  return 'world'
}

const WorldPage = lazy(() => import('./world/WorldPage.tsx'))
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
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash))
  const [hash, setHash] = useState(() => location.hash)

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash(location.hash))
      setHash(location.hash)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return (
    <Suspense fallback={<Boot />}>
      {route === 'world' && <WorldPage />}
      {route === 'lab' && <LabPage />}
      {route === 'perf' && <PerfBench />}
      {route === 's1' && <S1Spike />}
      {route === 'sandbox' && <Sandbox hash={hash} />}
    </Suspense>
  )
}

function Boot() {
  return (
    <div className="flex h-full items-center justify-center font-mono text-[11px] uppercase tracking-[0.2em] text-concrete">
      crystallising…
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
