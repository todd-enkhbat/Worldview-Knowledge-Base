import { useState, type ReactNode } from 'react'
import type { TemporalPrecision } from '../../domain/types.ts'
import { MONTHS, PRECISIONS, composeDate, daysInMonth, pad2, shows, splitUtc, withPrecision, type UtcParts } from './dateParts.ts'
import { ERROR_TEXT, HINT_TEXT, INPUT, SELECT } from './ui.ts'

export interface DateFieldProps {
  /** Prefix for the control ids (labels point at them). */
  id: string
  label: string
  /** Epoch ms (UTC). */
  value: number
  precision: TemporalPrecision
  onChange: (value: number, precision: TemporalPrecision) => void
  /** Inclusive bounds; the stored value is clamped into them. */
  min?: number
  max?: number
  error?: string | null
  hint?: ReactNode
}

/**
 * Date with an explicit precision. Separate year / month / day / time boxes instead of
 * <input type="date">: Safari has no month picker, native pickers cannot express "just a
 * year", and the boxes are unambiguous about UTC.
 */
export function DateField({ id, label, value, precision, onChange, min, max, error, hint }: DateFieldProps) {
  const parts = splitUtc(value)
  const minYear = min !== undefined ? splitUtc(min).year : -9999
  const maxYear = max !== undefined ? splitUtc(max).year : 9999
  const [yearProblem, setYearProblem] = useState<string | null>(null)

  const commit = (patch: Partial<UtcParts>) => onChange(composeDate({ ...parts, ...patch }, precision, min, max), precision)
  const describedBy = [error ? `${id}-error` : '', hint ? `${id}-hint` : '', yearProblem ? `${id}-year-error` : '']
    .filter(Boolean)
    .join(' ')

  return (
    <fieldset className="min-w-0 border-0 p-0" aria-describedby={describedBy || undefined}>
      <legend className="hud-label mb-1.5 p-0">{label}</legend>
      <div className="flex flex-wrap items-end gap-1.5">
        <Part label="Year" htmlFor={`${id}-year`}>
          <NumberBox
            id={`${id}-year`}
            className="w-[5.5rem]"
            value={parts.year}
            min={minYear}
            max={maxYear}
            invalid={!!error || !!yearProblem}
            onCommit={(year) => commit({ year })}
            onProblem={(bad) => setYearProblem(bad ? `Year must be between ${minYear} and ${maxYear}` : null)}
          />
        </Part>
        {shows(precision, 'month') && (
          <Part label="Month" htmlFor={`${id}-month`}>
            <select
              id={`${id}-month`}
              className={`${SELECT} w-[5.5rem]`}
              value={parts.month}
              aria-invalid={!!error}
              onChange={(e) => commit({ month: Number(e.target.value) })}
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>
                  {pad2(i + 1)} {m}
                </option>
              ))}
            </select>
          </Part>
        )}
        {shows(precision, 'day') && (
          <Part label="Day" htmlFor={`${id}-day`}>
            <NumberBox
              id={`${id}-day`}
              className="w-[4rem]"
              value={parts.day}
              min={1}
              max={daysInMonth(parts.year, parts.month)}
              invalid={!!error}
              onCommit={(day) => commit({ day })}
            />
          </Part>
        )}
        {shows(precision, 'minute') && (
          <Part label="Time UTC" htmlFor={`${id}-time`}>
            <input
              id={`${id}-time`}
              type="time"
              className={`${INPUT} w-[7rem]`}
              value={`${pad2(parts.hour)}:${pad2(parts.minute)}`}
              aria-invalid={!!error}
              onChange={(e) => {
                const m = /^(\d{1,2}):(\d{2})/.exec(e.target.value)
                if (m) commit({ hour: Number(m[1]), minute: Number(m[2]) })
              }}
            />
          </Part>
        )}
        <Part label="Precision" htmlFor={`${id}-precision`}>
          <select
            id={`${id}-precision`}
            className={`${SELECT} w-[6.5rem]`}
            value={precision}
            onChange={(e) => {
              const p = e.target.value as TemporalPrecision
              onChange(withPrecision(value, p, min, max), p)
            }}
          >
            {PRECISIONS.map((p) => (
              <option key={p} value={p}>
                {p.toUpperCase()}
              </option>
            ))}
          </select>
        </Part>
      </div>
      {yearProblem && (
        <p id={`${id}-year-error`} className={ERROR_TEXT}>
          {yearProblem}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className={ERROR_TEXT}>
          {error}
        </p>
      )}
      {hint && (
        <p id={`${id}-hint`} className={HINT_TEXT}>
          {hint}
        </p>
      )}
    </fieldset>
  )
}

function Part({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label htmlFor={htmlFor} className="font-mono text-[9px] uppercase tracking-[0.14em] text-concrete">
        {label}
      </label>
      {children}
    </div>
  )
}

/**
 * Integer box that commits only in-range values, so typing "2019" does not clamp through
 * "2", "20", "201" on the way. The half-typed text lives here until blur.
 */
function NumberBox(props: {
  id: string
  className: string
  value: number
  min: number
  max: number
  invalid: boolean
  onCommit: (v: number) => void
  onProblem?: (bad: boolean) => void
}) {
  const { id, className, value, min, max, invalid, onCommit, onProblem } = props
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      step={1}
      min={min}
      max={max}
      className={`${INPUT} ${className}`}
      value={draft ?? String(value)}
      aria-invalid={invalid}
      onChange={(e) => {
        const text = e.target.value
        setDraft(text)
        const n = Number(text)
        const ok = text.trim() !== '' && Number.isInteger(n) && n >= min && n <= max
        if (ok) onCommit(n)
        onProblem?.(!ok && text.trim() !== '')
      }}
      onBlur={() => {
        setDraft(null)
        onProblem?.(false)
      }}
    />
  )
}
