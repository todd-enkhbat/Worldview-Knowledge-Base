/** Install the reviewed official runtime into the ignored repository-local tool prefix. */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { QMD_VERSION, QMD_CACHE_ROOT, QMD_RUNTIME_ROOT, qmdInstallation } from '../server/qmdRuntime.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const execute = (command: string, args: string[], env?: NodeJS.ProcessEnv) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, env: env ?? process.env, stdio: 'inherit' })
  child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}.`)))
})
await mkdir(QMD_RUNTIME_ROOT, { recursive: true })
if (!(await qmdInstallation()).installed) await execute('npm', ['install', '--prefix', QMD_RUNTIME_ROOT, '--save-exact', `@tobilu/qmd@${QMD_VERSION}`])
const environment = { ...process.env, XDG_CACHE_HOME: QMD_CACHE_ROOT, QMD_CONFIG_DIR: join(QMD_CACHE_ROOT, 'config'), INDEX_PATH: join(QMD_CACHE_ROOT, 'setup.sqlite'), GGML_METAL_NO_RESIDENCY: '1' }
await execute(process.execPath, [join(QMD_RUNTIME_ROOT, 'node_modules/@tobilu/qmd/bin/qmd'), '--version'], environment)
if (!process.argv.includes('--lexical-only')) await execute(process.execPath, [join(QMD_RUNTIME_ROOT, 'node_modules/@tobilu/qmd/bin/qmd'), 'pull'], environment)
await writeFile(join(QMD_RUNTIME_ROOT, 'installation.json'), JSON.stringify({ installedAt: new Date().toISOString(), package: `@tobilu/qmd@${QMD_VERSION}`, runtimeRoot: QMD_RUNTIME_ROOT, cacheRoot: QMD_CACHE_ROOT, ...(await qmdInstallation()) }, null, 2) + '\n')
console.log('QMD is ready. Build an explicit source scope in Sources & activity; the world remains authoritative.')
