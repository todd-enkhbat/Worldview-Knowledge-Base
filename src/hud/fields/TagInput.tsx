import { useId, useState, type ReactNode } from 'react'
import { mergeTags } from './helpers.ts'
import { FOCUS, HINT_TEXT } from './ui.ts'

export interface TagInputProps {
  id: string
  label: string
  value: string[]
  onChange: (tags: string[]) => void
  /** Existing tags offered as completions. */
  suggestions?: readonly string[]
  placeholder?: string
  hint?: ReactNode
}

/** Chip input: Enter or comma commits, Backspace in an empty box removes the last chip, paste splits on commas. */
export function TagInput({ id, label, value, onChange, suggestions, placeholder, hint }: TagInputProps) {
  const [text, setText] = useState('')
  const listId = useId()

  const commit = (raw: string) => {
    const next = mergeTags(value, raw)
    if (next.length !== value.length) onChange(next)
    setText('')
  }
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i))

  return (
    <div>
      <label htmlFor={id} className="hud-label mb-1.5 block">
        {label}
      </label>
      <div className="flex min-h-[2.1rem] flex-wrap items-center gap-1 border border-bone/25 bg-void px-1 py-1 focus-within:border-bone/60">
        {value.map((t, i) => (
          <span key={t} className="inline-flex items-center border border-bone/30 font-mono text-[11px] text-bone">
            <span className="px-1.5">{t}</span>
            <button
              type="button"
              className={`border-l border-bone/30 px-1 text-concrete hover:bg-signal hover:text-void ${FOCUS}`}
              aria-label={`Remove tag ${t}`}
              onClick={() => remove(i)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 font-mono text-[12px] text-bone placeholder:text-concrete/60 focus:outline-none"
          value={text}
          placeholder={value.length === 0 ? placeholder : undefined}
          list={suggestions && suggestions.length > 0 ? listId : undefined}
          aria-describedby={hint ? `${id}-hint` : undefined}
          autoComplete="off"
          onChange={(e) => {
            const v = e.target.value
            // A comma (typed or pasted) commits everything before the last one.
            if (v.includes(',')) {
              const cut = v.lastIndexOf(',')
              const next = mergeTags(value, v.slice(0, cut))
              if (next.length !== value.length) onChange(next)
              setText(v.slice(cut + 1).trimStart())
            } else setText(v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (text.trim()) commit(text)
            } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
              e.preventDefault()
              remove(value.length - 1)
            }
          }}
          onBlur={() => {
            if (text.trim()) commit(text)
          }}
        />
      </div>
      {suggestions && suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions
            .filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()))
            .slice(0, 50)
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      )}
      {hint && (
        <p id={`${id}-hint`} className={HINT_TEXT}>
          {hint}
        </p>
      )}
    </div>
  )
}
