import { useEffect } from 'react'
import { crmConnectionRequest } from './CrmConnections.tsx'
import { notifyCrmChanged } from './client.ts'

export const SYNC_REQUEST = 'worldview:crm-sync-preferences'
export const SYNC_FINISHED = 'worldview:crm-sync-finished'
/** Only the local writer runs opted-in account sync while People is open. */
export function useRelationshipSync(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let running = false
    const run = async () => {
      if (running) return
      running = true
      try {
        const result = await crmConnectionRequest<{ changed: boolean }>('sync/run', {}, controller.signal)
        if (result.changed && !controller.signal.aborted) {
          notifyCrmChanged()
          window.dispatchEvent(new Event(SYNC_FINISHED))
        }
      } catch {
        // Account-specific failures are recorded on the Connections screen.
      } finally { running = false }
    }
    void run()
    const timer = window.setInterval(run, 15 * 60000)
    window.addEventListener(SYNC_REQUEST, run)
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener(SYNC_REQUEST, run) }
  }, [enabled])
}
