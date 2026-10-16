// Module-worker entry for the #/lab demos (labClient.ts spawns it). Behaviour lives in
// labHost.ts; this file only wires it to the worker scope.

import { LabHost } from './labHost.ts'
import type { FromLab, ToLab } from './labProtocol.ts'

const scope = self as unknown as {
  postMessage(msg: FromLab, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<ToLab>) => void) | null
}

const host = new LabHost({ post: (msg, transfer) => scope.postMessage(msg, transfer ?? []) })
scope.onmessage = (e) => host.handle(e.data)
