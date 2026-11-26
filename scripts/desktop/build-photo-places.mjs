import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function buildPhotoPlaces(output) {
  if (process.platform !== 'darwin') throw new Error('The Photos connector requires the macOS SDK.')
  const include = [
    resolve(dirname(realpathSync(process.execPath)), '../include/node'),
    '/opt/homebrew/include/node', '/usr/local/include/node',
  ].find(directory => existsSync(join(directory, 'node_api.h')))
  if (!include) throw new Error('Install Node.js with its public Node-API headers before building the Mac app.')
  mkdirSync(dirname(output), { recursive: true })
  const compiled = spawnSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-mmacosx-version-min=12',
    '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-bundle', '-undefined', 'dynamic_lookup',
    '-I', include, '-framework', 'Contacts', '-framework', 'Photos', '-framework', 'Vision', '-framework', 'CoreLocation', '-framework', 'AppKit', '-framework', 'Foundation',
    'scripts/desktop/native/photo-places.mm', '-o', output], { stdio: 'inherit' })
  if (compiled.status !== 0) throw new Error('The native Apple Photos connector could not be compiled.')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildPhotoPlaces(resolve(process.argv[2] || 'data/desktop/native/photo-places.node'))
}
