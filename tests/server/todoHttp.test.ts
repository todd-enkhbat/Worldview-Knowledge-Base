import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createHost } from '../../server/host.ts'
import { blobSink, exportArchive, importArchive } from '../../src/data/archive.ts'
import { createHttpStore } from '../../src/data/httpStore.ts'
import type { TodoChange, TodoWorkspace } from '../../src/data/todos.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const headers = { 'x-wv-client': 'enki-test', 'content-type': 'application/json' }

function newDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'worldview-todos-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function serve(dataDir = newDirectory(), accounts = false) {
  const host = createHost({ dataDir, accounts })
  const server = createServer((req, res) => host.handler(req, res))
  let closed = false
  async function close() {
    if (closed) return
    closed = true
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    host.close()
  }
  cleanups.push(close)
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api'
  async function state(): Promise<TodoWorkspace> {
    const response = await fetch(base + '/todos/state', { headers })
    expect(response.status).toBe(200)
    return response.json()
  }
  function edit(previous: TodoWorkspace, change: TodoChange) {
    return fetch(base + '/todos/mutate', { headers, method: 'POST', body: JSON.stringify({
      expectedRevision: previous.revision, workspaceToken: previous.workspaceToken, ...change,
    }) })
  }
  return { base, state, edit, close }
}

it('retains lists and edits in SQLite after restart and through portable backup and restore', async () => {
  const directory = newDirectory(), first = await serve(directory)
  const empty = await first.state(), listId = crypto.randomUUID(), taskId = crypto.randomUUID()
  expect(empty.lists).toEqual([{ id: 'inbox', name: 'Inbox' }])
  const list = await (await first.edit(empty, { action: 'add-list', id: listId, name: 'Reading' })).json()
  const added = await (await first.edit(list, { action: 'add-task', id: taskId, listId, text: 'Read the essay' })).json()
  const revised = await (await first.edit(added, { action: 'edit-task', id: taskId, text: 'Review the essay', done: true })).json()
  const renamed = await (await first.edit(revised, { action: 'rename-list', id: listId, name: 'Writing' })).json()
  expect(renamed).toMatchObject({ revision: 4, tasks: [{ listId, text: 'Review the essay', done: true }] })
  await first.close()

  const second = await serve(directory)
  expect(await second.state()).toEqual(renamed)
  const sink = blobSink()
  await exportArchive(createHttpStore({ base: second.base }), sink)
  const restored = await serve()
  const before = await restored.state()
  await importArchive(createHttpStore({ base: restored.base }), sink.blob(), { allowWithoutBackup: true })
  const after = await restored.state()
  expect(after.tasks).toEqual(renamed.tasks)
  expect(after.lists).toEqual(renamed.lists)
  expect(after.workspaceToken).not.toBe(before.workspaceToken)
  expect((await restored.edit({ ...after, workspaceToken: before.workspaceToken }, { action: 'edit-task', id: taskId, done: false })).status).toBe(409)
  expect((await restored.state()).tasks[0].done).toBe(true)
})

it('safely retries a task, checks stale edits and refuses malformed input', async () => {
  const world = await serve(), empty = await world.state()
  const change = { action: 'add-task', id: crypto.randomUUID(), listId: 'inbox', text: 'Write' } as const
  const [a, b] = await Promise.all([world.edit(empty, change), world.edit(empty, change)])
  expect(a.status).toBe(200)
  expect(b.status).toBe(200)
  expect(await a.json()).toEqual(await b.json())
  expect((await world.edit(empty, { action: 'edit-task', id: change.id, text: 'Overwrite' })).status).toBe(409)
  const list = await world.state()
  expect(list.tasks).toHaveLength(1)
  expect((await world.edit(list, { action: 'add-task', id: crypto.randomUUID(), listId: 'inbox', text: ' ' })).status).toBe(400)
  expect((await world.edit(list, { action: 'edit-task', id: change.id })).status).toBe(400)
  expect((await world.edit(list, { action: 'add-task', id: crypto.randomUUID(), listId: crypto.randomUUID(), text: 'Missing list' })).status).toBe(409)
  expect((await world.state()).revision).toBe(1)
})

it('requires the workspace client and origin, and a signed-in session on an account server', async () => {
  const local = await serve(), hosted = await serve(newDirectory(), true)
  expect((await fetch(local.base + '/todos/state')).status).toBe(403)
  expect((await fetch(local.base + '/todos/state', { headers: { ...headers, origin: 'https://example.com' } })).status).toBe(403)
  expect((await fetch(hosted.base + '/todos/state', { headers })).status).toBe(401)
})

it('deletes only a confirmed list and its tasks, checking concurrent additions and preserving earlier backups', async () => {
  const directory = newDirectory(), world = await serve(directory)
  const empty = await world.state(), id = crypto.randomUUID()
  const created = await (await world.edit(empty, { action: 'add-list', id, name: 'Research' })).json()
  const inbox = await (await world.edit(created, { action: 'add-task', id: crypto.randomUUID(), listId: 'inbox', text: 'Keep this' })).json()
  const reviewed = await (await world.edit(inbox, { action: 'add-task', id: crypto.randomUUID(), listId: id, text: 'First' })).json()
  const updated = await (await world.edit(reviewed, { action: 'add-task', id: crypto.randomUUID(), listId: id, text: 'Second' })).json()
  const deletion = { action: 'delete-list', id } as const
  expect((await world.edit(reviewed, deletion)).status).toBe(409)
  expect((await world.edit(updated, { action: 'delete-list', id: 'inbox' })).status).toBe(400)
  expect(await world.state()).toEqual(updated)

  const before = blobSink()
  await exportArchive(createHttpStore({ base: world.base }), before)
  const deleted = await (await world.edit(updated, deletion)).json()
  expect(deleted).toMatchObject({ revision: updated.revision + 1, lists: empty.lists, tasks: inbox.tasks })
  expect(await (await world.edit(updated, deletion)).json()).toEqual(deleted)
  const after = blobSink()
  await exportArchive(createHttpStore({ base: world.base }), after)
  await world.close()
  const reopened = await serve(directory)
  expect(await reopened.state()).toEqual(deleted)
  const restored = await serve()
  const store = createHttpStore({ base: restored.base })
  await importArchive(store, before.blob(), { allowWithoutBackup: true })
  expect((await restored.state()).tasks).toEqual(updated.tasks)
  await importArchive(store, after.blob(), { allowWithoutBackup: true })
  expect((await restored.state()).tasks).toEqual(deleted.tasks)
})

it('shares task deletion and Inbox clearing with a paired reader and enforces revision and origin checks',async()=>{
  const world=await serve(), empty=await world.state()
  const origin='chrome-extension://'+'c'.repeat(32)
  const paired=await fetch(world.base+'/reading-capture',{method:'POST',headers,body:JSON.stringify({origin,name:'Test reader'})})
  expect(paired.status).toBe(201)
  const {token}=await paired.json()
  function reader(route:string, body:unknown={},originHeader=origin, bearer=token) {
    return fetch(world.base+'/reading-capture/todos-'+route,{method:'POST',headers:{'content-type':'application/json',origin:originHeader,...(bearer ? {authorization:'Bearer '+bearer} : {})},body:JSON.stringify(body)})
  }
  expect((await reader('state',{},origin,'')).status).toBe(401)
  expect((await reader('state',{},'chrome-extension://'+'d'.repeat(32))).status).toBe(403)
  expect(await (await reader('state')).json()).toEqual(empty)
  const other=crypto.randomUUID(), keep=crypto.randomUUID(), active=crypto.randomUUID(), completed=crypto.randomUUID()
  async function edit(change:TodoChange) {const r=await world.edit(await world.state(),change);expect(r.status).toBe(200);return r.json()}
  await edit({action:'add-list',id:other,name:'Keep'})
  await edit({action:'add-task',id:keep,listId:other,text:'Keep me'})
  await edit({action:'add-task',id:active,listId:'inbox',text:'Open'})
  const stale=await edit({action:'add-task',id:completed,listId:'inbox',text:'Finished'})
  const done=await edit({action:'edit-task',id:completed,done:true})
  const payload=(previous:TodoWorkspace, change:TodoChange)=>({...change,expectedRevision:previous.revision,workspaceToken:previous.workspaceToken})
  const clear={action:'clear-inbox',id:'inbox'} as const
  expect((await reader('mutate',payload(stale,clear))).status).toBe(409)
  const del=payload(done,{action:'delete-task',id:completed})
  const removed=await (await reader('mutate',del)).json()
  expect(removed.tasks.map((t:{id:string})=>t.id)).toEqual([keep,active])
  expect(await (await reader('mutate',del)).json()).toEqual(removed)
  expect(await world.state()).toEqual(removed)
  const cleared=await (await world.edit(removed,clear)).json()
  expect(cleared.tasks.map((t:{id:string})=>t.id)).toEqual([keep])
  expect(cleared.lists).toEqual([{id:'inbox',name:'Inbox'},{id:other,name:'Keep'}])
  expect(await (await reader('mutate',payload(removed,clear))).json()).toEqual(cleared)
  await edit({action:'delete-task',id:keep})
  expect((await (await reader('state')).json()).tasks).toHaveLength(0)
})
