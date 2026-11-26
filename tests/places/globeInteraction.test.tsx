// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AtlasGlobe } from '../../src/places/AtlasGlobe.tsx'
import type { AtlasGroup } from '../../src/places/atlas.ts'

vi.mock('../../src/places/GlobeSurface.tsx', () => ({ GlobeSurface: () => null }))

it('opens the pressed marker once when the globe captures the release, and treats a drag as rotation', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches:true }))
  const host = document.createElement('div'), root = createRoot(host)
  const select = vi.fn(), openMap = vi.fn()
  const london: AtlasGroup = {id:'london', title:'London', latitude:51.5, longitude:-.12, entries:[]}
  try {
    act(() => root.render(<AtlasGlobe groups={[london]} active="" focus={null} switcher={null} select={select} openMap={openMap}/>))
    const scene = host.querySelector<HTMLElement>('.atlas-globe-scene')!
    const marker = scene.querySelector('button')!
    scene.setPointerCapture = vi.fn()
    scene.hasPointerCapture = () => true
    const point = (target:Element,type:string,x:number) => act(() => {
      const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:180})
      Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event)
    })
    point(marker,'pointerdown',360);point(scene,'pointerup',360)
    expect(select).toHaveBeenCalledExactlyOnceWith([london])
    expect(openMap).not.toHaveBeenCalled()
    point(marker,'pointerdown',360);point(scene,'pointermove',395);point(scene,'pointerup',395)
    expect(select).toHaveBeenCalledTimes(1)
    point(scene,'pointerdown',360);point(scene,'pointerup',360)
    expect(openMap).toHaveBeenCalledTimes(1)
    act(()=>marker.click())
    expect(select).toHaveBeenCalledTimes(2)
  } finally { act(()=>root.unmount());vi.unstubAllGlobals() }
})

it('returns from a focused Leaflet map to the globe without calling into a removed map', async () => {
  const {AtlasMap} = await import('../../src/places/AtlasMap.tsx')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.stubGlobal('ResizeObserver',class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia',()=>({matches:true}))
  const host=document.createElement('div'),root=createRoot(host)
  document.body.append(host)
  const location:AtlasGroup={id:'location',title:'Location',latitude:51.5,longitude:-.12,entries:[]}
  try {
    act(()=>root.render(<AtlasMap groups={[location]} active="" select={()=>{}} focus={location} expanded={false} onExpand={()=>{}}/>))
    expect(host.querySelector('.leaflet-container')).not.toBeNull()
    const toggle=[...host.querySelectorAll('button')].find(button=>button.textContent==='Globe')!
    act(()=>toggle.click())
    expect(host.querySelector('.atlas-globe-scene')).not.toBeNull()
    expect(host.querySelector('.leaflet-container')).toBeNull()
  } finally {act(()=>root.unmount());host.remove();vi.unstubAllGlobals()}
})
