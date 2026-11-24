import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const version = '26.5.0', platform = process.platform, arch = process.arch
if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('This desktop packaging target currently supports macOS arm64/x64.')
const cache = resolve('data/tools/desktop-node', `${version}-${platform}-${arch}`), binary = join(cache, 'bin/node')
if (existsSync(binary)) { console.log(`Verified Node runtime already retained: ${cache}`); process.exit(0) }
const filename = `node-v${version}-${platform}-${arch}.tar.gz`, base = `https://nodejs.org/dist/v${version}`
async function download(url) { const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) }); if (!response.ok) throw new Error(`Official Node download failed (${response.status}).`); return new Uint8Array(await response.arrayBuffer()) }
const manifest = new TextDecoder().decode(await download(`${base}/SHASUMS256.txt`)), row = manifest.split('\n').find((line) => line.endsWith(`  ${filename}`))
if (!row || !/^[a-f0-9]{64}  /.test(row)) throw new Error('The official Node checksum manifest did not contain this runtime.')
const archive = await download(`${base}/${filename}`), hash = createHash('sha256').update(archive).digest('hex')
if (hash !== row.slice(0, 64)) throw new Error('The Node runtime did not match its official SHA-256 manifest.')
const temporary = `${cache}.${process.pid}.tmp`, archivePath = `${temporary}.tar.gz`
await mkdir(temporary, { recursive: true }); await writeFile(archivePath, archive)
try { const result = spawnSync('/usr/bin/tar', ['-xzf', archivePath, '--strip-components=1', '-C', temporary], { stdio: 'inherit' }); if (result.status !== 0) throw new Error('The verified Node runtime could not be extracted.'); const check = spawnSync(join(temporary, 'bin/node'), ['--version'], { encoding: 'utf8' }); if (check.status !== 0 || check.stdout.trim() !== `v${version}`) throw new Error('The downloaded Node runtime did not start at the expected version.'); await chmod(join(temporary, 'bin/node'), 0o755); await writeFile(join(temporary, 'worldview-runtime.json'), JSON.stringify({ version, filename, sha256: hash, source: `${base}/${filename}` }, null, 2)+'\n'); await mkdir(resolve(cache, '..'), { recursive: true }); await rename(temporary, cache); console.log(`Verified and retained official Node ${version} (${arch}).`) }
finally { await rm(archivePath, { force: true }); if (!existsSync(binary)) await rm(temporary, { recursive: true, force: true }) }
