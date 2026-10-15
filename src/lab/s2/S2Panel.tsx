import { useEffect, useState } from 'react'
import { type S2Options, type S2Result, runS2 } from './runS2.ts'

declare global {
  interface Window {
    /** Dev: run the S2 CPU≡GPU dust check and return its JSON. */
    __s2?: (opts?: Omit<S2Options, 'onProgress'>) => Promise<S2Result>
  }
}

type Listener = (s: { running: boolean; progress: string; result: S2Result | null }) => void
const listeners = new Set<Listener>()
let state = { running: false, progress: 'idle', result: null as S2Result | null }
let queue: Promise<unknown> = Promise.resolve()
let autoRan = false

function publish(patch: Partial<typeof state>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l(state)
}

/** Runs are serialised (each one owns a WebGL context for its duration). */
function run(opts: Omit<S2Options, 'onProgress'> = {}): Promise<S2Result> {
  const p = queue.then(async () => {
    publish({ running: true, progress: 'starting…' })
    try {
      const result = await runS2({ ...opts, onProgress: (progress) => publish({ progress }) })
      publish({ result, progress: result.error ? 'error' : 'done' })
      return result
    } finally {
      publish({ running: false })
    }
  })
  queue = p.catch(() => {})
  return p
}

if (import.meta.env.DEV) window.__s2 = run

const SIZES = [4096, 16384, 65536, 131072]

export function S2Panel() {
  const [s, setS] = useState(state)
  const [n, setN] = useState(16384)

  useEffect(() => {
    listeners.add(setS)
    // StrictMode mounts twice in dev; run the default check once per page load.
    if (!autoRan) {
      autoRan = true
      void run()
    }
    return () => {
      listeners.delete(setS)
    }
  }, [])

  const r = s.result
  const pass = r ? r.identicalAfterForward && r.identicalAfterBackward : null
  return (
    <section className="hud-panel p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="hud-label text-bone">S2: CPU≡GPU dust</h2>
        <span
          className={`font-mono text-[11px] uppercase tracking-wider ${
            pass === null ? 'text-concrete' : pass ? 'text-glass' : 'text-signal'
          }`}
        >
          {s.running ? s.progress : pass === null ? s.progress : pass ? 'bit-identical' : 'mismatch'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="border border-bone/30 bg-void px-1 py-1 font-mono text-[11px] text-bone"
            value={n}
            onChange={(e) => setN(Number(e.target.value))}
            disabled={s.running}
          >
            {SIZES.map((v) => (
              <option key={v} value={v}>
                n = {v}
              </option>
            ))}
          </select>
          <button className="hud-btn" disabled={s.running} onClick={() => void run({ n })}>
            run
          </button>
        </div>
      </div>
      <p className="mb-3 max-w-[72ch] text-[11px] leading-relaxed text-concrete">
        The real dust kernel (tether + 8-mode landscape, integer-only) on an RGBA32I MRT ping-pong, compared in
        every int with the TypeScript reference after each draw: 500 steps forward, then 500 back to the uploaded
        state.
      </p>
      <pre className="max-h-[60vh] overflow-auto border border-bone/10 p-3 text-[11px] leading-snug text-bone">
        {r ? JSON.stringify(r, null, 2) : '—'}
      </pre>
    </section>
  )
}
