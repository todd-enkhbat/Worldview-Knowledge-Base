// node scripts/compare-qmd.ts [--qmd-binary /absolute/path/to/qmd] [--size 1000]
// Lexical-only, explicit native opt-in. Never installs QMD or downloads models.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { openWorldDb } from '../server/worldDb.ts'
import { buildQmdMirror, resolveQmdHits, writeQmdMirror } from '../server/qmdMirror.ts'
import { knowledgeFixture, timingSummary } from './knowledge-fixtures.ts'

const option = (key: string) => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1] }
const binary = option('--qmd-binary'), size = Number(option('--size') ?? '1000')
if (binary && !isAbsolute(binary)) throw new Error('--qmd-binary must name an explicitly selected absolute executable path.')
if (!Number.isSafeInteger(size) || size < 1 || size > 50_000) throw new Error('--size must be from 1 to 50000.')
const directory = await mkdtemp(join(tmpdir(), 'worldview-qmd-compare-')), db = openWorldDb(':memory:')
const execute = promisify(execFile)
try {
  const { snapshot, queries } = knowledgeFixture(size)
  db.putKv('knowledge.v1', snapshot)
  const options = { liveNodeIds: new Set<string>(), filters: { aiOnly: true, limit: 20 } }, mirror = buildQmdMirror(snapshot, options)
  const mirrorDirectory = join(directory, 'mirror')
  await writeQmdMirror(mirrorDirectory, mirror)
  const environment = { ...process.env, INDEX_PATH: join(directory, 'qmd.sqlite'), QMD_CONFIG_DIR: join(directory, 'config'), XDG_CONFIG_HOME: join(directory, 'xdg-config'), XDG_CACHE_HOME: join(directory, 'cache') }
  const native = async (args: string[]) => (await execute(binary!, args, { cwd: directory, env: environment, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout
  let version: string | null = null, indexMs: number | null = null
  if (binary) {
    version = (await native(['--version'])).trim()
    const start = performance.now()
    await native(['--index', 'worldview-bench', 'collection', 'add', mirrorDirectory, '--name', mirror.manifest.collection, '--mask', '**/*.md'])
    indexMs = performance.now() - start
  }
  const comparisons: Record<string, unknown>[] = []
  for (const query of queries) {
    const sqliteSamples: number[] = [], qmdSamples: number[] = []
    let sqliteIds: string[] = [], qmdIds: string[] = [], nativeRows = 0
    for (let iteration = 0; iteration < 6; iteration++) {
      let start = performance.now()
      const lexical = db.searchKnowledge(query, options.filters).hits
      if (iteration) sqliteSamples.push(performance.now() - start)
      sqliteIds = lexical.map((hit) => hit.id)
      if (binary) {
        start = performance.now()
        const parsed: unknown = JSON.parse(await native(['--index', 'worldview-bench', 'search', query, '--json', '-n', '20', '-c', mirror.manifest.collection]))
        if (!Array.isArray(parsed)) throw new Error('Native QMD JSON must be an array of result objects.')
        nativeRows = parsed.length
        qmdIds = resolveQmdHits(parsed.filter((row): row is { file?: string; score?: number } => !!row && typeof row === 'object'), mirror, snapshot, options).map((hit) => hit.id)
        if (nativeRows && !qmdIds.length) throw new Error('Native QMD results did not resolve to any permitted full-identity passages.')
        if (iteration) qmdSamples.push(performance.now() - start)
      }
    }
    const common = sqliteIds.filter((id) => qmdIds.includes(id)).length, union = new Set([...sqliteIds, ...qmdIds]).size
    comparisons.push({ query, sqlite: timingSummary(sqliteSamples), nativeQmd: binary ? timingSummary(qmdSamples) : null, sqliteResultIds: sqliteIds, resolvedQmdIds: qmdIds, nativeRows, overlapJaccard: binary && union ? common / union : null })
  }
  await mkdir('bench-results', { recursive: true })
  const file = `bench-results/qmd-compare-${new Date().toISOString().slice(0, 10)}.json`
  await writeFile(file, JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, sources: size, nativeQmd: binary ? { selectedBinary: binary, version, indexMs, mode: 'lexical search; fresh isolated config/cache; subprocess overhead and authoritative result revalidation included' } : { status: 'not executed', reason: 'No explicit --qmd-binary; no native package or model was installed.' }, mirror: { entries: mirror.files.length, policyHash: mirror.manifest.policyHash }, methodology: 'Five rotating synthetic queries. One warmup plus five measured samples per query. This measures lexical ranking overlap, not evidence truth or answer quality. QMD native results are freshly revalidated against current Worldview source policy and exact passage identity. Temporary index/config/cache and synthetic corpus are deleted after the run.', comparisons }, null, 2) + '\n')
  console.log(`Wrote ${file}. Native QMD ${binary ? 'lexical comparison complete' : 'not executed (explicit --qmd-binary required)'}.`)
} finally { db.close(); await rm(directory, { recursive: true, force: true }) }
