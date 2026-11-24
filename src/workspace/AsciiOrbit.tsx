import { useEffect, useRef } from 'react'

/** A quiet, bounded character orbit. No canvas, network, or animation dependency. */
export function AsciiOrbit() {
  const frame = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const element = frame.current
    if (!element) return
    if (typeof matchMedia !== 'function' || typeof IntersectionObserver !== 'function') return
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    let visible = true, timer: ReturnType<typeof setInterval> | undefined, phase = 0
    function draw() {
      const rows = Array.from({ length: 7 }, () => Array<string>(27).fill(' '))
      for (let i = 0; i < 54; i++) {
        const angle = i / 54 * Math.PI * 2 + phase
        const x = Math.round(13 + Math.cos(angle) * 11), y = Math.round(3 + Math.sin(angle) * 2 + Math.cos(angle) * .6)
        rows[y]![x] = i % 9 === 0 ? '·' : '.'
      }
      rows[3]![13] = '✦'
      rows[Math.round(3 + Math.sin(phase) * 2)]![Math.round(13 + Math.cos(phase) * 11)] = '*'
      element!.textContent = rows.map((row) => row.join('')).join('\n')
      phase += .07
      if (phase >= 1.96) clearInterval(timer)
    }
    function sync() {
      clearInterval(timer)
      if (visible && !document.hidden && !motion.matches && phase < 1.96) timer = setInterval(draw, 140)
    }
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync() })
    observer.observe(element); draw(); sync()
    motion.addEventListener('change', sync); document.addEventListener('visibilitychange', sync)
    return () => { clearInterval(timer); observer.disconnect(); motion.removeEventListener('change', sync); document.removeEventListener('visibilitychange', sync) }
  }, [])
  return <pre ref={frame} className="worldview-ascii-orbit" aria-hidden="true" />
}
