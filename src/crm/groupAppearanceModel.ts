import type { CrmGroup } from './types.ts'

export const GROUP_ICONS = ['folder', 'people', 'graduation', 'planet', 'sparkle', 'books', 'globe', 'heart', 'coffee', 'briefcase', 'camera', 'music', 'leaf', 'lightning', 'code', 'mountains'] as const
export const GROUP_COVER_STYLES = ['contours', 'orbit', 'paper', 'grid', 'solid'] as const
export const GROUP_ACCENTS = ['#315d49', '#476d88', '#8b634d', '#846a88', '#a66563', '#77794d', '#3e7c79', '#2d3343'] as const
export type GroupIcon = typeof GROUP_ICONS[number]
export type GroupCoverStyle = typeof GROUP_COVER_STYLES[number]
export interface GroupAppearance {
  iconAssetId: string | null; coverAssetId: string | null; emoji: string; icon: GroupIcon;
  coverStyle: GroupCoverStyle; coverPosition: number; appearanceDensity: 'compact' | 'comfortable';
  titleFont: 'sans' | 'serif'; coverHeight: 'small' | 'medium' | 'large'; titleColor: string; coverDim: number;
}
export const validGroupColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
export const groupIconFor = (name: string): GroupIcon => /columbia|university|school|college|academ/i.test(name) ? 'graduation' : /cosmos|space|astro/i.test(name) ? 'planet' : /journal|news|writ/i.test(name) ? 'books' : /friend|family|close/i.test(name) ? 'heart' : /invest|founder|business|work|startup/i.test(name) ? 'briefcase' : /art|photo|design|creat/i.test(name) ? 'camera' : /tech|engineer|develop|code/i.test(name) ? 'code' : 'people'
/** Derived display defaults never rewrite imported group metadata. */
export function groupAppearance(group: CrmGroup): GroupAppearance {
  return {
    iconAssetId: group.iconAssetId ?? null, coverAssetId: group.coverAssetId ?? null,
    emoji: group.emoji ?? '', icon: group.icon ?? groupIconFor(group.name),
    coverStyle: group.coverStyle ?? 'contours', coverPosition: group.coverPosition ?? 50,
    appearanceDensity: group.appearanceDensity ?? 'comfortable', titleFont: group.titleFont ?? 'sans',
    coverHeight: group.coverHeight ?? 'medium', titleColor: group.titleColor ?? '', coverDim: group.coverDim ?? 12,
  }
}
