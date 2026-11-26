import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export async function checkBundle(app) {
  const base = join(app, 'Contents/Resources/app'), runtime = join(base, 'runtime')
  const photos = spawnSync(join(runtime, 'node/bin/node'), [
    '-e', "if (typeof require(process.argv[1]).read !== 'function') process.exit(1)",
    join(base, 'electron/photo-places.node'),
  ], { timeout: 10000 })
  if (photos.status !== 0) throw new Error('The packaged Apple Photos connector could not be loaded.')
  const scratch = await mkdtemp(join(tmpdir(), 'worldview-startup-check-'))
  const child = spawn(join(runtime, 'node/bin/node'), [
    join(runtime, 'scripts/desktop/server.mjs'), '--workspace', scratch, '--dist', join(base, 'dist'), '--port', '0',
  ], { cwd: runtime, env: { HOME: scratch, TMPDIR: scratch, PATH: '/usr/bin:/bin', AI_PROVIDER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, killSignal: 'SIGKILL' })
  const closed = once(child, 'close').catch(() => {})
  let diagnostics = ''
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4000) })
  try {
    const lines = createInterface({ input: child.stdout })
    for await (const line of lines) {
      if (!line.startsWith('{')) continue
      const ready = JSON.parse(line)
      if (!ready.worldviewDesktopReady) continue
      const url = new URL(ready.url)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('Unexpected desktop service address')
      const options = { signal: AbortSignal.timeout(5000), headers: { 'x-wv-client': 'desktop-package-check' } }
      const index = await fetch(url, options)
      if (!index.ok || !(await index.text()).includes('id="root"')) throw new Error('The packaged workspace could not load its client')
      const status = await fetch(new URL('/api/ai/status', url), options)
      if (!status.ok || (await status.json()).configured !== false) throw new Error('The packaged local API did not respond with cloud AI off')
      return
    }
    throw new Error('The packaged desktop service failed to start. ' + diagnostics.trim())
  } finally {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM')
    await closed
    await rm(scratch, { recursive: true, force: true })
  }
}
