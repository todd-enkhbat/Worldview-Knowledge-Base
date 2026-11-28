const { createHash } = require('node:crypto')

// The extension supplies its own fixed extractors; the desktop never sends code.
function readerSource(context) {
  let client = null, pageRef = null, requestedRef = null, controller = new AbortController()
  async function request(operation, args = {}) {
    const state = context(), url = new URL(state.origin)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw Error('Open the local Worldview workspace first.')
    const response = await fetch(url.origin + '/api/reading-capture/enki/request', {
      method: 'POST', credentials: 'omit', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-wv-client': 'desktop-profile-capture', 'x-wv-workspace-fingerprint': createHash('sha256').update(state.workspace).digest('hex') },
      body: JSON.stringify({ operation, args, ...(client ? { client } : {}) }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)]),
    })
    const result = await response.json()
    if (context().workspace !== state.workspace || context().origin !== state.origin || context().epoch !== state.epoch) throw Error('The workspace changed. Press ]]] again.')
    if (!response.ok) throw Error(result.error || 'Update Worldview and Reader to connect Enki to Dia.')
    client = result.client
    return result.value
  }
  return {
    peek: () => request('identify'),
    acceptPage: () => { pageRef = null; requestedRef = null },
    identify: async () => {
      const ref = await request('identify')
      if (pageRef && (ref.id !== pageRef.id || ref.url !== pageRef.url || ref.documentId !== pageRef.documentId)) throw Error('The Dia page changed. Press ]]] again to read it.')
      return ref
    },
    page: async () => { const ref = requestedRef; requestedRef = null; const value = await request('page', ref ? { ref } : {}); pageRef = value.ref; return value },
    bind: (browserClient, ref) => { client = browserClient; requestedRef = ref },
    readProfile: (ref, selectedUrl) => request('profile', { ref, selectedUrl }),
    readPeople: (ref, selectedUrl) => request('people', { ref, selectedUrl }),
    collect: async (ref, name) => {
      const result = await request('collect', { ref, name })
      if (result.ref?.id !== ref.id || result.ref?.url !== ref.url) throw Error('The Dia page changed. Press ]]] again.')
      Object.assign(ref, result.ref)
      if (pageRef) pageRef = result.ref
      return result
    },
    form: ref => request('form', { ref: ref || pageRef }),
    savePage: () => { if (!pageRef) throw Error('Read the Dia page first.'); return request('save-page', { ref: pageRef }) },
    reset: () => { controller.abort(); controller = new AbortController(); client = null; pageRef = null; requestedRef = null },
  }
}
module.exports = { readerSource }
