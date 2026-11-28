import { useState, type FormEvent } from 'react'
import { crmCommand, crmMessage, type CrmDetail } from './client.ts'
import type { CrmCommand } from './types.ts'

export function CompanyActivity({ companyId, related, writer, onChanged, kind }: {
  companyId: string
  related?: CrmDetail['related']
  writer: boolean
  onChanged: () => void
  kind: 'interactions' | 'tasks'
}) {
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const tasks = kind === 'tasks'
  const canWrite = writer && !!related && !busy

  async function run(command: Omit<CrmCommand, 'commandId'>, success: string) {
    if (!canWrite) return false
    setBusy(true)
    setError(false)
    setMessage('')
    try {
      await crmCommand(command)
      onChanged()
      setMessage(success)
      return true
    } catch (failure) {
      setError(true)
      setMessage(crmMessage(failure))
      return false
    } finally { setBusy(false) }
  }

  function add(event: FormEvent) {
    event.preventDefault()
    if (!title.trim()) return
    const timestamp = date ? new Date(tasks ? date + 'T12:00:00' : date).getTime() : null
    const occurred = timestamp ?? Date.now()
    const command: Omit<CrmCommand, 'commandId'> = tasks
      ? { operation: 'create', collection: 'tasks', record: { title: title.trim(), dueAt: timestamp, entityRefs: [{ type: 'company', id: companyId }] } }
      : { operation: 'create', collection: 'interactions', record: { title: title.trim(), type: 'meeting', status: occurred > Date.now() ? 'scheduled' : 'logged', companyIds: [companyId], personIds: [], startAt: occurred, occurredAt: occurred > Date.now() ? null : occurred } }
    void run(command, tasks ? 'Task added.' : 'Interaction saved.').then(ok => {
      if (ok) { setTitle(''); setDate('') }
    })
  }

  return <div className="crm-company-activity">
    <form className="crm-form" onSubmit={add}>
      <label>{tasks ? 'Task' : 'What happened?'}<input value={title} onChange={event => setTitle(event.target.value)} required /></label>
      <label>{tasks ? 'Due date' : 'Date and time'}<input type={tasks ? 'date' : 'datetime-local'} value={date} onChange={event => setDate(event.target.value)} /></label>
      <button className="crm-button is-primary" disabled={!canWrite || !title.trim()}>{tasks ? 'Add task' : 'Save interaction'}</button>
    </form>
    {message && <p role={error ? 'alert' : 'status'}>{message}</p>}
    {tasks ? related?.tasks.map(task => <article key={task.id}>
      <strong>{task.title}</strong>
      <small>{task.completedAt ? 'Completed' : task.dueAt ? new Date(task.dueAt).toLocaleDateString() : 'No due date'}</small>
      <button type="button" className="crm-button" disabled={!canWrite}
        onClick={() => void run({ operation: 'complete_task', id: task.id, expectedRecordRevision: task.revision, completed: !task.completedAt }, task.completedAt ? 'Task reopened.' : 'Task completed.')}>{task.completedAt ? 'Reopen' : 'Complete'}</button>
    </article>) : related?.interactions.map(activity => <article key={activity.id}>
      <strong>{activity.title}</strong><small>{activity.startAt ? new Date(activity.startAt).toLocaleString() : activity.status}</small>
      {activity.body && <p>{activity.body}</p>}
    </article>)}
    {related && !(tasks ? related.tasks.length : related.interactions.length) && <p className="crm-muted">{tasks ? 'No tasks for this organization yet.' : 'No interactions for this organization yet.'}</p>}
  </div>
}
