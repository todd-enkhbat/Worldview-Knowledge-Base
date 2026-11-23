import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const QMD_VERSION = '2.9.0'
export const QMD_RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../data/tools/qmd')
export const QMD_CACHE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../data/tools/qmd-cache')
export type QmdMode = 'lexical' | 'hybrid'
export interface NativeQmdHit { file?: string; score?: number; explain?: unknown }
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

export async function qmdInstallation(runtimeRoot = QMD_RUNTIME_ROOT, cacheRoot = QMD_CACHE_ROOT) {
  const packagePath = join(runtimeRoot, 'node_modules/@tobilu/qmd/package.json')
  let version: string | null = null
  try { version = JSON.parse(await readFile(packagePath, 'utf8')).version as string } catch { /* explicit uninstalled status */ }
  let models: { file: string; bytes: number }[] = []
  try { models = await Promise.all((await readdir(join(cacheRoot, 'qmd/models'), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.gguf')).map(async (entry) => ({ file: entry.name, bytes: (await stat(join(cacheRoot, 'qmd/models', entry.name))).size }))) } catch { /* downloads have not been requested */ }
  return { installed: version === QMD_VERSION && existsSync(join(runtimeRoot, 'node_modules/@tobilu/qmd/dist/index.js')), version, expectedVersion: QMD_VERSION, models }
}

/** One per-world worker, with a shared read-only model cache and no provider credentials. */
export class QmdNativeRuntime {
  private child: ChildProcess | null = null
  private sequence = 0
  private epoch = 0
  private pending = new Map<number, Pending>()
  progress: unknown = null
  diagnostics = ''
  readonly runtimeRoot: string
  readonly cacheRoot: string
  constructor(runtimeRoot = QMD_RUNTIME_ROOT, cacheRoot = QMD_CACHE_ROOT) { this.runtimeRoot = runtimeRoot; this.cacheRoot = cacheRoot }

  private async start(epoch: number): Promise<ChildProcess> {
    if (this.child) return this.child
    if (!(await qmdInstallation(this.runtimeRoot, this.cacheRoot)).installed) throw new Error('Install the pinned local QMD runtime with node scripts/qmd-setup.ts.')
    await mkdir(this.cacheRoot, { recursive: true })
    if (epoch !== this.epoch) throw new Error('The QMD operation was cancelled before startup.')
    const child = fork(fileURLToPath(new URL('../scripts/qmd-worker.mjs', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG ?? 'en_US.UTF-8', XDG_CACHE_HOME: this.cacheRoot, QMD_CONFIG_DIR: join(this.cacheRoot, 'config'), WORLDVIEW_QMD_MODULE: join(this.runtimeRoot, 'node_modules/@tobilu/qmd/dist/index.js'), LLAMA_LOG_LEVEL: 'error', GGML_LOG_LEVEL: 'error', GGML_BACKEND_SILENT: '1', GGML_METAL_NO_RESIDENCY: '1', ...(process.env.WORLDVIEW_QMD_FORCE_CPU === '1' ? { QMD_FORCE_CPU: '1' } : {}) },
    })
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => { this.diagnostics = (this.diagnostics + chunk.toString()).slice(-8192) })
    child.on('message', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return
      const message = raw as { id?: number; result?: unknown; error?: string; progress?: unknown }
      if (message.progress) { this.progress = message.progress; return }
      if (typeof message.id !== 'number') return
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result)
    })
    const ended = () => { if (this.child === child) { this.child = null; for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('The local QMD worker stopped. Retry or rebuild its disposable index.')) }; this.pending.clear() } }
    child.once('error', ended); child.once('exit', ended)
    return child
  }

  async request<T>(operation: string, input: unknown, timeoutMs = 300_000, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const epoch = this.epoch, child = await this.start(epoch), id = ++this.sequence
    if (epoch !== this.epoch) throw new Error('The QMD operation was cancelled before startup.')
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.stop('The local QMD operation timed out.'); reject(new Error('The local QMD operation timed out.')) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.send({ id, operation, input }, (error) => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('Unable to send this operation to the local QMD worker.')) } })
    })
    const abort = () => this.stop('The QMD request was cancelled.')
    signal?.addEventListener('abort', abort, { once: true })
    try { return await result as T } finally { signal?.removeEventListener('abort', abort) }
  }

  stop(reason = 'The disposable QMD index changed. Retry the search.'): void {
    this.epoch++
    const child = this.child; this.child = null
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(reason)) }
    this.pending.clear(); child?.kill('SIGTERM')
  }
  async destroy(directory: string): Promise<void> {
    const target = resolve(directory)
    if ([this.runtimeRoot, this.cacheRoot].some((protectedPath) => { const path = resolve(protectedPath); return path === target || path.startsWith(target + sep) })) throw new Error('The disposable QMD index must be outside the installed runtime and model cache.')
    this.stop(); await rm(target, { recursive: true, force: true })
  }
}
