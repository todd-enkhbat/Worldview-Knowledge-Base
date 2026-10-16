import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import { RepoValidationError, addAttachment, createNode, removeAttachment, updateNode, useRepoStatus } from '../data/repo.ts'
import { SIGMA } from '../domain/constants.ts'
import { formatByPrecision } from '../domain/time.ts'
import type { Archetype, EntityKind, NodeRecord, Visibility, WorldSettings } from '../domain/types.ts'
import { ARCHETYPE_DEFAULTS, TITLE_MAX, maxTemporalOrigin, validateNode } from '../domain/validate.ts'
import { flyTo } from '../world/camera/flyTo.ts'
import { ARCHETYPE_INFO, ArchetypeGlyph } from './ArchetypePicker.tsx'
import { AttachmentField } from './fields/AttachmentField.tsx'
import { DateField } from './fields/DateField.tsx'
import { truncate } from './fields/dateParts.ts'
import { candidateOf, collectIssues, editableOf, newDraft, sameEditable } from './fields/editorModel.ts'
import { massToSignificance, significanceToMass, significanceWord, volatilityWord } from './fields/helpers.ts'
import { LinkPicker } from './fields/LinkPicker.tsx'
import { SceneField } from './fields/SceneField.tsx'
import { Slider } from './fields/Slider.tsx'
import { TagInput } from './fields/TagInput.tsx'
import { BTN, BTN_SIGNAL, ERROR_TEXT, FOCUS, HINT_TEXT, INPUT, SELECT } from './fields/ui.ts'
import { Markdown } from './markdown.ts'

// Side-sheet editor for creating and editing a node (useApp.editor). The form edits a local
// copy; nothing is written until Save. Save = createNode/updateNode, then staged attachment
// changes, then select + fly to the node. createNode toasts "Created … / Undo" itself; an
// edit gets its own undo toast here because updateNode does not push one.

const ENTITY_KINDS: readonly { value: EntityKind; label: string }[] = [
  { value: 'person', label: 'Person' },
  { value: 'place', label: 'Place' },
  { value: 'organization', label: 'Organisation' },
  { value: 'work', label: 'Work (book, film, artwork…)' },
  { value: 'other', label: 'Other' },
]

/** Controls that render their own messages; anything else is listed above the footer. */
const RENDERED_KEYS = new Set([
  'title',
  'tags',
  'contentMd',
  'temporalOrigin',
  'temporalPrecision',
  'referenceDate',
  'referenceDate.epochMs',
  'referenceDate.precision',
  'thermo.mass',
  'thermo.temperature',
  'visibility',
  'links',
  'entity.kind',
  'demon',
  'demon.query',
  'demon.radius',
  'demon.active',
  'anchorXZ',
])

const rootOf = (key: string) => key.split(/[.[]/)[0]

function describeError(e: unknown): string {
  if (e instanceof RepoValidationError) return e.errors.map((x) => x.message).join('; ') || e.message
  return e instanceof Error ? e.message : String(e)
}

/** The node's render pose appears a frame or more after it is created; retry until it does. */
function flyToWhenReady(id: string, tries = 90): void {
  if (flyTo(id) || tries <= 0) return
  requestAnimationFrame(() => flyToWhenReady(id, tries - 1))
}

/** Node editor side sheet. Mount once in the HUD; it renders while useApp.editor.open. */
export function NodeEditor() {
  const editor = useApp((s) => s.editor)
  if (!editor.open) return null
  return <EditorGate key={editor.nodeId ?? `new:${editor.archetype ?? ''}`} nodeId={editor.nodeId} archetype={editor.archetype} />
}

function EditorGate({ nodeId, archetype }: { nodeId: string | null; archetype: Archetype | null }) {
  const settings = useWorld((s) => s.settings)
  const live = useWorld((s) => (nodeId ? s.nodes.get(nodeId) : undefined))
  // The form keeps the record it opened with; later store changes must not reset it.
  const [source, setSource] = useState<NodeRecord | undefined>(live)
  if (!source && live) setSource(live)

  const close = () => useApp.getState().closeEditor()
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      useApp.getState().escape()
    }
  }

  let problem: string | null = null
  if (!settings) problem = 'The world is still loading.'
  else if (nodeId && !source) problem = 'This node no longer exists. It may have been deleted in another tab.'
  else if (!source && !archetype) problem = 'Choose an archetype first.'

  if (problem || !settings) {
    return (
      <Sheet labelledBy="node-editor-missing" onKeyDown={onKeyDown}>
        <div className="flex items-start justify-between gap-3 border-b border-bone/15 p-4">
          <h2 id="node-editor-missing" className="font-mono text-[14px] font-bold uppercase tracking-[0.06em] text-bone">
            Editor
          </h2>
          <CloseButton onClick={close} />
        </div>
        <p className="p-4 font-mono text-[12px] text-concrete">{problem}</p>
      </Sheet>
    )
  }
  return <EditorForm source={source ?? null} archetype={source?.archetype ?? archetype!} settings={settings} />
}

function Sheet(props: { labelledBy: string; onKeyDown: (e: KeyboardEvent) => void; children: ReactNode }) {
  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby={props.labelledBy}
      className="hud-panel fixed top-0 right-0 bottom-0 z-30 flex w-full max-w-[32rem] flex-col border-y-0 border-r-0"
      onKeyDown={props.onKeyDown}
    >
      {props.children}
    </aside>
  )
}

function CloseButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={`shrink-0 border border-bone/30 px-2 py-0.5 font-mono text-[14px] leading-none text-bone hover:bg-bone hover:text-void disabled:opacity-40 ${FOCUS}`}
      aria-label="Close editor"
      onClick={onClick}
      disabled={disabled}
    >
      ×
    </button>
  )
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2 border-b border-bone/10 pb-1">
        <h3 id={id} className="hud-label">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Messages({ id, errors, warnings }: { id?: string; errors?: string[]; warnings?: string[] }) {
  if (!errors?.length && !warnings?.length) return null
  return (
    <div id={id}>
      {errors?.map((m) => (
        <p key={`e:${m}`} className={ERROR_TEXT}>
          {m}
        </p>
      ))}
      {warnings?.map((m) => (
        <p key={`w:${m}`} className="mt-1 font-mono text-[11px] text-brass">
          {m}
        </p>
      ))}
    </div>
  )
}

interface EditorFormProps {
  source: NodeRecord | null
  archetype: Archetype
  settings: WorldSettings
}

function EditorForm({ source, archetype, settings }: EditorFormProps) {
  const nodes = useWorld((s) => s.nodes)
  const trash = useWorld((s) => s.trash)
  const repoReady = useRepoStatus((s) => s.ready)
  const writer = useRepoStatus((s) => s.writer)

  const [now] = useState(() => Date.now())
  const [baseline, setBaseline] = useState<NodeRecord>(() => source ?? newDraft(archetype, settings, now))
  const [draft, setDraft] = useState<NodeRecord>(baseline)
  /** Stored id: null until a new node has been created. */
  const [savedId, setSavedId] = useState<string | null>(source?.id ?? null)
  const [anchorOverride, setAnchorOverride] = useState<[number, number] | null>(null)
  const [pending, setPending] = useState<File[]>([])
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set())
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [preview, setPreview] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  const isNew = savedId === null
  const live = savedId ? nodes.get(savedId) : undefined
  const gone = savedId !== null && !live
  const info = ARCHETYPE_INFO[archetype]
  const maxOrigin = maxTemporalOrigin(now)

  // ─── validation ──────────────────────────────────────────────────────────────────
  const others = useMemo(() => [...nodes.values(), ...trash.values()], [nodes, trash])
  const slugs = useMemo(() => others.map((o) => o.slug), [others])
  const candidate = useMemo(() => {
    // Edits validate at the stored anchor (it may have been dragged since the sheet opened).
    const anchorXZ = anchorOverride ?? live?.anchorXZ ?? draft.anchorXZ
    return candidateOf({ ...draft, anchorXZ }, isNew, slugs)
  }, [draft, anchorOverride, live, isNew, slugs])
  const result = useMemo(
    () => validateNode(candidate, { settings, now, others, trashedLinkTargets: 'warn' }),
    [candidate, settings, now, others],
  )
  const issues = useMemo(() => collectIssues(result, isNew, settings.T0), [result, isNew, settings.T0])
  const show = (key: string) => submitted || touched.has(rootOf(key))
  const errs = (key: string) => (show(key) ? issues.errors.get(key) : undefined)
  const warns = (key: string) => issues.warnings.get(key)
  const otherErrors = submitted ? [...issues.errors].filter(([k]) => !RENDERED_KEYS.has(k)).flatMap(([, v]) => v) : []

  const hasChanges = !sameEditable(draft, baseline) || pending.length > 0 || removed.size > 0 || anchorOverride !== null

  const tagSuggestions = useMemo(() => {
    const all = new Set<string>()
    for (const n of nodes.values()) for (const t of n.tags) all.add(t)
    return [...all].sort((a, b) => a.localeCompare(b))
  }, [nodes])

  useEffect(() => {
    if (!hasChanges) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasChanges])

  // The sheet is not modal: after a click in the world, Esc goes to the camera rig, whose
  // escape() closes the editor outright. Ask first when that would drop unsaved edits.
  // document (bubble) runs after every React handler (dialogs, Library claim their own Esc)
  // and before the rig's window listener, which skips defaultPrevented keys.
  useEffect(() => {
    if (!hasChanges) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      if (!saving) setConfirming(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [hasChanges, saving])

  // ─── editing ─────────────────────────────────────────────────────────────────────
  function set<K extends keyof NodeRecord>(key: K, value: NodeRecord[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
    setTouched((t) => (t.has(key) ? t : new Set(t).add(key)))
  }

  const setOrigin = (value: number, precision: NodeRecord['temporalPrecision']) => {
    setDraft((d) => ({ ...d, temporalOrigin: value, temporalPrecision: precision }))
    setTouched((t) => (t.has('temporalOrigin') ? t : new Set(t).add('temporalOrigin')))
    setAnchorOverride(null) // a snap found for the old height no longer applies
  }

  // ─── closing ─────────────────────────────────────────────────────────────────────
  const close = () => useApp.getState().closeEditor()
  const requestClose = () => {
    if (saving) return
    if (hasChanges) setConfirming(true)
    else close()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (saving) return
      if (confirming) setConfirming(false)
      else if (hasChanges) setConfirming(true)
      else useApp.getState().escape()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      // Fields commit half-typed input on blur (a tag not yet confirmed with Enter), so
      // blur first and save once that commit has rendered, or the save would drop it.
      const el = document.activeElement
      if (el instanceof HTMLElement && el !== document.body) {
        el.blur()
        requestAnimationFrame(() => void saveRef.current())
      } else void save()
    }
  }

  // ─── saving ──────────────────────────────────────────────────────────────────────
  async function save() {
    if (saving) return
    setSubmitted(true)
    setConfirming(false)
    if (issues.blocking.length > 0 || gone || !writer) {
      requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    setSaving(true)
    setSaveError(null)
    const app = useApp.getState()
    let id = savedId
    try {
      if (id === null) {
        const rec = await createNode({ ...editableOf(candidate), id: draft.id, archetype, title: candidate.title })
        id = rec.id
        setSavedId(rec.id)
        setBaseline(rec)
        setDraft(rec)
      } else if (!sameEditable(candidate, baseline) || anchorOverride) {
        const before = editableOf(live ?? baseline)
        const rec = await updateNode(id, editableOf(candidate))
        setBaseline(rec)
        setDraft(rec)
        setAnchorOverride(null)
        const nid = id
        app.pushToast({ message: `Updated ${rec.title}`, undo: () => updateNode(nid, before).then(() => {}) })
      }
    } catch (e) {
      setSaveError(describeError(e))
      setSaving(false)
      return
    }

    // Attachments after the record exists. A failure keeps the sheet open on what failed;
    // the node itself is saved, so a retry only re-runs the attachment step.
    const problems: string[] = []
    const keepRemoved = new Set<string>()
    const failedFiles: File[] = []
    for (const attId of removed) {
      try {
        await removeAttachment(id, attId)
      } catch (e) {
        keepRemoved.add(attId)
        problems.push(describeError(e))
      }
    }
    for (const f of pending) {
      try {
        await addAttachment(id, f, f.name)
      } catch (e) {
        failedFiles.push(f)
        problems.push(`${f.name}: ${describeError(e)}`)
      }
    }

    app.select(id)
    flyToWhenReady(id)
    if (problems.length > 0) {
      setPending(failedFiles)
      setRemoved(keepRemoved)
      setSaveError(`Saved, but ${problems.length} attachment change${problems.length > 1 ? 's' : ''} failed: ${problems.join('; ')}`)
      setSaving(false)
      return
    }
    app.closeEditor()
  }
  /** save() of the latest render, for the deferred ⌘/Ctrl+Enter save. */
  const saveRef = useRef(save)
  useLayoutEffect(() => {
    saveRef.current = save
  })

  // ─── render ──────────────────────────────────────────────────────────────────────
  const thermo = draft.thermo
  const defaults = ARCHETYPE_DEFAULTS[archetype]
  const spacing = result.spacing
  const nearTitle = spacing.status === 'snap' || spacing.status === 'reject' ? (nodes.get(spacing.nearestId)?.title ?? 'another node') : ''
  const deferredMd = useDeferredValue(draft.contentMd)
  const titleErrs = errs('title')
  const banner = !repoReady
    ? 'The world is still loading; saving is disabled.'
    : !writer
      ? 'Another tab holds the write lock, so this one is read-only. Close the other tab to edit here.'
      : gone
        ? 'This node was deleted while you were editing. Saving is disabled.'
        : null

  return (
    <Sheet labelledBy={titleId} onKeyDown={onKeyDown}>
      <header className="flex items-start gap-3 border-b border-bone/15 p-4">
        <ArchetypeGlyph archetype={archetype} className="h-10 w-10 shrink-0 text-ember" />
        <div className="min-w-0 flex-1">
          <p className="hud-label">
            {isNew ? 'New' : 'Edit'} {info.name}
          </p>
          <h2 id={titleId} className="mt-0.5 truncate font-mono text-[15px] font-bold uppercase tracking-[0.06em] text-bone">
            {draft.title.trim() || 'Untitled'}
          </h2>
          <p className="mt-0.5 font-mono text-[10px] text-concrete">
            {info.description}. {info.form}.
          </p>
        </div>
        <CloseButton onClick={requestClose} disabled={saving} />
      </header>

      {banner && (
        <p role="status" className="border-b border-signal/60 bg-signal/10 px-4 py-2 font-mono text-[11px] text-signal">
          {banner}
        </p>
      )}

      <div ref={bodyRef} className="flex flex-1 flex-col gap-7 overflow-y-auto px-4 py-5">
        {/* Title */}
        <div>
          <label htmlFor="ne-title" className="hud-label mb-1.5 block">
            Title
          </label>
          <input
            id="ne-title"
            autoFocus
            className={`${INPUT} py-2 text-[14px]`}
            value={draft.title}
            placeholder={`Name this ${info.name.toLowerCase()}`}
            aria-invalid={!!titleErrs?.length}
            aria-describedby={titleErrs?.length ? 'ne-title-msg' : undefined}
            onChange={(e) => set('title', e.target.value)}
          />
          {draft.title.length > TITLE_MAX - 40 && (
            <p className={HINT_TEXT}>
              {draft.title.trim().length} / {TITLE_MAX}
            </p>
          )}
          <Messages id="ne-title-msg" errors={titleErrs} />
        </div>

        {/* Time */}
        <Section title="Time">
          <DateField
            id="ne-origin"
            label="When it entered your worldview"
            value={draft.temporalOrigin}
            precision={draft.temporalPrecision}
            min={settings.T0}
            max={maxOrigin}
            onChange={setOrigin}
            error={errs('temporalOrigin')?.join(' ') ?? null}
            hint={`Sets its height on the timeline: ${formatByPrecision(settings.T0, 'day')} to ${formatByPrecision(maxOrigin, 'day')} (UTC).`}
          />

          {!isNew && spacing.status === 'snap' && !anchorOverride && (
            <div className="border border-brass/60 p-2 font-mono text-[11px] text-bone" role="status">
              <p>
                At this date it sits {spacing.distance.toFixed(1)} u from “{nearTitle}”, closer than the {SIGMA} u spacing. A free spot
                lies nearby; saving moves it there.
              </p>
              <button type="button" className={`${BTN} mt-2`} onClick={() => setAnchorOverride(spacing.anchorXZ)}>
                Use nearby free spot
              </button>
            </div>
          )}
          {!isNew && anchorOverride && (
            <p className={HINT_TEXT}>
              Will move to the free spot ({anchorOverride[0].toFixed(1)}, {anchorOverride[1].toFixed(1)}) on save.{' '}
              <button type="button" className={`underline ${FOCUS}`} onClick={() => setAnchorOverride(null)}>
                Undo
              </button>
            </p>
          )}
          {!isNew && spacing.status === 'reject' && (
            <p className="border border-brass/60 p-2 font-mono text-[11px] text-brass" role="status">
              At this date it sits {spacing.distance.toFixed(1)} u from “{nearTitle}” with no free spot close by. Saving will look further
              out; if that fails, pick another date.
            </p>
          )}

          {draft.referenceDate ? (
            <div className="flex flex-col gap-2 border-l-2 border-brass/60 pl-3">
              <DateField
                id="ne-ref"
                label="Historical date"
                value={draft.referenceDate.epochMs}
                precision={draft.referenceDate.precision}
                onChange={(epochMs, precision) => set('referenceDate', { ...draft.referenceDate, epochMs, precision })}
                error={errs('referenceDate.epochMs')?.join(' ') ?? null}
                hint="Display only, e.g. when a theory was published. It never moves the node."
              />
              <div>
                <label htmlFor="ne-ref-label" className="hud-label mb-1.5 block">
                  Label for the historical date
                </label>
                <input
                  id="ne-ref-label"
                  className={INPUT}
                  value={draft.referenceDate.label ?? ''}
                  placeholder="e.g. published, founded, born"
                  maxLength={60}
                  onChange={(e) => {
                    const { label: _drop, ...rest } = draft.referenceDate!
                    const label = e.target.value
                    set('referenceDate', label ? { ...rest, label } : rest)
                  }}
                />
              </div>
              <button type="button" className={`${BTN} self-start`} onClick={() => set('referenceDate', null)}>
                Remove historical date
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={`${BTN} self-start`}
              onClick={() => set('referenceDate', { epochMs: truncate(draft.temporalOrigin, 'year'), precision: 'year' })}
            >
              + Historical date
            </button>
          )}
        </Section>

        {/* Tags */}
        <TagInput
          id="ne-tags"
          label="Tags"
          value={draft.tags}
          onChange={(tags) => set('tags', tags)}
          suggestions={tagSuggestions}
          placeholder="Type a tag, then Enter or comma"
          hint="The first tag picks the node's sector in the world."
        />

        {/* Notes */}
        <Section
          title="Notes"
          aside={
            <button type="button" className={`font-mono text-[10px] uppercase text-concrete hover:text-bone ${FOCUS}`} onClick={() => setPreview((p) => !p)} aria-pressed={preview}>
              {preview ? 'Hide preview' : 'Show preview'}
            </button>
          }
        >
          <div>
            <label htmlFor="ne-content" className="sr-only">
              Notes in Markdown
            </label>
            <textarea
              id="ne-content"
              rows={8}
              className={`${INPUT} min-h-[8rem] resize-y leading-relaxed`}
              value={draft.contentMd}
              placeholder="Markdown: # heading, **bold**, *italic*, `code`, [link](https://…), - list, > quote"
              onChange={(e) => set('contentMd', e.target.value)}
            />
          </div>
          {preview && (
            <div className="border border-bone/15 p-3" aria-label="Notes preview" role="region">
              <p className="hud-label mb-1">Preview</p>
              {deferredMd.trim() ? (
                <Markdown source={deferredMd} className="font-mono text-[12px] break-words text-bone" />
              ) : (
                <p className="font-mono text-[11px] text-concrete">Nothing to preview yet.</p>
              )}
            </div>
          )}
        </Section>

        {/* Archetype-specific */}
        {archetype === 'entity' && (
          <Section title="Entity">
            <div>
              <label htmlFor="ne-entity-kind" className="hud-label mb-1.5 block">
                Kind
              </label>
              <select
                id="ne-entity-kind"
                className={SELECT}
                value={draft.entity?.kind ?? 'other'}
                aria-invalid={!!errs('entity.kind')?.length}
                onChange={(e) => set('entity', { kind: e.target.value as EntityKind })}
              >
                {ENTITY_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <Messages errors={errs('entity.kind')} />
            </div>
          </Section>
        )}

        {archetype === 'demon' && draft.demon && (
          <Section title="Demon">
            <div>
              <label htmlFor="ne-demon-query" className="hud-label mb-1.5 block">
                Standing query
              </label>
              <input
                id="ne-demon-query"
                className={INPUT}
                value={draft.demon.query}
                placeholder="e.g. entropy information"
                aria-invalid={!!errs('demon.query')?.length}
                aria-describedby="ne-demon-query-hint"
                onChange={(e) => set('demon', { ...draft.demon!, query: e.target.value })}
              />
              <p id="ne-demon-query-hint" className={HINT_TEXT}>
                Matches titles, tags and notes. Matching nodes within its radius are sorted onto its lattice.
              </p>
              <Messages errors={errs('demon.query')} warnings={warns('demon.query')} />
            </div>
            <div>
              <Slider
                id="ne-demon-radius"
                label="Radius"
                value={draft.demon.radius}
                min={2}
                max={Math.max(60, Math.ceil(draft.demon.radius))}
                step={1}
                lowHint="tight"
                highHint="wide"
                valueText={`${draft.demon.radius} u`}
                onChange={(radius) => set('demon', { ...draft.demon!, radius })}
              />
              <Messages errors={errs('demon.radius')} />
            </div>
            <label className="flex cursor-pointer items-center gap-2 font-mono text-[12px] text-bone">
              <input
                type="checkbox"
                className={`h-4 w-4 accent-signal ${FOCUS}`}
                checked={draft.demon.active}
                onChange={(e) => set('demon', { ...draft.demon!, active: e.target.checked })}
              />
              Active: sorting now
            </label>
          </Section>
        )}

        {archetype === 'memory' && (
          <Section title="Volumetric scene">
            <SceneField id="ne-splat" nodeId={gone ? null : savedId} />
          </Section>
        )}

        {/* Physics */}
        <Section
          title="Weight in the field"
          aside={
            (thermo.mass !== defaults.mass || thermo.temperature !== defaults.temperature) && (
              <button
                type="button"
                className={`font-mono text-[10px] uppercase text-concrete hover:text-bone ${FOCUS}`}
                onClick={() => set('thermo', { mass: defaults.mass, temperature: defaults.temperature })}
              >
                Reset to {info.name.toLowerCase()} defaults
              </button>
            )
          }
        >
          <div>
            <Slider
              id="ne-significance"
              label="Significance"
              value={massToSignificance(thermo.mass)}
              min={0}
              max={1}
              step={0.01}
              lowHint="passing"
              highHint="foundational"
              valueText={`${significanceWord(thermo.mass)} (mass ${thermo.mass.toFixed(2)})`}
              onChange={(s) => set('thermo', { ...thermo, mass: significanceToMass(s) })}
            />
            <Messages errors={errs('thermo.mass')} />
          </div>
          <div>
            <Slider
              id="ne-volatility"
              label="Volatility"
              value={thermo.temperature}
              min={0}
              max={1}
              step={0.01}
              lowHint="anchored"
              highHint="restless"
              valueText={`${volatilityWord(thermo.temperature)} (${thermo.temperature.toFixed(2)})`}
              onChange={(t) => set('thermo', { ...thermo, temperature: Math.round(t * 100) / 100 })}
            />
            <Messages errors={errs('thermo.temperature')} />
          </div>
        </Section>

        {/* Links */}
        <div>
          <LinkPicker
            id="ne-links"
            selfId={draft.id}
            links={draft.links}
            onChange={(links) => set('links', links)}
            nodes={nodes}
            trash={trash}
            errors={issues.links}
          />
        </div>

        {/* Attachments */}
        <AttachmentField
          id="ne-attachments"
          existing={live?.attachments ?? []}
          removedIds={removed}
          onToggleRemove={(attId) =>
            setRemoved((r) => {
              const next = new Set(r)
              if (!next.delete(attId)) next.add(attId)
              return next
            })
          }
          pending={pending}
          onAdd={(files) => setPending((p) => [...p, ...files])}
          onRemovePending={(i) => setPending((p) => p.filter((_, j) => j !== i))}
        />

        {/* Visibility */}
        <fieldset className="border-0 p-0">
          <legend className="hud-label mb-1.5 p-0">Visibility</legend>
          <div className="flex" role="radiogroup" aria-describedby="ne-visibility-hint">
            {(['private', 'public'] as const satisfies readonly Visibility[]).map((v) => (
              <label
                key={v}
                className={
                  'relative -ml-px flex-1 cursor-pointer border border-bone/30 px-3 py-1.5 text-center font-mono text-[11px] uppercase tracking-wider text-bone first:ml-0 ' +
                  'hover:bg-bone/10 has-[:checked]:z-10 has-[:checked]:border-bone has-[:checked]:bg-bone has-[:checked]:text-void ' +
                  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal'
                }
              >
                <input
                  type="radio"
                  name="ne-visibility"
                  value={v}
                  className="sr-only"
                  checked={draft.visibility === v}
                  onChange={() => set('visibility', v)}
                />
                {v}
              </label>
            ))}
          </div>
          <p id="ne-visibility-hint" className={HINT_TEXT}>
            Marks what may be shared later. Nothing leaves this browser today.
          </p>
        </fieldset>
      </div>

      <footer className="border-t border-bone/15 p-3">
        {otherErrors.length > 0 && <Messages errors={otherErrors} />}
        {saveError && (
          <p role="alert" className={`${ERROR_TEXT} mb-2`}>
            {saveError}
          </p>
        )}
        {submitted && issues.blocking.length > 0 && !saveError && (
          <p role="alert" className={`${ERROR_TEXT} mb-2`}>
            Fix the highlighted field{issues.blocking.length > 1 ? 's' : ''} to save.
          </p>
        )}
        {/* Keyed so the prompt mounts fresh: reusing the footer's <div>/<button> would skip autoFocus. */}
        {confirming ? (
          <div key="discard" role="alertdialog" aria-labelledby="ne-discard-q" className="flex flex-wrap items-center gap-2 border border-signal p-2">
            <p id="ne-discard-q" className="mr-auto font-mono text-[11px] uppercase tracking-wider text-signal">
              Discard unsaved changes?
            </p>
            <button type="button" className={BTN} autoFocus onClick={() => setConfirming(false)}>
              Keep editing
            </button>
            <button type="button" className={BTN_SIGNAL} onClick={close}>
              Discard
            </button>
          </div>
        ) : (
          <div key="actions" className="flex items-center justify-end gap-2">
            <span className="mr-auto font-mono text-[10px] text-concrete" aria-live="polite">
              {saving ? 'Saving…' : hasChanges ? 'Unsaved changes' : 'No changes'}
              <span className="hidden sm:inline"> · ⌘/Ctrl+Enter saves</span>
            </span>
            <button type="button" className={BTN} onClick={requestClose} disabled={saving}>
              Cancel
            </button>
            <button type="button" className={BTN_SIGNAL} onClick={() => void save()} disabled={saving || gone || !writer}>
              {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
            </button>
          </div>
        )}
      </footer>
    </Sheet>
  )
}
