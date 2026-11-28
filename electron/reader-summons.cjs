const { createHash } = require('node:crypto')

function createReaderSummons({ context, show, fetcher = fetch }) {
  let controller = null, retry = null
  function stop() { controller?.abort(); controller = null; clearTimeout(retry); retry = null }
  function start() {
    stop()
    const state = context()
    if (!state.ready) return
    const connection = controller = new AbortController()
    void (async () => {
      try {
        while (!connection.signal.aborted) {
          const current = context()
          if (!current.ready || current.origin !== state.origin || current.workspace !== state.workspace) return
          const response = await fetcher(state.origin + '/api/reading-capture/enki/summons', {
            method: 'POST', credentials: 'omit', redirect: 'error', body: '{}',
            headers: { 'content-type': 'application/json', 'x-wv-client': 'desktop-profile-capture', 'x-wv-workspace-fingerprint': createHash('sha256').update(state.workspace).digest('hex') },
            signal: AbortSignal.any([connection.signal, AbortSignal.timeout(24_000)]),
          })
          if (!response.ok) throw Error('Browser shortcut service unavailable')
          const { summon } = await response.json(), latest = context()
          if (connection.signal.aborted || !latest.ready || latest.origin !== state.origin || latest.workspace !== state.workspace) return
          if (summon && Date.now() - summon.at < 5000) await show(summon)
        }
      } catch { /* Reconnect after service restart or system sleep. */ }
      finally {
        if (controller === connection && !connection.signal.aborted) {
          retry = setTimeout(start, 1000); retry.unref?.()
        }
      }
    })()
  }
  return { start, stop }
}
module.exports = { createReaderSummons }
