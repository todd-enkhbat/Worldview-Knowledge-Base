// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ContactGroupPicker } from '../../src/crm/ContactGroupPicker.tsx'
import { createCrmRecord } from '../../src/crm/model.ts'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('selects multiple new memberships while keeping an existing membership checked', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host), add = vi.fn(async () => true), close = vi.fn()
  const groups = ['Founders', 'Columbia', 'Friends'].map((name, index) => createCrmRecord('groups', { id: 'group-' + index, name, entityType: 'person' }))
  try {
    await act(async () => root.render(<ContactGroupPicker groups={groups} memberships={new Set(['group-0'])} disabled={false} onAdd={add} onClose={close} />))
    const inputs = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    expect(inputs[0].checked).toBe(true); expect(inputs[0].disabled).toBe(true)
    await act(async () => { inputs[1].click(); inputs[2].click() })
    const submit = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Add to 2 groups')!
    await act(async () => submit.click())
    expect(add).toHaveBeenCalledExactlyOnceWith(['group-1','group-2']); expect(close).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); host.remove() }
})
