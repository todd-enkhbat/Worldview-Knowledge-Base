import { useEffect, useState } from 'react'
import { type DustIdentityOptions, type DustIdentityResult, runDustIdentity } from '../../gpu/dust/identity.ts'

declare global {
  interface Window {
    /** Dev: the full GPU dust pipeline (births, checkpoints, edits, backward) against the CPU world. */
    __dustIdentity?: (opts?: Omit<DustIdentityOptions, 'onProgress'>) => Promise<DustIdentityResult>
  }
}

type State = { running: boolean; progress: string; result: DustIdentityResult | null }
type Listener = (s: State) => void
const listeners = new Set<Listener>()
let state: State = { running: false, progress: 'idle', result: null }
let queue: Promise<unknown> = Promise.resolve()

function publish(patch: Partial<State>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l(state)
}

/** Serialised like the S2 runs: each owns a WebGL context while it runs. */
function run(opts: Omit<DustIdentityOptions, 'onProgress'> = {}): Promise<DustIdentityResult> {
  const p = queue.then(async () => {
    publish({ running: true, progress: 'starting…' })
    try {
      const result = await runDustIdentity({ ...opts, onProgress: (progress) => publish({ progress }) })
      publish({ result, progress: result.error ? 'error' : 'done' })
      return result
    } finally {
      publish({ running: false })
    }
  })
  queue = p.catch(() => {})
  return p
}

if (import.meta.env.DEV) window.__dustIdentity = run

export function DustIdentityPanel() {
  const [s, setS] = useState(state)
  useEffect(() => {
    listeners.add(setS)
    return () => {
      listeners.delete(setS)
    }
  }, [])
  const r = s.result
  const pass = r ? r.identical : null
  return (
    <section className="hud-panel mt-6 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="hud-label text-bone">G: dust pipeline CPU≡GPU</h2>
        <span
          className={`font-mono text-[11px] uppercase tracking-wider ${
            pass === null ? 'text-concrete' : pass ? 'text-glass' : 'text-signal'
          }`}
        >
          {s.running ? s.progress : pass === null ? s.progress : pass ? 'bit-identical' : 'mismatch'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button className="hud-btn" disabled={s.running} onClick={() => void run()}>
            run
          </button>
        </div>
      </div>
      <p className="mb-3 max-w-[72ch] text-[11px] leading-relaxed text-concrete">
        DustSim on the real WebGL2 backend: births regenerated on the GPU, k-step draws forward and back,
        checkpoint saves and restores, sync and async CPU edit rows. Every int is compared with the CPU dust
        world after each phase. In the world, <code>__wv.dustCheck()</code> runs the same comparison on the live
        dust at the playhead.
      </p>
      <pre className="max-h-[60vh] overflow-auto border border-bone/10 p-3 text-[11px] leading-snug text-bone">
        {r ? JSON.stringify(r, null, 2) : '—'}
      </pre>
    </section>
  )
}
