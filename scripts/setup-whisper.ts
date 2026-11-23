// Explicit model setup: node scripts/setup-whisper.ts [--directory /absolute/model/root]
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { WHISPER_FILES, WHISPER_MODEL, WHISPER_REVISION } from '../src/ai/transcribeConfig.ts'

const index = process.argv.indexOf('--directory')
const root = resolve(index < 0 ? 'data/models' : process.argv[index + 1])
const destination = join(root, WHISPER_MODEL)
const response = await fetch(`https://huggingface.co/api/models/${WHISPER_MODEL}/revision/${WHISPER_REVISION}?blobs=true`, { signal: AbortSignal.timeout(30000) })
if (!response.ok) throw new Error(`Official Whisper metadata returned ${response.status}.`)
const metadata = await response.json() as { sha: string; cardData?: { license?: string }; siblings: { rfilename: string; size?: number; lfs?: { sha256: string; size: number }; blobId?: string }[] }
if (metadata.sha !== WHISPER_REVISION || metadata.cardData?.license !== 'apache-2.0') throw new Error('Whisper model identity/license changed; review before installing.')
await mkdir(destination, { recursive: true })
const installed: { path: string; bytes: number; sha256: string; upstreamSha256: string | null }[] = []
for (const file of WHISPER_FILES) {
  const expected = metadata.siblings.find((item) => item.rfilename === file)
  if (!expected) throw new Error(`Pinned model is missing ${file}.`)
  const path = join(destination, file)
  await mkdir(dirname(path), { recursive: true })
  let valid = false
  try { const info = await stat(path); const bytes = await readFile(path); const hash = createHash('sha256').update(bytes).digest('hex'); valid = info.size === expected.size && (!expected.lfs || hash === expected.lfs.sha256) } catch { /* absent cache is downloaded */ }
  if (!valid) {
    console.log(`Downloading ${WHISPER_MODEL}/${file} (${expected.size ?? 'unknown'} bytes).`)
    const reply = await fetch(`https://huggingface.co/${WHISPER_MODEL}/resolve/${WHISPER_REVISION}/${file}`, { signal: AbortSignal.timeout(300000) })
    if (!reply.ok || !reply.body) throw new Error(`Whisper asset ${file} returned ${reply.status}.`)
    const temporary = `${path}.download`
    await pipeline(Readable.fromWeb(reply.body), createWriteStream(temporary, { mode: 0o600 }))
    const bytes = await readFile(temporary)
    if (bytes.byteLength !== expected.size || expected.lfs && createHash('sha256').update(bytes).digest('hex') !== expected.lfs.sha256) throw new Error(`Whisper asset ${file} failed size/SHA-256 verification.`)
    await rename(temporary, path)
  }
  const bytes = await readFile(path)
  installed.push({ path: file, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), upstreamSha256: expected.lfs?.sha256 ?? null })
}
await writeFile(join(destination, 'worldview-model.json'), JSON.stringify({ schemaVersion: 1, model: WHISPER_MODEL, revision: WHISPER_REVISION, dtype: 'q8', license: 'apache-2.0', source: `https://huggingface.co/${WHISPER_MODEL}/tree/${WHISPER_REVISION}`, installedAt: new Date().toISOString(), files: installed }, null, 2) + '\n')
await writeFile(join(destination, 'upstream-metadata.json'), JSON.stringify(metadata, null, 2) + '\n')
console.log(`Verified ${installed.length} pinned Whisper files (${installed.reduce((sum, file) => sum + file.bytes, 0)} bytes) under ${destination}.`)
