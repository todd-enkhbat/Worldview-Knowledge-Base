export interface SliderProps {
  id: string
  label: string
  /** Slider position (not necessarily the stored quantity: the caller maps it). */
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  /** Plain-language ends of the scale, e.g. "anchored" ↔ "restless". */
  lowHint: string
  highHint: string
  /** Readout of the current value for sighted users and screen readers. */
  valueText: string
}

/** Range input with a plain-language readout; aria-valuetext carries the readout, not the raw number. */
export function Slider({ id, label, value, min, max, step, onChange, lowHint, highHint, valueText }: SliderProps) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="hud-label">
          {label}
        </label>
        <output htmlFor={id} className="font-mono text-[11px] text-bone">
          {valueText}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueText}
        aria-describedby={`${id}-scale`}
        onChange={(e) => onChange(Number(e.target.value))}
        className="block h-5 w-full cursor-pointer accent-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
      />
      <div className="mt-0.5 flex justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-concrete" id={`${id}-scale`}>
        <span>{lowHint}</span>
        <span className="sr-only"> to </span>
        <span>{highHint}</span>
      </div>
    </div>
  )
}
