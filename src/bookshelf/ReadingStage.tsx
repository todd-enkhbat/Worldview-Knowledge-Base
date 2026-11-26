import { useId } from 'react'
import { BookmarkSimple, Books, BookOpen, CheckCircle } from '@phosphor-icons/react'
import type { ShelfStatus } from './types.ts'

export const shelfStages = [
  { id: 'wish', label: 'Wishlist', action: 'Add to Wishlist', icon: BookmarkSimple },
  { id: 'unread', label: 'Unread', action: 'Save as unread', icon: Books },
  { id: 'reading', label: 'Reading', action: 'Save as reading', icon: BookOpen },
  { id: 'read', label: 'Read', action: 'Save as read', icon: CheckCircle }
] as const

export function stageOf(status: ShelfStatus) {
  return shelfStages.find(stage => stage.id === status)!
}

export function ReadingStage({ value, onChange, disabled }: {
  value: ShelfStatus
  onChange: (stage: ShelfStatus) => void
  disabled: boolean
}) {
  const name = useId()
  return <fieldset className="book-stage-choice" disabled={disabled}>
    <legend>Reading stage</legend>
    <div>{shelfStages.map(({ id, label, icon: Icon }) => <label key={id} data-stage={id}>
      <input type="radio" name={name} value={id} checked={value === id} onChange={() => onChange(id)} />
      <span><Icon size={17} weight={value === id ? 'fill' : 'regular'} aria-hidden="true" />{label}</span>
    </label>)}</div>
  </fieldset>
}
