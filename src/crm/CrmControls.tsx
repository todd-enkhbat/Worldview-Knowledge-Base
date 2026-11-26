import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { X } from '@phosphor-icons/react'
import { getStore, getWorldGeneration, isRepoReady, useRepoStatus } from '../data/repo.ts'

const portraitPalette = [['#e5ebe4','#405b47'],['#eee4d9','#76553a'],['#e4e8ef','#4f607d'],['#efe2e2','#895856'],['#e9e4ee','#725d84'],['#e6e9df','#65704e']]
const raster = new Set(['image/png','image/jpeg','image/webp','image/gif','image/avif'])
export function CrmAvatar({ name, assetId, size = 30, organization = false }: { name: string; assetId?: string | null; size?: number; organization?:boolean }) {
  const ready = useRepoStatus(s=>s.ready)
  const store = assetId && isRepoReady() ? getStore() : null, generation = getWorldGeneration()
  const [portrait, setPortrait] = useState<{assetId:string; url:string; store:typeof store; generation:number} | null>(null)
  useEffect(() => {
    if (!assetId || !store) return
    let alive = true, objectUrl = ''
    void (async () => {
      const blob = await store.getBlob(assetId)
      if (!blob) return
      const mime = blob.type && blob.type !== 'application/octet-stream' ? blob.type : (await store.getAssetMeta(assetId))?.mime
      if (!alive || !mime || !raster.has(mime) || !isRepoReady() || store !== getStore() || generation !== getWorldGeneration()) return
      objectUrl = URL.createObjectURL(mime === blob.type ? blob : blob.slice(0,blob.size,mime))
      setPortrait({assetId,url:objectUrl,store,generation})
    })().catch(()=>{})
    return () => { alive=false; if(objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [assetId,store,generation,ready])
  const parts = name.trim().split(/\s+/u).filter(Boolean)
  const initials = [parts[0], parts.length > 1 ? parts.at(-1) : ''].map(part=>Array.from(part || '')[0] || '').join('').toLocaleUpperCase()
  const index = [...name].reduce((hash, part) => (Math.imul(hash, 31) + part.charCodeAt(0)) | 0, 0) >>> 0
  const [background, color] = portraitPalette[index % portraitPalette.length]
  const url = portrait && portrait.assetId === assetId && portrait.store === store && portrait.generation === generation ? portrait.url : ''
  return <span className={'crm-avatar' + (organization ? ' is-organization' : '')} style={{width:size,height:size,fontSize:Math.max(10,size*.32),'--crm-avatar-background':background,'--crm-avatar-color':color} as CSSProperties} aria-hidden="true">{url ? <img src={url} alt="" onError={()=>setPortrait(null)} /> : initials || '·'}</span>
}
export function CrmDialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), close = useRef(onClose)
  close.current = onClose
  useEffect(() => { const dialog = ref.current, previous = document.activeElement; dialog?.showModal(); return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() } }, [])
  return <dialog ref={ref} className={`crm-dialog ${wide ? 'is-wide' : ''}`} aria-label={title} onCancel={(event) => { event.preventDefault(); close.current() }} onClick={(event) => { if (event.target === event.currentTarget) close.current() }}><div className="crm-dialog-inner"><header><h2>{title}</h2><button className="crm-icon" aria-label="Close dialog" onClick={onClose}><X size={19} /></button></header>{children}</div></dialog>
}
export function CrmEmpty({ title, children }: { title: string; children?: ReactNode }) { return <div className="crm-empty"><span className="crm-empty-glyph" aria-hidden="true">∴</span><h3>{title}</h3>{children && <p>{children}</p>}</div> }
