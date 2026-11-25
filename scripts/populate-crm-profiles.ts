import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { publicProfileUrl, profilePlatform } from '../server/crmProfileMedia.ts'
import type { CrmSnapshot } from '../src/crm/types.ts'
import type { WorldSnapshot } from '../src/data/WorldStore.ts'

// Existing attached sources only. No name search, paid providers, browser cookies or AI.
const args = process.argv.slice(2), apply = args.includes('--apply'), resume = args.find(value => value.startsWith('--resume='))?.slice(9), base = 'http://127.0.0.1:5173'
const directory = resolve(resume || `data/qa/crm-profile-population-${Date.now()}`), headers = { 'x-wv-client': 'approved-profile-population', 'x-wv-knowledge-format': '2', Origin: base }
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`)
  return response.json() as Promise<T>
}
const before = await request<WorldSnapshot>('/api/world/snapshot'), crm = before.kv['crm.v1'] as CrmSnapshot
if (!crm) throw new Error('Open the migrated local People workspace before populating profiles.')
const websites = crm.people.filter(person => person.archivedAt === null && !person.mergedIntoId && person.urls.some(url => { const value = publicProfileUrl(url); return value && profilePlatform(value) === 'website' }))
if (!apply) { console.log(JSON.stringify({ applied: false, people: crm.people.length, attachedWebsiteProfiles: websites.length, savedPortraits: crm.people.filter(person => !!person.avatarAssetId).length, note: 'Use --apply to process eligible attached sources. Existing portraits and unrelated data are preserved.' }, null, 2)); process.exit(0) }
await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700)
async function save(name: string, value: unknown) { const path = join(directory, name); await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await chmod(path, 0o600) }
interface Batch { offset: number; requestId: string }
interface Result { total: number; offset: number; nextOffset: number | null; downloaded: number; updated: number; addedLinks: number; results: { personId: string; status: string; downloaded?: boolean; addedLinks?: number; error?: string; notices?: string[] }[] }
let plan: { total: number; batches: Batch[] }
const outcomes = new Map<number, Result>()
async function run(batch: Batch) {
  const name = `batch-${String(batch.offset).padStart(5, '0')}.json`
  const existing = await readFile(join(directory, name), 'utf8').catch(() => null)
  const result = existing ? JSON.parse(existing) as Result : await request<Result>('/api/crm/profile-media/populate', { requestId: batch.requestId, offset: batch.offset, limit: 5, discover: true, eligibleOnly: true })
  if (!Number.isSafeInteger(result.total) || !Array.isArray(result.results) || result.offset !== batch.offset) throw new Error('The profile population receipt is incomplete.')
  if (!existing) await save(name, result)
  outcomes.set(batch.offset, result)
  console.log(JSON.stringify({ checked: [...outcomes.values()].reduce((sum, value) => sum + value.results.length, 0), total: result.total, photos: [...outcomes.values()].reduce((sum, value) => sum + value.downloaded, 0), links: [...outcomes.values()].reduce((sum, value) => sum + value.addedLinks, 0), batch: batch.offset }))
  return result
}
if (resume) plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as typeof plan
else {
  await save('before-world.json', before)
  const first = { offset: 0, requestId: randomUUID() }; await save('initial-request.json', first)
  const firstResult = await run(first)
  plan = { total: firstResult.total, batches: Array.from({ length: Math.ceil(firstResult.total / 5) }, (_, index) => index === 0 ? first : { offset: index * 5, requestId: randomUUID() }) }
  await save('plan.json', plan)
}
const queue = [...plan.batches]
await Promise.all(Array.from({ length: 3 }, async () => { for (;;) { const batch = queue.shift(); if (!batch) return; if (!outcomes.has(batch.offset)) await run(batch) } }))
const summary = { format: 'worldview-profile-population.v1', completedAt: Date.now(), eligible: plan.total, checked: [...outcomes.values()].reduce((sum, value) => sum + value.results.length, 0), photos: [...outcomes.values()].reduce((sum, value) => sum + value.downloaded, 0), links: [...outcomes.values()].reduce((sum, value) => sum + value.addedLinks, 0), errors: [...outcomes.values()].flatMap(value => value.results.filter(row => row.status === 'error')).length, cloudAiUsed: false }
await save('after-world.json', await request('/api/world/snapshot')); await save('summary.json', summary)
console.log(JSON.stringify({ ...summary, privateProof: directory }, null, 2))
