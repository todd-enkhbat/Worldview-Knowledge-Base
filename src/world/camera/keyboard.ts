import { useEffect } from 'react'
import { canTransition, useApp } from '../../app/store.ts'

// Global camera keys. Listeners sit on window in the bubble phase so HUD widgets can claim a
// key first with preventDefault (we then ignore it).
//   Esc → useApp.escape() (palette/modal → first-person exit → deselect)
//   F   → toggle first person      T → toggle third person      O → orbit

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** True while the user is typing somewhere on the page (focus in a text field). */
export function isTyping(): boolean {
  return typeof document !== 'undefined' && isEditableTarget(document.activeElement)
}

/** Leave first person for the mode it was entered from (orbit or third person). */
export function exitFirstPerson(): void {
  const app = useApp.getState()
  if (app.mode !== 'first_person') return
  const back = app.prevMode === 'third_person' && canTransition('first_person', 'third_person') ? 'third_person' : 'orbit'
  app.setMode(back)
}

export function useCameraKeys(thirdPersonAvailable: boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const app = useApp.getState()
      switch (e.code) {
        case 'Escape':
          app.escape()
          break
        case 'KeyF':
          if (e.repeat) return
          if (app.mode === 'first_person') exitFirstPerson()
          else app.setMode('first_person')
          break
        case 'KeyT':
          if (e.repeat) return
          if (app.mode === 'third_person') app.setMode('orbit')
          else if (thirdPersonAvailable) app.setMode('third_person')
          break
        case 'KeyO':
          if (e.repeat) return
          app.setMode('orbit')
          break
        default:
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [thirdPersonAvailable])
}
