import { getStore, getWorldGeneration, isRepoReady, useRepoStatus } from '../data/repo.ts'
import { notifyCrmChanged } from './client.ts'

/** The review stays bound to the workspace that initiated it, even during recovery. */
export async function profileCapturePost<T>(path: string, input: Record<string, unknown>): Promise<T> {
  if (!isRepoReady() || !useRepoStatus.getState().writer) throw new Error('Open the writer window to collect and save profile details.')
  const store = getStore(), generation = getWorldGeneration()
  const response = await fetch(`/api/crm/profile-capture${path ? `/${path.replace(/^\//, '')}` : ''}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-wv-client': 'people-workspace' }, body: JSON.stringify(input) })
  const value = await response.json() as T & { error?: string }
  if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) throw new Error('The workspace changed. Reopen Collect profile to check the saved result.')
  if (!response.ok) throw new Error(value.error ?? 'The capture could not finish. Your review is still here.')
  notifyCrmChanged()
  return value
}
