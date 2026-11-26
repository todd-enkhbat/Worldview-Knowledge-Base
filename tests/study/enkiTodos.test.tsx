// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EnkiTodos } from '../../src/study/EnkiTodos.tsx'
import type { TodoWorkspace } from '../../src/data/todos.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
const listId = crypto.randomUUID(), taskId = crypto.randomUUID()
const saved: TodoWorkspace = {
  schemaVersion: 1, revision: 2, workspaceToken: 'test',
  lists: [{ id: 'inbox', name: 'Inbox' }, { id: listId, name: 'Reading' }],
  tasks: [{ id: taskId, listId, text: 'Finish the chapter', done: false }],
}
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('worldview.enki.list.test', listId)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const find = (s: string) => host.querySelector<HTMLButtonElement>(s)!
async function click(s: string) { await act(async () => find(s).click()) }

it('focuses Cancel and requires a fresh confirmation after another window adds a task', async () => {
  const changed = { ...saved, revision: 3, tasks: [...saved.tasks, { id: crypto.randomUUID(), listId, text: 'Another task', done: true }] }
  const deleted = { ...saved, revision: 4, lists: [saved.lists[0]], tasks: [] }
  const api = vi.fn()
    .mockResolvedValueOnce(Response.json(saved))
    .mockResolvedValueOnce(Response.json({ error: 'Your lists changed' }, {status: 409}))
    .mockResolvedValueOnce(Response.json(changed))
    .mockResolvedValueOnce(Response.json(deleted))
  vi.stubGlobal('fetch', api)
  await act(async () => root.render(<EnkiTodos />))
  await click('.enki-delete-list')
  expect(find('.enki-delete-confirm p').textContent).toContain('1 task')
  expect(document.activeElement?.textContent).toBe('Cancel')
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(find('.enki-delete-list'))
  expect(api).toHaveBeenCalledTimes(1)
  await click('.enki-delete-list')
  await click('.enki-confirm-delete')
  expect(api).toHaveBeenCalledTimes(3)
  expect(host.querySelector('.enki-delete-confirm')).toBeNull()
  await click('.enki-delete-list')
  expect(find('.enki-delete-confirm p').textContent).toContain('2 tasks')
  await click('.enki-confirm-delete')
  expect(JSON.parse(api.mock.calls[3][1].body)).toMatchObject({ action: 'delete-list', id: listId, expectedRevision: 3 })
  expect(host.querySelector('select')?.value).toBe('inbox')
  expect(host.querySelector('.enki-delete-list')).toBeNull()
  expect(document.activeElement).toBe(find('[name=task]'))
})

it('celebrates only a successfully checked task', async () => {
  const done = { ...saved, revision: 3, tasks: [{ ...saved.tasks[0], done: true }] }
  const celebrate = vi.fn()
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json(saved))
    .mockResolvedValueOnce(Response.json({ error: 'Try again' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json(done))
    .mockResolvedValueOnce(Response.json({ ...saved, revision: 4 })))
  await act(async () => root.render(<EnkiTodos onCelebrate={celebrate} />))
  await click('[type=checkbox]')
  expect(celebrate).not.toHaveBeenCalled()
  await click('[type=checkbox]')
  expect(celebrate).toHaveBeenCalledTimes(1)
  await click('[type=checkbox]')
  expect(celebrate).toHaveBeenCalledTimes(1)
})

it('opens task and list confirmations from a secondary click, Control-click, or keyboard and deletes only after confirmation',async()=>{
  localStorage.clear()
  const open={...saved.tasks[0],listId:'inbox'}, done={...open,id:crypto.randomUUID(),text:'Done',done:true}
  const initial={...saved,tasks:[open,done]}
  const afterTask={...initial,revision:3,tasks:[open]}
  const api=vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(afterTask).mockResolvedValueOnce({...afterTask,revision:4,tasks:[]})
  await act(async()=>root.render(<EnkiTodos requestTodos={api}/>))
  async function dispatch(selector:string,event:Event){await act(async()=>{find(selector).dispatchEvent(event)})}
  await dispatch('.enki-task',new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))
  expect(find('.enki-delete-confirm p').textContent).toContain(open.text)
  expect(document.activeElement?.textContent).toBe('Cancel')
  await click('.enki-delete-actions button')
  await click('summary')
  await dispatch('details .enki-task input',new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'F10',shiftKey:true}))
  expect(find('.enki-delete-confirm p').textContent).toContain(done.text)
  await click('.enki-confirm-delete')
  expect(api.mock.calls[1][0]).toMatchObject({action:'delete-task',id:done.id,expectedRevision:2})
  await dispatch('.enki-list-picker',new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true}))
  expect(find('.enki-delete-confirm p').textContent).toContain('Clear 1 task')
  await click('.enki-confirm-delete')
  expect(api.mock.calls[2][0]).toMatchObject({action:'clear-inbox',id:'inbox',expectedRevision:3})
  expect(find('.enki-clear-inbox').disabled).toBe(true)
  expect(host.querySelector('select')?.value).toBe('inbox')
})

it('refreshes a reopened panel, repeats stale confirmations and keeps drafted text when the selected list has been deleted elsewhere',async()=>{
  const initial={...saved,revision:1}, changed={...saved,revision:2,tasks:[...saved.tasks,{id:crypto.randomUUID(),listId,text:'Added elsewhere',done:false}]}
  const removed={...saved,revision:3,lists:[saved.lists[0]],tasks:[]}
  const api=vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(changed).mockRejectedValueOnce(new Error('Cannot refresh right now')).mockResolvedValueOnce(removed)
  await act(async()=>root.render(<EnkiTodos requestTodos={api}/>))
  const compose=host.querySelector<HTMLTextAreaElement>('[name=task]')!
  await act(async()=>{
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(compose,'My unsent note')
    compose.dispatchEvent(new Event('input',{bubbles:true}))
  })
  await click('.enki-delete-list')
  await act(async()=>window.dispatchEvent(new Event('worldview:todos-refresh')))
  expect(host.querySelector('.enki-delete-confirm')).toBeNull()
  expect(host.querySelector('[role=alert]')?.textContent).toContain('before deleting')
  expect(compose.value).toBe('My unsent note')
  await click('.enki-delete-list')
  expect(find('.enki-delete-confirm p').textContent).toContain('2 tasks')
  await click('.enki-delete-actions button')
  await act(async()=>window.dispatchEvent(new Event('focus')))
  expect(host.textContent).toContain('Cannot refresh right now')
  expect(host.querySelectorAll('.enki-task')).toHaveLength(2)
  await click('.enki-error button')
  expect(host.textContent).not.toContain('Cannot refresh right now')
  expect(host.querySelector('select')?.value).toBe('inbox')
  expect(compose.value).toBe('My unsent note')
  expect(localStorage.getItem('worldview.enki.list.test')).toBe('inbox')
})
