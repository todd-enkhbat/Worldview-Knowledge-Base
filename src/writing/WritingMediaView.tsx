import { useEffect, useRef, useState } from 'react'
import { NodeViewWrapper, useEditorState, type NodeViewProps } from '@tiptap/react'
import { getStore, getWorldGeneration, isRepoReady, subscribeRepo, useRepoStatus } from '../data/repo.ts'
import { parseWritingEmbed, readWritingMedia, WRITING_ASSET_ID, type WritingMediaAttributes } from './media.ts'
import './writingMedia.css'

/** Object URLs belong to one world generation and are revoked on replacement or unmount. */
export function useWritingMediaUrl(assetId: string | null): { url: string | null; error: string } {
  const ready = useRepoStatus((state) => state.ready)
  const [epoch, setEpoch] = useState(0), [result, setResult] = useState<{ id: string; url: string; store: ReturnType<typeof getStore>; generation: number } | null>(null), [error, setError] = useState('')
  useEffect(() => subscribeRepo((change) => { if (change.type === 'wipe' || change.type === 'import') setEpoch((value) => value + 1) }), [])
  useEffect(() => {
    let live = true, url: string | null = null
    setResult(null); setError('')
    if (!assetId || !ready || !isRepoReady()) return
    const store = getStore(), generation = getWorldGeneration()
    void readWritingMedia(assetId, { store, generation }).then(({ blob }) => {
      if (!live || !isRepoReady() || getStore() !== store || getWorldGeneration() !== generation) return
      url = URL.createObjectURL(blob); setResult({ id: assetId, url, store, generation })
    }).catch((failure: unknown) => { if (live) setError(failure instanceof Error ? failure.message : 'The local original could not be opened.') })
    return () => { live = false; if (url) URL.revokeObjectURL(url) }
  }, [assetId, ready, epoch])
  const current = result && result.id === assetId && ready && isRepoReady() && result.store === getStore() && result.generation === getWorldGeneration()
  return { url: current ? result.url : null, error }
}
export const useWritingAssetUrl = useWritingMediaUrl

export function WritingMediaView({ node, selected, updateAttributes, deleteNode, editor }: NodeViewProps) {
  const attributes = node.attrs as Partial<WritingMediaAttributes>
  const validId = typeof attributes.assetId === 'string' && WRITING_ASSET_ID.test(attributes.assetId)
  const { url, error } = useWritingMediaUrl(validId ? attributes.assetId! : null)
  const editable = useEditorState({ editor, selector: ({ editor }) => editor.isEditable }), name = typeof attributes.name === 'string' ? attributes.name : 'Retained media'
  const wrapper = useRef<HTMLDivElement>(null), resize = useRef<{ start: number; width: number; parent: number; value: number } | null>(null)
  const displayWidth = typeof attributes.displayWidth === 'number' && Number.isFinite(attributes.displayWidth) ? Math.max(20, Math.min(100, attributes.displayWidth)) : undefined
  const width = ['normal', 'wide', 'full'].includes(attributes.width ?? '') ? attributes.width : 'normal'
  return <NodeViewWrapper ref={wrapper} style={displayWidth ? { width: `${displayWidth}%` } : undefined} className={`writing-media-block writing-media--${width}${selected ? ' is-selected' : ''}`} contentEditable={false}>
    <figure>
      {url ? attributes.kind === 'image' ? <img src={url} alt={typeof attributes.alt === 'string' ? attributes.alt : ''} draggable={false} loading="lazy" /> : attributes.kind === 'video' ? <video src={url} controls playsInline preload="metadata" aria-label={name} /> : attributes.kind === 'audio' ? <audio src={url} controls preload="metadata" aria-label={name} /> : <p role="alert">Unsupported media block.</p> : <p className="writing-media-placeholder" role={error || !validId ? 'alert' : 'status'}>{!validId ? 'This media block has no valid retained original.' : error || 'Opening the local original…'}</p>}
      {typeof attributes.caption === 'string' && attributes.caption && <figcaption>{attributes.caption}</figcaption>}
    </figure>
    {selected && editable && attributes.kind === 'image' && <button type="button" className="writing-image-resize" aria-label="Resize image" title="Drag to resize. Arrow keys adjust width." onPointerDown={(event) => { if (!wrapper.current) return; event.preventDefault(); event.stopPropagation(); const box = wrapper.current.getBoundingClientRect(), parent = wrapper.current.parentElement?.getBoundingClientRect().width ?? box.width; resize.current = { start: event.clientX, width: box.width, parent, value: displayWidth ?? box.width / parent * 100 }; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={(event) => { const state = resize.current; if (!state || !wrapper.current) return; state.value = Math.round(Math.max(20, Math.min(100, (state.width + (event.clientX - state.start) * 2) / state.parent * 100))); wrapper.current.style.width = `${state.value}%`; event.currentTarget.setAttribute('aria-valuetext', `${state.value} percent`) }} onPointerUp={(event) => { if (!resize.current) return; updateAttributes({ displayWidth: resize.current.value }); resize.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onPointerCancel={() => { resize.current = null; if (wrapper.current) wrapper.current.style.width = displayWidth ? `${displayWidth}%` : '' }} onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const value = event.key === 'Home' ? 20 : event.key === 'End' ? 100 : Math.max(20, Math.min(100, (displayWidth ?? (width === 'normal' ? 72 : width === 'wide' ? 90 : 100)) + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 5 : 1))); updateAttributes({ displayWidth: value }) }}><span aria-hidden="true" /></button>}
    {selected && editable && <div className="writing-media-inspector" aria-label="Media block settings" onPointerDown={(event) => event.stopPropagation()}>
      <span className="writing-media-name">{name}</span>
      {attributes.kind === 'image' && <label>Image description<input value={typeof attributes.alt === 'string' ? attributes.alt : ''} maxLength={2000} onChange={(event) => updateAttributes({ alt: event.target.value })} placeholder="Describe this image for readers" /></label>}
      <label>Caption<input value={typeof attributes.caption === 'string' ? attributes.caption : ''} maxLength={4000} onChange={(event) => updateAttributes({ caption: event.target.value })} /></label>
      <label>Media width<select value={width} onChange={(event) => updateAttributes({ width: event.target.value, displayWidth: null })}><option value="normal">Normal</option><option value="wide">Wide</option><option value="full">Full width</option></select></label>
      {attributes.kind === 'image' && <label>Image width ({Math.round(displayWidth ?? (width === 'normal' ? 72 : width === 'wide' ? 90 : 100))}%)<input type="range" aria-label="Image width" min={20} max={100} step={1} value={displayWidth ?? (width === 'normal' ? 72 : width === 'wide' ? 90 : 100)} onChange={(event) => updateAttributes({ displayWidth: Number(event.target.value) })} /></label>}
      <button type="button" onClick={() => deleteNode()}>Remove from this draft</button>
    </div>}
  </NodeViewWrapper>
}

export function WritingEmbedView({ node, selected, deleteNode, editor }: NodeViewProps) {
  const value = typeof node.attrs.url === 'string' ? node.attrs.url : '', embed = parseWritingEmbed(value)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  useEffect(() => { setLoadedUrl(null) }, [value])
  const editable = useEditorState({ editor, selector: ({ editor }) => editor.isEditable })
  return <NodeViewWrapper className={`writing-embed-block${selected ? ' is-selected' : ''}`} contentEditable={false}>
    {embed ? loadedUrl === embed.embedUrl ? <><iframe src={embed.embedUrl} title={`${embed.provider === 'youtube' ? 'YouTube' : 'Vimeo'} video`} loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen; picture-in-picture" allowFullScreen /><button type="button" onClick={() => setLoadedUrl(null)}>Unload external video</button></> : <div className="writing-embed-consent"><strong>{embed.provider === 'youtube' ? 'YouTube' : 'Vimeo'} video</strong><p>Loading connects to this external video provider.</p><button type="button" onClick={() => setLoadedUrl(embed.embedUrl)}>Load external video</button><a href={embed.url} target="_blank" rel="noreferrer noopener">Open the original video</a></div> : <p role="alert">Use a public HTTPS YouTube or Vimeo video link.</p>}
    {selected && editable && <button type="button" onClick={() => deleteNode()}>Remove video block</button>}
  </NodeViewWrapper>
}
