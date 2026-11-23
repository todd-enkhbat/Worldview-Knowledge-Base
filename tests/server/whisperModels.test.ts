import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { handleWhisperModelRequest } from '../../server/whisperModels.ts'
import { WHISPER_REVISION } from '../../src/ai/transcribeConfig.ts'

let server: Server, base: string
beforeAll(async () => { server = createServer((req, res) => { void handleWhisperModelRequest(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end() } }).catch(() => { res.writeHead(500); res.end() }) }); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) })
it('only exposes public pinned model identity and a fixed asset allowlist', async () => {
  const status = await fetch(`${base}/api/models/whisper/status`)
  expect(status.status).toBe(200); expect(await status.json()).toMatchObject({ model: 'onnx-community/whisper-base', revision: WHISPER_REVISION })
  expect((await fetch(`${base}/api/models/whisper/status`, { method: 'POST' })).status).toBe(405)
  expect((await fetch(`${base}/api/models/${WHISPER_REVISION}/onnx-community/whisper-base/%2e%2e/.env.local`)).status).toBe(404)
  expect((await fetch(`${base}/api/models/${WHISPER_REVISION}/onnx-community/whisper-base/worldview-model.json`)).status).toBe(404)
})
it.skipIf(process.env.WORLDVIEW_LIVE_ASR !== '1')('serves the installed pinned asset with bounded range and HEAD responses', async () => {
  const url = `${base}/api/models/${WHISPER_REVISION}/onnx-community/whisper-base/onnx/encoder_model_quantized.onnx`
  const head = await fetch(url, { method: 'HEAD' }); expect(head.status).toBe(200); expect(Number(head.headers.get('content-length'))).toBe(23201314)
  const part = await fetch(url, { headers: { range: 'bytes=0-15' } }); expect(part.status).toBe(206); expect((await part.arrayBuffer()).byteLength).toBe(16)
  expect((await fetch(url, { headers: { range: 'bytes=999999999-' } })).status).toBe(416)
})
