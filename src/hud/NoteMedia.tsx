import { useState } from 'react'
import type { Attachment, Embed } from '../domain/types.ts'
import { youtubeId } from '../ai/chat/apply.ts'
import { formatBytes } from '../ai/chat/preview.ts'
import { useStoredBlobUrl } from './fields/SceneField.tsx'

// What a note holds beyond its text, in the Inspector: originals of any type (played, shown or
// opened in place) and live embeds (a YouTube video, a page, a place on the map). Heavy or
// third-party content loads only when asked, so opening a note never streams a video or
// contacts YouTube or a map server by itself.

const label = (a: Attachment) => {
  const m = a.mime
  if (m === 'application/pdf') return 'PDF'
  if (m.startsWith('video/')) return 'Video'
  if (m.startsWith('audio/')) return 'Audio'
  if (m === 'text/vcard') return 'Contacts'
  if (m === 'text/calendar') return 'Calendar'
  if (m.includes('csv') || m.includes('tab-separated')) return 'Sheet'
  if (m.startsWith('text/') || a.kind === 'text') return 'Text'
  if (m.includes('zip') || m.includes('x-tar') || m.includes('7z') || m.includes('gzip')) return 'Archive'
  if (m.includes('sqlite') || m.includes('parquet')) return 'Database'
  if (m.includes('spreadsheet') || m.includes('csv') || m.includes('numbers')) return 'Sheet'
  if (m.includes('word') || m.includes('pages') || m.includes('epub')) return 'Document'
  if (m.includes('presentation') || m.includes('keynote')) return 'Slides'
  return 'File'
}

const inline = (a: Attachment) => a.mime === 'application/pdf' || a.mime.startsWith('video/') || a.mime.startsWith('audio/')

function FileBody({ attachment }: { attachment: Attachment }) {
  const url = useStoredBlobUrl(attachment.blobId)
  if (!url) return <p className="m-0 py-2 text-[11px] text-concrete">Loading…</p>
  const m = attachment.mime
  if (m.startsWith('video/')) return <video src={url} controls playsInline className="mt-1 max-h-72 w-full bg-black" />
  if (m.startsWith('audio/')) return <audio src={url} controls className="mt-1 w-full" />
  if (m === 'application/pdf') return <iframe src={url} title={attachment.name} className="mt-1 h-80 w-full border border-bone/15 bg-white" />
  return null
}

function FileActions({ attachment }: { attachment: Attachment }) {
  const url = useStoredBlobUrl(attachment.blobId)
  if (!url) return null
  return (
    <>
      <a href={url} target="_blank" rel="noopener" className="hud-btn px-1.5 py-0">
        Open
      </a>
      <a href={url} download={attachment.name} className="hud-btn px-1.5 py-0">
        Save
      </a>
    </>
  )
}

/** One original that is not an image: its kind, name and size; play, view, open or save it. */
export function FileRow({ attachment }: { attachment: Attachment }) {
  const [shown, setShown] = useState(false)
  const [actions, setActions] = useState(false)
  return (
    <li className="border border-bone/15 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="hud-label w-16 shrink-0">{label(attachment)}</span>
        <span className="min-w-0 flex-1 truncate text-[12px]" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="shrink-0 text-[10px] text-concrete">{formatBytes(attachment.bytes)}</span>
      </div>
      <div className="mt-1 flex gap-1">
        {inline(attachment) && (
          <button type="button" className="hud-btn px-1.5 py-0" onClick={() => setShown((s) => !s)}>
            {shown ? 'Hide' : attachment.mime.startsWith('video/') || attachment.mime.startsWith('audio/') ? 'Play' : 'View'}
          </button>
        )}
        {actions ? (
          <FileActions attachment={attachment} />
        ) : (
          <button type="button" className="hud-btn px-1.5 py-0" onClick={() => setActions(true)}>
            Open…
          </button>
        )}
      </div>
      {shown && <FileBody attachment={attachment} />}
    </li>
  )
}

// ─── embeds ──────────────────────────────────────────────────────────────────────────

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function mapsQuery(e: Embed): string {
  const p = e.place
  if (!p) return e.title ?? ''
  return p.lat !== undefined && p.lng !== undefined && !p.address ? `${p.lat},${p.lng}` : [p.name, p.address].filter(Boolean).join(', ')
}

function osmEmbed(lat: number, lng: number): string {
  const d = 0.008
  const bbox = [lng - d * 1.6, lat - d, lng + d * 1.6, lat + d].map((x) => x.toFixed(5)).join(',')
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(5)},${lng.toFixed(5)}`
}

function EmbedRow({ embed }: { embed: Embed }) {
  const [live, setLive] = useState(false)
  if (embed.kind === 'youtube' && embed.url) {
    const id = youtubeId(embed.url)
    return (
      <li className="border border-bone/15 px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className="hud-label w-16 shrink-0">Video</span>
          <span className="min-w-0 flex-1 truncate text-[12px]">{embed.title ?? 'YouTube video'}</span>
        </div>
        <div className="mt-1 flex gap-1">
          {id && (
            <button type="button" className="hud-btn px-1.5 py-0" onClick={() => setLive((s) => !s)}>
              {live ? 'Hide' : 'Play'}
            </button>
          )}
          <a href={embed.url} target="_blank" rel="noopener noreferrer" className="hud-btn px-1.5 py-0">
            YouTube
          </a>
        </div>
        {live && id && (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1`}
            title={embed.title ?? 'YouTube video'}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            className="mt-1 aspect-video w-full border-0 bg-black"
          />
        )}
      </li>
    )
  }
  if (embed.kind === 'place') {
    const p = embed.place
    const q = encodeURIComponent(mapsQuery(embed))
    const coords = p?.lat !== undefined && p?.lng !== undefined
    return (
      <li className="border border-bone/15 px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className="hud-label w-16 shrink-0">Place</span>
          <span className="min-w-0 flex-1 text-[12px]">
            {p?.name ?? embed.title ?? 'Place'}
            {p?.address && <span className="block truncate text-[11px] text-concrete">{p.address}</span>}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {coords && (
            <button type="button" className="hud-btn px-1.5 py-0" onClick={() => setLive((s) => !s)}>
              {live ? 'Hide map' : 'Map'}
            </button>
          )}
          <a href={`https://maps.apple.com/?q=${q}`} target="_blank" rel="noopener noreferrer" className="hud-btn px-1.5 py-0">
            Apple Maps
          </a>
          <a href={`https://www.google.com/maps/search/?api=1&query=${q}`} target="_blank" rel="noopener noreferrer" className="hud-btn px-1.5 py-0">
            Google Maps
          </a>
        </div>
        {live && coords && <iframe src={osmEmbed(p!.lat!, p!.lng!)} title={`Map of ${p!.name}`} className="mt-1 h-56 w-full border border-bone/15" />}
      </li>
    )
  }
  return (
    <li className="border border-bone/15 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="hud-label w-16 shrink-0">Page</span>
        <span className="min-w-0 flex-1 truncate text-[12px]">{embed.title ?? (embed.url ? host(embed.url) : 'Page')}</span>
      </div>
      {embed.url && (
        <div className="mt-1 flex items-center gap-2">
          <a href={embed.url} target="_blank" rel="noopener noreferrer" className="hud-btn px-1.5 py-0">
            Open
          </a>
          <span className="truncate text-[10px] text-concrete">{host(embed.url)}</span>
        </div>
      )}
    </li>
  )
}

export function EmbedsSection({ embeds }: { embeds: Embed[] }) {
  return (
    <section aria-labelledby="hud-inspector-embeds" className="mb-5">
      <h3 id="hud-inspector-embeds" className="hud-label m-0 mb-2">
        Linked
      </h3>
      <ul className="m-0 list-none space-y-1.5 p-0">
        {embeds.map((e) => (
          <EmbedRow key={e.id} embed={e} />
        ))}
      </ul>
    </section>
  )
}
