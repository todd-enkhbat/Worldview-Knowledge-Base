/* global self, caches, Response, URL */
const inbox = 'worldview-share-inbox-v1'
const lifetime = 10 * 60 * 1000
const maximum = 24 * 1024 * 1024
const key = (id) => new URL(`/share-target/${id}`, self.location.origin).href

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

async function receive(request) {
  const cache = await caches.open(inbox)
  for (const entry of await cache.keys()) {
    const saved = await cache.match(entry)
    if (Date.now() - Number(saved?.headers.get('x-worldview-shared-at')) > lifetime) await cache.delete(entry)
  }
  // Retain at most four unreviewed shares on this device.
  const entries = await cache.keys()
  if (entries.length >= 4) await cache.delete(entries[0])
  const contentType = request.headers.get('content-type')
  if (!contentType?.startsWith('multipart/form-data;') || !request.body) {
    return Response.redirect(new URL('/#/today?share=invalid', self.location.origin).href, 303)
  }
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximum) {
      await reader.cancel()
      return Response.redirect(new URL('/#/today?share=too-large', self.location.origin).href, 303)
    }
    chunks.push(value)
  }
  const id = self.crypto.randomUUID()
  await cache.put(key(id), new Response(new Blob(chunks), { headers: {
    'content-type': contentType, 'x-worldview-shared-at': String(Date.now()),
  } }))
  return Response.redirect(new URL(`/#/today?share=${id}`, self.location.origin).href, 303)
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method === 'POST' && event.request.mode === 'navigate' && url.origin === self.location.origin && url.pathname === '/share-target') {
    event.respondWith(receive(event.request).catch(() => Response.redirect(new URL('/#/today?share=invalid', self.location.origin).href, 303)))
  }
})

self.addEventListener('message', (event) => {
  const { id, action } = event.data ?? {}
  const port = event.ports[0]
  if (event.origin !== self.location.origin || !port || !/^[a-f0-9-]{36}$/.test(id ?? '') || !['preview', 'dismiss'].includes(action)) return
  event.waitUntil((async () => {
    const cache = await caches.open(inbox)
    const entry = key(id)
    if (action === 'dismiss') { await cache.delete(entry); port.postMessage({ dismissed: true }); return }
    const saved = await cache.match(entry)
    if (!saved || Date.now() - Number(saved.headers.get('x-worldview-shared-at')) > lifetime) {
      await cache.delete(entry)
      port.postMessage(null)
      return
    }
    const form = await saved.formData()
    const strings = ['title', 'text', 'url'].flatMap((field) => {
      const value = form.get(field)
      return typeof value === 'string' && value.trim() ? [value.trim()] : []
    })
    const files = form.getAll('files').filter((file) => typeof file !== 'string' && file.name)
    port.postMessage({ text: [...new Set(strings)].join('\n\n'), files })
  })().catch(() => port.postMessage(null)))
})
