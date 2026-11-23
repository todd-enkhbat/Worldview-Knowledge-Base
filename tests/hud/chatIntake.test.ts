import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { useWorld } from '../../src/app/store.ts'
import { fileToIntake, importVault, readDirectoryEntry, type FolderFile, type IntakeItem } from '../../src/ai/chat/apply.ts'
import { chatSessionToken, isChatSessionTokenCurrent, loadChat, resetChat, useChat } from '../../src/ai/chat/session.ts'
import { closeRepo, completeFirstRun, getStore, initRepo, putWorldState } from '../../src/data/repo.ts'
import { createMemoryStore } from '../../src/data/memoryStore.ts'
import { intake, intakeFolderFiles } from '../../src/hud/chatIntake.ts'

vi.mock('../../src/ai/chat/apply.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/chat/apply.ts')>()
  return { ...actual, fileToIntake: vi.fn(actual.fileToIntake), readDirectoryEntry: vi.fn(actual.readDirectoryEntry), importVault: vi.fn(actual.importVault) }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const item = (name: string): IntakeItem => ({ name, kind: 'text', bytes: 4, blocks: [{ type: 'text', text: name }] })
const file = (name: string) => new File(['note'], name, { type: 'text/plain' })

beforeEach(async () => {
  vi.clearAllMocks()
  await initRepo({ store: createMemoryStore() })
  await completeFirstRun({ T0: Date.UTC(1990, 0, 1), start: 'empty' })
  resetChat()
  await loadChat()
})
afterEach(async () => { await closeRepo() })

describe('file preparation across restored conversations', () => {
  it('cannot stage a file that finishes reading after the conversation was replaced', async () => {
    const read = deferred<IntakeItem>()
    vi.mocked(fileToIntake).mockReturnValueOnce(read.promise)
    const pending = intake([file('old.txt')])
    expect(useChat.getState().intakeBusy).toBe(true)
    resetChat()
    useChat.setState({ staged: [item('Restored attachment')], error: 'Restored notice' })
    read.resolve(item('Old attachment'))
    await pending
    expect(useChat.getState()).toMatchObject({ staged: [item('Restored attachment')], error: 'Restored notice', intakeBusy: false })
  })

  it('does not clear a newer intake’s progress or replace its error when an old read fails', async () => {
    const oldRead = deferred<IntakeItem>()
    const newRead = deferred<IntakeItem>()
    vi.mocked(fileToIntake).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise)
    const oldWork = intake([file('old.txt')])
    resetChat()
    const newWork = intake([file('new.txt')])
    useChat.setState({ error: 'Current notice' })
    oldRead.reject(new Error('Old file failure'))
    await oldWork
    expect(useChat.getState()).toMatchObject({ error: 'Current notice', intakeBusy: true, staged: [] })
    newRead.resolve(item('New attachment'))
    await newWork
    expect(useChat.getState()).toMatchObject({ intakeBusy: false, staged: [item('New attachment')] })
  })

  it('stops a dropped directory before importing if the world changed while enumerating it', async () => {
    const read = deferred<FolderFile[]>()
    vi.mocked(readDirectoryEntry).mockReturnValueOnce(read.promise)
    const dir = { name: 'Notes', isDirectory: true } as FileSystemDirectoryEntry
    const work = intake([], [dir])
    resetChat()
    read.resolve([{ path: 'note.md', file: file('note.md') }])
    await work
    expect(importVault).not.toHaveBeenCalled()
    expect(fileToIntake).not.toHaveBeenCalled()
    expect(useChat.getState().staged).toEqual([])
  })

  it('prevents a picked vault’s delayed file read from writing into a restored world', async () => {
    const read = deferred<string>()
    const markdown = new File(['# Old vault note'], 'note.md', { type: 'text/markdown' })
    Object.defineProperties(markdown, { text: { value: () => read.promise }, webkitRelativePath: { value: 'Vault/note.md' } })
    const work = intakeFolderFiles([markdown])
    expect(importVault).toHaveBeenCalledOnce()
    resetChat()
    useChat.setState({ staged: [item('Restored attachment')] })
    read.resolve('# Old vault note\n\nDo not import into the restored world.')
    await work
    expect([...useWorld.getState().nodes.values()]).toEqual([])
    expect(useChat.getState().staged).toEqual([item('Restored attachment')])
  })

  it('keeps the progress indicator until both concurrent reads in the current conversation finish', async () => {
    const one = deferred<IntakeItem>()
    const two = deferred<IntakeItem>()
    vi.mocked(fileToIntake).mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise)
    const first = intake([file('one.txt')])
    const second = intake([file('two.txt')])
    one.resolve(item('One'))
    await first
    expect(useChat.getState().intakeBusy).toBe(true)
    two.resolve(item('Two'))
    await second
    expect(useChat.getState()).toMatchObject({ staged: [item('One'), item('Two')], intakeBusy: false })
  })

  it('checks a vault write guard again at the repository queue boundary', async () => {
    const store = getStore()
    const put = store.putKv.bind(store)
    const gate = deferred<void>()
    const entered = deferred<void>()
    store.putKv = async (key, value) => {
      if (key === 'intake-test-block') { entered.resolve(); await gate.promise }
      return put(key, value)
    }
    const blockingWrite = putWorldState('intake-test-block', true)
    await entered.promise
    const token = chatSessionToken()
    const markdown = new File(['# Stale note'], 'note.md')
    const work = importVault([{ path: 'note.md', file: markdown }], Date.now(), { shouldWrite: () => isChatSessionTokenCurrent(token) })
    await nextTurn()
    resetChat()
    gate.resolve()
    await blockingWrite
    expect(await work).toMatchObject({ added: 0 })
    expect(useWorld.getState().nodes.size).toBe(0)
  })
})
