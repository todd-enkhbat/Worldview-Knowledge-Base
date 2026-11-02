import { useEffect, useState } from 'react'
import { useApp } from '../app/store.ts'
import { bootData } from '../app/boot.ts'
import { stopSemantic } from '../ai/semanticIndex.ts'
import { createMemoryStore } from '../data/memoryStore.ts'
import { addAttachment, addNodes, closeRepo, completeFirstRun, createNode, initRepo, link, type NodeDraftInput } from '../data/repo.ts'
import { markOnce } from '../app/timings.ts'
import type { Archetype } from '../domain/types.ts'
import { MS_PER_YEAR } from '../domain/constants.ts'
import WorldPage from '../world/WorldPage.tsx'

// #/sandbox/field: the real world page on a throwaway in-memory world, so the particle field
// can be checked with media no real world has yet: a generated video note, a photo note,
// links between them, and the demo world around them. Nothing here touches the user's world:
// the page's store is swapped for a memory store (no writer lock, no sync, no backups).

/** A few seconds of a moving test pattern, recorded from a canvas. */
async function makeVideo(seconds = 3): Promise<File | null> {
  const types = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4']
  const type = typeof MediaRecorder !== 'undefined' ? types.find((t) => MediaRecorder.isTypeSupported(t)) : undefined
  if (!type) return null
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 180
  const ctx = canvas.getContext('2d')!
  const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: type })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const done = new Promise<void>((r) => (rec.onstop = () => r()))
  rec.start()
  const t0 = performance.now()
  await new Promise<void>((resolve) => {
    const frame = () => {
      const t = (performance.now() - t0) / 1000
      const g = ctx.createLinearGradient(0, 0, 320, 180)
      g.addColorStop(0, `hsl(${(t * 60) % 360}, 70%, 45%)`)
      g.addColorStop(1, `hsl(${(t * 60 + 140) % 360}, 70%, 30%)`)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 320, 180)
      ctx.fillStyle = '#f4e9d0'
      ctx.beginPath()
      ctx.arc(160 + Math.cos(t * 2.4) * 110, 90 + Math.sin(t * 3.1) * 55, 22, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = 'bold 28px monospace'
      ctx.fillText('WAVES', 18, 40)
      // A timer, not requestAnimationFrame: frames are throttled in hidden or background panes.
      if (t < seconds) setTimeout(frame, 33)
      else resolve()
    }
    frame()
  })
  rec.stop()
  await done
  return new File(chunks, `waves.${type.includes('mp4') ? 'mp4' : 'webm'}`, { type: type.split(';')[0] })
}

/** A photo-like test image: a sunset over water. */
async function makeImage(): Promise<File> {
  const c = new OffscreenCanvas(480, 480)
  const ctx = c.getContext('2d')!
  const sky = ctx.createLinearGradient(0, 0, 0, 300)
  sky.addColorStop(0, '#20305a')
  sky.addColorStop(1, '#f2a65a')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, 480, 300)
  ctx.fillStyle = '#ffd27a'
  ctx.beginPath()
  ctx.arc(240, 290, 70, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#123'
  ctx.fillRect(0, 300, 480, 180)
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(255, 200, 120, ${0.15 + Math.random() * 0.3})`
    ctx.fillRect(160 + Math.random() * 160, 310 + i * 4, 30 + Math.random() * 60, 2)
  }
  return new File([await c.convertToBlob({ type: 'image/png' })], 'sunset.png', { type: 'image/png' })
}

async function setup(): Promise<void> {
  // Let the normal boot finish, then swap its store for a throwaway one.
  await bootData()
  // Stop the semantic indexer first: it writes to the real world's vector store, and a sync
  // against this throwaway world would prune the real world's embeddings.
  stopSemantic()
  await closeRepo()
  await initRepo({ store: createMemoryStore() })
  const now = Date.now()
  await completeFirstRun({ T0: now - 30 * MS_PER_YEAR, start: 'demo' })
  const video = await createNode({ archetype: 'memory', title: 'Waves at the pier', temporalOrigin: now - 0.6 * MS_PER_YEAR, temporalPrecision: 'month' }, { announce: false })
  const file = await makeVideo()
  if (file) await addAttachment(video.id, file, file.name)
  const photo = await createNode({ archetype: 'memory', title: 'Sunset over the bay', temporalOrigin: now - 1.4 * MS_PER_YEAR, temporalPrecision: 'month' }, { announce: false })
  await addAttachment(photo.id, await makeImage(), 'sunset.png')
  await link(video.id, photo.id, 'relates')
  const n = Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('n') ?? 0)
  if (n > 0) await addSynthetic(Math.min(n, 5000), now)
  useApp.getState().setView({ world: 'field' })
}

/** `?n=800`: that many synthetic notes, to see how the field holds up at scale. */
async function addSynthetic(n: number, now: number): Promise<void> {
  const kinds: Archetype[] = ['idea', 'idea', 'idea', 'entity', 'lens', 'document', 'memory', 'document']
  const tags = Array.from({ length: 40 }, (_, i) => `topic-${i}`)
  let seed = 12345
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const ids = Array.from({ length: n }, () => crypto.randomUUID())
  const kinds2 = ['supports', 'relates', 'derives', 'influenced-by', 'contradicts'] as const
  const drafts: NodeDraftInput[] = ids.map((id, i) => ({
    id,
    archetype: kinds[Math.floor(rand() * kinds.length)],
    title: `Synthetic note ${i + 1}`,
    contentMd: 'x'.repeat(Math.floor(rand() * 1200)),
    tags: [tags[Math.floor(rand() * tags.length)], ...(rand() < 0.4 ? [tags[Math.floor(rand() * tags.length)]] : [])],
    temporalOrigin: now - rand() * 29 * MS_PER_YEAR,
    temporalPrecision: 'month',
    // About 1.5 links each, to earlier notes, like a world that grew.
    links: i === 0 ? [] : Array.from({ length: Math.floor(rand() * 3.2) }, () => ({ targetId: ids[Math.floor(rand() * i)], kind: kinds2[Math.floor(rand() * kinds2.length)], createdAt: now })),
  }))
  for (const d of drafts) d.links = d.links!.filter((l, k, a) => a.findIndex((x) => x.targetId === l.targetId) === k)
  markOnce('synthetic-start')
  await addNodes(drafts, { announce: false })
  markOnce('synthetic-added')
}

export default function FieldSandbox() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setup()
      .then(() => live && setReady(true))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [])
  if (error) return <p className="p-6 font-mono text-[12px] text-signal">Field sandbox failed: {error}</p>
  if (!ready) return <p className="p-6 font-mono text-[12px] text-concrete">Preparing a throwaway world with a video and a photo…</p>
  return <WorldPage />
}
