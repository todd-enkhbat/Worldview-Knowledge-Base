import { createRoot, type Root } from 'react-dom/client'
import { EnkiTodos, type TodoRequest } from './EnkiTodos.tsx'
import type { TodoWorkspace } from '../data/todos.ts'

declare const chrome: {runtime:{ sendMessage(message:unknown):Promise<{ok:boolean;state:TodoWorkspace;error?:string;status?:number}> }}
const roots = new WeakMap<HTMLElement, Root>()
const requestTodos: TodoRequest = async body => {
  const response = await chrome.runtime.sendMessage({type:body ? 'todos-mutate' : 'todos-state', ...(body ? {body} : {})})
  if (!response?.ok) throw Object.assign(new Error(response?.error || 'Open Worldview and reconnect your reader.'),{status:response?.status})
  return response.state
}
export function mountTodos(container: HTMLElement) {
  let root = roots.get(container)
  if (!root) { root = createRoot(container); roots.set(container,root); root.render(<EnkiTodos requestTodos={requestTodos} />) }
  else {
    window.dispatchEvent(new Event('worldview:todos-refresh'))
    container.querySelector<HTMLElement>('.enki-delete-actions button, textarea[name="editedTask"], input[name="listName"], textarea[name="task"]')?.focus()
  }
}
