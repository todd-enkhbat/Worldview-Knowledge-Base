// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CreateRecordDialog } from '../../src/crm/PeopleWorkspace.tsx'
import { createCrmRecord } from '../../src/crm/model.ts'
const mocks = vi.hoisted(() => ({ command: vi.fn() }))
vi.mock('../../src/crm/client.ts', async original => ({ ...await original<Record<string, unknown>>(), crmCommand: mocks.command }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
beforeEach(() => { Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true } }); Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false } }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); mocks.command.mockReset() })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const group = createCrmRecord('groups', { id: 'group', name: 'Chosen group' }), savedPerson = createCrmRecord('people', { id: 'saved', fullName: 'Saved person' })
async function text(input: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
const submit = async () => { await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
it('retries only membership after the contact was saved, preserving the created identity', async () => {
  const onCreated = vi.fn(); mocks.command.mockResolvedValueOnce({ record: savedPerson }).mockRejectedValueOnce(new Error('Membership response lost')).mockResolvedValueOnce({ record: { id: 'membership' } })
  await act(async () => root.render(<CreateRecordDialog kind="person" group={group} groups={[group]} writer onClose={() => {}} onCreated={onCreated} />)); await text(host.querySelector('input')!, 'Saved person'); await submit()
  expect(host.textContent).toContain('The record is saved'); expect(host.querySelector('fieldset')!.disabled).toBe(true); await submit()
  expect(mocks.command.mock.calls.filter(([command]) => command.operation === 'create')).toHaveLength(1)
  expect(mocks.command.mock.calls.filter(([command]) => command.operation === 'membership')).toHaveLength(2); expect(onCreated).toHaveBeenCalledWith(savedPerson)
})
it('keeps option identities stable while retrying the same custom field draft', async () => {
  mocks.command.mockRejectedValueOnce(new TypeError('Network lost')).mockResolvedValueOnce({ record: createCrmRecord('fields', { id: 'field', name: 'Status', groupId: group.id }) })
  await act(async () => root.render(<CreateRecordDialog kind="field" group={group} groups={[group]} writer onClose={() => {}} onCreated={() => {}} />)); await text(host.querySelector('input')!, 'Status')
  await act(async () => { const select = host.querySelector('select')!; select.value = 'singleSelect'; select.dispatchEvent(new Event('change', { bubbles: true })) }); await submit(); await submit()
  expect(mocks.command.mock.calls[0][0].record.options).toEqual(mocks.command.mock.calls[1][0].record.options)
  expect(mocks.command.mock.calls[0][0].record.options).toHaveLength(3)
})
