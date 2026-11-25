import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Books, Briefcase, Camera, Check, Code, Coffee, Folder, GlobeHemisphereWest, GraduationCap, Heart, Image, Leaf, Lightning, Mountains, MusicNotes, Palette, Planet, Sparkle, UploadSimple, Users, X } from '@phosphor-icons/react'
import { getStore, getWorldGeneration, isRepoReady } from '../data/repo.ts'
import { CrmDialog } from './CrmControls.tsx'
import { crmCommand, crmMessage } from './client.ts'
import { retainCrmPortrait, type CrmCommentAttachment } from './commentMedia.ts'
import { GROUP_ACCENTS, GROUP_COVER_STYLES, GROUP_ICONS, groupAppearance, validGroupColor, type GroupAppearance, type GroupIcon } from './groupAppearanceModel.ts'
import { validateCrmRow } from './model.ts'
import type { CrmGroup } from './types.ts'
import './groupAppearance.css'

const icons = { folder: Folder, people: Users, graduation: GraduationCap, planet: Planet, sparkle: Sparkle, books: Books, globe: GlobeHemisphereWest, heart: Heart, coffee: Coffee, briefcase: Briefcase, camera: Camera, music: MusicNotes, leaf: Leaf, lightning: Lightning, code: Code, mountains: Mountains }
const iconLabels: Record<GroupIcon, string> = { folder: 'Folder', people: 'People', graduation: 'Education', planet: 'Space', sparkle: 'Ideas', books: 'Books', globe: 'World', heart: 'Friends', coffee: 'Coffee', briefcase: 'Work', camera: 'Creative', music: 'Music', leaf: 'Nature', lightning: 'Energy', code: 'Technology', mountains: 'Adventure' }
const emojis = ['🪐', '🎓', '🌿', '🫂', '📚', '☕', '🎨', '🧠', '🌊', '🗽', '🎬', '✍️', '🏛️', '💌', '🌞', '🌱', '🎧', '🔭', '🧭', '💡', '🏔️', '🦋', '🍊', '⚡']

function useGroupImage(assetId?: string | null) {
  const [image, setImage] = useState({ id: '', url: '' })
  useEffect(() => {
    if (!assetId || !isRepoReady()) return
    let alive = true, url = ''; const store = getStore(), generation = getWorldGeneration()
    void store.getBlob(assetId).then(blob => {
      if (alive && blob?.type.startsWith('image/') && isRepoReady() && store === getStore() && generation === getWorldGeneration()) { url = URL.createObjectURL(blob); setImage({ id: assetId, url }) }
    }).catch(() => {})
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [assetId])
  return image.id === assetId ? image.url : ''
}

export function GroupIdentity({ group, size = 25 }: { group: CrmGroup; size?: number }) {
  const appearance = groupAppearance(group), image = useGroupImage(appearance.iconAssetId), Icon = icons[appearance.icon]
  return <span className="crm-group-identity" style={{ '--group-accent': validGroupColor(group.color) ? group.color : '#315d49', width: size, height: size, fontSize: size * .53 } as CSSProperties} aria-hidden="true">{image ? <img src={image} alt="" /> : appearance.emoji ? <span>{appearance.emoji}</span> : <Icon size={size * .57} weight="duotone" />}</span>
}

export function GroupCover({ group, onCustomize, disabled = false }: { group: CrmGroup; onCustomize?: () => void; disabled?: boolean }) {
  const appearance = groupAppearance(group), image = useGroupImage(appearance.coverAssetId)
  return <div className={`crm-group-cover cover-${appearance.coverStyle} height-${appearance.coverHeight} ${image ? 'has-picture' : ''}`} style={{ '--group-accent': validGroupColor(group.color) ? group.color : '#315d49', '--group-shade': appearance.coverDim / 100 } as CSSProperties}>
    {image && <img src={image} alt="" style={{ objectPosition: `50% ${appearance.coverPosition}%` }} />}
    <div className="crm-group-cover-pattern" aria-hidden="true"><i /><i /><i /></div><div className="crm-group-cover-shade" />
    <div className="crm-group-cover-caption"><span>PEOPLE & POSSIBILITIES</span><span>{group.name}</span></div>
    <div className="crm-group-cover-identity"><GroupIdentity group={group} size={56} /></div>
    {onCustomize && <button type="button" className="crm-group-cover-edit" disabled={disabled} onClick={onCustomize}><Palette size={14} />Customize</button>}
  </div>
}

export function GroupAppearanceDialog({ group, onClose, onSaved, disabled = false }: { group: CrmGroup; onClose: () => void; onSaved?: () => void; disabled?: boolean }) {
  const baseline = useRef(group), alive = useRef(true)
  const [draft, setDraft] = useState<GroupAppearance>(() => groupAppearance(group)), [name, setName] = useState(group.name), [description, setDescription] = useState(group.description), [color, setColor] = useState(validGroupColor(group.color) ? group.color : '#315d49'), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [originals, setOriginals] = useState<Record<string, CrmCommentAttachment>>({}), iconInput = useRef<HTMLInputElement>(null), coverInput = useRef<HTMLInputElement>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const preview = { ...group, ...draft, name: name || group.name, color }
  function change<K extends keyof GroupAppearance>(key: K, value: GroupAppearance[K]) { setDraft(previous => ({ ...previous, [key]: value })) }
  async function upload(file: File | undefined, target: 'icon' | 'cover') {
    if (!file || busy || disabled) return; setBusy(target); setError('')
    try {
      const retained = await retainCrmPortrait(file, { shouldWrite: () => alive.current })
      if (alive.current) { setDraft(previous => ({ ...previous, [target === 'icon' ? 'iconAssetId' : 'coverAssetId']: retained.assetId })); setOriginals(previous => ({ ...previous, [target === 'icon' ? 'iconOriginal' : 'coverOriginal']: retained })) }
    } catch (cause) { if (alive.current) setError(crmMessage(cause)) } finally { if (alive.current) setBusy('') }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || disabled) return; setError(''); setBusy('save')
    try {
      const patch = { ...draft, name: name.trim(), description, color, ...originals }
      validateCrmRow('groups', { ...baseline.current, ...patch })
      await crmCommand({ operation: 'update', collection: 'groups', id: baseline.current.id, expectedRecordRevision: baseline.current.revision, patch })
      if (alive.current) { onSaved?.(); onClose() }
    } catch (cause) { if (alive.current) setError(crmMessage(cause)) } finally { if (alive.current) setBusy('') }
  }
  return <CrmDialog title="Make this group yours" onClose={onClose} wide><form className="crm-group-customizer" onSubmit={event => void save(event)}>
    <section className="crm-group-preview" aria-label="Group appearance preview"><GroupCover group={preview} /><div className="crm-group-preview-title" style={{ color: draft.titleColor || undefined, fontFamily: draft.titleFont === 'serif' ? 'Georgia, serif' : undefined }}><strong>{preview.name}</strong><span>{description || 'A place for the people who share a thread.'}</span></div></section>
    <fieldset disabled={disabled || !!busy}>
      <div className="crm-group-customizer-columns"><section><h3><Sparkle size={16} />Identity</h3><label>Group name<input required maxLength={1000} value={name} onChange={event => setName(event.target.value)} /></label><label>A little context<textarea rows={2} value={description} onChange={event => setDescription(event.target.value)} placeholder="What brings these people together?" /></label>
        <div className="crm-group-image-picker"><GroupIdentity group={preview} size={48} /><div><button type="button" className="crm-button" onClick={() => iconInput.current?.click()}><UploadSimple size={14} />Upload group picture</button>{draft.iconAssetId && <button type="button" className="crm-link-button" onClick={() => change('iconAssetId', null)}>Remove picture</button>}</div></div>
        <label>Emoji or short mark<input className="crm-group-emoji-input" value={draft.emoji} maxLength={32} onChange={event => setDraft(previous => ({ ...previous, emoji: event.target.value, iconAssetId: null }))} placeholder="Add an emoji…" /></label><div className="crm-group-emoji-grid" aria-label="Emoji choices">{emojis.map(emoji => <button type="button" key={emoji} aria-label={`Use ${emoji} for this group`} aria-pressed={draft.emoji === emoji && !draft.iconAssetId} onClick={() => setDraft(previous => ({ ...previous, emoji, iconAssetId: null }))}>{emoji}</button>)}</div>
        <span className="crm-group-control-label">Or choose an icon</span><div className="crm-group-icon-grid" aria-label="Group icons">{GROUP_ICONS.map(key => { const Icon = icons[key]; return <button type="button" key={key} title={iconLabels[key]} aria-label={`Use ${iconLabels[key]} icon`} aria-pressed={draft.icon === key && !draft.emoji && !draft.iconAssetId} onClick={() => setDraft(previous => ({ ...previous, icon: key, emoji: '', iconAssetId: null }))}><Icon size={20} weight="duotone" /></button> })}</div>
      </section><section><h3><Image size={16} />Cover & palette</h3><div className="crm-group-cover-choices" aria-label="Cover patterns">{GROUP_COVER_STYLES.map(style => <button type="button" className={`crm-group-cover-swatch cover-${style}`} key={style} style={{ '--group-accent': color } as CSSProperties} aria-pressed={draft.coverStyle === style && !draft.coverAssetId} onClick={() => setDraft(previous => ({ ...previous, coverStyle: style, coverAssetId: null }))}><span>{style[0].toUpperCase() + style.slice(1)}</span>{draft.coverStyle === style && !draft.coverAssetId && <Check size={14} />}</button>)}</div><div className="crm-group-upload-cover"><button type="button" className="crm-button" onClick={() => coverInput.current?.click()}><UploadSimple size={14} />Upload cover picture</button>{draft.coverAssetId && <button type="button" className="crm-icon" aria-label="Remove cover picture" onClick={() => change('coverAssetId', null)}><X size={15} /></button>}</div><p className="crm-group-help">Your own images, kept locally with the group. PNG, JPEG, WebP, GIF or AVIF, up to 12 MiB.</p>
        {draft.coverAssetId && <><label>Picture position<input type="range" min={0} max={100} value={draft.coverPosition} onChange={event => change('coverPosition', Number(event.target.value))} /></label><label>Picture shade<input type="range" min={0} max={80} value={draft.coverDim} onChange={event => change('coverDim', Number(event.target.value))} /></label></>}
        <span className="crm-group-control-label">Accent color</span><div className="crm-group-color-choices">{GROUP_ACCENTS.map(accent => <button type="button" key={accent} style={{ background: accent }} aria-label={`Use accent ${accent}`} aria-pressed={color.toLowerCase() === accent} onClick={() => setColor(accent)}>{color.toLowerCase() === accent && <Check size={14} />}</button>)}<label className="crm-group-custom-color"><input type="color" aria-label="Custom group accent" value={color} onChange={event => setColor(event.target.value)} /><Palette size={15} /></label></div>
        <div className="crm-group-style-options"><label>Cover size<select value={draft.coverHeight} onChange={event => change('coverHeight', event.target.value as GroupAppearance['coverHeight'])}><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select></label><label>Title style<select value={draft.titleFont} onChange={event => change('titleFont', event.target.value as GroupAppearance['titleFont'])}><option value="sans">Modern</option><option value="serif">Editorial</option></select></label><label>Spacing<select value={draft.appearanceDensity} onChange={event => change('appearanceDensity', event.target.value as GroupAppearance['appearanceDensity'])}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><label>Title color<div className="crm-group-title-color"><input type="color" aria-label="Custom group title color" value={draft.titleColor || '#30332f'} onChange={event => change('titleColor', event.target.value)} /><button type="button" className="crm-link-button" disabled={!draft.titleColor} onClick={() => change('titleColor', '')}>Auto</button></div></label></div>
      </section></div>
    </fieldset>
    <input ref={iconInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/avif" aria-label="Group picture file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file, 'icon') }} /><input ref={coverInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/avif" aria-label="Group cover file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file, 'cover') }} />
    {error && <p className="crm-error" role="alert">{error}</p>}<footer className="crm-group-customizer-footer"><span>{busy === 'icon' || busy === 'cover' ? 'Keeping your original image…' : 'Saved with the group, including its edit history.'}</span><button type="button" className="crm-button" onClick={onClose}>Cancel</button><button type="submit" className="crm-button is-primary" disabled={disabled || !!busy || !name.trim()}>{busy === 'save' ? 'Saving…' : 'Save appearance'}</button></footer>
  </form></CrmDialog>
}
