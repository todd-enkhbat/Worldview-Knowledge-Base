import { useEffect, useState } from 'react'
import { EnkiPerson, type ProfileBridge } from './EnkiPerson'
import { StudyDesk, type StudyNative } from './StudyDesk'

export interface DiaPage {
  title: string; url: string; description: string; selection: string
  kind: 'person' | 'application' | 'article'
}
export type PageBridge = ProfileBridge & StudyNative & {
  page: () => Promise<DiaPage>
  savePage: () => Promise<{ queued?: boolean; sourceId?: string }>
}

export function EnkiPage({ bridge }: { bridge?: PageBridge }) {
  const [page, setPage] = useState<DiaPage | null>(null)
  const [tool, setTool] = useState<DiaPage['kind']>('article')
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState('')
  useEffect(() => {
    let active = true
    setLoading(true); setPage(null); setError(''); setReceipt('')
    if (!bridge?.page) { setError('Open the latest Worldview for Mac and connect Enki in Worldview Reader in Dia.'); setLoading(false); return }
    void bridge.page().then(value => {
      if (active) { setPage(value); setTool(value.kind) }
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Dia could not read this page. Try again.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [bridge, refresh])
  async function save() {
    if (!bridge || saving) return
    setSaving(true); setError(''); setReceipt('')
    try {
      const result = await bridge.savePage()
      if (!result.queued && !result.sourceId) throw Error('The save was not confirmed. Try again.')
      setReceipt(result.queued ? 'Page queued in Reader. It will be delivered when Worldview is available.' : 'Saved to your library.')
    } catch (e) { setError(e instanceof Error ? e.message : 'The page could not be saved. Try again.') }
    finally { setSaving(false) }
  }
  return <section className="enki-dia-page" aria-label="Current Dia page" aria-busy={loading}>
    {loading && <p className="enki-help-status" role="status">Reading your Dia page…</p>}
    {page && <>
      <div className="enki-page-source"><span title={page.url}>{new URL(page.url).hostname}</span>
        <button className="enki-text-action" disabled={saving} onClick={() => setRefresh(value => value + 1)}>Refresh page</button></div>
      {tool === 'article' && <><h1>{page.title}</h1>{page.description && <p>{page.description}</p>}
        {page.selection && <blockquote>{page.selection}</blockquote>}</>}
      <details className="enki-page-actions"><summary>Page actions</summary>
        <button className={tool === 'article' ? 'enki-primary' : 'enki-text-action'} disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save page'}</button>
        <button className="enki-text-action" aria-pressed={tool === 'person'} disabled={saving} onClick={() => setTool('person')}>CRM</button>
        <button className="enki-text-action" aria-pressed={tool === 'application'} disabled={saving} onClick={() => setTool('application')}>Application</button>
      </details>
      {tool === 'person' && <EnkiPerson key={refresh} bridge={bridge} autoRead browserConnected />}
      {tool === 'application' && <StudyDesk key={refresh} mode="application" native={bridge && { ...bridge, activeTab: true }} helper />}
    </>}
    {receipt && <p role="status" className="enki-help-status">{receipt}</p>}
    {error && <div className="enki-page-error"><p role="alert" className="enki-help-error">{error}</p>
      <button className="enki-primary" disabled={loading || saving} onClick={() => setRefresh(value => value + 1)}>Try again</button></div>}
  </section>
}
