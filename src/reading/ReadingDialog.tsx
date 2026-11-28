import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from '@phosphor-icons/react'

export function ReadingDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const element = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = element.current!
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (dialog.showModal) dialog.showModal()
    else dialog.setAttribute('open', '')
    const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? dialog.querySelector<HTMLElement>('form input, form textarea') ?? dialog.querySelector<HTMLElement>('button')
    initial?.focus()
    return () => { dialog.close?.(); if (opener?.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={element} className="reading-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose() }} onClick={(event) => { if (event.target === element.current) { const rect = element.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose() } }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" aria-label="Close dialog" className="knowledge-icon-button" onClick={onClose}><X size={20} /></button></header>
    {children}
  </dialog>
}
