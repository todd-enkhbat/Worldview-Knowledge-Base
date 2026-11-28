import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { PencilSimple, Trash } from '@phosphor-icons/react'
import type { TodoChange, TodoWorkspace } from '../data/todos.ts'
import './enki-todos.css'

type Task = TodoWorkspace['tasks'][number]
type Draft = { id: string; text: string; original?: string }
type DeletePrompt = { action:'delete-list' | 'clear-inbox' | 'delete-task'; id:string; name:string; count:number; revision:number }
export type TodoRequest = (body?: TodoChange & {workspaceToken:string; expectedRevision:number}) => Promise<TodoWorkspace>
const lastListKey = (token: string) => 'worldview.enki.list.' + token
const draftKey = (token: string) => 'worldview.enki.draft.' + token
type PanelDraft = { text?: string; newList?: string | null; edit?: Draft | null; createId?: { task: string; list: string } }
function readDraft(token: string): PanelDraft {
  try { return JSON.parse(sessionStorage.getItem(draftKey(token)) || '{}') || {} }
  catch { return {} }
}

async function localTodos(body?: TodoChange & { workspaceToken: string; expectedRevision: number }) {
  const response = await fetch('/api/todos/' + (body ? 'mutate' : 'state'), {
    method: body ? 'POST' : 'GET',
    cache: 'no-store',
    headers: { 'x-wv-client': 'enki-todo', ...(body && { 'content-type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const message = (await response.json().catch(() => ({}))).error
    throw Object.assign(new Error(message || 'Could not reach your Worldview to-do lists.'), { status: response.status })
  }
  return await response.json() as TodoWorkspace
}

function enterToSave(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }
}

export function EnkiTodos({ onSummon, onCelebrate, requestTodos = localTodos, showHeading = true }: {
  requestTodos?: TodoRequest
  onSummon?: (callback: () => void) => () => void
  onCelebrate?: () => void
  showHeading?: boolean
}) {
  const [data, setData] = useState<TodoWorkspace | null>(null)
  const [listId, setListId] = useState('inbox')
  const [text, setText] = useState('')
  const [newList, setNewList] = useState<string | null>(null)
  const [edit, setEdit] = useState<Draft | null>(null)
  const [deletePrompt, setDeletePrompt] = useState<DeletePrompt | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const entry = useRef<HTMLTextAreaElement>(null)
  const listName = useRef<HTMLInputElement>(null)
  const editText = useRef<HTMLTextAreaElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const cancelDelete = useRef<HTMLButtonElement>(null)
  const locked = useRef(false)
  const writeSequence = useRef(0)
  const refreshAfterWrite = useRef(false)
  const createId = useRef({ task: '', list: '' })
  const sync = useRef<BroadcastChannel | null>(null)

  function applySnapshot(value: TodoWorkspace) {
    setLoadError('')
    if (data?.workspaceToken === value.workspaceToken && value.revision < data.revision) return
    setData(value)
    if (!data || data.workspaceToken !== value.workspaceToken) {
      const savedList = localStorage.getItem(lastListKey(value.workspaceToken))
      const selected = value.lists.find(list => list.id === savedList)?.id ?? 'inbox'
      const draft = readDraft(value.workspaceToken)
      setListId(selected)
      setText(typed => !data && typed || draft.text || '')
      setNewList(draft.newList ?? null)
      setEdit(value.tasks.some(task => task.id === draft.edit?.id && task.listId === selected) ? draft.edit ?? null : null)
      createId.current = draft.createId ?? {task:'',list:''}
      setDeletePrompt(null)
      if (data) setStatus('Showing the current workspace.')
      return
    }
    if (value.revision === data.revision) return
    const selectedRemoved = !value.lists.some(list => list.id === listId)
    if (selectedRemoved) {
      setListId('inbox')
      localStorage.setItem(lastListKey(value.workspaceToken),'inbox')
      createId.current.task = ''
      setStatus('That list was deleted in another window. Showing Inbox.')
    }
    if (edit && !value.tasks.some(task => task.id === edit.id)) {
      setText(typed => [typed,edit.text].filter(Boolean).join('\n'))
      setEdit(null)
      setStatus('That task was deleted in another window. Your edit is in the new-task field.')
    }
    if (deletePrompt) {
      setDeletePrompt(null)
      setError('Your lists changed. Review the latest version before deleting.')
      entry.current?.focus()
    }
  }
  const receiveSnapshot = useEffectEvent(applySnapshot)
  useEffect(() => {
    function refresh() {
      if (document.hidden || entry.current?.closest('[hidden]')) return
      if (locked.current) refreshAfterWrite.current = true
      else setAttempt(value => value + 1)
    }
    window.addEventListener('focus',refresh)
    window.addEventListener('worldview:todos-refresh',refresh)
    document.addEventListener('visibilitychange',refresh)
    // Same-origin windows get immediate updates. A visible Reader uses a different
    // origin, so check periodically even when focus never leaves the editor.
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('worldview-todos') : null
    sync.current = channel
    channel?.addEventListener('message', refresh)
    const timer = window.setInterval(refresh, 5000)
    return () => {
      window.removeEventListener('focus',refresh)
      window.removeEventListener('worldview:todos-refresh',refresh)
      document.removeEventListener('visibilitychange',refresh)
      window.clearInterval(timer)
      sync.current = null
      channel?.close()
    }
  },[])
  useEffect(() => {
    let alive = true
    const sequence = writeSequence.current
    void requestTodos().then(value => {
      if (alive && sequence === writeSequence.current && !locked.current) receiveSnapshot(value)
    }).catch(err => {
      if (alive && sequence === writeSequence.current) setLoadError(err instanceof Error ? err.message : 'Could not refresh your lists.')
    })
    return () => { alive = false }
  }, [attempt,requestTodos])
  const token = data?.workspaceToken
  useEffect(() => {
    if (!token) return
    if (!text && newList === null && !edit) sessionStorage.removeItem(draftKey(token))
    else sessionStorage.setItem(draftKey(token), JSON.stringify({ text, newList, edit, createId: createId.current }))
  }, [token, text, newList, edit, busy])
  useEffect(() => {
    entry.current?.focus()
    return onSummon?.(() => (cancelDelete.current || editText.current || listName.current || entry.current)?.focus())
  }, [onSummon])
  const creatingList = newList !== null
  useEffect(() => { if (creatingList) listName.current?.focus() }, [creatingList])
  const editId = edit?.id
  useEffect(() => { if (editId) editText.current?.focus() }, [editId])
  useEffect(() => { if (deletePrompt) cancelDelete.current?.focus() }, [deletePrompt])

  function selectList(id: string) {
    if (id !== listId) createId.current.task = ''
    setListId(id)
    if (data) localStorage.setItem(lastListKey(data.workspaceToken), id)
    setEdit(null)
    setDeletePrompt(null)
    setStatus('')
    setError('')
    entry.current?.focus()
  }
  async function save(change: TodoChange, expectedRevision = data?.revision) {
    if (!data || expectedRevision === undefined || locked.current) return false
    locked.current = true
    writeSequence.current++
    setBusy(true)
    setError('')
    setStatus('Saving…')
    try {
      const saved = await requestTodos({ ...change, workspaceToken: data.workspaceToken, expectedRevision })
      setData(saved)
      sync.current?.postMessage('changed')
      setLoadError('')
      setStatus('Saved to Worldview.')
      return true
    } catch (e) {
      setStatus('')
      let message = e instanceof Error ? e.message : 'Could not save this change.'
      if ((e as { status?: number }).status === 409) {
        setDeletePrompt(null)
        try {
          const latest = await requestTodos()
          applySnapshot(latest)
          message = 'Your lists changed. Review the latest version and try your change again.'
        } catch { /* The draft remains available for another attempt. */ }
      }
      setError(message)
      return false
    } finally {
      locked.current = false
      setBusy(false)
      if (refreshAfterWrite.current) { refreshAfterWrite.current = false; setAttempt(value => value + 1) }
    }
  }
  async function addTask(event: FormEvent) {
    event.preventDefault()
    if (!text.trim() || !data) { entry.current?.focus(); return }
    createId.current.task ||= crypto.randomUUID()
    if (await save({ action: 'add-task', id: createId.current.task, listId, text: text.trim() })) {
      createId.current.task = ''
      setText('')
      entry.current?.focus()
    }
  }
  async function addList(event: FormEvent) {
    event.preventDefault()
    if (!newList?.trim()) { listName.current?.focus(); return }
    const id = createId.current.list ||= crypto.randomUUID()
    if (await save({ action: 'add-list', id, name: newList.trim() })) {
      createId.current.list = ''
      setNewList(null)
      selectList(id)
      setStatus('List created.')
    }
  }
  async function editTask(event: FormEvent) {
    event.preventDefault()
    if (edit?.text.trim() && await save({ action: 'edit-task', id: edit.id, text: edit.text.trim() })) {
      setEdit(null)
      entry.current?.focus()
    }
  }
  const tasks = data?.tasks.filter(task => task.listId === listId) || []
  const selectedList = data?.lists.find(list => list.id === listId)
  function confirm(target: HTMLElement, task?: Task) {
    if (locked.current || !data || !selectedList || !task && listId === 'inbox' && !tasks.length) return
    returnFocus.current = target
    setDeletePrompt({action:task ? 'delete-task' : listId === 'inbox' ? 'clear-inbox' : 'delete-list',
      id:task?.id ?? listId, name:task?.text ?? selectedList.name, count:tasks.length, revision:data.revision})
    setError('')
  }
  function menuEvents(task?: Task) {
    const open = (event: React.SyntheticEvent<HTMLElement>) => {
      if (busy || task && edit?.id === task.id) return
      event.preventDefault()
      event.stopPropagation()
      const target = event.currentTarget.querySelector<HTMLElement>('button[data-delete]') ?? entry.current
      if (target) confirm(target,task)
    }
    return {
      onContextMenu: open,
      onClickCapture: (event: React.MouseEvent<HTMLElement>) => { if (event.ctrlKey && event.button === 0) open(event) },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) open(event)
      },
    }
  }
  function cancelRemoval() {
    setDeletePrompt(null)
    returnFocus.current?.focus()
  }
  async function remove() {
    if (!deletePrompt) return
    const {action,id,revision} = deletePrompt
    const change: TodoChange = action === 'clear-inbox' ? {action,id:'inbox'} : {action,id}
    if (!await save(change,revision)) return
    setDeletePrompt(null)
    if (action === 'delete-list') selectList('inbox')
    else if (edit?.id === id || action === 'clear-inbox') setEdit(null)
    setStatus(action === 'delete-task' ? 'Task deleted.' : action === 'clear-inbox' ? 'Inbox cleared.' : 'List deleted.')
    entry.current?.focus()
  }
  function confirmation(prompt: DeletePrompt) {
    const clearing = prompt.action === 'clear-inbox', task = prompt.action === 'delete-task'
    const count = prompt.count + (prompt.count === 1 ? ' task' : ' tasks')
    const question = task ? 'Delete “'+prompt.name+'”?' : clearing ? 'Clear '+count+' from “'+prompt.name+'”?' :
      'Delete “'+prompt.name+'”'+(prompt.count ? ' and its '+count : '')+'?'
    return <div className="enki-delete-confirm" role="group" aria-labelledby="enki-delete-question"
      onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); cancelRemoval() } }}>
      <p id="enki-delete-question">{question}</p>
      <div className="enki-delete-actions">
        <button type="button" ref={cancelDelete} disabled={busy} onClick={cancelRemoval}>Cancel</button>
        <button type="button" className="enki-confirm-delete" disabled={busy} onClick={() => void remove()}>{task ? 'Delete task' : clearing ? 'Clear Inbox' : 'Delete list'}</button>
      </div>
    </div>
  }
  const completed = tasks.filter(task => task.done)
  const renderTask = (task: Task) => {
    const changedElsewhere = edit?.id === task.id && edit.original !== undefined && edit.original !== task.text
    return (
    <li key={task.id} className="enki-task" {...menuEvents(task)}>
      {edit?.id === task.id ? (
        <form className="enki-edit" onSubmit={editTask}>
          {changedElsewhere && <p className="enki-edit-conflict" role="status">Updated in another window. Current task reads “{task.text}”</p>}
          <textarea ref={editText} aria-label="Edit task" name="editedTask" value={edit.text} rows={2}
            required maxLength={4000} readOnly={busy} onChange={event => setEdit({ ...edit, text: event.target.value })}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); setEdit(null); entry.current?.focus() }
              else if (!changedElsewhere) enterToSave(event)
            }} />
          <div><button type="submit" disabled={busy}>{changedElsewhere ? 'Save my edit' : 'Save'}</button> <button type="button" disabled={busy}
            onClick={() => { setEdit(null); entry.current?.focus() }}>Cancel</button></div>
        </form>
      ) : (
        <>
          <label className={task.done ? 'is-complete' : undefined}>
            <input type="checkbox" checked={task.done} disabled={busy} onChange={async event => {
              const done = event.target.checked
              if (await save({ action: 'edit-task', id: task.id, done })) {
                if (done && !task.done) onCelebrate?.()
                entry.current?.focus()
              }
            }} />
            <span>{task.text}</span>
          </label>
          <button className="enki-icon-button" title="Edit task" aria-label={'Edit ' + task.text} disabled={busy}
            onClick={() => setEdit({ id: task.id, text: task.text, original: task.text })}><PencilSimple aria-hidden="true" size={16} /></button>
          <button type="button" className="enki-icon-button enki-delete-task" data-delete
            aria-label={'Delete '+task.text} title="Delete task" disabled={busy}
            onClick={event => confirm(event.currentTarget,task)}><Trash aria-hidden="true" size={15}/></button>
        </>
      )}
      {deletePrompt?.action === 'delete-task' && deletePrompt.id === task.id && confirmation(deletePrompt)}
    </li>
    )
  }

  return (
    <section className="enki-todos" aria-label="TO-DO lists">
      <div className={'enki-todo-heading' + (showHeading ? '' : ' enki-todo-actions')}>
        {showHeading && <h1>To-do</h1>}
        <button type="button" className="enki-new-list" disabled={!data || busy}
          aria-expanded={newList !== null} onClick={() => { createId.current.list = ''; setNewList(newList === null ? '' : null); setError('') }}>
          New list
        </button>
      </div>
      {newList !== null && (
        <form className="enki-create-list" onSubmit={addList}>
          <input name="listName" ref={listName} aria-label="New list name" placeholder="List name…" maxLength={120}
            required autoComplete="off" value={newList} readOnly={busy} onChange={event => { createId.current.list = ''; setNewList(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setNewList(null); entry.current?.focus() } }} />
          <button type="submit" disabled={busy}>Create</button>
        </form>
      )}
      {data && <div className="enki-list-controls" {...menuEvents()}><label className="enki-list-picker">List
        <select aria-label="Current to-do list" value={listId} disabled={busy} onChange={event => selectList(event.target.value)}>
          {data.lists.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}
        </select>
      </label>
        {selectedList && <button type="button" className={'enki-icon-button ' + (listId === 'inbox' ? 'enki-clear-inbox' : 'enki-delete-list')}
          data-delete aria-label={listId === 'inbox' ? 'Clear Inbox' : 'Delete list'} title={listId === 'inbox' ? 'Clear Inbox' : 'Delete list'}
          aria-expanded={!!deletePrompt && deletePrompt.action !== 'delete-task'}
          disabled={busy || listId === 'inbox' && !tasks.length} onClick={event => confirm(event.currentTarget)}>
          <Trash aria-hidden="true" size={17} /></button>}
      </div>}
      {deletePrompt && deletePrompt.action !== 'delete-task' && confirmation(deletePrompt)}
      <form className="enki-compose" onSubmit={addTask}>
        <textarea ref={entry} name="task" aria-label="New task" rows={2} required maxLength={4000} readOnly={busy}
          placeholder="Add a task…" value={text} onChange={event => { createId.current.task = ''; setText(event.target.value) }} onKeyDown={enterToSave} />
        <button type="submit" className="enki-submit" disabled={!data || busy}>Add task</button>
      </form>
      {error && <div className="enki-error" role="alert">{error}</div>}
      {loadError && <div className="enki-error" role="alert">{loadError}{' '}
        <button disabled={busy} onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
      {!data && !loadError && <p role="status" className="enki-note">Loading lists…</p>}
      {data && !tasks.length && <p className="enki-note">No tasks yet. Press Enter to add your first.</p>}
      {tasks.length > completed.length && <ul className="enki-task-list" aria-label="Open tasks">{tasks.filter(task => !task.done).map(renderTask)}</ul>}
      {!!completed.length && <details className="enki-completed">
        <summary>Completed ({completed.length})</summary>
        <ul className="enki-task-list" aria-label="Completed tasks">{completed.map(renderTask)}</ul>
      </details>}
      <p role="status" className="enki-save-status">{status}</p>
    </section>
  )
}
