import { useEffect, useState } from 'react'
import { Minus, Plus } from '@phosphor-icons/react'

export function CrmTableZoom() {
  const zoomPage = window.worldviewDesktop?.pageZoom
  const [percent, setPercent] = useState(100)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!zoomPage) return
    let active = true
    const sync = () => { void zoomPage('read').then(value => { if (active) setPercent(value) }).catch(() => {}) }
    sync()
    window.addEventListener('resize', sync)
    return () => { active = false; window.removeEventListener('resize', sync) }
  }, [zoomPage])
  if (!zoomPage) return null

  async function act(direction: 'in' | 'out' | 'reset') {
    if (!zoomPage) return
    setPending(true)
    setError('')
    try { setPercent(await zoomPage(direction)) }
    catch { setError('Couldn’t change the zoom. Try again.') }
    finally { setPending(false) }
  }

  return <div className="crm-table-zoom" role="group" aria-label="Window zoom">
    <button type="button" className="crm-icon" aria-label="Zoom out" title="Zoom out (⌘−)" disabled={pending || percent <= 48} onClick={() => void act('out')}><Minus size={14} aria-hidden="true" /></button>
    <button type="button" className="crm-zoom-value" aria-label={`Reset zoom to 100%. Current zoom ${percent}%`} title="Actual size (⌘0)" disabled={pending} onClick={() => void act('reset')}>{percent}%</button>
    <button type="button" className="crm-icon" aria-label="Zoom in" title="Zoom in (⌘+)" disabled={pending || percent >= 207} onClick={() => void act('in')}><Plus size={14} aria-hidden="true" /></button>
    {error && <span role="status">{error}</span>}
  </div>
}
