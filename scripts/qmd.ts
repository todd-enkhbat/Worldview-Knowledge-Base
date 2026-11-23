/** Repository-local QMD launcher: config, model cache and index stay out of global state. */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { QMD_CACHE_ROOT, QMD_RUNTIME_ROOT } from '../server/qmdRuntime.ts'
const child = spawn(process.execPath, [join(QMD_RUNTIME_ROOT, 'node_modules/@tobilu/qmd/bin/qmd'), ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, XDG_CACHE_HOME: QMD_CACHE_ROOT, QMD_CONFIG_DIR: join(QMD_CACHE_ROOT, 'config'), INDEX_PATH: join(QMD_CACHE_ROOT, 'manual.sqlite'), GGML_METAL_NO_RESIDENCY: '1' },
})
child.once('error', (error) => { console.error(error.message); process.exitCode = 1 })
child.once('exit', (code) => { process.exitCode = code ?? 1 })
