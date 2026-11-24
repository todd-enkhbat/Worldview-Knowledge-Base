import { packager } from '@electron/packager'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

// Only application code, built public assets, explicit runtime dependencies and the
// verified official Node executable enter the package. No .env, data, logs or corpus.
const root = process.cwd(), stage = resolve('data/desktop/staging'), out = resolve('data/desktop/releases')
const nodeRoot = resolve(`data/tools/desktop-node/26.5.0-${process.platform}-${process.arch}`)
if (!existsSync(join(root, 'dist/index.html')) || !existsSync(join(nodeRoot, 'bin/node'))) throw new Error('Build the app and prepare its official Node runtime before packaging.')
await rm(stage, { recursive: true, force: true }); await mkdir(join(stage, 'runtime'), { recursive: true })
await Promise.all([
  cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true, verbatimSymlinks: true }),
  cp(join(root, 'electron'), join(stage, 'electron'), { recursive: true, verbatimSymlinks: true }),
  cp(join(root, 'server'), join(stage, 'runtime/server'), { recursive: true, verbatimSymlinks: true }),
  cp(join(root, 'src'), join(stage, 'runtime/src'), { recursive: true, verbatimSymlinks: true }),
  cp(join(root, 'scripts'), join(stage, 'runtime/scripts'), { recursive: true, verbatimSymlinks: true, filter: (path) => !path.includes('/desktop/staging') && !path.includes('/__pycache__') && !path.endsWith('.pyc') }),
  cp(join(root, 'extensions/worldview-reader'), join(stage, 'runtime/extensions/worldview-reader'), { recursive: true, verbatimSymlinks: true }),
])
await mkdir(join(stage, 'runtime/node/bin'), { recursive: true })
await cp(join(nodeRoot, 'bin/node'), join(stage, 'runtime/node/bin/node'))
await cp(join(nodeRoot, 'LICENSE'), join(stage, 'runtime/node/LICENSE'))
await cp(join(nodeRoot, 'worldview-runtime.json'), join(stage, 'runtime/node/worldview-runtime.json'))
const roots = ['@modelcontextprotocol/sdk', 'sqlite-vec', 'zod', 'fflate', '@huggingface/transformers']
const packages = new Map()
async function dependency(name, from = root, optional = false) {
  let folder
  try {
    const require = createRequire(join(from, 'package.json'))
    for (const location of require.resolve.paths(name) ?? []) {
      const candidate = join(location, name, 'package.json')
      if (existsSync(candidate)) { folder = dirname(candidate); break }
    }
    if (!folder) throw new Error(`Cannot locate required desktop dependency ${name}`)
  } catch (error) { if (optional) return; throw error }
  const metadata = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
  if (packages.has(folder)) return
  packages.set(folder, { folder, name: metadata.name, version: metadata.version })
  for (const [child] of Object.entries(metadata.dependencies ?? {})) await dependency(child, folder)
  for (const [child] of Object.entries(metadata.optionalDependencies ?? {})) await dependency(child, folder, true)
}
for (const name of roots) await dependency(name)
for (const value of packages.values()) await cp(value.folder, join(stage, 'runtime/node_modules', relative(join(root, 'node_modules'), value.folder)), { recursive: true, verbatimSymlinks: true, filter: (path) => !path.includes('/.cache/') && !path.includes('/__tests__/') })
await writeFile(join(stage, 'runtime/package.json'), JSON.stringify({ name: 'worldview-runtime', private: true, type: 'module', dependencies: Object.fromEntries(roots.map((name) => [name, [...packages.values()].find((value) => value.folder === join(root, 'node_modules', name)).version])) }, null, 2)+'\n')
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'worldview-desktop', productName: 'Worldview', version: '0.1.0', main: 'electron/main.cjs', private: true }, null, 2)+'\n')
await mkdir(out, { recursive: true })
const temporaryOutput = await mkdtemp(join(tmpdir(), 'worldview-desktop-build-'))
const targets = await packager({ dir: stage, out: temporaryOutput, name: 'Worldview', appBundleId: 'org.mindcorpus.worldview', appCategoryType: 'public.app-category.productivity', icon: existsSync(resolve('data/desktop/Worldview.icns')) ? resolve('data/desktop/Worldview.icns') : undefined, platform: 'darwin', arch: process.arch, electronVersion: '45.4.1', asar: false, prune: false, overwrite: true, darwinDarkModeSupport: true, extendInfo: { NSMicrophoneUsageDescription: 'Record an explicit voice note for local transcription in your selected Worldview workspace.' } })
const report = { schemaVersion: 1, builtAt: new Date().toISOString(), electron: '45.4.1', node: JSON.parse(await readFile(join(nodeRoot, 'worldview-runtime.json'), 'utf8')), platform: process.platform, arch: process.arch, directories: [join(out, 'Worldview-darwin-' + process.arch)], runtimeDependencies: Object.fromEntries([...packages.values()].map((value) => [`${value.name}@${value.version}`, value.version])), privateDataIncluded: false, cloudAi: 'off' }
for (const target of targets) { const app = join(target, 'Worldview.app'), destination = join(out, 'Worldview-darwin-' + process.arch), zip = join(out, `Worldview-mac-${process.arch}.zip`), temporary = `${zip}.tmp`; spawnSync('/usr/bin/xattr', ['-d', 'com.apple.FinderInfo', app], { stdio: 'ignore' }); const signed = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' }); if (signed.status !== 0) throw new Error('The local ad-hoc app signature could not be created.'); const verified = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' }); if (verified.status !== 0) throw new Error('The local app signature did not verify.'); const compressed = spawnSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, temporary], { stdio: 'inherit' }); if (compressed.status !== 0) throw new Error('The desktop app was packaged, but its download archive could not be created.'); await rename(temporary, zip); await rm(destination, { recursive: true, force: true }); await cp(target, destination, { recursive: true, verbatimSymlinks: true }); console.log(`Packaged desktop app: ${join(destination, 'Worldview.app')}`); console.log(`Desktop download: ${zip}`) }

report.signing = { type: 'ad-hoc', verified: true, notarized: false }; await writeFile(join(out, 'worldview-desktop-build.json'), JSON.stringify(report, null, 2)+'\n')
