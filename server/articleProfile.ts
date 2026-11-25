/** Bounded references from an explicitly captured page. No network access happens here. */
export function capturedProfileMetadata(input: Record<string, unknown>, sourceUrl: string) {
  const url = (value: unknown) => { if (typeof value !== 'string' || !value.trim() || value.length > 2048) return ''; try { const parsed = new URL(value, sourceUrl); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href.length > 2048) return ''; parsed.hash = ''; return parsed.href } catch { return '' } }
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const profileImages = (Array.isArray(input.profileImages) ? input.profileImages.slice(0, 8) : []).filter(record).flatMap(value => {
    const imageUrl = url(value.url)
    return imageUrl ? [{ url: imageUrl, sourceUrl, label: String(value.label ?? 'Captured page image').slice(0, 200), isProfile: value.isProfile === true, ...(typeof value.subjectName === 'string' && value.subjectName.trim() ? { subjectName: value.subjectName.slice(0, 200) } : {}) }] : []
  })
  const profileLinks = (Array.isArray(input.profileLinks) ? input.profileLinks.slice(0, 32) : []).filter(record).flatMap(value => {
    const linkUrl = url(value.url)
    return linkUrl ? [{ url: linkUrl, rel: 'me', ...(typeof value.subjectName === 'string' && value.subjectName.trim() ? { subjectName: value.subjectName.slice(0, 200) } : {}) }] : []
  })
  return { profileImages, profileLinks }
}
