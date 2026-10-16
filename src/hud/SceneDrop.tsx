import { useEffect, useRef, useState } from 'react'
import { canTransition, useApp } from '../app/store.ts'
import { createNode, softDelete, useRepoStatus } from '../data/repo.ts'
import { truncateToPrecision } from '../domain/time.ts'
import { titleFromFileName } from '../world/splats/ingest/ingest.ts'
import { startIngest, useIngestJobs } from '../world/splats/ingest/jobs.ts'
import { ACCEPTED_EXTENSIONS, extensionOf } from '../world/splats/ingest/sniff.ts'

// "New memory from a splat file": drop a capture anywhere on the world (or TopBar → + Scene)
// and it becomes a memory, dated by the file's modification day (usually the capture day),
// titled after the file, selected so the Inspector shows the crystallising progress, and
// entered once its terrarium is built. A failed ingest sends the empty memory to the trash.

const ACCEPT = ACCEPTED_EXTENSIONS.join(',')

export function isSplatFile(f: File): boolean {
  const ext = extensionOf(f.name)
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(`.${ext}`)
}

export async function createMemoryFromSplat(file: File): Promise<string | null> {
  const day = file.lastModified > 0 && file.lastModified <= Date.now() ? file.lastModified : Date.now()
  const node = await createNode({
    archetype: 'memory',
    title: titleFromFileName(file.name),
    temporalOrigin: truncateToPrecision(day, 'day'),
    temporalPrecision: 'day',
  })
  const app = useApp.getState()
  app.select(node.id)
  const result = await startIngest(node.id, file)
  if (!result) {
    const failed = useIngestJobs.getState().jobs[node.id]?.error
    // Cancelled or failed: an empty memory is not what the user asked for.
    await softDelete(node.id).catch(() => {})
    if (failed) setSceneDropError(`${file.name}: ${failed}`)
    return null
  }
  const now = useApp.getState()
  if (now.selectedId === node.id && canTransition(now.mode, 'entering') && now.mode !== 'entering') {
    now.focus(node.id)
    now.setMode('entering')
  }
  return node.id
}

let openPicker: (() => void) | null = null
let setSceneDropError: (msg: string | null) => void = () => {}

/** TopBar entry point: the file picker for a new scene memory. */
export function openSceneFilePicker(): void {
  openPicker?.()
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

export function SceneDrop() {
  const writer = useRepoStatus((s) => s.writer)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const depth = useRef(0)

  useEffect(() => {
    openPicker = () => input.current?.click()
    setSceneDropError = setError
    return () => {
      openPicker = null
      setSceneDropError = () => {}
    }
  }, [])

  useEffect(() => {
    if (!writer) return
    // Window-level so a drop anywhere on the world works; the scene field in the node editor
    // handles its own drops and stops them (closest handler wins, see `defaultPrevented`).
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current++
      setOver(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    }
    const overFn = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      depth.current = 0
      setOver(false)
      if (e.defaultPrevented || !hasFiles(e)) return
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files ?? [])
      const splats = files.filter(isSplatFile)
      if (splats.length === 0) {
        if (files.length) setError(`Not a splat capture (${ACCEPTED_EXTENSIONS.join(' ')}): ${files[0].name}`)
        return
      }
      setError(null)
      // One at a time: each ingest takes the transcode worker and the Spark LoD worker.
      void (async () => {
        for (const f of splats) await createMemoryFromSplat(f)
      })()
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', overFn)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', overFn)
      window.removeEventListener('drop', drop)
    }
  }, [writer])

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          setError(null)
          void createMemoryFromSplat(f)
        }}
      />
      {over && (
        <div className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center border-2 border-dashed border-brass/80 bg-void/60">
          <div className="hud-panel px-6 py-4 text-center">
            <p className="hud-label m-0 mb-1">New memory</p>
            <p className="m-0 text-[13px] text-bone">Drop a Gaussian-splat capture to build its terrarium</p>
            <p className="m-0 mt-1 text-[11px] text-concrete">{ACCEPTED_EXTENSIONS.join(' ')}</p>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="hud-panel fixed bottom-24 left-1/2 z-30 flex max-w-[90vw] -translate-x-1/2 items-center gap-3 px-3 py-2 text-[12px]">
          <span className="text-signal">{error}</span>
          <button type="button" className="hud-btn" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </>
  )
}
