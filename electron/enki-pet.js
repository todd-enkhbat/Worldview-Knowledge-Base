/* global EnkiModel */
'use strict'
const pet = document.querySelector('#pet')
const canvas = document.querySelector('#enki-model')
const model = EnkiModel.mount(canvas)
const desktop = window.enkiPet
let gesture = null
let suppressClick = false

pet.addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0) return
  suppressClick = false
  gesture = { id: event.pointerId, startX: event.screenX, startY: event.screenY, lastX: event.screenX, turn: event.altKey, moved: false }
  pet.setPointerCapture(event.pointerId)
  if (!gesture.turn) desktop?.drag('start')
})
pet.addEventListener('pointermove', event => {
  if (gesture && gesture.id === event.pointerId) {
    if (!gesture.moved && Math.hypot(event.screenX - gesture.startX, event.screenY - gesture.startY) < 4) return
    gesture.moved = true
    if (gesture.turn) model.turn((event.screenX - gesture.lastX) * 1.5)
    else desktop?.drag('move')
    gesture.lastX = event.screenX
  } else if (!gesture) {
    const bounds = pet.getBoundingClientRect()
    model.look(2 * (event.clientX - bounds.left) / bounds.width - 1, 2 * (event.clientY - bounds.top) / bounds.height - 1)
  }
})
function finishGesture(event) {
  if (gesture?.id !== event.pointerId) return
  suppressClick = gesture.moved || gesture.turn || event.type === 'pointercancel'
  if (!gesture.turn) desktop?.drag('end')
  gesture = null
}
pet.addEventListener('pointerup', finishGesture)
pet.addEventListener('pointercancel', finishGesture)
pet.addEventListener('lostpointercapture', finishGesture)
pet.addEventListener('pointerleave', () => { if (!gesture) model.look(0, 0) })
pet.addEventListener('click', event => {
  if (event.detail && suppressClick) return
  model.greet()
  desktop?.activate()
})
pet.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  model.turn(event.key === 'ArrowLeft' ? -20 : 20)
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') desktop?.hide()
})
document.addEventListener('contextmenu', event => { event.preventDefault(); desktop?.menu() })
document.querySelector('#options').addEventListener('click', () => desktop?.menu())
document.addEventListener('visibilitychange', () => model.setActive(!document.hidden))
desktop?.onOrient(command => command === 'reset' ? model.reset() : model.turn(command === 'left' ? -35 : 35))
desktop?.onCelebrate(() => model.celebrate())
window.addEventListener('pagehide', () => model.dispose(), { once: true })
