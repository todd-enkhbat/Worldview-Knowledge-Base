// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { closeRepo, completeFirstRun, initRepo, wipeWorld } from '../../src/data/repo.ts'
import { useVoiceInbox } from '../../src/capture/voiceInbox.ts'
import { VoiceEvidencePlayer } from '../../src/capture/SourcesVoiceInbox.tsx'
import { PortabilityControls } from '../../src/capture/PortabilityControls.tsx'

const mocks = vi.hoisted(() => ({ original: vi.fn(), snapshot: vi.fn(), createUrl: vi.fn(() => 'blob:retained-original'), revokeUrl: vi.fn() }))
vi.mock('../../src/capture/voiceInbox.ts', async (original) => ({ ...await original<object>(), voiceOriginal: mocks.original, initializeVoiceInbox: vi.fn(async () => {}) }))
vi.mock('../../src/data/worldSnapshot.ts', async (original) => ({ ...await original<object>(), readWorldSnapshot: mocks.snapshot }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
beforeEach(async () => {
  mocks.original.mockReset(); mocks.snapshot.mockReset(); mocks.createUrl.mockClear(); mocks.revokeUrl.mockClear()
  await initRepo({ store: createMemoryStore() }); await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  const OriginalUrl = URL
  vi.stubGlobal('URL', class extends OriginalUrl { static override createObjectURL = mocks.createUrl; static override revokeObjectURL = mocks.revokeUrl })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useVoiceInbox.setState({ entries: [] }); await closeRepo(); vi.unstubAllGlobals() })

it('ignores a late original read after changing citations and revokes playback URLs when leaving the source', async () => {
  useVoiceInbox.setState({ entries: ['a', 'b'].map((id) => ({ id, sourceId: id, hash: 'a'.repeat(64), blobId: `voice-${id}`, name: `${id}.wav`, mime: 'audio/wav', bytes: 8, capturedAt: 1, language: 'en', attribution: 'unknown', aiAllowed: true, status: 'ready', attempts: 1 })) })
  let release: (value: { blob: Blob; name: string }) => void = () => {}
  mocks.original.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
  await act(async () => root.render(<VoiceEvidencePlayer sourceId="a" />))
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  await act(async () => root.render(<VoiceEvidencePlayer sourceId="b" />))
  await act(async () => release({ blob: new Blob(['original']), name: 'a.wav' }))
  expect(mocks.createUrl).not.toHaveBeenCalled()
  mocks.original.mockResolvedValueOnce({ blob: new Blob(['original']), name: 'b.wav' })
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
  expect(host.querySelector('audio')?.getAttribute('src')).toBe('blob:retained-original')
  await act(async () => root.render(<VoiceEvidencePlayer sourceId="a" />))
  expect(mocks.revokeUrl).toHaveBeenCalledWith('blob:retained-original')
  expect(host.querySelector('audio')).toBeNull()
})

it('never downloads an export from before a same-store workspace replacement', async () => {
  let release: (value: unknown) => void = () => {}
  mocks.snapshot.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
  await act(async () => root.render(<PortabilityControls />))
  await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Download knowledge')!.click())
  expect(mocks.snapshot).toHaveBeenCalledOnce()
  await act(async () => { await wipeWorld({ confirm: true }) })
  await act(async () => release({ kv: {}, nodes: [], assets: [], events: [], settings: null }))
  expect(mocks.createUrl).not.toHaveBeenCalled()
  expect(host.querySelector('[role=alert]')?.textContent).toContain('workspace changed')
})
