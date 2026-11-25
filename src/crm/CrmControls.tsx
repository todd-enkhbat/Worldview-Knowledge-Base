import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { X } from '@phosphor-icons/react'
import { getStore, getWorldGeneration, isRepoReady } from '../data/repo.ts'

export function CrmAvatar({ name, assetId, size = 30 }: { name: string; assetId?: string | null; size?: number }) {
  const [portrait, setPortrait] = useState({ assetId: '', url: '' })
  useEffect(() => {
    if (!assetId || !isRepoReady()) return
    let alive = true, objectUrl = ''; const store = getStore(), generation = getWorldGeneration()
    void store.getBlob(assetId).then((blob) => { if (alive && blob?.type.startsWith('image/') && isRepoReady() && store === getStore() && generation === getWorldGeneration()) { objectUrl = URL.createObjectURL(blob); setPortrait({ assetId, url: objectUrl }) } }).catch(() => {})
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [assetId])
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
  const url = portrait.assetId === assetId ? portrait.url : ''
  const palette = [['#e5ebe4','#405b47'],['#eee4d9','#76553a'],['#e4e8ef','#4f607d'],['#efe2e2','#895856'],['#e9e4ee','#725d84'],['#e6e9df','#65704e']]
  const index = [...name].reduce((hash, part) => (Math.imul(hash, 31) + part.charCodeAt(0)) | 0, 0) >>> 0
  const [background, color] = palette[index % palette.length]
  return <span className="crm-avatar" style={{ width: size, height: size, fontSize: Math.max(10, size * .32), '--crm-avatar-background': background, '--crm-avatar-color': color } as CSSProperties} aria-hidden="true">{url ? <img src={url} alt="" onError={() => setPortrait({ assetId: '', url: '' })} /> : initials || '·'}</span>
}
export function CrmDialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), close = useRef(onClose)
  close.current = onClose
  useEffect(() => { const dialog = ref.current, previous = document.activeElement; dialog?.showModal(); return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() } }, [])
  return <dialog ref={ref} className={`crm-dialog ${wide ? 'is-wide' : ''}`} aria-label={title} onCancel={(event) => { event.preventDefault(); close.current() }} onClick={(event) => { if (event.target === event.currentTarget) close.current() }}><div className="crm-dialog-inner"><header><h2>{title}</h2><button className="crm-icon" aria-label="Close dialog" onClick={onClose}><X size={19} /></button></header>{children}</div></dialog>
}
export function CrmEmpty({ title, children }: { title: string; children?: ReactNode }) { return <div className="crm-empty"><span className="crm-empty-glyph" aria-hidden="true">∴</span><h3>{title}</h3>{children && <p>{children}</p>}</div> }
