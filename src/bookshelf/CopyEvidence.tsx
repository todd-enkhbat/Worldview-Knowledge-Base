import { useState } from 'react'
import type { BookPatch, ShelfBook } from './types'
import { useCover } from './copyPhoto'

type Evidence = {
  title: string
  author: string
  publisher: string
  year: number | null
  binding: string
  url: string
  excerpt: string
}
export function CopyEvidence({
  book,
  apply,
  photo,
  disabled
}: {
  book: ShelfBook
  apply: (patch: BookPatch) => void
  photo: (file: File) => Promise<void>
  disabled: boolean
}) {
  const [url, setUrl] = useState(''),
    [preview, setPreview] = useState<Evidence | null>(null),
    [status, setStatus] = useState(''),
    [loading, setLoading] = useState(false)
  return (
    <details className="copy-evidence">
      <summary>Identify my copy from a link or photograph</summary>
      <label>
        Publisher or bookseller link
        <input
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setPreview(null)
          }}
          placeholder="https://…"
        />
      </label>
      <button
        type="button"
        disabled={disabled || loading || !url.trim()}
        onClick={async () => {
          setLoading(true)
          try {
            const r = await fetch('/api/book-catalog/evidence', {
              method: 'POST',
              headers: { 'x-wv-client': 'bookshelf', 'content-type': 'application/json' },
              body: JSON.stringify({ url })
            })
            const value = await r.json()
            if (!r.ok) throw Error(value.error)
            setPreview(value)
            setStatus('Check the details against your copy.')
          } catch (e) {
            setStatus((e as Error).message)
          } finally {
            setLoading(false)
          }
        }}
      >
        {loading ? 'Reading listing…' : 'Preview listing'}
      </button>
      {preview && (
        <>
          <blockquote>{preview.excerpt}</blockquote>
          {(['title', 'author', 'publisher', 'binding'] as const).map((k) => (
            <label key={k}>
              {k}
              <input value={preview[k]} onChange={(e) => setPreview({ ...preview, [k]: e.target.value })} />
            </label>
          ))}
          <label>
            Year
            <input
              type="number"
              value={preview.year ?? ''}
              onChange={(e) => setPreview({ ...preview, year: e.target.value ? Number(e.target.value) : null })}
            />
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              const field = (label: string, value: string) => ({ id: crypto.randomUUID(), label, value })
              apply({
                catalog: undefined,
                title: preview.title || book.title,
                authors: preview.author ? [preview.author] : book.authors,
                url: preview.url,
                year: preview.year,
                fields: [
                  ...book.fields,
                  ...[
                    field('Publisher', preview.publisher),
                    field('Binding', preview.binding),
                    field('Edition evidence', preview.url + '\n' + preview.excerpt)
                  ].filter((f) => f.value)
                ]
              })
              setPreview(null)
              setStatus('Edition details ready to save.')
            }}
          >
            Use these details
          </button>
        </>
      )}
      <label>
        Copyright page or other evidence
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={disabled}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void photo(f)
            e.target.value = ''
          }}
        />
      </label>
      {book.evidencePhotos?.map((id) => (
        <EvidencePhoto key={id} id={id} />
      ))}
      <p role="status">{status}</p>
    </details>
  )
}
function EvidencePhoto({ id }: { id: string }) {
  const url = useCover(id)
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      <img width={100} src={url} alt="Retained edition photograph" />
    </a>
  ) : null
}
