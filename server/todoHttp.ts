import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorldDb } from './worldDb.ts'
import type { ChangeBus } from './changes.ts'
import { memoryOriginAllowed, readMemoryBody, sendMemoryJson } from './memoryHttp.ts'
import { decodeTodos, TODO_KEY, todoChangeSchema, type TodoChange, type TodoState } from '../src/data/todos.ts'

export class TodoError extends Error {
  readonly status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
class TodoConflict extends TodoError {
  constructor(message: string) { super(message,409) }
}

/** Return false when a retried request already has its requested effect. */
function changeTodos(state: TodoState, edit: TodoChange): boolean {
  if (edit.action === 'delete-task' || edit.action === 'clear-inbox') {
    const keep = state.tasks.filter(task => edit.action === 'delete-task' ? task.id !== edit.id : task.listId !== 'inbox')
    if (keep.length === state.tasks.length) return false
    state.tasks = keep
    return true
  }
  if (edit.action === 'delete-list') {
    if (!state.lists.some(list => list.id === edit.id)) return false
    state.lists = state.lists.filter(list => list.id !== edit.id)
    state.tasks = state.tasks.filter(task => task.listId !== edit.id)
    return true
  }
  if (edit.action === 'add-list' || edit.action === 'rename-list') {
    const current = state.lists.find(list => list.id === edit.id)
    if (current?.name === edit.name) return false
    if (edit.action === 'add-list') {
      if (current) throw new TodoConflict('This list already exists. Refresh your lists.')
      state.lists.push({ id: edit.id, name: edit.name })
    } else {
      if (!current) throw new TodoConflict('This list is no longer in the workspace.')
      current.name = edit.name
    }
    return true
  }
  const current = state.tasks.find(task => task.id === edit.id)
  if (edit.action === 'add-task') {
    if (current?.listId === edit.listId && current.text === edit.text) return false
    if (current) throw new TodoConflict('This task already exists. Refresh your list.')
    if (!state.lists.some(list => list.id === edit.listId)) throw new TodoConflict('This list is no longer in the workspace.')
    state.tasks.push({ id: edit.id, listId: edit.listId, text: edit.text, done: false })
    return true
  }
  if (!current) throw new TodoConflict('This task is no longer in the workspace.')
  const { text = current.text, done = current.done } = edit
  if (current.text === text && current.done === done) return false
  Object.assign(current, { text, done })
  return true
}

/** Both the first-party helper and the paired reader use the same revision and
 * workspace checks. Their origin/credential gates run before entering this service. */
export function accessTodos(db: WorldDb, bus?: ChangeBus, body?: Record<string, unknown>) {
  const result = db.tx(() => {
    if (db.getKv('importInProgress') !== undefined) throw new TodoConflict('Finish restoring the workspace, then reopen TO-DO.')
    const workspaceToken = db.crm.workspaceFingerprint()
    const state = decodeTodos(db.getKv(TODO_KEY))
    let changed = false
    if (body) {
      const edit = todoChangeSchema.safeParse(body)
      if (!edit.success) throw new TodoError(edit.error.issues[0]?.message ?? 'Invalid to-do edit.',400)
      if (typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)
        throw new TodoError('Open the current to-do list before editing.',400)
      if (body.workspaceToken !== workspaceToken) throw new TodoConflict('Your workspace changed. Reopen TO-DO.')
      changed = changeTodos(state, edit.data)
      if (changed) {
        if (body.expectedRevision !== state.revision) throw new TodoConflict('Your lists changed. Refresh and retry your edit.')
        state.revision++
        db.putKv(TODO_KEY, state)
      }
    }
    return {changed,state:{...state,workspaceToken}}
  })
  if (result.changed) bus?.publish({v:1,from:'enki',change:{type:'kv',keys:[TODO_KEY]}})
  return result.state
}

export async function todoHttp(req: IncomingMessage, res: ServerResponse, route: string, db: WorldDb, bus: ChangeBus) {
  if (!memoryOriginAllowed(req) || !req.headers['x-wv-client'])
    return sendMemoryJson(res,403,{error:'Open your workspace to use TO-DO.'})
  if (!['state','mutate'].includes(route)) return sendMemoryJson(res,404,{error:'Unknown to-do operation.'})
  if (req.method !== (route === 'state' ? 'GET' : 'POST')) return sendMemoryJson(res,405,{error:'Unsupported method.'})
  let body: Record<string,unknown> | undefined
  if (route === 'mutate') {
    try { body = await readMemoryBody(req,32*1024) }
    catch { return sendMemoryJson(res,400,{error:'Send one valid to-do edit at a time.'}) }
  }
  try { return sendMemoryJson(res,200,accessTodos(db,bus,body)) }
  catch (error) {
    if (error instanceof TodoError) return sendMemoryJson(res,error.status,{error:error.message})
    return sendMemoryJson(res,500,{error:'Worldview could not access your saved to-do lists.'})
  }
}
