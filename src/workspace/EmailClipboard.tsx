import { useEffect, useState } from 'react'
import { Check, Copy } from '@phosphor-icons/react'

type Receipt = { address: string; copied: boolean }
const receiptEvent = 'worldview:email-copy'

function copyWithSelection(address: string) {
  const previous = document.activeElement
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []
  const field = document.createElement('textarea')
  field.value = address
  field.readOnly = true
  field.style.cssText = 'position:fixed;inset:0 auto auto -10000px'
  document.body.append(field)
  try {
    field.select()
    return document.execCommand('copy')
  } finally {
    field.remove()
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true })
    if (selection && ranges.length) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}

export async function copyEmail(address: string) {
  let copied = false
  try {
    await navigator.clipboard.writeText(address)
    copied = true
  } catch {
    try { copied = copyWithSelection(address) } catch { /* The receipt offers manual copying. */ }
  }
  window.dispatchEvent(new CustomEvent<Receipt>(receiptEvent, { detail: { address, copied } }))
}

export function CopyEmailButton({ address, showAddress = false }: { address: string; showAddress?: boolean }) {
  return <button type="button" className="copy-email-button" title={'Copy ' + address}
    aria-label={'Copy email address ' + address} onClick={event => { event.stopPropagation(); void copyEmail(address) }}>
    <Copy size={14} aria-hidden="true" /><span>{showAddress ? address : 'Copy email'}</span>
  </button>
}

/** Imported and authored rich text can contain its own mailto links. */
export function EmailClipboard() {
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  useEffect(() => {
    const receive = (event: Event) => setReceipt((event as CustomEvent<Receipt>).detail)
    const activate = (event: MouseEvent | KeyboardEvent) => {
      if (!(event.target instanceof Element)) return
      if (event instanceof KeyboardEvent && (event.key !== 'Enter' || event.isComposing || event.repeat)) return
      if (event instanceof MouseEvent && event.type === 'auxclick' && event.button !== 1) return
      const link = event.target.closest('a[href^="mailto:" i]')
      if (!link) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const [recipient, query] = link.getAttribute('href')!.slice(7).split('?')
      let address = recipient
      try { address = decodeURIComponent(recipient) } catch { /* Keep the author's literal address. */ }
      const additional = new URLSearchParams(query).getAll('to')
      const addresses = [address, ...additional].map(value => value.trim()).filter(Boolean)
      if (addresses.length) void copyEmail(addresses.join(', '))
    }
    window.addEventListener(receiptEvent, receive)
    document.addEventListener('click', activate, true)
    document.addEventListener('auxclick', activate, true)
    // Rich text editors can handle Enter on the link before Chrome generates click.
    document.addEventListener('keydown', activate, true)
    return () => {
      window.removeEventListener(receiptEvent, receive)
      document.removeEventListener('click', activate, true)
      document.removeEventListener('auxclick', activate, true)
      document.removeEventListener('keydown', activate, true)
    }
  }, [])
  useEffect(() => {
    if (!receipt?.copied) return
    const timer = window.setTimeout(() => setReceipt(null), 2400)
    return () => window.clearTimeout(timer)
  }, [receipt])
  return <div className="email-copy-feedback" role="status" aria-live="polite">{receipt &&
    (receipt.copied ? <><Check size={15} aria-hidden="true" />Email address copied</> :
      <><label>Copy this address<input readOnly value={receipt.address} onFocus={event => event.target.select()} /></label>
        <button type="button" onClick={() => setReceipt(null)}>Dismiss</button></>)}</div>
}
