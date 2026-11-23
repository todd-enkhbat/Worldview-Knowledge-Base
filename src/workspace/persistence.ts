import { create } from 'zustand'
import { getStore, isRepoReady, putWorldState, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import type { WorldStore } from '../data/WorldStore.ts'
import { getWorkspaceScope, hasDeviceWorkspaceContext, restoreWorkspaceContext, useWorkspace, validateWorkspaceContext, workspaceHomeHash, type WorkspaceContext } from './state.ts'

export const WORKSPACE_KV = 'workspace.v1'
export const useWorkspacePersistence = create<{ error: string | null }>()(() => ({ error: null }))

interface Binding {
  scope: string
  store: WorldStore
  active: boolean
  ready: boolean
  changes: number
  suppress: boolean
  restoration: number
  awaitingFirstRun: boolean
  hadDeviceContext: boolean
  cleanup: (() => void)[]
  promise: Promise<void>
}
let binding: Binding | null = null
const writes = new Set<Promise<void>>()

function current(bound: Binding): boolean {
  return bound.active && binding === bound && getWorkspaceScope() === bound.scope && isRepoReady() && getStore() === bound.store
}

function persist(bound: Binding, context: WorkspaceContext) {
  if (!bound.ready || bound.suppress || !current(bound) || !useRepoStatus.getState().writer) return
  const value = { schemaVersion: 1, context: structuredClone(context) }
  const restoration = bound.restoration
  const task = putWorldState(WORKSPACE_KV, value, { store: bound.store, shouldWrite: () => current(bound) && bound.ready && !bound.suppress && bound.restoration === restoration }).then(() => {
    if (current(bound)) useWorkspacePersistence.setState({ error: null })
  }).catch((error) => {
    if (current(bound)) useWorkspacePersistence.setState({ error: `Your research context is saved on this device, but could not be included in the next backup: ${error instanceof Error ? error.message : String(error)}` })
  })
  writes.add(task)
  void task.finally(() => writes.delete(task))
}

function deactivate(bound: Binding) {
  bound.active = false
  for (const cleanup of bound.cleanup.splice(0)) cleanup()
  if (binding === bound) binding = null
}

function savedContext(value: unknown): WorkspaceContext | null {
  if (!value || typeof value !== 'object') return null
  const envelope = value as { schemaVersion?: unknown; context?: unknown }
  if (envelope.schemaVersion !== undefined && envelope.schemaVersion !== 1) return null
  const context = envelope.context ?? value
  if (!context || typeof context !== 'object') return null
  return validateWorkspaceContext(context)
}

async function restoreFromWorld(bound: Binding) {
  const restoration = bound.restoration
  const before = structuredClone(useWorkspace.getState())
  const value = await bound.store.getKv<unknown>(WORKSPACE_KV)
  if (!current(bound) || bound.hadDeviceContext || bound.restoration !== restoration) return
  const context = savedContext(value)
  if (!context) return
  // Preserve direct-link selection and any typing performed while the snapshot was loading.
  const latest = useWorkspace.getState()
  const restored = Object.fromEntries(Object.entries(context).map(([key, value]) => {
    const field = key as keyof WorkspaceContext
    return [key, JSON.stringify(latest[field]) === JSON.stringify(before[field]) ? value : latest[field]]
  })) as unknown as WorkspaceContext
  bound.suppress = true
  try { useWorkspace.setState(restored, true) } finally { bound.suppress = false }
}

async function adoptExplicitRestore(bound: Binding): Promise<void> {
  const restoration = ++bound.restoration
  bound.awaitingFirstRun = false
  bound.ready = false
  bound.suppress = true
  try {
    const value = await bound.store.getKv<unknown>(WORKSPACE_KV)
    if (!current(bound) || bound.restoration !== restoration) return
    const context = value === undefined ? validateWorkspaceContext(null) : savedContext(value)
    if (!context) throw new Error('The restored investigation context uses an unsupported format. Its saved copy has been preserved.')
    useWorkspace.setState(context, true)
    bound.suppress = false
    bound.ready = true
    persist(bound, context)
    location.hash = workspaceHomeHash()
  } catch (error) {
    if (current(bound) && bound.restoration === restoration) useWorkspacePersistence.setState({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    if (current(bound) && bound.restoration === restoration) bound.suppress = false
  }
}

/** Device context wins; a fresh device can resume the context retained in a restored archive. */
export function initializeWorkspacePersistence(scope = 'local'): Promise<void> {
  if (!isRepoReady()) return Promise.resolve()
  const store = getStore()
  if (binding?.active && binding.store === store && binding.scope === scope) return binding.promise
  if (binding) deactivate(binding)
  const hadDeviceContext = hasDeviceWorkspaceContext(scope)
  restoreWorkspaceContext(scope)
  const bound: Binding = { scope, store, active: true, ready: false, changes: 0, suppress: false, restoration: 0, awaitingFirstRun: false, hadDeviceContext, cleanup: [], promise: Promise.resolve() }
  binding = bound
  useWorkspacePersistence.setState({ error: null })
  bound.cleanup.push(useWorkspace.subscribe((context) => { if (!bound.suppress) bound.changes++; persist(bound, context) }))
  bound.cleanup.push(useRepoStatus.subscribe((status) => { if (!status.ready) deactivate(bound) }))
  bound.cleanup.push(subscribeRepo((change, origin) => {
    // Shared-device edits must never silently overwrite the investigation on this device.
    if (!current(bound) || origin !== 'local') return
    if (change.type === 'wipe') {
      bound.restoration++
      bound.awaitingFirstRun = true
      bound.ready = false
      bound.suppress = true
      try { useWorkspace.setState(validateWorkspaceContext(null), true) } finally { bound.suppress = false }
    }
    else if (change.type === 'import') void adoptExplicitRestore(bound)
    else if (change.type === 'settings' && bound.awaitingFirstRun) { bound.awaitingFirstRun = false; bound.ready = true; persist(bound, useWorkspace.getState()) }
  }))
  const restoration = bound.restoration
  bound.promise = (async () => {
    try { if (!hadDeviceContext) await restoreFromWorld(bound) } catch (error) {
      if (current(bound)) useWorkspacePersistence.setState({ error: `Could not restore saved research context: ${error instanceof Error ? error.message : String(error)}` })
    }
    if (!current(bound) || bound.restoration !== restoration) return
    bound.ready = true
    persist(bound, useWorkspace.getState())
  })()
  return bound.promise
}

/** Writes enter the repository queue immediately, ahead of a subsequently requested export. */
export async function flushWorkspacePersistence(): Promise<void> {
  if (binding && current(binding)) persist(binding, useWorkspace.getState())
  await Promise.all([...writes])
}
