import { expect, it } from 'vitest'

type Display = (group: { name: string; emoji?: string; icon?: string }) => { icon: string; name: string }
const { groupDisplay } = await import(new URL('../../extensions/worldview-reader/group-icon.js', import.meta.url).href) as { groupDisplay: Display }

it('uses the saved group mark, including for renamed groups, before any fallback', () => {
  for (const group of [{ name: 'Venture Capital $', emoji: '💸' }, { name: 'Columbia', emoji: '🦁' }, { name: 'AI Labs / Research', emoji: '🛎️' }]) expect(groupDisplay(group)).toEqual({ name: group.name, icon: group.emoji })
  expect(groupDisplay({ name: 'Banks' })).toEqual({ name: 'Banks', icon: '🏦' })
  expect(groupDisplay({ name: 'Banks', icon: 'books' }).icon).toBe('📚')
})

it('shows embedded graphemes once and leaves emoji-only names usable', () => {
  expect(groupDisplay({ name: '🕵️‍♂️ Reach People', emoji: '🕵️‍♂️' })).toEqual({ icon: '🕵️‍♂️', name: 'Reach People' })
  expect(groupDisplay({ name: 'Policy 💸', emoji: '💸' })).toEqual({ icon: '💸', name: 'Policy' })
  expect(groupDisplay({ name: '🇺🇸 USA' })).toEqual({ icon: '🇺🇸', name: 'USA' })
  expect(groupDisplay({ name: 'Open 🪐 Cosmos', emoji: '🪐' })).toEqual({ icon: '', name: 'Open 🪐 Cosmos' })
  expect(groupDisplay({ name: '🎓', emoji: '🎓' })).toEqual({ icon: '', name: '🎓' })
})
