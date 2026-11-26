import { z } from 'zod'

export const TODO_KEY = 'todos.v1'
const listId = z.union([z.literal('inbox'), z.uuid()])
const listName = z.string().trim().min(1, 'Give the list a name.').max(120, 'Use a list name of 120 characters or fewer.')
const taskText = z.string().trim().min(1, 'Enter something to do.').max(4000, 'Use 4,000 characters or fewer for a task.')
const list = z.object({ id: listId, name: listName })
const task = z.object({ id: z.uuid(), listId, text: taskText, done: z.boolean() })
const snapshot = z.object({
  schemaVersion: z.literal(1), revision: z.int().nonnegative(), lists: z.array(list), tasks: z.array(task),
}).refine(value => {
  const lists = new Set(value.lists.map(item => item.id))
  return lists.has('inbox') && lists.size === value.lists.length
    && new Set(value.tasks.map(item => item.id)).size === value.tasks.length
    && value.tasks.every(item => lists.has(item.listId))
}, 'The saved to-do lists contain missing or duplicate records.')

export const todoChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add-list'), id: z.uuid(), name: listName }),
  z.object({ action: z.literal('rename-list'), id: listId, name: listName }),
  z.object({ action: z.literal('delete-list'), id: z.uuid('Choose a list you created to delete.') }),
  z.object({ action: z.literal('clear-inbox'), id: z.literal('inbox') }),
  z.object({ action: z.literal('delete-task'), id: z.uuid() }),
  z.object({ action: z.literal('add-task'), id: z.uuid(), listId, text: taskText }),
  z.object({ action: z.literal('edit-task'), id: z.uuid(), text: taskText.optional(), done: z.boolean().optional() })
    .refine(item => item.text !== undefined || item.done !== undefined, 'Choose a task change.'),
])

export type TodoState = z.infer<typeof snapshot>
export type TodoWorkspace = TodoState & { workspaceToken: string }
export type TodoChange = z.infer<typeof todoChangeSchema>

export function decodeTodos(value: unknown): TodoState {
  if (value === undefined) return { schemaVersion: 1, revision: 0, lists: [{ id: 'inbox', name: 'Inbox' }], tasks: [] }
  return snapshot.parse(value)
}
