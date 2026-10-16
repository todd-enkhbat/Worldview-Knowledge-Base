import { create } from 'zustand'
import { ingestScene, type IngestOptions, type IngestProgress, type IngestResult } from './ingest.ts'

// In-flight ingests by node, outside React: closing the editor must not lose (or cancel) a
// scene that is still crystallising, and the Inspector / world can show the same progress.

export interface IngestJobState {
  nodeId: string
  fileName: string
  progress: IngestProgress
  /** Set when the job failed; the job stays listed until dismissed or restarted. */
  error: string | null
  running: boolean
  startedAt: number
}

export const useIngestJobs = create<{ jobs: Readonly<Record<string, IngestJobState>> }>()(() => ({ jobs: {} }))

const controllers = new Map<string, AbortController>()

function patch(nodeId: string, next: Partial<IngestJobState> | null): void {
  useIngestJobs.setState((s) => {
    const jobs = { ...s.jobs }
    if (next === null) delete jobs[nodeId]
    else jobs[nodeId] = { ...jobs[nodeId], ...next }
    return { jobs }
  })
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

/**
 * Start (or restart) the ingest for a node. Resolves with the result, or null when it was
 * cancelled or failed (the failure stays in useIngestJobs for the UI).
 */
export async function startIngest(
  nodeId: string,
  source: Blob | { url: string },
  opts: Omit<IngestOptions, 'onProgress' | 'signal'> = {},
): Promise<IngestResult | null> {
  controllers.get(nodeId)?.abort()
  const controller = new AbortController()
  controllers.set(nodeId, controller)
  const fileName = opts.name ?? (source instanceof Blob ? ((source as Partial<File>).name ?? 'scene') : source.url.split('/').pop() || 'scene')
  patch(nodeId, {
    nodeId,
    fileName,
    progress: { stage: 'read', fraction: 0, label: 'reading file' },
    error: null,
    running: true,
    startedAt: Date.now(),
  })
  try {
    const result = await ingestScene(nodeId, source, {
      ...opts,
      signal: controller.signal,
      onProgress: (progress) => {
        if (controllers.get(nodeId) === controller) patch(nodeId, { progress })
      },
    })
    if (controllers.get(nodeId) === controller) patch(nodeId, null)
    return result
  } catch (e) {
    if (controllers.get(nodeId) !== controller) return null // superseded by a restart
    if (isAbort(e)) patch(nodeId, null)
    else patch(nodeId, { running: false, error: e instanceof Error ? e.message : String(e) })
    return null
  } finally {
    if (controllers.get(nodeId) === controller) controllers.delete(nodeId)
  }
}

export function cancelIngest(nodeId: string): void {
  controllers.get(nodeId)?.abort()
}

/** Forget a failed job (the error message). */
export function dismissIngest(nodeId: string): void {
  if (!controllers.has(nodeId)) patch(nodeId, null)
}
