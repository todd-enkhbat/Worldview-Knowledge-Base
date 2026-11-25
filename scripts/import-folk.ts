import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { zipSync } from 'fflate'
import { normalizeFolkExport } from '../server/crmFolk.ts'
import { CRM_COLLECTIONS, type CrmSnapshot } from '../src/crm/types.ts'
import type { WorldSnapshot } from '../src/data/WorldStore.ts'

// Explicit CLI migration through the running authenticated local app. No Folk writes.
const args = process.argv.slice(2), source = args.find((arg) => !arg.startsWith('--'))
if (!source) throw new Error('Usage: node scripts/import-folk.ts PATH/folk-export.json [--apply]')
const root = resolve(dirname(source)), bytes = await readFile(resolve(source)), original = JSON.parse(bytes.toString()) as Record<string, unknown>, normalized = normalizeFolkExport(original)
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const stable = (value: unknown): string => JSON.stringify(value, (_, part: unknown) => part && typeof part === 'object' && !Array.isArray(part) ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part)
const report = { format: 'worldview-folk-migration-proof.v1', sourceSha256: hash(bytes), counts: normalized.report.counts, completeness: normalized.report.completeness, issues: normalized.report.issues }
if (!args.includes('--apply')) { console.log(JSON.stringify({ ...report, applied: false }, null, 2)); process.exit(0) }
const base = 'http://127.0.0.1:5173', headers = { 'x-wv-client': 'approved-folk-migration', 'x-wv-knowledge-format': '2', Origin: base }
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> { const response = await fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`); return response.status === 204 ? undefined as T : await response.json() as T }
const before = await request<WorldSnapshot>('/api/world/snapshot'), proofDir = join(root, `applied-${Date.now()}`)
await mkdir(proofDir, { recursive: true, mode: 0o700 }); await chmod(proofDir, 0o700)
const save = async (name: string, value: unknown) => { const path = join(proofDir, name); await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await chmod(path, 0o600) }
await save('before-world.json', before)
const originalHashes = new Map<string, string>()
for (const asset of before.assets) { const response = await fetch(`${base}/api/world/blobs/${encodeURIComponent(asset.id)}`, { headers }); if (!response.ok) throw new Error('A saved original could not be verified before migration.'); originalHashes.set(asset.id, hash(new Uint8Array(await response.arrayBuffer()))) }
await save('original-hashes.json', Object.fromEntries(originalHashes))
const originals: Record<string, Uint8Array> = {}; for (const name of (await readdir(root)).sort()) if (name === basename(source) || name === 'manifest.json' || name === 'normalization-report.json' || name.endsWith('.raw.json')) originals[basename(name)] = await readFile(join(root, name))
const archive = zipSync(originals, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') }), assetId = `crm-file-${hash(archive)}`, meta = { id: assetId, kind: 'file', mime: 'application/zip', bytes: archive.byteLength, createdAt: Date.now(), nodeId: null }
const uploaded = await fetch(`${base}/api/world/blobs/${assetId}?meta=${encodeURIComponent(JSON.stringify(meta))}`, { method: 'PUT', headers, body: archive }); if (!uploaded.ok) throw new Error('The original Folk export archive could not be retained.')
const snapshot = normalized.snapshot
for (const collection of CRM_COLLECTIONS) for (const row of snapshot[collection]) row.sourceRefs = row.sourceRefs.map((ref) => ({ ...ref, originalAssetId: assetId }))
const command = { operation: 'import', provider: 'folk', accountId: String(original.accountId ?? 'folk-workspace'), name: 'Folk workspace migration', originalAssetIds: [assetId], completeness: normalized.report.completeness, sourceErrors: normalized.report.issues, collections: snapshot }
const result = await request<{ counts: Record<string, number> }>('/api/crm/command', 'POST', { ...command, requestId: randomUUID() })
const after = await request<WorldSnapshot>('/api/world/snapshot'), imported = after.kv['crm.v1'] as CrmSnapshot
if (!imported) throw new Error('The CRM is missing from the portable workspace snapshot.')
const checks: Record<string, boolean> = { settingsPreserved: stable(before.settings) === stable(after.settings), worldNodesPreserved: stable(before.nodes) === stable(after.nodes), worldEventsPreserved: stable(before.events) === stable(after.events), existingPortableDataPreserved: Object.entries(before.kv).filter(([key]) => key !== 'crm.v1').every(([key, value]) => stable(value) === stable(after.kv[key])), existingAssetMetadataPreserved: before.assets.every((asset) => after.assets.some((next) => stable(asset) === stable(next))), originalsPreserved: true, importedRawPreserved: true, sourceAssetRetained: false }
for (const [id, expected] of originalHashes) { const response = await fetch(`${base}/api/world/blobs/${encodeURIComponent(id)}`, { headers }); checks.originalsPreserved &&= response.ok && hash(new Uint8Array(await response.arrayBuffer())) === expected }
for (const collection of CRM_COLLECTIONS.filter((name) => !['imports', 'history'].includes(name))) { const expected = snapshot[collection]; checks[`${collection}Present`] = expected.every((row) => imported[collection].some((next) => next.id === row.id)); for (const row of expected) { const saved = imported[collection].find((next) => next.id === row.id); checks.importedRawPreserved &&= stable(row.raw) === stable(saved?.raw) } }
const retained = await fetch(`${base}/api/world/blobs/${assetId}`, { headers }); checks.sourceAssetRetained = retained.ok && hash(new Uint8Array(await retained.arrayBuffer())) === hash(archive)
const replay = await request<{ counts: Record<string, number> }>('/api/crm/command', 'POST', { ...command, requestId: randomUUID() }); checks.reimportIdempotent = replay.counts.created === 0 && replay.counts.staged === 0
await save('after-world.json', await request('/api/world/snapshot'))
await save('verification.json', { ...report, applied: true, result, reimport: replay.counts, originalAssetId: assetId, checks, pass: Object.values(checks).every(Boolean) })
if (!Object.values(checks).every(Boolean)) throw new Error(`Migration verification failed. Review the private proof in ${proofDir}.`)
console.log(JSON.stringify({ applied: true, counts: normalized.report.counts, checks, privateProof: proofDir, pass: true }, null, 2))
