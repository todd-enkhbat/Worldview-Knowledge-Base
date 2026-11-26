/// <reference lib="webworker" />
import { parsePlaceFile } from './imports.ts'
import type { PlaceImportOptions } from './types.ts'

declare const self: DedicatedWorkerGlobalScope
self.onmessage = async ({ data }: MessageEvent<{ file: File; options: PlaceImportOptions }>) => {
  try { self.postMessage({ result: await parsePlaceFile(data.file, data.options) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
