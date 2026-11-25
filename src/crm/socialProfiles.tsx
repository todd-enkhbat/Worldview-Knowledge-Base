import { useEffect, useRef, useState, type ComponentType } from 'react'
import { ArrowClockwise, ArrowSquareOut, Butterfly, Camera, CheckCircle, FacebookLogo, GithubLogo, GlobeSimple, ImageSquare, InstagramLogo, LinkedinLogo, LinkSimple, MastodonLogo, MediumLogo, PinterestLogo, SpinnerGap, ThreadsLogo, TiktokLogo, UploadSimple, XLogo, YoutubeLogo, type IconProps } from '@phosphor-icons/react'
import { crmMessage } from './client.ts'
import { profileMediaGet, profileMediaPost } from './profileMediaClient.ts'
import type { CrmPerson } from './types.ts'
import './socialProfiles.css'

export type SocialPlatform = 'website' | 'linkedin' | 'x' | 'instagram' | 'github' | 'youtube' | 'facebook' | 'threads' | 'tiktok' | 'bluesky' | 'mastodon' | 'medium' | 'pinterest'
interface PlatformSpec { id: SocialPlatform; label: string; Icon: ComponentType<IconProps>; hosts: string[]; placeholder: string }
export const SOCIAL_PLATFORMS: PlatformSpec[] = [
  { id: 'website', label: 'Personal website', Icon: GlobeSimple, hosts: [], placeholder: 'https://their-website.com' },
  { id: 'linkedin', label: 'LinkedIn', Icon: LinkedinLogo, hosts: ['linkedin.com'], placeholder: 'https://linkedin.com/in/username' },
  { id: 'x', label: 'X / Twitter', Icon: XLogo, hosts: ['x.com', 'twitter.com'], placeholder: 'https://x.com/username' },
  { id: 'instagram', label: 'Instagram', Icon: InstagramLogo, hosts: ['instagram.com'], placeholder: 'https://instagram.com/username' },
  { id: 'github', label: 'GitHub', Icon: GithubLogo, hosts: ['github.com'], placeholder: 'https://github.com/username' },
  { id: 'youtube', label: 'YouTube', Icon: YoutubeLogo, hosts: ['youtube.com', 'youtu.be'], placeholder: 'https://youtube.com/@username' },
  { id: 'facebook', label: 'Facebook', Icon: FacebookLogo, hosts: ['facebook.com', 'fb.com'], placeholder: '' },
  { id: 'threads', label: 'Threads', Icon: ThreadsLogo, hosts: ['threads.net', 'threads.com'], placeholder: '' },
  { id: 'tiktok', label: 'TikTok', Icon: TiktokLogo, hosts: ['tiktok.com'], placeholder: '' },
  { id: 'bluesky', label: 'Bluesky', Icon: Butterfly, hosts: ['bsky.app'], placeholder: '' },
  { id: 'mastodon', label: 'Mastodon', Icon: MastodonLogo, hosts: ['mastodon.social', 'mastodon.online'], placeholder: '' },
  { id: 'medium', label: 'Medium', Icon: MediumLogo, hosts: ['medium.com'], placeholder: '' },
  { id: 'pinterest', label: 'Pinterest', Icon: PinterestLogo, hosts: ['pinterest.com'], placeholder: '' },
]
export function safeProfileUrl(value: string): string {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '' } catch { return '' }
}
export function socialProfile(value: string) {
  const url = safeProfileUrl(value)
  if (!url) return null
  const parsed = new URL(url), host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const platform = SOCIAL_PLATFORMS.slice(1).find(item => item.hosts.some(domain => host === domain || host.endsWith(`.${domain}`))) ?? SOCIAL_PLATFORMS[0]
  let pathname = parsed.pathname
  try { pathname = decodeURI(pathname) } catch { /* Keep a malformed original escape visible as text. */ }
  const handle = platform.id === 'website' ? host : pathname.replace(/^\/(?:in|@)\/?/, '').replace(/^\/|\/$/g, '') || host
  return { url, platform, handle }
}
export function SocialProfileLinks({ urls, compact = false }: { urls: string[]; compact?: boolean }) {
  const seen = new Set<string>(), profiles = urls.flatMap(value => { const item = socialProfile(value); if (!item || seen.has(item.url)) return []; seen.add(item.url); return [item] })
  if (!profiles.length) return null
  return <div className={`crm-social-links ${compact ? 'is-compact' : ''}`} aria-label="Websites and social profiles">{profiles.map(({ url, platform, handle }) => <a key={url} href={url} target="_blank" rel="noreferrer noopener" title={`${platform.label} · ${handle}`} data-platform={platform.id}><platform.Icon size={compact ? 16 : 19} weight={platform.id === 'website' ? 'regular' : 'fill'} /><span>{compact ? platform.label === 'Personal website' ? 'Website' : platform.label : <><strong>{platform.label}</strong><small>{handle}</small></>}</span>{!compact && <ArrowSquareOut size={12} />}</a>)}</div>
}

/** Editing one named profile leaves every other original URL, including duplicates, intact. */
export function socialEditorValues(urls: string[]) {
  const fields: Partial<Record<SocialPlatform, string>> = {}, other: string[] = []
  for (const url of urls) { const profile = socialProfile(url); if (profile && ['website', 'linkedin', 'x', 'instagram', 'github', 'youtube'].includes(profile.platform.id) && !fields[profile.platform.id]) fields[profile.platform.id] = url; else other.push(url) }
  return { fields, other }
}
export function replaceSocialProfile(urls: string[], platform: SocialPlatform, next: string) {
  const existing = socialEditorValues(urls).fields[platform], index = existing === undefined ? -1 : urls.indexOf(existing), result = [...urls]
  if (index >= 0) { if (next.trim()) result[index] = next; else result.splice(index, 1) } else if (next.trim()) result.push(next)
  return result
}
export function SocialProfileEditor({ value, onChange }: { value: string[]; onChange: (urls: string[]) => void }) {
  const [draft, setDraft] = useState(() => socialEditorValues(value))
  const change = (next: typeof draft) => { setDraft(next); onChange([...SOCIAL_PLATFORMS.slice(0, 6).flatMap(item => next.fields[item.id] ? [next.fields[item.id]!] : []), ...next.other]) }
  return <section className="crm-social-editor"><header><LinkSimple size={15} /><strong>Websites & social profiles</strong></header><div>{SOCIAL_PLATFORMS.slice(0, 6).map(({ id, label, Icon, placeholder }) => <label key={id}><span><Icon size={15} />{label}</span><input type="url" aria-label={`${label} URL`} value={draft.fields[id] ?? ''} placeholder={placeholder} onChange={event => change({ ...draft, fields: { ...draft.fields, [id]: event.target.value } })} /></label>)}</div><label>Additional profiles & original links<textarea aria-label="Additional profile URLs" rows={2} value={draft.other.join('\n')} onChange={event => change({ ...draft, other: event.target.value.split('\n') })} /><small>One per line. Additional and imported links stay with this person.</small></label></section>
}

export interface CrmPhotoCandidate { id: string; url: string; sourceUrl: string; label: string; kind: 'imported' | 'page' | 'captured' }
export interface CrmProfileMediaPreview { personId: string; recordRevision: number; avatarAssetId: string | null; photoCandidates: CrmPhotoCandidate[]; links: { url: string; platform: string; label: string; sourceUrl: string }[]; notices: string[] }
interface ProfileMediaResult { record: CrmPerson; downloaded: boolean; addedLinks: number; notices: string[] }
export async function saveProfileMedia(personId: string, input: Record<string, unknown>): Promise<ProfileMediaResult> {
  const result = await profileMediaPost<ProfileMediaResult>(encodeURIComponent(personId), input)
  if (!result.record || result.record.id !== personId) throw new Error('The profile save receipt was incomplete. Retry to check the saved result.')
  return result
}
export function ProfileMediaPanel({ person, disabled, onChanged, onUploadPhoto }: { person: CrmPerson; disabled: boolean; onChanged: () => void; onUploadPhoto?: () => void }) {
  const [preview, setPreview] = useState<CrmProfileMediaPreview | null>(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [manual, setManual] = useState(false), [photoUrl, setPhotoUrl] = useState(''), [sourceUrl, setSourceUrl] = useState(''), [confirmed, setConfirmed] = useState(false)
  const alive = useRef(true), pending = useRef(new Map<string, string>()), busyRef = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const sources = [...new Set([...person.urls, ...person.sourceRefs.map(ref => ref.url ?? '')].filter(value => !!safeProfileUrl(value)))]
  const load = async () => {
    if (busyRef.current || disabled) return
    busyRef.current = true; setBusy('preview'); setError(''); setNotice('')
    try { const result = await profileMediaGet<CrmProfileMediaPreview>(person.id, true); if (alive.current) { setPreview(result); setNotice(result.photoCandidates?.length ? 'Choose a photo below to keep its original on your Mac.' : 'No verified photo was available from these sources. You can add an image yourself.'); } }
    catch (cause) { if (alive.current) setError(crmMessage(cause)) }
    finally { busyRef.current = false; if (alive.current) setBusy('') }
  }
  const save = async (key: string, input: Record<string, unknown>) => {
    if (busyRef.current || disabled) return
    busyRef.current = true; setBusy(key); setError(''); setNotice('')
    const value = { expectedRecordRevision: preview?.recordRevision ?? person.revision, ...input }, signature = JSON.stringify(value), requestId = pending.current.get(signature) ?? crypto.randomUUID(); pending.current.set(signature, requestId)
    try { const result = await saveProfileMedia(person.id, { ...value, requestId }); pending.current.delete(signature); if (alive.current) { setNotice(`${result.downloaded ? 'Photo saved locally. ' : ''}${result.addedLinks ? `${result.addedLinks} source-backed profile links added. ` : ''}${(result.notices ?? []).join(' ')}`.trim() || 'Profile sources checked.'); setPreview(null); if (key === 'manual') { setManual(false); setPhotoUrl(''); setConfirmed(false) } onChanged(); } }
    catch (cause) { if (alive.current) setError(crmMessage(cause)) }
    finally { busyRef.current = false; if (alive.current) setBusy('') }
  }
  const portrait = person.portraitSource && typeof person.portraitSource === 'object' ? person.portraitSource as Record<string, unknown> : null, original = person.portraitOriginal && typeof person.portraitOriginal === 'object' ? person.portraitOriginal as Record<string, unknown> : null
  const provenanceUrl = typeof portrait?.sourceUrl === 'string' ? safeProfileUrl(portrait.sourceUrl) : '', provenanceLabel = typeof portrait?.label === 'string' ? portrait.label : 'Original profile source'
  return <section className="crm-profile-media-panel"><header><span className="crm-profile-media-mark"><Camera size={19} /></span><div><h3>A fuller picture</h3><p>Keep their photo, websites and social profiles together.</p></div>{person.avatarAssetId && <span className="crm-profile-media-saved"><CheckCircle size={14} />Local photo</span>}</header><div className="crm-profile-media-actions"><button type="button" className="crm-person-small-button" disabled={disabled || !!busy} onClick={() => void load()}>{busy === 'preview' ? <SpinnerGap className="crm-person-spin" size={14} /> : <ArrowClockwise size={14} />}Find photos & profiles</button>{onUploadPhoto && <button type="button" className="crm-person-small-button" disabled={disabled || !!busy} onClick={onUploadPhoto}><UploadSimple size={14} />Upload picture</button>}<button type="button" className="crm-person-text-button" disabled={disabled || !!busy} onClick={() => setManual(value => !value)}>Add image URL</button></div><p className="crm-profile-media-footnote">Checks this person’s linked pages and retained sources. LinkedIn or X may require you to capture the visible profile with Reader or upload a picture.</p>{(provenanceUrl || !!original?.name) && <p className="crm-profile-media-provenance"><CheckCircle size={12} />{provenanceUrl ? <a href={provenanceUrl} target="_blank" rel="noreferrer noopener">{provenanceLabel}<ArrowSquareOut size={11} /></a> : `Original kept · ${String(original?.name)}`}</p>}
    {preview && <div className="crm-profile-media-preview">{!!preview.photoCandidates?.length && <div className="crm-photo-candidates">{preview.photoCandidates.map((candidate, index) => <div key={candidate.id}><span><ImageSquare size={21} /></span><div><strong>{candidate.label || `Source photo ${index + 1}`}</strong><a href={safeProfileUrl(candidate.sourceUrl) || undefined} target="_blank" rel="noreferrer noopener">{safeProfileUrl(candidate.sourceUrl) ? new URL(candidate.sourceUrl).hostname : 'Retained source'}<ArrowSquareOut size={10} /></a>{safeProfileUrl(candidate.url) && <a href={safeProfileUrl(candidate.url)} target="_blank" rel="noreferrer noopener">View image<ArrowSquareOut size={10} /></a>}</div><button type="button" className="crm-person-small-button" disabled={disabled || !!busy} onClick={() => void save(candidate.id, { photoUrl: candidate.url, sourceUrl: candidate.sourceUrl, replacePhoto: true })}>{busy === candidate.id ? 'Saving…' : person.avatarAssetId ? 'Use photo' : 'Save photo'}</button></div>)}</div>}{!!preview.links?.length && <div className="crm-discovered-profiles"><span>{preview.links.length} source-backed profile links</span><SocialProfileLinks urls={preview.links.map(link => link.url)} compact /><button type="button" className="crm-person-small-button" disabled={disabled || !!busy} onClick={() => void save('links', { discover: true })}>Keep discovered profiles</button></div>}{preview.notices?.map((item, index) => <p key={index} className="crm-profile-media-footnote">{item}</p>)}</div>}
    {manual && <div className="crm-profile-manual-photo"><label>Image URL<input type="url" aria-label="Profile image URL" value={photoUrl} onChange={event => { setPhotoUrl(event.target.value); setConfirmed(false) }} placeholder="https://…/portrait.jpg" /></label><label>Person’s source page<select aria-label="Profile image source page" value={sourceUrl} onChange={event => { setSourceUrl(event.target.value); setConfirmed(false) }}><option value="">Choose a saved profile or website</option>{sources.map(url => <option key={url} value={url}>{url}</option>)}</select></label>{!sources.length && <p>Add their website or social profile in Contact details first.</p>}<label className="crm-profile-photo-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I checked that this image belongs to this person.</label><button type="button" className="crm-person-small-button" disabled={disabled || !!busy || !confirmed || !safeProfileUrl(photoUrl) || !sourceUrl} onClick={() => void save('manual', { photoUrl, sourceUrl, confirmManualPhoto: true, replacePhoto: true })}>{busy === 'manual' ? 'Saving original…' : 'Save photo locally'}</button></div>}
    {busy && <p className="crm-profile-media-footnote" role="status">{busy === 'preview' ? 'Reading the linked public pages…' : 'Keeping the source and original image…'}</p>}{error && <p className="crm-profile-media-error" role="alert">{error} <button type="button" onClick={() => { if (busyRef.current) return; void load() }}>Check sources again</button></p>}{notice && <p className="crm-profile-media-notice" role="status">{notice}</p>}
  </section>
}
