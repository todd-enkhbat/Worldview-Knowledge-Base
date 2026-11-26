import { useEffect, useState } from 'react'
import { readBookshelfOriginal } from './media'
export function useCover(id: string) {
  const [url, set] = useState('')
  useEffect(() => {
    let active = true,
      href = ''
    void readBookshelfOriginal(id)
      .then((file) => {
        if (active) {
          href = URL.createObjectURL(file.blob)
          set(href)
        }
      })
      .catch(() => {})
    return () => {
      active = false
      if (href) URL.revokeObjectURL(href)
    }
  }, [id])
  return url
}
