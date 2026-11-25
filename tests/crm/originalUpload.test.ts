import { expect, it } from 'vitest'
import { request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestEngine } from '../helpers/engine.ts'

it('verifies CRM original identities before replacing any retained bytes', async () => {
  const engine = await startTestEngine(), bytes = Buffer.from('Retained contact attachment'), id = 'crm-file-' + createHash('sha256').update(bytes).digest('hex'), meta = { id, kind: 'file', mime: 'application/octet-stream', bytes: bytes.length, createdAt: 1, nodeId: null }, url = `${engine.base}/world/blobs/${id}?meta=${encodeURIComponent(JSON.stringify(meta))}`
  expect((await fetch(url, { method: 'PUT', body: bytes })).status).toBe(204)
  expect((await fetch(url, { method: 'PUT', body: 'Different bytes' })).status).toBe(400)
  expect(readFileSync(join(engine.blobDir, id))).toEqual(bytes)
  expect(engine.db.getAssetMeta(id)?.bytes).toBe(bytes.length)
})

it('refuses a CRM attachment upload that arrives after a workspace replacement', async () => {
  const engine = await startTestEngine(), bytes = Buffer.from('Attachment from the old workspace'), id = 'crm-file-' + createHash('sha256').update(bytes).digest('hex'), meta = { id, kind: 'file', mime: 'application/octet-stream', bytes: bytes.length, createdAt: 1, nodeId: null }, url = `${engine.base}/world/blobs/${id}?meta=${encodeURIComponent(JSON.stringify(meta))}`
  const arrived = new Promise<void>(resolve => engine.server.once('request', () => resolve())); let finish!: () => void
  const response = new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { method: 'PUT' }, reply => { reply.resume(); reply.on('end', () => resolve(reply.statusCode!)) }); request.on('error', reject); request.write(bytes.subarray(0, 10)); finish = () => request.end(bytes.subarray(10))
  })
  await arrived
  engine.db.wipe(); finish()
  expect(await response).toBe(409); expect(engine.db.getAssetMeta(id)).toBeUndefined()
})
