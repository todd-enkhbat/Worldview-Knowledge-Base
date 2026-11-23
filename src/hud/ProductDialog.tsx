import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { trapKeys } from './DurabilityKit.tsx'
import './ProductDialog.css'

/** Product panels share keyboard trapping and restore focus to their opening control. */
export function ProductDialog({ title, description, onClose, children }: {
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.focus()
    return () => { if (opener?.isConnected) opener.focus() }
  }, [])
  return createPortal(
    <div className="product-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className="product-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined} tabIndex={-1}
        onKeyDown={(e) => trapKeys(e, ref.current, onClose)}>
        <header className="product-modal-header">
          <div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
          <button type="button" className="product-modal-close" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}>×</button>
        </header>
        <div className="product-modal-body">{children}</div>
      </div>
    </div>, document.body,
  )
}
