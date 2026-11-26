import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function buildEnkiBracket(output) {
  const include = [resolve(dirname(realpathSync(process.execPath)), '../include/node'), '/opt/homebrew/include/node', '/usr/local/include/node']
    .find(path => existsSync(join(path, 'node_api.h')))
  if (!include) throw Error('The Mac shortcut requires the Node-API headers.')
  mkdirSync(dirname(output), { recursive: true })
  const build = spawnSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-O2', '-mmacosx-version-min=12',
    '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-bundle', '-undefined', 'dynamic_lookup', '-I', include,
    '-framework', 'AppKit', '-framework', 'Carbon', '-framework', 'CoreGraphics', '-framework', 'IOKit',
    resolve('scripts/desktop/native/enki-bracket.mm'), '-o', output], { stdio: 'inherit' })
  if (build.status !== 0) throw Error('The native Enki shortcut could not be compiled.')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  buildEnkiBracket(resolve(process.argv[2] || 'data/desktop/native/enki-bracket.node'))
