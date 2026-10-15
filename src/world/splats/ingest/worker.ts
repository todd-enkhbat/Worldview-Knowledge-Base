import { transcodeToInterior, type Crop, type TranscodeResult, type TranscodeStage } from './transcode.ts'

// Module Worker for the heavy half of ingest (decode, v4 repack, transcode, analysis), so a
// 200 MB PLY never blocks a frame. One job per worker: the WASM heap only grows, so the main
// thread terminates the worker after each scene instead of reusing it.

export interface IngestJob {
  id: number
  /** The file: a Blob (read here, off the main thread) or transferred bytes. */
  source: Blob | ArrayBuffer
  name?: string
  crop?: Crop | null
}

export type IngestWorkerMessage =
  | { id: number; type: 'stage'; stage: TranscodeStage }
  | { id: number; type: 'done'; result: TranscodeResult }
  | { id: number; type: 'error'; message: string }

interface WorkerScope {
  onmessage: ((e: MessageEvent<IngestJob>) => void) | null
  postMessage(message: IngestWorkerMessage, transfer: Transferable[]): void
}

const scope = self as unknown as WorkerScope

/** A buffer we can transfer without detaching anything else (e.g. a WASM heap view). */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
  return exact ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice()
}

scope.onmessage = (e) => {
  const { id, source, name, crop } = e.data
  const read = source instanceof Blob ? source.arrayBuffer() : Promise.resolve(source)
  read
    .then((buf) => transcodeToInterior({ bytes: new Uint8Array(buf), name, crop }, (stage) => scope.postMessage({ id, type: 'stage', stage }, [])))
    .then((r) => {
      const interior = owned(r.interior)
      const framed = r.framed ? owned(r.framed) : null
      const transfer: Transferable[] = [interior.buffer]
      if (framed) transfer.push(framed.buffer)
      scope.postMessage({ id, type: 'done', result: { ...r, interior, framed } }, transfer)
    })
    .catch((err: unknown) => scope.postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) }, []))
}
