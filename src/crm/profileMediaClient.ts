import { getStore, getWorldGeneration, isRepoReady, useRepoStatus } from '../data/repo.ts'
import { crmGet, notifyCrmChanged } from './client.ts'

export const profileMediaGet = <T,>(personId: string, discover = false, signal?: AbortSignal) => crmGet<T>(`profile-media/${encodeURIComponent(personId)}${discover ? '?discover=true' : ''}`, { signal })

/** Remote bytes are downloaded by the local server; the UI never loads tracking images. */
export async function profileMediaPost<T>(path: string, input: Record<string, unknown>): Promise<T> {
  if (!isRepoReady() || !useRepoStatus.getState().writer) throw new Error('Open the writer window to save profile details.')
  const store = getStore(), generation = getWorldGeneration()
  const response = await fetch(`/api/crm/profile-media/${path.replace(/^\//, '')}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-wv-client': 'people-workspace' }, body: JSON.stringify(input) })
  const value = await response.json() as T & { error?: string }
  if (!isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) throw new Error('The workspace changed. Reopen People to check the saved result.')
  if (!response.ok) throw new Error(value.error ?? 'The profile update could not finish. Retry to check its saved result.')
  notifyCrmChanged()
  return value
}
