import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHost, type Host, type HostOptions } from '../../server/host.ts'
import { WHISPER_FILES, WHISPER_MODEL, WHISPER_REVISION } from '../../src/ai/transcribeConfig.ts'

const started: { host: Host; server: Server; dir: string }[] = []
afterEach(async () => { for (const item of started.splice(0)) { item.server.closeAllConnections(); await new Promise<void>((resolve) => item.server.close(() => resolve())); item.host.close(); rmSync(item.dir, { recursive: true, force: true }) } vi.unstubAllEnvs() })
async function serve(options: Partial<HostOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'worldview-live-host-')), probe = vi.fn(async () => ({ provider: 'openai' as const, model: 'test-model', configured: true, ok: true, checkedAt: '2026-11-23T00:00:00Z' }))
  const host = createHost({ dataDir: dir, ai: { status: () => ({ provider: 'openai', model: 'test-model', configured: true }), probe }, ...options }), server = createServer((req, res) => host.handler(req, res))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); started.push({ host, server, dir })
  return { dir, host, probe, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}
const headers = { 'content-type': 'application/json', 'x-wv-client': 'live-host-test' }
const paths = ['/api/qmd/status', '/api/capture/telegram', '/api/ai/status']

describe('live services host boundaries', () => {
  it('returns disabled connector state and probes only the injected AI runtime', async () => {
    const f = await serve()
    expect(await (await fetch(`${f.base}/api/qmd/status`, { headers })).json()).toMatchObject({ enabled: false, sourceIds: [] })
    expect(await (await fetch(`${f.base}/api/capture/telegram`, { headers })).json()).toMatchObject({ configured: false, enabled: false, phase: 'unconfigured', userIds: [], chatIds: [] })
    expect(await (await fetch(`${f.base}/api/ai/status`, { headers })).json()).toEqual({ provider: 'openai', model: 'test-model', configured: true }); expect(f.probe).not.toHaveBeenCalled()
    expect(await (await fetch(`${f.base}/api/ai/status`, { method: 'POST', headers, body: '{}' })).json()).toMatchObject({ ok: true }); expect(f.probe).toHaveBeenCalledOnce()
  })
  it('rejects missing client headers, foreign origins, and DNS-rebinding hosts for all service controls', async () => {
    const f = await serve()
    for (const path of paths) {
      expect((await fetch(f.base + path)).status).toBe(403)
      expect((await fetch(f.base + path, { headers: { ...headers, origin: 'https://attacker.example' } })).status).toBe(403)
      const status = await new Promise<number | undefined>((resolve, reject) => { const request = httpRequest(f.base + path, { headers: { ...headers, host: 'attacker.example' } }, (response) => { response.resume(); resolve(response.statusCode) }); request.once('error', reject); request.end() })
      expect(status).toBe(403)
    }
    expect(f.probe).not.toHaveBeenCalled()
  })
  it('requires account sessions and keeps Telegram allowlists in the owning account world', async () => {
    const f = await serve({ accounts: true, signup: 'open' })
    for (const path of paths) expect((await fetch(f.base + path, { headers })).status).toBe(401)
    const a = await f.host.accounts!.signUp('alice@example.com', 'alice long password 123'), b = await f.host.accounts!.signUp('bob@example.com', 'bob long password 456')
    const tokenA = f.host.accounts!.createSession(a.id).token, tokenB = f.host.accounts!.createSession(b.id).token
    const aHeaders = { ...headers, cookie: `wv_session=${tokenA}` }, bHeaders = { ...headers, cookie: `wv_session=${tokenB}` }
    const configured = await fetch(`${f.base}/api/capture/telegram`, { method: 'POST', headers: aHeaders, body: JSON.stringify({ enabled: false, userIds: [7], chatIds: [11] }) }); expect(configured.status).toBe(200)
    expect(await configured.json()).toMatchObject({ enabled: false, userIds: [7], chatIds: [11] })
    expect(await (await fetch(`${f.base}/api/capture/telegram`, { headers: bHeaders })).json()).toMatchObject({ userIds: [], chatIds: [], configured: false })
    expect((await fetch(`${f.base}/api/ai/status`, { headers: { cookie: `wv_session=${tokenA}` } })).status).toBe(403)
    expect((await fetch(`${f.base}/api/qmd/status`, { headers: bHeaders })).status).toBe(200)
  })
  it('serves only pinned public model files, with byte ranges and no account requirement', async () => {
    const f = await serve({ accounts: true }), models = join(f.dir, 'models'), root = join(models, WHISPER_MODEL)
    vi.stubEnv('WORLDVIEW_MODELS_DIR', models)
    mkdirSync(join(root, 'onnx'), { recursive: true })
    for (const file of WHISPER_FILES) writeFileSync(join(root, file), '{}')
    writeFileSync(join(root, 'worldview-model.json'), JSON.stringify({ model: WHISPER_MODEL, revision: WHISPER_REVISION, files: WHISPER_FILES.map((path) => ({ path, bytes: 2 })) }))
    const prefix = `${f.base}/api/models/${WHISPER_REVISION}/${WHISPER_MODEL}`
    expect(await (await fetch(`${f.base}/api/models/whisper/status`)).json()).toMatchObject({ modelReady: true, model: WHISPER_MODEL, revision: WHISPER_REVISION })
    const file = await fetch(`${prefix}/config.json`); expect(file.status).toBe(200); expect(await file.text()).toBe('{}'); expect(file.headers.get('cache-control')).toContain('immutable')
    const partial = await fetch(`${prefix}/config.json`, { headers: { range: 'bytes=1-1' } }); expect(partial.status).toBe(206); expect(partial.headers.get('content-range')).toBe('bytes 1-1/2'); expect(await partial.text()).toBe('}')
    expect((await fetch(`${prefix}/config.json`, { method: 'HEAD' })).headers.get('content-length')).toBe('2')
    expect((await fetch(`${prefix}/config.json`, { headers: { range: 'bytes=9-10' } })).status).toBe(416)
    for (const path of [`${prefix}/worldview-model.json`, `${prefix}/%2e%2e%2fworld.sqlite`, `${prefix}/.env.local`, `${f.base}/api/models/unpinned/${WHISPER_MODEL}/config.json`]) expect((await fetch(path)).status).toBe(404)
    expect((await fetch(`${prefix}/config.json`, { method: 'POST', body: '{}' })).status).toBe(405)
  })
})
