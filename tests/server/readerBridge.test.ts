import { afterEach, expect, it, vi } from 'vitest'
import { ReaderBridge } from '../../server/readerBridge.ts'

afterEach(() => vi.useRealTimers())

it('wakes the desktop for the exact browser document, expires old summons and clears revoked work', async () => {
  vi.useFakeTimers()
  const bridge = new ReaderBridge(), ref = { id: '17', url: 'https://example.org/', documentId: 'document' }
  const waiting = bridge.waitForSummon(new AbortController().signal)
  bridge.summon('dia', ref)
  expect(await waiting).toMatchObject({ client: 'dia', ref })
  bridge.summon('dia', ref); bridge.disconnect('dia')
  const controller = new AbortController(), revoked = bridge.waitForSummon(controller.signal)
  controller.abort(); expect(await revoked).toBeNull()
  bridge.summon('dia', ref)
  await vi.advanceTimersByTimeAsync(5001)
  const staleController = new AbortController(), stale = bridge.waitForSummon(staleController.signal)
  staleController.abort(); expect(await stale).toBeNull()
})

it('delivers fixed actions only to the paired browser and accepts its reply once', async () => {
  const bridge = new ReaderBridge(), controller = new AbortController()
  const poll = bridge.poll('dia', controller.signal)
  const result = bridge.request('page', {})
  const command = (await poll)!
  expect(command.operation).toBe('page')
  expect(() => bridge.reply('other-browser', { id: command.id, value: 'wrong' })).toThrow('expired')
  bridge.reply('dia', { id: command.id, value: { title: 'Current page' } })
  expect(await result).toEqual({ client: 'dia', value: { title: 'Current page' } })
  expect(() => bridge.reply('dia', { id: command.id })).toThrow('expired')
  await expect(bridge.request('evaluate', { code: 'alert(1)' })).rejects.toThrow('supported')
})

it('queues during the gap between polls, refuses ambiguous browsers and drops canceled requests', async () => {
  const bridge = new ReaderBridge(), controller = new AbortController()
  const first = bridge.poll('dia', controller.signal)
  controller.abort(); expect(await first).toBeNull()
  const result = bridge.request('profile', {}, 'dia')
  const poll = bridge.poll('dia', new AbortController().signal)
  const command = (await poll)!
  bridge.reply('dia', { id: command.id, value: { name: 'Ada' } })
  expect(await result).toMatchObject({ value: { name: 'Ada' } })
  const other = new AbortController(), otherPoll = bridge.poll('chrome', other.signal)
  await expect(bridge.request('page', {})).rejects.toThrow('More than one')
  const cancel = new AbortController(), canceled = bridge.request('page', {}, 'dia', cancel.signal)
  cancel.abort(); await expect(canceled).rejects.toThrow('closed')
  expect(() => bridge.reply('dia', { id: command.id })).toThrow('expired')
  other.abort(); await otherPoll
})

it('expires dead connections and pending work and rejects work after revocation', async () => {
  vi.useFakeTimers()
  const bridge = new ReaderBridge(), controller = new AbortController()
  const poll = bridge.poll('dia', controller.signal)
  const pending = bridge.request('page', {})
  const failure = expect(pending).rejects.toThrow('did not respond')
  await poll
  await vi.advanceTimersByTimeAsync(60_001); await failure
  await vi.advanceTimersByTimeAsync(15_000)
  await expect(bridge.request('page', {})).rejects.toThrow('Connect Enki')
  const second = bridge.poll('dia', controller.signal)
  const revoked = bridge.request('page', {})
  await second
  bridge.disconnect('dia')
  await expect(revoked).rejects.toThrow('revoked')
  await expect(bridge.request('page', {}, 'dia')).rejects.toThrow('Connect Enki')
})
