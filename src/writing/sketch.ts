// Drawings stay editable in document history and backups. Coordinates use the same
// viewBox at every screen size, including the self-contained export.
export const sketchWidth = 800
export const sketchHeight = 260
export const maxSketchStrokes = 256
export const maxStrokePoints = 1800
export type SketchPoint = [number, number]
export type SketchStroke = { ink: string; width: number; points: SketchPoint[] }
export type SketchData = { title: string; strokes: SketchStroke[] }

export function validWritingSketch(attrs?: Record<string, unknown>): attrs is SketchData {
  if (!attrs || Object.keys(attrs).some(key => key !== 'title' && key !== 'strokes') ||
      typeof attrs.title !== 'string' || attrs.title.length > 240 ||
      !Array.isArray(attrs.strokes) || attrs.strokes.length > maxSketchStrokes) return false
  return attrs.strokes.every(stroke => stroke && typeof stroke === 'object' &&
    Object.keys(stroke).every(key => ['ink', 'width', 'points'].includes(key)) &&
    typeof stroke.ink === 'string' && /^#[0-9a-f]{6}$/i.test(stroke.ink) &&
    [2, 4, 8].includes(stroke.width) && Array.isArray(stroke.points) &&
    stroke.points.length > 0 && stroke.points.length <= maxStrokePoints &&
    stroke.points.every((point: unknown) => Array.isArray(point) && point.length === 2 &&
      Number.isInteger(point[0]) && point[0] >= 0 && point[0] <= sketchWidth &&
      Number.isInteger(point[1]) && point[1] >= 0 && point[1] <= sketchHeight))
}

// The clipboard carries this data as inert JSON. Accept only our coordinate schema.
export function parseSketchData(value: string | null): SketchData | null {
  if (!value || value.length > 4_000_000) return null
  try {
    const attrs = JSON.parse(value)
    return validWritingSketch(attrs) ? attrs : null
  } catch { return null }
}

export function strokePath(points: SketchPoint[]): string {
  if (points.length === 1) return 'M' + points[0].join(' ') + 'l0.01 0'
  return 'M' + points.map(point => point.join(' ')).join(' L')
}
function escapeTitle(s: string) { return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }
export function sketchHTML(attrs?: Record<string, unknown>): string {
  if (!validWritingSketch(attrs)) return ''
  const paths = attrs.strokes.map(s => '<path d="' + strokePath(s.points) + '" stroke="' + s.ink + '" stroke-width="' + s.width + '" />').join('')
  return '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + escapeTitle(attrs.title || 'Freehand sketch') + '" viewBox="0 0 800 260" width="800" style="max-width:100%;height:auto;background:white" fill="none" stroke-linecap="round" stroke-linejoin="round"><title>' + escapeTitle(attrs.title || 'Freehand sketch') + '</title><rect width="800" height="260" fill="white"/>' + paths + '</svg>'
}
export function sketchMarkdown(attrs?: Record<string, unknown>): string { return sketchHTML(attrs) }
