// @vitest-environment jsdom
import { popupScript } from './popupRuntime.ts'
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => document.body.replaceChildren())
async function popup() {
  document.body.innerHTML = readFileSync('extensions/worldview-reader/popup.html', 'utf8')
  let release: (value: unknown) => void = () => {}
  const sendMessage = vi.fn(async (message: { type: string }) => message.type === 'reader-status' ? { paired: true, extensionId: 'a'.repeat(32), queued: 0, tracked: {} } : new Promise((resolve) => { release = resolve }))
  const chrome = { tabs: { query: async () => [{ id: 7 }] }, runtime: { sendMessage } }
  await new Script(`(async () => { ${popupScript()}\n})()`).runInContext(createContext({ chrome, document, confirm: () => true }))
  return { complete: (value: unknown) => release(value), note: document.getElementById('note') as HTMLTextAreaElement, save: document.getElementById('highlight') as HTMLButtonElement }
}

it('retains a newer popup comment typed while its previous highlight save is pending', async () => {
  const p = await popup(); p.note.value = 'First personal comment.'; p.save.click()
  p.note.value = 'A newer thought typed while waiting.'
  p.complete({ ok: true, result: { sourceId: 'source', highlightId: 'highlight' } })
  await vi.waitFor(() => expect(document.getElementById('notice')?.textContent).toContain('Selected passage and comment saved'))
  expect(p.note.value).toBe('A newer thought typed while waiting.')
})

it('keeps the popup comment editable until an offline queued capture is confirmed by the local workspace', async () => {
  const p = await popup(); p.note.value = 'Keep this exact comment if delivery fails.'; p.save.click()
  p.complete({ ok: true, result: { queued: true } })
  await vi.waitFor(() => expect(document.getElementById('notice')?.textContent).toContain('Queued on this browser'))
  expect(p.note.value).toBe('Keep this exact comment if delivery fails.')
})
