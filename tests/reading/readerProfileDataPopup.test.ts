import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'

const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options?: { url?: string }) => { window: { document: Document; close(): void } } }

async function popup(existing = true, queued = false) {
  const page = new JSDOM(readFileSync('extensions/worldview-reader/popup.html', 'utf8')), doc = page.window.document
  let pending = queued
  const retry = vi.fn(async () => ({ ok: true, result: { sourceId: 'later-article', versionId: 'article-version' } }))
  const send = vi.fn(async (message: { type: string }) => {
    if (message.type === 'reader-status') return { paired: true, tracked: {}, folkTracked: {}, pending: [], queued: pending ? 1 : 0 }
    if (message.type === 'reader-retry') { const result = await retry(); pending = false; return result }
    return { ok: true, result: queued ? { queued: true } : { profileDraft: { id: 'capture-ada', profile: { name: 'Ada Example' } }, reviewUrl: 'https://untrusted.example/' } }
  })
  const tabs = { query: vi.fn(async (query: Record<string, unknown>) => query.url ? existing ? [{ id: 8, windowId: 1, url: 'http://127.0.0.1:5173/#/graph' }, { id: 9, windowId: 1, url: 'https://untrusted.example/' }] : [] : [{ id: 7, windowId: 1, url: 'https://www.linkedin.com/in/ada-example/' }]), update: vi.fn(async () => ({})), create: vi.fn(async () => ({})) }
  const chrome = { tabs, runtime: { sendMessage: send } }
  await new Script(`(async () => { ${readFileSync('extensions/worldview-reader/popup.js', 'utf8')}\n})()`).runInContext(createContext({ chrome, document: doc, URL, confirm: () => true }))
  return { page, doc, tabs, send, retry }
}
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)) }

it('opens confirmed capture review in the existing Worldview writer tab rather than creating another app tab', async () => {
  const f = await popup(); const note = f.doc.getElementById('note') as HTMLTextAreaElement; note.value = 'Keep this unfinished comment'
  const button = f.doc.getElementById('profile-data') as HTMLButtonElement; expect(button.disabled).toBe(false); button.click(); await settle()
  expect(f.send).toHaveBeenCalledWith({ type: 'reader-profile-data', tabId: 7, token: '', note: note.value })
  expect(f.tabs.query).toHaveBeenCalledWith({ url: ['http://127.0.0.1:5173/*', 'http://localhost:5173/*'] })
  expect(f.tabs.update).toHaveBeenCalledWith(8, { active: true, url: 'http://127.0.0.1:5173/#/people?capture=capture-ada' }); expect(f.tabs.create).not.toHaveBeenCalled()
  expect(f.doc.getElementById('profile-data-status')!.textContent).toContain('Ada Example source saved locally')
  expect(note.value).toBe('Keep this unfinished comment'); f.page.window.close()
})

it('creates a fixed local review tab only when no Worldview tab exists and never follows a response URL', async () => {
  const f = await popup(false); (f.doc.getElementById('profile-data') as HTMLButtonElement).click(); await settle()
  expect(f.tabs.create).toHaveBeenCalledWith({ url: 'http://127.0.0.1:5173/#/people?capture=capture-ada' }); expect(f.tabs.update).not.toHaveBeenCalled(); f.page.window.close()
})

it('distinguishes a queued source from a saved profile and leaves the browser on the source page', async () => {
  const f = await popup(true, true); (f.doc.getElementById('profile-data') as HTMLButtonElement).click(); await settle()
  expect(f.doc.getElementById('profile-data-status')!.textContent).toContain('not been confirmed'); expect(f.tabs.update).not.toHaveBeenCalled(); expect(f.tabs.create).not.toHaveBeenCalled(); f.page.window.close()
})

it('clears stale profile queued copy when retry delivers a mixed outbox ending in an article receipt', async () => {
  const f = await popup(true, true); (f.doc.getElementById('profile-data') as HTMLButtonElement).click(); await settle()
  expect(f.doc.getElementById('profile-data-status')!.textContent).toContain('not been confirmed')
  ;(f.doc.getElementById('retry') as HTMLButtonElement).click(); await settle()
  expect(f.retry).toHaveBeenCalledOnce(); expect(f.doc.getElementById('queue')!.textContent).toBe('All captures delivered')
  expect(f.doc.getElementById('profile-data-status')!.textContent).toBe('No captures remain queued. Open Collect profiles in People to review saved sources.')
  expect(f.tabs.update).not.toHaveBeenCalled(); expect(f.tabs.create).not.toHaveBeenCalled(); f.page.window.close()
})
