import { useEffect, useState } from 'react'

export type Appearance = 'system' | 'dark' | 'light'
const KEY = 'worldview.appearance.v1'
function preference(): Appearance {
  try { const value = localStorage.getItem(KEY); return value === 'dark' || value === 'light' ? value : 'system' } catch { return 'system' }
}
export function initialWorkspaceTheme(): 'light' | 'dark' {
  const value = preference()
  return value === 'system' ? typeof matchMedia === 'function' && !matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark' : value
}

/** Device presentation stays separate from the world and never changes its renderer. */
export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(preference)
  const [systemDark, setSystemDark] = useState(() => typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : true)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const media = matchMedia('(prefers-color-scheme: dark)'), update = () => setSystemDark(media.matches)
    media.addEventListener('change', update)
    const stored = (event: StorageEvent) => { if (event.key === KEY) setAppearance(preference()) }
    window.addEventListener('storage', stored)
    return () => { media.removeEventListener('change', update); window.removeEventListener('storage', stored) }
  }, [])
  const theme = appearance === 'system' ? systemDark ? 'dark' : 'light' : appearance
  useEffect(() => { document.body.dataset.workspaceTheme = theme; return () => { delete document.body.dataset.workspaceTheme } }, [theme])
  const change = (value: Appearance) => { setAppearance(value); try { localStorage.setItem(KEY, value) } catch { /* Presentation still works without storage. */ } }
  return { appearance, theme, setAppearance: change }
}

export function useCompactViewport() {
  const [compact, setCompact] = useState(() => typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const media = matchMedia('(max-width: 760px)'), update = () => setCompact(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return compact
}
